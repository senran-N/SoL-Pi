/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live handles for commands that outlived their foreground deadline.
 *
 * A handle owns the command after the yield: it keeps collecting output, tracks
 * how much of that output the agent has already been shown, and holds the only
 * abort path that can still kill the process tree.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { commandIdentity, type DiagnosticCategory } from "./command-results.ts";

/** Memory budget for disk-backed handles; unread output remains in the spool. */
export const RETAINED_BYTES = 1024 * 1024;

const HANDLE_ID_PATTERN = /^exec_[a-f0-9]{12}$/u;

export type HandleStatus = "running" | "exited" | "killed" | "failed";

export interface HandleSnapshot {
	readonly id: string;
	readonly commandSha256: string;
	readonly diagnosticCategory: DiagnosticCategory;
	readonly cwd: string;
	readonly status: HandleStatus;
	readonly exitCode: number | null | undefined;
	readonly error: string | undefined;
	readonly startedAt: number;
	readonly settledAt: number | undefined;
	/** Bytes produced and not yet handed to the agent. */
	readonly pendingBytes: number;
	/** Bytes discarded because the retention budget was reached. */
	readonly droppedBytes: number;
	readonly outputPath?: string;
}

export interface Increment {
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	/** Output still waiting after this increment, because a limit was reached. */
	readonly remainingBytes: number;
	readonly droppedBytes: number;
	readonly startOffset: number;
	readonly endOffset: number;
}

export interface IncrementLimits {
	readonly maxBytes: number;
	readonly maxLines: number;
}

export interface Handle {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly startedAt: number;
	status: HandleStatus;
	exitCode: number | null | undefined;
	error: string | undefined;
	settledAt: number | undefined;
	/** Kills the process tree; set by the operations wrapper that owns the child. */
	abort: () => void;
	/** Absolute offset of the first retained byte. */
	baseOffset: number;
	/** Absolute offset one past the last byte received. */
	endOffset: number;
	/** Absolute offset of the first byte the agent has not been shown. */
	cursor: number;
	droppedBytes: number;
	chunks: Buffer[];
	waiters: Set<() => void>;
	outputPath?: string;
	/** Persistent read/write descriptor for the session spool. */
	spoolFd?: number;
	/** One bounded read window avoids reopening/scanning the spool for every page. */
	readCache?: Buffer;
	readCacheStart?: number;
}

export interface Registry {
	/** Session-derived storage only; commands themselves are never written. */
	setOutputRoot(root: string): void;
	create(command: string, cwd: string): Handle;
	get(id: string): Handle | undefined;
	list(): HandleSnapshot[];
	/** Forget a command that finished inside its foreground deadline. */
	discard(handle: Handle): void;
	append(handle: Handle, chunk: Buffer): void;
	settle(handle: Handle, status: HandleStatus, exitCode: number | null | undefined, error?: string): void;
	take(handle: Handle, limits: IncrementLimits): Increment;
	snapshot(handle: Handle): HandleSnapshot;
	/** Resolves on new output, on settlement, or when the wait budget runs out. */
	wait(handle: Handle, timeoutMs: number): Promise<void>;
	kill(handle: Handle): void;
	killAll(): void;
}

export function isHandleId(value: string): boolean {
	return HANDLE_ID_PATTERN.test(value);
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) {
		if (character === "\n") lines += 1;
	}
	return lines;
}

/**
 * Trim retained output once it passes the budget.
 *
 * A persistent session spools every byte before trimming memory. Without
 * session storage, only delivered bytes can be trimmed; unread evidence wins
 * over the memory target.
 */
function trim(handle: Handle): void {
	while (handle.endOffset - handle.baseOffset > RETAINED_BYTES) {
		// Only discard bytes that remain recoverable on disk or were delivered.
		if (!handle.outputPath && handle.baseOffset + (handle.chunks[0]?.length ?? 0) > handle.cursor) return;
		const oldest = handle.chunks.shift();
		if (!oldest) return;
		handle.baseOffset += oldest.length;
	}
}

/** Back an offset off a split multi-byte character, so a slice decodes cleanly. */
function trimUtf8End(buffer: Buffer, limit: number): number {
	let end = limit;
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	// The process may have emitted only the first bytes of a UTF-8 character.
	if (end === buffer.length && end > 0) {
		let start = end - 1;
		while (start > 0 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start--;
		const first = buffer[start] ?? 0;
		const width = first >= 0xf0 && first <= 0xf4 ? 4 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xc2 && first <= 0xdf ? 2 : 1;
		if (end - start < width) end = start;
	}
	return end;
}

function notify(handle: Handle): void {
	for (const waiter of [...handle.waiters]) waiter();
}

export function createRegistry(): Registry {
	const handles = new Map<string, Handle>();
	let outputRoot: string | undefined;

	const registry: Registry = {
		setOutputRoot(root) {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			outputRoot = root;
		},
		create(command, cwd) {
			let id = `exec_${randomBytes(6).toString("hex")}`;
			while (handles.has(id)) id = `exec_${randomBytes(6).toString("hex")}`;
			const handle: Handle = {
				id,
				command,
				cwd,
				startedAt: Date.now(),
				status: "running",
				exitCode: undefined,
				error: undefined,
				settledAt: undefined,
				abort: () => {},
				baseOffset: 0,
				endOffset: 0,
				cursor: 0,
				droppedBytes: 0,
				chunks: [],
				waiters: new Set(),
			};
			if (outputRoot) {
				handle.outputPath = join(outputRoot, `${id}.log`);
				handle.spoolFd = openSync(handle.outputPath, "wx+", 0o600);
			}
			handles.set(id, handle);
			return handle;
		},

		get(id) {
			return handles.get(id);
		},

		list() {
			return [...handles.values()].map((handle) => registry.snapshot(handle));
		},

		discard(handle) {
			handles.delete(handle.id);
			if (handle.spoolFd !== undefined) {
				closeSync(handle.spoolFd);
				handle.spoolFd = undefined;
			}
		},

		append(handle, chunk) {
			if (chunk.length === 0) return;
			if (handle.spoolFd !== undefined) {
				let offset = 0;
				while (offset < chunk.length) offset += writeSync(handle.spoolFd, chunk, offset, chunk.length - offset, null);
			} else if (handle.outputPath) appendFileSync(handle.outputPath, chunk);
			handle.chunks.push(chunk);
			handle.endOffset += chunk.length;
			trim(handle);
			notify(handle);
		},

		settle(handle, status, exitCode, error) {
			if (handle.status !== "running") return;
			handle.status = status;
			handle.exitCode = exitCode;
			handle.error = error;
			handle.settledAt = Date.now();
			notify(handle);
		},

			take(handle, limits) {
				const startOffset = handle.cursor;
				let pending: Buffer;
				if (handle.outputPath) {
					const cacheStart = handle.readCacheStart;
					const cacheEnd = cacheStart === undefined || !handle.readCache ? -1 : cacheStart + handle.readCache.length;
					if (!handle.readCache || cacheStart === undefined || handle.cursor < cacheStart || handle.cursor >= cacheEnd) {
						const cacheBytes = Math.min(handle.endOffset - handle.cursor, RETAINED_BYTES);
						const cache = Buffer.alloc(cacheBytes);
						const fd = handle.spoolFd ?? openSync(handle.outputPath, "r");
						try {
							const bytes = readSync(fd, cache, 0, cache.length, handle.cursor);
							handle.readCache = cache.subarray(0, bytes);
							handle.readCacheStart = handle.cursor;
						} finally {
							if (handle.spoolFd === undefined) closeSync(fd);
						}
					}
					pending = handle.readCache?.subarray(handle.cursor - (handle.readCacheStart ?? handle.cursor)) ?? Buffer.alloc(0);
			} else {
				pending = Buffer.concat(handle.chunks).subarray(handle.cursor - handle.baseOffset);
			}
			const droppedBytes = handle.droppedBytes;
			handle.droppedBytes = 0;

			// Cut on a line boundary, then back off any split multi-byte character,
			// so the next increment resumes on a clean boundary in both senses.
			let end = Math.min(pending.length, Math.max(0, limits.maxBytes));
			let newlines = 0;
			for (let index = 0; index < end; index += 1) {
				if (pending[index] !== 0x0a) continue;
				newlines += 1;
				if (newlines === limits.maxLines) {
					end = index + 1;
					break;
				}
			}
			end = trimUtf8End(pending, end);
			const slice = pending.subarray(0, end);
			const text = slice.toString("utf8");

				handle.cursor += slice.length;
				if (handle.readCache && handle.readCacheStart !== undefined && handle.cursor >= handle.readCacheStart + handle.readCache.length) {
					handle.readCache = undefined;
					handle.readCacheStart = undefined;
				}
			// Retained output the agent has now seen is no longer needed.
			while (handle.chunks.length > 0) {
				const oldest = handle.chunks[0];
				if (!oldest || handle.baseOffset + oldest.length > handle.cursor) break;
				handle.chunks.shift();
				handle.baseOffset += oldest.length;
			}
			// A completed handle no longer needs its persistent descriptor once all
			// bytes have been delivered. This keeps long sessions from accumulating
			// one open file per yielded command while preserving the spool itself.
			if (handle.status !== "running" && handle.cursor >= handle.endOffset && handle.spoolFd !== undefined) {
				closeSync(handle.spoolFd);
				handle.spoolFd = undefined;
				handle.readCache = undefined;
				handle.readCacheStart = undefined;
			}

			return {
				text,
				bytes: slice.length,
				lines: countLines(text),
				remainingBytes: handle.endOffset - handle.cursor,
				droppedBytes,
				startOffset,
				endOffset: handle.cursor,
			};
		},

		snapshot(handle) {
			return {
				id: handle.id,
				...commandIdentity(handle.command),
				cwd: handle.cwd,
				status: handle.status,
				exitCode: handle.exitCode,
				// Backend exception strings may embed command arguments or credentials.
				error: handle.error ? "Command execution failed; inspect the output and status." : undefined,
				startedAt: handle.startedAt,
				settledAt: handle.settledAt,
				pendingBytes: handle.endOffset - handle.cursor,
				droppedBytes: handle.droppedBytes,
				...(handle.outputPath ? { outputPath: handle.outputPath } : {}),
			};
		},

		async wait(handle, timeoutMs) {
			if (handle.status !== "running" || handle.endOffset > handle.cursor) return;
			await new Promise<void>((resolve) => {
				const finish = () => {
					handle.waiters.delete(finish);
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(finish, timeoutMs);
				if (typeof timer === "object" && "unref" in timer) timer.unref();
				handle.waiters.add(finish);
			});
		},

		kill(handle) {
			if (handle.status !== "running") return;
			handle.abort();
		},

		killAll() {
			for (const handle of handles.values()) registry.kill(handle);
		},
	};

	return registry;
}
