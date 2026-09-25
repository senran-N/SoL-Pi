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
import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const NOTE_MAX_BYTES = 32_768;
export const NOTE_INDEX_MAX_BYTES = 1_024;
export const NOTE_VERSION_ENTRY = "sol-pi-note-version-v1";

const NOTE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NOTE_INDEX_TRUNCATION_MARKER = "[sol-pi-notes index truncated]";

export type NoteEntry = {
	readonly slug: string;
	readonly bytes: number;
};

/** The session owns the reference and recovery body; objects are immutable. */
export type NoteVersion = NoteEntry & {
	readonly version: 1;
	readonly contentHash: string;
	readonly body: string;
	readonly importedLegacy?: true;
};

const digest = (body: string): string => createHash("sha256").update(body).digest("hex");

export function parseNoteVersion(value: unknown): NoteVersion | undefined {
	if (!value || typeof value !== "object") return;
	const note = value as Record<string, unknown>;
	if (note.version !== 1 || typeof note.slug !== "string" || !NOTE_SLUG_PATTERN.test(note.slug) ||
		typeof note.body !== "string" || Buffer.byteLength(note.body, "utf8") > NOTE_MAX_BYTES ||
		note.bytes !== Buffer.byteLength(note.body, "utf8") || note.contentHash !== digest(note.body)) return;
	return { version: 1, slug: note.slug, body: note.body, bytes: note.bytes as number, contentHash: note.contentHash as string,
		...(note.importedLegacy === true ? { importedLegacy: true as const } : {}) };
}

/** Never consult another branch or a mutable legacy file during ordinary reads. */
export function branchNotes(entries: readonly SessionEntry[]): Map<string, NoteVersion> {
	const notes = new Map<string, NoteVersion>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== NOTE_VERSION_ENTRY) continue;
		const version = parseNoteVersion(entry.data);
		if (version) notes.set(version.slug, version);
	}
	return notes;
}

export async function storeNoteVersion(root: string, note: NoteVersion): Promise<void> {
	if (!parseNoteVersion(note)) throw new Error("Invalid immutable note version");
	const directory = join(notesDirectory(root), "objects");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${note.contentHash}.md`);
	try {
		await writeFile(path, note.body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (digest(await readFile(path, "utf8")) !== note.contentHash) throw new Error("Immutable note object hash mismatch");
	}
}

export async function createNoteVersion(root: string, slug: string, body: string, importedLegacy = false): Promise<NoteVersion> {
	notePath(root, slug);
	const text = noteText(body);
	if (Buffer.byteLength(text, "utf8") > NOTE_MAX_BYTES) throw new Error(`Online Context Compact note must stay under ${NOTE_MAX_BYTES} bytes`);
	const note: NoteVersion = { version: 1, slug, body: text, bytes: Buffer.byteLength(text, "utf8"), contentHash: digest(text),
		...(importedLegacy ? { importedLegacy: true } : {}) };
	await storeNoteVersion(root, note);
	return note;
}

export function branchNoteIndex(entries: readonly SessionEntry[]): readonly string[] {
	return boundedNoteIndex([...branchNotes(entries).values()].sort((a, b) => a.slug.localeCompare(b.slug)));
}

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
		return boundedNoteIndex(await listNotes(root));
	} catch (error) {
		console.error(`[onlinecontextcompact] note index read failed: ${described(error)}`);
		return [];
	}
}

function boundedNoteIndex(entries: readonly NoteEntry[]): readonly string[] {
	const lines: string[] = [];
	let budget = NOTE_INDEX_MAX_BYTES - Buffer.byteLength(NOTE_INDEX_TRUNCATION_MARKER, "utf8") - 1;
	for (const entry of entries) {
		const line = formatNoteIndexLine(entry);
		const cost = Buffer.byteLength(line, "utf8") + 1;
		if (cost > budget) { lines.push(NOTE_INDEX_TRUNCATION_MARKER); break; }
		lines.push(line);
		budget -= cost;
	}
	return lines;
}
