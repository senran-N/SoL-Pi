/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Durable scratch notes for Online Context Compact.
 *
 * The window fragment is the compaction checkpoint, so it may only carry what
 * structured state already recorded. Notes are the deliberate escape hatch: the
 * model writes down anything the plan and progress records cannot express, and a
 * short index of the notes rides along in every window fragment. The note bodies
 * themselves stay on disk and are pulled back on demand, which keeps the
 * checkpoint small no matter how much has been written.
 *
 * Everything lives under `<runtimeRoot>/online-context-compact/notes/` and no
 * model-supplied text ever becomes a path: the slug is matched against a strict
 * pattern before it is joined.
 */
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const NOTE_MAX_BYTES = 32_768;
export const NOTE_INDEX_MAX_BYTES = 1_024;

const NOTE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NOTE_INDEX_TRUNCATION_MARKER = "[sol-pi-notes index truncated]";

export type NoteEntry = {
	readonly slug: string;
	readonly bytes: number;
};

export function notesDirectory(root: string): string {
	return join(root, "online-context-compact", "notes");
}

/**
 * Resolve a note path. The slug pattern forbids separators, dots, and anything
 * else that could escape the notes directory, so this is traversal-safe.
 */
export function notePath(root: string, slug: string): string {
	if (!NOTE_SLUG_PATTERN.test(slug)) {
		throw new Error(`Online Context Compact note slug must match [a-z0-9][a-z0-9-]{0,63}: ${slug}`);
	}
	return join(notesDirectory(root), `${slug}.md`);
}

function described(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function noteText(body: string): string {
	const trimmed = body.replace(/\r\n/gu, "\n").trim();
	if (trimmed.length === 0) throw new Error("Online Context Compact note body must not be empty");
	const bytes = Buffer.byteLength(trimmed, "utf8");
	if (bytes > NOTE_MAX_BYTES) {
		throw new Error(`Online Context Compact note must stay under ${NOTE_MAX_BYTES} bytes, got ${bytes}`);
	}
	return `${trimmed}\n`;
}

export async function writeNote(root: string, slug: string, body: string): Promise<NoteEntry> {
	const text = noteText(body);
	const path = notePath(root, slug);
	await mkdir(notesDirectory(root), { recursive: true });
	await writeFile(path, text, "utf8");
	return { slug, bytes: Buffer.byteLength(text, "utf8") };
}

export async function appendNote(root: string, slug: string, body: string): Promise<NoteEntry> {
	const addition = noteText(body);
	const path = notePath(root, slug);
	await mkdir(notesDirectory(root), { recursive: true });
	const existing = await readNote(root, slug);
	// Notes this module writes always end in a newline, but a hand-edited file
	// may not: write the separator rather than only charging for it, so an
	// append can never land on the end of an existing line.
	const separator = existing !== undefined && existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	const payload = `${separator}${addition}`;
	const total =
		Buffer.byteLength(payload, "utf8") + (existing === undefined ? 0 : Buffer.byteLength(existing, "utf8"));
	if (total > NOTE_MAX_BYTES) {
		throw new Error(`Online Context Compact note "${slug}" would exceed ${NOTE_MAX_BYTES} bytes`);
	}
	await appendFile(path, payload, "utf8");
	return { slug, bytes: total };
}

export async function readNote(root: string, slug: string): Promise<string | undefined> {
	try {
		return await readFile(notePath(root, slug), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

export async function listNotes(root: string): Promise<readonly NoteEntry[]> {
	let names: readonly string[];
	try {
		names = await readdir(notesDirectory(root));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: NoteEntry[] = [];
	for (const name of [...names].sort()) {
		if (!name.endsWith(".md")) continue;
		const slug = name.slice(0, -3);
		if (!NOTE_SLUG_PATTERN.test(slug)) continue;
		const info = await stat(join(notesDirectory(root), name));
		if (!info.isFile()) continue;
		entries.push({ slug, bytes: info.size });
	}
	return entries;
}

export function formatNoteIndexLine(entry: NoteEntry): string {
	return `${entry.slug} (${entry.bytes} bytes)`;
}

/**
 * Bounded, fail-open index for the window fragment: a broken notes directory
 * must never block a compaction, so any failure degrades to "no notes".
 */
export async function readNotesIndex(root: string): Promise<readonly string[]> {
	try {
		const lines: string[] = [];
		let budget = NOTE_INDEX_MAX_BYTES;
		let truncated = false;
		for (const entry of await listNotes(root)) {
			const line = formatNoteIndexLine(entry);
			const cost = Buffer.byteLength(line, "utf8") + 1;
			if (cost > budget) {
				truncated = true;
				break;
			}
			lines.push(line);
			budget -= cost;
		}
		if (truncated) lines.push(NOTE_INDEX_TRUNCATION_MARKER);
		return lines;
	} catch (error) {
		console.error(`[onlinecontextcompact] note index read failed: ${described(error)}`);
		return [];
	}
}
