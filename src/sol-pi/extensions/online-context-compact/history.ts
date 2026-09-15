/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
};

export type HistorySearch = {
	readonly total: number;
	readonly hits: readonly HistoryHit[];
	readonly truncated: boolean;
};

type HistoryRecord = {
	readonly id: string;
	readonly index: number;
	readonly kind: string;
	readonly text: string;
};

const MAX_TOOL_ARGUMENT_CHARS = 200;

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
			parts.push(`[tool ${record.name}] ${args.slice(0, MAX_TOOL_ARGUMENT_CHARS)}`);
		}
	}
	return parts.join("\n");
}

function recordFor(entry: SessionEntry, index: number): HistoryRecord | undefined {
	if (entry.type === "message") {
		const message = entry.message as { role?: string; content?: unknown };
		const role = typeof message.role === "string" ? message.role : "message";
		const text = textFromContent(message.content);
		if (!text) return undefined;
		const kind = role === "toolResult" ? "tool result" : role;
		return { id: entry.id, index, kind, text };
	}
	if (entry.type === "compaction") {
		return { id: entry.id, index, kind: "compaction", text: entry.summary };
	}
	if (entry.type === "branch_summary") {
		return { id: entry.id, index, kind: "branch summary", text: entry.summary };
	}
	if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		return text ? { id: entry.id, index, kind: "note", text } : undefined;
	}
	return undefined;
}

function recordsOf(entries: readonly SessionEntry[]): HistoryRecord[] {
	const records: HistoryRecord[] = [];
	for (const [offset, entry] of entries.entries()) {
		const record = recordFor(entry, offset + 1);
		if (record) records.push(record);
	}
	return records;
}

function snippetAround(text: string, at: number, length: number): string {
	const start = Math.max(0, at - HISTORY_SNIPPET_RADIUS);
	const end = Math.min(text.length, at + length + HISTORY_SNIPPET_RADIUS);
	const head = start > 0 ? "..." : "";
	const tail = end < text.length ? "..." : "";
	const body = text.slice(start, end).replace(/\s+/gu, " ").trim();
	return `${head}${body}${tail}`;
}

/** Case-insensitive substring search over the readable parts of a session log. */
export function searchHistory(
	entries: readonly SessionEntry[],
	query: string,
	limit: number = HISTORY_DEFAULT_LIMIT,
): HistorySearch {
	const needle = query.trim().toLowerCase();
	if (!needle) return { total: 0, hits: [], truncated: false };
	const requested = Math.min(Math.max(1, Math.trunc(limit) || 1), HISTORY_MAX_LIMIT);
	const hits: HistoryHit[] = [];
	let total = 0;
	let truncated = false;
	let bytes = 0;
	for (const record of recordsOf(entries)) {
		const at = record.text.toLowerCase().indexOf(needle);
		if (at < 0) continue;
		total += 1;
		if (hits.length >= requested) continue;
		const hit: HistoryHit = {
			id: record.id,
			index: record.index,
			kind: record.kind,
			snippet: snippetAround(record.text, at, needle.length),
		};
		const size = byteLength(hit.snippet) + hit.id.length + 32;
		if (bytes + size > HISTORY_HINT_MAX_BYTES) {
			truncated = true;
			continue;
		}
		bytes += size;
		hits.push(hit);
	}
	return { total, hits, truncated: truncated || total > hits.length };
}

/** Full text of one recorded entry, bounded so a read cannot refill the window. */
export function readHistoryEntry(
	entries: readonly SessionEntry[],
	id: string,
): { readonly kind: string; readonly index: number; readonly text: string } | undefined {
	const record = recordsOf(entries).find((candidate) => candidate.id === id);
	if (!record) return undefined;
	const budget = HISTORY_READ_MAX_BYTES - byteLength(HISTORY_TRUNCATION_MARKER) - 1;
	const text = byteLength(record.text) > budget ? `${sliceBytes(record.text, budget)}\n${HISTORY_TRUNCATION_MARKER}` : record.text;
	return { kind: record.kind, index: record.index, text };
}
