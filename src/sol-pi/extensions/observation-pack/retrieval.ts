/* SPDX-License-Identifier: MIT */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createObservation, ensureStored, hash, isPackableTextResult, type Observation } from "./observation.ts";

const SCAN_BYTES = 2 * 1024 * 1024;
const FIRST_PASS_BYTES = 64 * 1024;
const PROTECTED_TOOLS = new Set(["read", "edit", "write", "obs_recall", "obs_search", "history_read", "history_search", "explore"]);

function excerpt(text: string, maxBytes = 400): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
	return `${buffer.subarray(0, end).toString("utf8")}…`;
}

function terms(query: string): string[] {
	return [...new Set(query.toLowerCase().trim().split(/\s+/u))].filter(Boolean).slice(0, 16);
}

/** Only explicit tool intent authorizes a first-pass relevance selection. Code reads stay exact. */
export function observationIntent(messages: readonly AgentMessage[], observation: Observation, toolCallId: string): string | undefined {
	if (observation.bytes < FIRST_PASS_BYTES || PROTECTED_TOOLS.has(observation.toolName)) return;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.id !== toolCallId) continue;
			const intent = block.arguments.intent;
			if (typeof intent === "string" && intent.trim().length > 0 && intent.length <= 512) return intent.trim();
		}
	}
	return;
}

export function intentProjection(observation: Observation, intent: string): string {
	const needles = terms(intent);
	const selected: string[] = [];
	let offset = 0;
	let line = 1;
	for (const part of observation.text.split(/(?<=\n)/u)) {
		if (needles.some((needle) => part.toLowerCase().includes(needle))) {
			selected.push(`line=${line} offset=${offset} text=${JSON.stringify(excerpt(part.trimEnd()))}`);
			if (selected.length >= 8) break;
		}
		offset += Buffer.byteLength(part);
		line++;
	}
	return [
		"[large tool result indexed before its first provider request; partial excerpts only]",
		`id: ${observation.id}`, `tool: ${observation.toolName}`, `outcome: ${observation.isError ? "error" : "ok"}`,
		`original_bytes: ${observation.bytes}`, `original_lines: ${observation.lines}`,
		`retrieve: obs_search {"id":"${observation.id}","query":"specific terms"} or obs_recall {"id":"${observation.id}","offset":0}`,
		"selection: explicit tool intent; matches are excerpts, not an exhaustive answer or a success adjudication",
		...selected,
		...(selected.length === 0 ? ["No matching excerpt; use obs_search or obs_recall before drawing conclusions."] : []),
		`head: ${JSON.stringify(excerpt(observation.text))}`,
		`tail: ${JSON.stringify(excerpt(observation.text.slice(-400)))}`,
	].join("\n");
}

export type ObservationSearchOptions = {
	query: string; cursor?: string; id?: string; tool?: string; after?: string; before?: string; limit?: number;
};

export async function searchObservations(entries: readonly SessionEntry[], root: string, options: ObservationSearchOptions) {
	if (!options.query.trim() || options.query.length > 512) throw new Error("query must contain 1 to 512 characters");
	const needles = terms(options.query);
	const limit = Math.max(1, Math.min(16, options.limit ?? 8));
	const after = options.after === undefined ? -Infinity : Date.parse(options.after);
	const before = options.before === undefined ? Infinity : Date.parse(options.before);
	if (Number.isNaN(after) || Number.isNaN(before) || after > before) throw new Error("Invalid observation date range");
	const candidates: Array<{ entryId: string; timestamp: string; observation: Observation }> = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || !isPackableTextResult(entry.message)) continue;
		const timestamp = Date.parse(entry.timestamp);
		if (timestamp < after || timestamp > before || (options.tool && entry.message.toolName !== options.tool)) continue;
		const observation = createObservation(entry.message, root);
		if (observation && (!options.id || observation.id === options.id)) candidates.push({ entryId: entry.id, timestamp: entry.timestamp, observation });
	}
	const scope = hash(JSON.stringify([root, candidates.map((item) => item.entryId), options.query, options.id, options.tool, options.after, options.before]));
	let itemIndex = 0;
	let byteOffset = 0;
	if (options.cursor) {
		let cursor: unknown;
		try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid observation search cursor"); }
		const value = cursor as { scope?: string; item?: number; offset?: number } | null;
		if (!value || value.scope !== scope || !Number.isSafeInteger(value.item) || !Number.isSafeInteger(value.offset) ||
			value.item! < 0 || value.item! >= candidates.length || value.offset! < 0) throw new Error("Observation search cursor does not match this branch or query");
		itemIndex = value.item!; byteOffset = value.offset!;
	}
	const hits: Array<{ id: string; entry_id: string; tool: string; timestamp: string; offset: number; text: string }> = [];
	let scannedBytes = 0;
	let failedArchives = 0;
	for (; itemIndex < candidates.length; itemIndex++) {
		const candidate = candidates[itemIndex]!;
		try { await ensureStored(candidate.observation); } catch { failedArchives++; byteOffset = 0; continue; }
		const buffer = Buffer.from(candidate.observation.text);
		if (byteOffset > buffer.length) throw new Error("Observation cursor is outside the archived result");
		while (byteOffset < buffer.length && hits.length < limit && scannedBytes < SCAN_BYTES) {
			const newline = buffer.indexOf(10, byteOffset);
			let end = Math.min(newline < 0 ? buffer.length : newline + 1, byteOffset + Math.min(16_384, SCAN_BYTES - scannedBytes));
			while (end < buffer.length && end > byteOffset && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
			if (end === byteOffset) break;
			const part = buffer.subarray(byteOffset, end).toString("utf8");
			const lower = part.toLowerCase();
			if (needles.every((needle) => lower.includes(needle))) {
				const match = lower.indexOf(needles[0]!);
				hits.push({ id: candidate.observation.id, entry_id: candidate.entryId, tool: candidate.observation.toolName,
					timestamp: candidate.timestamp, offset: byteOffset + Buffer.byteLength(part.slice(0, match)), text: excerpt(part.slice(match).trimEnd(), 320) });
			}
			scannedBytes += end - byteOffset;
			byteOffset = end;
		}
		if (byteOffset < buffer.length) break;
		byteOffset = 0;
		if (hits.length >= limit || scannedBytes >= SCAN_BYTES) { itemIndex++; break; }
	}
	const next = itemIndex < candidates.length ? Buffer.from(JSON.stringify({ scope, item: itemIndex, offset: byteOffset })).toString("base64url") : null;
	return { schema: "sol-pi-observation-search/1", order: "newest observations first; byte order within each observation", hits,
		next_cursor: next, scanned_bytes: scannedBytes, archive_failures: failedArchives,
		complete: next === null && failedArchives === 0,
		limitations: "Literal case-insensitive terms must occur together in a bounded segment. Empty partial pages do not prove absence. Original bytes are available with obs_recall." };
}
