/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { NOTE_VERSION_ENTRY, parseNoteVersion } from "./notes.ts";

/**
 * Local, read-only history search over the current Pi session log.
 *
 * This is the deliberate local counterpart to Codex's history-notes backend:
 * it never leaves the session, never contacts a service, and only reads what Pi
 * already recorded. Bounds keep a search answer inside a hint-sized budget, so
 * recalling the past cannot itself refill the context window.
 */
export const HISTORY_HINT_MAX_BYTES = 4_000;
export const HISTORY_READ_MAX_BYTES = 24_000;
export const HISTORY_DEFAULT_LIMIT = 8;
export const HISTORY_MAX_LIMIT = 32;
export const HISTORY_SNIPPET_RADIUS = 120;
export const HISTORY_TRUNCATION_MARKER = "[sol-pi-history truncated to fit its byte budget]";

export type HistoryHit = {
	readonly id: string;
	readonly index: number;
	readonly kind: string;
	readonly snippet: string;
	readonly source: HistorySource;
	readonly timestamp: string;
	readonly tool?: string;
};

export type HistorySource = "message" | "compaction" | "branch_summary" | "note" | "checkpoint";
export type HistorySearchOptions = {
	readonly cursor?: string;
	readonly role?: string;
	readonly tool?: string;
	readonly after?: string;
	readonly before?: string;
	readonly source?: HistorySource;
};

export type HistorySearch = {
	readonly total: number;
	readonly hits: readonly HistoryHit[];
	readonly truncated: boolean;
	readonly nextCursor: string | null;
};

type HistoryRecord = {
	readonly id: string;
	readonly index: number;
	readonly kind: string;
	readonly text: string;
	readonly source: HistorySource;
	readonly timestamp: string;
	readonly role?: string;
	readonly tools?: readonly string[];
};

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function sliceBytes(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	const buffer = Buffer.from(text, "utf8");
	// Back off past any continuation byte so the cut never splits a character
	// into a replacement glyph.
	let end = maxBytes;
	while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
			continue;
		}
		if (record.type === "toolCall" && typeof record.name === "string") {
			const args = record.arguments === undefined ? "" : JSON.stringify(record.arguments);
			parts.push(`[tool ${record.name}] ${args}`);
		}
	}
	return parts.join("\n");
}

function recordFor(entry: SessionEntry, index: number): HistoryRecord | undefined {
	const base = { index, timestamp: entry.timestamp };
	if (entry.type === "message") {
		const message = entry.message as { role?: string; content?: unknown; toolName?: string };
		const role = typeof message.role === "string" ? message.role : "message";
		const text = textFromContent(message.content);
		if (!text) return undefined;
		const kind = role === "toolResult" ? "tool result" : role;
		const tools = typeof message.toolName === "string" ? [message.toolName] :
			Array.isArray(message.content) ? message.content.flatMap((part) =>
				part?.type === "toolCall" && typeof part.name === "string" ? [part.name] : []) : [];
		return { ...base, id: entry.id, kind, text, source: "message", role, tools };
	}
	if (entry.type === "compaction") {
		return { ...base, id: entry.id, kind: "compaction", text: entry.summary, source: "compaction" };
	}
	if (entry.type === "branch_summary") {
		return { ...base, id: entry.id, kind: "branch summary", text: entry.summary, source: "branch_summary" };
	}
	if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		return text ? { ...base, id: entry.id, kind: "note", text, source: "note" } : undefined;
	}
	if (entry.type === "custom" && entry.customType === NOTE_VERSION_ENTRY) {
		const note = parseNoteVersion(entry.data);
		return note ? { ...base, id: entry.id, kind: "note", text: `${note.slug}\n${note.body}`, source: "note" } : undefined;
	}
	return undefined;
}

function recordsOf(entries: readonly SessionEntry[]): HistoryRecord[] {
	const records: HistoryRecord[] = [];
	for (const [offset, entry] of entries.entries()) {
		const record = recordFor(entry, offset + 1);
		if (record) records.push(record);
		if (entry.type === "compaction") {
			const details = entry.details as { solPiWindow?: { windowId?: string; checkpoint?: unknown } } | undefined;
			if (details?.solPiWindow?.windowId && details.solPiWindow.checkpoint) {
				records.push({ id: `checkpoint-${details.solPiWindow.windowId}`, index: offset + 1, kind: "checkpoint",
					text: JSON.stringify(details.solPiWindow.checkpoint, null, 2), source: "checkpoint", timestamp: entry.timestamp });
			}
		}
	}
	return records;
}

/** A deterministic local index, never a generated summary or replacement evidence. */
export function recentHistoryReferences(entries: readonly SessionEntry[]): readonly { id: string; kind: string; preview: string }[] {
	return recordsOf(entries).filter((record) => record.source !== "checkpoint").slice(-12).reverse()
		.map((record) => ({ id: record.id, kind: record.kind, preview: sliceBytes(record.text.replace(/\s+/gu, " "), 240) }));
}

/** Last recorded process state is a recovery pointer, never proof a process is still alive. */
export function pendingCommandReferences(entries: readonly SessionEntry[]): readonly { handle: string; sourceId: string; lastKnownStatus: string }[] {
	const commands = new Map<string, { handle: string; sourceId: string; lastKnownStatus: string; pending: boolean }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" ||
			!["bash", "powershell", "exec_wait", "exec_list", "exec_kill"].includes(entry.message.toolName)) continue;
		const details = entry.message.details as Record<string, unknown> | undefined;
		const snapshots = Array.isArray(details?.handles) ? details.handles : [details?.commandYield ?? details];
		for (const value of snapshots) {
			if (!value || typeof value !== "object") continue;
			const snapshot = value as Record<string, unknown>;
			if (typeof snapshot.id !== "string" || !/^exec_[a-f0-9]+$/u.test(snapshot.id) || typeof snapshot.status !== "string") continue;
			commands.set(snapshot.id, { handle: snapshot.id, sourceId: entry.id, lastKnownStatus: snapshot.status,
				pending: snapshot.status === "running" || (typeof snapshot.pendingBytes === "number" && snapshot.pendingBytes > 0) });
		}
	}
	return [...commands.values()].filter((command) => command.pending).map(({ pending: _pending, ...reference }) => reference);
}

function snippetAround(text: string, at: number, length: number): string {
	const start = Math.max(0, at - HISTORY_SNIPPET_RADIUS);
	const end = Math.min(text.length, at + length + HISTORY_SNIPPET_RADIUS);
	const head = start > 0 ? "..." : "";
	const tail = end < text.length ? "..." : "";
	const body = text.slice(start, end).replace(/\s+/gu, " ").trim();
	return `${head}${body}${tail}`;
}

/** Newest-first local search. A cursor pins a branch snapshot and the filters. */
export function searchHistory(
	entries: readonly SessionEntry[],
	query: string,
	limit: number = HISTORY_DEFAULT_LIMIT,
	options: HistorySearchOptions = {},
): HistorySearch {
	const needle = query.trim().toLowerCase();
	if (!needle) return { total: 0, hits: [], truncated: false, nextCursor: null };
	const requested = Math.min(Math.max(1, Math.trunc(limit) || 1), HISTORY_MAX_LIMIT);
	const { cursor, ...filters } = options;
	const fingerprint = createHash("sha256").update(JSON.stringify([needle, filters.role ?? null, filters.tool ?? null,
		filters.after ?? null, filters.before ?? null, filters.source ?? null])).digest("hex");
	const date = (value: string | undefined): number | undefined => {
		if (value === undefined) return;
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed)) throw new Error("History time filters must be valid ISO timestamps");
		return parsed;
	};
	const after = date(options.after), before = date(options.before);
	if (after !== undefined && before !== undefined && after >= before) throw new Error("History after must precede before");
	let snapshot = entries.at(-1)?.id ?? null;
	let last: string | undefined;
	if (cursor !== undefined) {
		try {
			const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
			if (decoded.version !== 1 || decoded.fingerprint !== fingerprint || typeof decoded.snapshot !== "string" || typeof decoded.last !== "string") throw new Error();
			snapshot = decoded.snapshot;
			last = decoded.last;
		} catch { throw new Error("Invalid history cursor or changed filters; restart history_search"); }
	}
	const snapshotIndex = snapshot === null ? -1 : entries.findIndex((entry) => entry.id === snapshot);
	if (snapshot !== null && snapshotIndex < 0) throw new Error("History cursor snapshot is not on the current branch; restart history_search");
	const records = recordsOf(entries.slice(0, snapshotIndex + 1)).reverse();
	const matches = records.filter((record) => {
		const timestamp = Date.parse(record.timestamp);
		return (!options.source || record.source === options.source) && (!options.role || record.role === options.role) &&
			(!options.tool || record.tools?.includes(options.tool)) &&
			(after === undefined || timestamp >= after) && (before === undefined || timestamp < before) &&
			record.text.toLowerCase().includes(needle);
	});
	const start = last === undefined ? 0 : matches.findIndex((record) => record.id === last) + 1;
	if (last !== undefined && start === 0) throw new Error("History cursor entry is unavailable; restart history_search");
	const hits: HistoryHit[] = [];
	let bytes = 0;
	for (const record of matches.slice(start)) {
		const at = record.text.toLowerCase().indexOf(needle);
		if (hits.length >= requested) break;
		const hit: HistoryHit = {
			id: record.id,
			index: record.index,
			kind: record.kind,
			snippet: snippetAround(record.text, at, needle.length),
			source: record.source,
			timestamp: record.timestamp,
			...(record.tools?.[0] ? { tool: record.tools[0] } : {}),
		};
		const size = byteLength(hit.snippet) + hit.id.length + 32;
		if (bytes + size > HISTORY_HINT_MAX_BYTES) {
			break;
		}
		bytes += size;
		hits.push(hit);
	}
	const truncated = start + hits.length < matches.length;
	const nextCursor = truncated && hits.length > 0 ? Buffer.from(JSON.stringify({ version: 1, fingerprint, snapshot,
		last: hits.at(-1)!.id })).toString("base64url") : null;
	return { total: matches.length, hits, truncated, nextCursor };
}

/** Full checkpoint lives on the compaction entry, not in a truncated preview. */
function checkpointRecord(entries: readonly SessionEntry[], id: string): HistoryRecord | undefined {
	if (!/^checkpoint-w\d+$/u.test(id)) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "compaction") continue;
		const details = entry.details as { solPiWindow?: { windowId?: string; checkpoint?: unknown } } | undefined;
		if (`checkpoint-${details?.solPiWindow?.windowId}` !== id || !details?.solPiWindow?.checkpoint) continue;
		return { id, index: index + 1, kind: "checkpoint", text: JSON.stringify(details.solPiWindow.checkpoint, null, 2),
			source: "checkpoint", timestamp: entry.timestamp };
	}
	return undefined;
}

/** Byte offsets address the original UTF-8 text, never the display marker. */
export function readHistoryEntry(
	entries: readonly SessionEntry[],
	id: string,
	offset = 0,
	limit = HISTORY_READ_MAX_BYTES,
): { readonly kind: string; readonly index: number; readonly text: string;
	readonly offset: number; readonly endOffset: number; readonly totalBytes: number; readonly nextOffset: number | null } | undefined {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("history offset must be a non-negative safe integer");
	if (!Number.isSafeInteger(limit) || limit < 128 || limit > HISTORY_READ_MAX_BYTES) {
		throw new Error(`history limit must be between 128 and ${HISTORY_READ_MAX_BYTES} bytes`);
	}
	const record = checkpointRecord(entries, id) ?? recordsOf(entries).find((candidate) => candidate.id === id);
	if (!record) return undefined;
	const buffer = Buffer.from(record.text, "utf8");
	if (offset > buffer.length || (offset < buffer.length && ((buffer[offset] ?? 0) & 0xc0) === 0x80)) {
		throw new Error("history offset must be within the entry at a UTF-8 character boundary; use next_offset");
	}
	const budget = limit - byteLength(HISTORY_TRUNCATION_MARKER) - 1;
	const body = sliceBytes(buffer.subarray(offset).toString("utf8"), budget);
	const endOffset = offset + byteLength(body);
	const nextOffset = endOffset < buffer.length ? endOffset : null;
	return { kind: record.kind, index: record.index, offset, endOffset, totalBytes: buffer.length, nextOffset,
		text: nextOffset === null ? body : `${body}\n${HISTORY_TRUNCATION_MARKER}` };
}
