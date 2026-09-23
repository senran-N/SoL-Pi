/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The action protocol spoken inside a scoped exploration.
 *
 * The explorer does not get Pi's tools, so there is no tool-call channel to use.
 * It emits one JSON object per step and SoL-Pi executes it. Keeping the protocol
 * this small is what makes the exploration auditable: every step is one line in
 * the transcript, and every action it could have taken is read-only by
 * construction rather than by permission.
 */
import {
	GREP_MAX_HITS,
	MAX_ANSWER_BYTES,
	MAX_CITATIONS,
	OBSERVATION_MAX_BYTES,
	READ_MAX_LINES,
} from "./config.ts";
import type { Citation } from "./citation.ts";
import { parseCitations } from "./citation.ts";

export type ExplorerAction =
	| { readonly kind: "grep"; readonly pattern: string; readonly path: string | undefined }
	| { readonly kind: "read"; readonly path: string; readonly offset: number | undefined; readonly limit: number | undefined }
	| { readonly kind: "list"; readonly path: string | undefined }
	| { readonly kind: "answer"; readonly found: boolean; readonly answer: string; readonly citations: readonly Citation[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalInteger(value: unknown): number | undefined | null {
	if (value === undefined || value === null) return undefined;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Strip a fenced block, which models add even when asked not to. */
function jsonPayload(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/u);
	const body = fenced?.[1] ?? trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export function parseAction(text: string): ExplorerAction | undefined {
	let value: unknown;
	try {
		value = JSON.parse(jsonPayload(text));
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	switch (value.action) {
		case "grep": {
			const path = optionalString(value.path);
			if (typeof value.pattern !== "string" || value.pattern.trim().length === 0 || path === null) return undefined;
			return { kind: "grep", pattern: value.pattern, path };
		}
		case "read": {
			const offset = optionalInteger(value.offset);
			const limit = optionalInteger(value.limit);
			if (typeof value.path !== "string" || value.path.length === 0 || offset === null || limit === null) {
				return undefined;
			}
			return { kind: "read", path: value.path, offset, limit };
		}
		case "list": {
			const path = optionalString(value.path);
			if (path === null) return undefined;
			return { kind: "list", path };
		}
		case "answer": {
			const citations = parseCitations(value.citations);
			if (typeof value.answer !== "string" || value.answer.trim().length === 0 || !citations) return undefined;
			if (typeof value.found !== "boolean") return undefined;
			return { kind: "answer", found: value.found, answer: value.answer.trim(), citations };
		}
		default:
			return undefined;
	}
}

export function explorerInstructions(maxSteps: number, excludedPaths: readonly string[] = []): string {
	return [
		"You are a scoped explorer working inside one project checkout. You answer one question by reading the project, and nothing else.",
		"",
		"Reply with exactly one JSON object per turn, no prose around it. The available actions are:",
		'{"action":"grep","pattern":"literal text","path":"optional/dir/or/file"}',
		'{"action":"read","path":"src/file.ts","offset":1,"limit":120}',
		'{"action":"list","path":"optional/dir"}',
		'{"action":"answer","found":true,"answer":"...","citations":[{"path":"src/file.ts","line":42,"quote":"exact text on that line"}]}',
		"",
		"Rules:",
		`- You have at most ${maxSteps} steps. Spend them; do not guess early.`,
		`- Excluded path patterns: ${excludedPaths.length > 0 ? excludedPaths.join(", ") : "none"}. Do not try to bypass an exclusion.`,
		"- grep matches a literal, case-insensitive substring. It is not a regular expression.",
		"- Every citation is checked against the file before the answer is delivered. A quote that is not found on that exact line is discarded.",
		"- Never invent a path, a line number, or a quote. If you did not read it, do not cite it.",
		'- If the project does not contain what was asked for, answer with "found": false and say what you searched.',
		`- The answer is for another agent that will not repeat your search. Keep it under ${MAX_ANSWER_BYTES} bytes, state the conclusion first, and cite at most ${MAX_CITATIONS} lines.`,
	].join("\n");
}

export function explorerTask(question: string): string {
	return [
		"Question:",
		question,
		"",
		"Reply with your first action as a single JSON object.",
	].join("\n");
}

function bounded(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= OBSERVATION_MAX_BYTES) return text;
	const buffer = Buffer.from(text, "utf8");
	let end = OBSERVATION_MAX_BYTES;
	while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
	return `${buffer.subarray(0, end).toString("utf8")}\n[observation truncated]`;
}

export function formatGrepObservation(input: {
	readonly pattern: string;
	readonly hits: readonly { path: string; line: number; text: string }[];
	readonly truncated: boolean;
}): string {
	if (input.hits.length === 0) return bounded(`No line contains ${JSON.stringify(input.pattern)}.`);
	const lines = input.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`);
	const note = input.truncated ? `\n[stopped at ${GREP_MAX_HITS} hits or the scan limit; narrow the path]` : "";
	return bounded(`${input.hits.length} hits:\n${lines.join("\n")}${note}`);
}

export function formatReadObservation(input: {
	readonly path: string;
	readonly firstLine: number;
	readonly lines: readonly string[];
	readonly eof: boolean;
}): string {
	const numbered = input.lines.map((line, index) => `${input.firstLine + index}: ${line}`);
	const note = input.eof ? "" : `\n[more lines follow; read again with a larger offset, up to ${READ_MAX_LINES} lines per step]`;
	return bounded(`${input.path}\n${numbered.join("\n")}${note}`);
}

export function formatListObservation(input: {
	readonly path: string;
	readonly entries: readonly string[];
	readonly truncated: boolean;
}): string {
	const note = input.truncated ? "\n[listing truncated]" : "";
	return bounded(`${input.path}\n${input.entries.join("\n")}${note}`);
}

export function stepsRemainingNotice(remaining: number): string {
	return remaining <= 1
		? "This is your last step. Reply with the answer action now, citing only what you actually read."
		: `${remaining} steps remain.`;
}
