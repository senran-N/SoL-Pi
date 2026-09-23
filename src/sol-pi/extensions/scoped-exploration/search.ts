/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Read-only primitives for a scoped exploration.
 *
 * The explorer model never reaches Pi's tools. It reaches these three functions
 * and nothing else: no writes, no commands, no network. Each one is confined to
 * the project root, refuses to follow a symlink out of it, and returns a bounded
 * result, so a step cannot stall on a large tree or smuggle a file in from
 * elsewhere on the machine.
 *
 * The match is a literal, case-insensitive substring rather than a regular
 * expression. A model-supplied pattern is untrusted input, and a literal match
 * cannot be made to backtrack.
 */
import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, matchesGlob } from "node:path";
import {
	GREP_MAX_HITS,
	LIST_MAX_ENTRIES,
	READ_MAX_LINES,
	SCAN_MAX_FILES,
	SCAN_MAX_FILE_BYTES,
	SKIPPED_DIRECTORIES,
} from "./config.ts";

export type GrepHit = { readonly path: string; readonly line: number; readonly text: string };

export function isExcluded(root: string, file: string, patterns: readonly string[]): boolean {
	const path = relativePath(root, file);
	// A basename exclusion applies at every depth; a directory exclusion applies
	// to its descendants as well. Explicit path globs still match the full path.
	const segments = path.split("/");
	return patterns.some((pattern) => {
		if (pattern.includes("/")) {
			return matchesGlob(path, pattern) || segments.some((_, index) => matchesGlob(segments.slice(0, index + 1).join("/"), pattern));
		}
		return segments.some((segment) => matchesGlob(segment, pattern));
	});
}

export type ReadSlice = { readonly path: string; readonly firstLine: number; readonly lines: readonly string[]; readonly eof: boolean };

const BINARY_PROBE_BYTES = 8_192;
const MAX_LINE_CHARS = 400;

/**
 * Resolve a candidate path inside the exploration root.
 *
 * `realpath` is what makes this a containment check rather than a string check:
 * a symlink that points outside the project resolves outside it and is refused.
 * A path that does not exist yet is resolved lexically, which is enough, because
 * every caller then opens it and a miss is reported as a miss.
 */
export async function resolveInside(root: string, candidate: string): Promise<string> {
	const rootReal = await realpath(root);
	const target = isAbsolute(candidate) ? candidate : join(rootReal, candidate);
	let resolved: string;
	try {
		resolved = await realpath(target);
	} catch {
		resolved = resolve(target);
	}
	const rooted = relative(rootReal, resolved);
	if (rooted === ".." || rooted.startsWith(`..${sep}`) || isAbsolute(rooted)) {
		throw new Error(`Path is outside the project: ${candidate}`);
	}
	return resolved;
}

export function relativePath(root: string, absolute: string): string {
	return relative(root, absolute).split(sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
	const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
	return probe.includes(0);
}

function clampLine(text: string): string {
	const collapsed = text.replace(/\r/gu, "");
	return collapsed.length > MAX_LINE_CHARS ? `${collapsed.slice(0, MAX_LINE_CHARS)}...` : collapsed;
}

async function* walk(root: string, start: string, budget: { remaining: number }, excludedPaths: readonly string[]): AsyncGenerator<string> {
	let entries: Dirent[];
	try {
		entries = await readdir(start, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (budget.remaining <= 0) return;
		const full = join(start, entry.name);
		// A symlink is never followed during a walk: containment is checked for
		// paths the model names, and a link inside the tree could otherwise pull
		// the whole filesystem into a single grep.
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name) || isExcluded(root, full, excludedPaths)) continue;
			yield* walk(root, full, budget, excludedPaths);
			continue;
		}
		if (!entry.isFile() || isExcluded(root, full, excludedPaths)) continue;
		budget.remaining -= 1;
		yield full;
	}
}

export async function grepFiles(input: {
	readonly root: string;
	readonly pattern: string;
	readonly path?: string;
	readonly excludedPaths?: readonly string[];
}): Promise<{ readonly hits: readonly GrepHit[]; readonly truncated: boolean; readonly scanned: number }> {
	const needle = input.pattern.toLowerCase();
	if (needle.length === 0) throw new Error("Search pattern must not be empty");
	// One resolution of the root for the whole call: a hit's path is reported
	// against the same real root that contains it, so a root reached through a
	// link (/tmp on macOS, a short path on Windows) still yields a usable
	// relative path rather than one that climbs out of the project.
	const rootReal = await realpath(input.root);
	const start = input.path ? await resolveInside(input.root, input.path) : rootReal;
	const budget = { remaining: SCAN_MAX_FILES };
	const excludedPaths = input.excludedPaths ?? [];
	const hits: GrepHit[] = [];
	let truncated = false;

	const startStats: Stats = await lstat(start);
	const files = startStats.isDirectory()
		? walk(rootReal, start, budget, excludedPaths)
		: (async function* () { if (!isExcluded(rootReal, start, excludedPaths)) yield start; })();

	for await (const file of files) {
		if (hits.length >= GREP_MAX_HITS) {
			truncated = true;
			break;
		}
		let stats: Stats;
		try {
			stats = await lstat(file);
		} catch {
			continue;
		}
		if (!stats.isFile() || stats.size > SCAN_MAX_FILE_BYTES) continue;
		let buffer: Buffer;
		try {
			buffer = await readFile(file);
		} catch {
			continue;
		}
		if (looksBinary(buffer)) continue;
		const lines = buffer.toString("utf8").split("\n");
		for (const [index, line] of lines.entries()) {
			if (!line.toLowerCase().includes(needle)) continue;
			if (hits.length >= GREP_MAX_HITS) {
				truncated = true;
				break;
			}
			hits.push({ path: relativePath(rootReal, file), line: index + 1, text: clampLine(line) });
		}
	}

	return { hits, truncated: truncated || budget.remaining <= 0, scanned: SCAN_MAX_FILES - budget.remaining };
}

export async function readSlice(input: {
	readonly root: string;
	readonly path: string;
	readonly excludedPaths?: readonly string[];
	readonly offset?: number;
	readonly limit?: number;
}): Promise<ReadSlice> {
	const rootReal = await realpath(input.root);
	const file = await resolveInside(input.root, input.path);
	if (isExcluded(rootReal, file, input.excludedPaths ?? [])) throw new Error(`Path is excluded: ${input.path}`);
	const stats = await lstat(file);
	if (!stats.isFile()) throw new Error(`Not a readable file: ${input.path}`);
	if (stats.size > SCAN_MAX_FILE_BYTES) throw new Error(`File is too large to read here: ${input.path}`);
	const buffer = await readFile(file);
	if (looksBinary(buffer)) throw new Error(`File looks binary: ${input.path}`);

	const all = buffer.toString("utf8").split("\n");
	const firstLine = Math.max(1, Math.trunc(input.offset ?? 1));
	const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? READ_MAX_LINES)), READ_MAX_LINES);
	const slice = all.slice(firstLine - 1, firstLine - 1 + limit).map((line) => clampLine(line));
	return {
		path: relativePath(rootReal, file),
		firstLine,
		lines: slice,
		eof: firstLine - 1 + slice.length >= all.length,
	};
}

export async function listDirectory(input: {
	readonly root: string;
	readonly path?: string;
	readonly excludedPaths?: readonly string[];
}): Promise<{ readonly path: string; readonly entries: readonly string[]; readonly truncated: boolean }> {
	const rootReal = await realpath(input.root);
	const directory = input.path ? await resolveInside(input.root, input.path) : rootReal;
	const excludedPaths = input.excludedPaths ?? [];
	if (isExcluded(rootReal, directory, excludedPaths)) throw new Error(`Path is excluded: ${input.path}`);
	const stats = await lstat(directory);
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${input.path ?? "."}`);
	const found = await readdir(directory, { withFileTypes: true });
	const entries = found
		.filter((entry) => !entry.isSymbolicLink() && !(entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) &&
			!isExcluded(rootReal, join(directory, entry.name), excludedPaths))
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
		.sort();
	return {
		path: relativePath(rootReal, directory) || ".",
		entries: entries.slice(0, LIST_MAX_ENTRIES),
		truncated: entries.length > LIST_MAX_ENTRIES,
	};
}

/** The exact line a citation points at, or undefined when it does not exist. */
export async function lineAt(root: string, path: string, line: number, excludedPaths: readonly string[] = []): Promise<string | undefined> {
	if (!Number.isSafeInteger(line) || line < 1) return undefined;
	const rootReal = await realpath(root);
	const file = await resolveInside(root, path);
	if (isExcluded(rootReal, file, excludedPaths)) throw new Error("path is excluded");
	let stats: Stats;
	try {
		stats = await lstat(file);
	} catch {
		// The reason travels back to the caller, so it names the citation's own
		// relative path rather than an absolute path from this machine.
		throw new Error("no such file");
	}
	if (!stats.isFile() || stats.size > SCAN_MAX_FILE_BYTES) return undefined;
	const buffer = await readFile(file);
	if (looksBinary(buffer)) return undefined;
	return buffer.toString("utf8").split("\n")[line - 1]?.replace(/\r$/u, "");
}
