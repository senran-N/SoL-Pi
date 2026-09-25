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
	MAX_ANSWER_BYTES,
	MAX_CITATIONS,
	OBSERVATION_MAX_BYTES,
} from "./config.ts";
import type { Citation } from "./citation.ts";
import { parseCitations } from "./citation.ts";

export type ExplorationStatus = "found" | "not_found_in_scope" | "incomplete";
export type ExplorationClaim = { readonly text: string; readonly citations: readonly Citation[] };

export type ExplorerAction =
	| { readonly kind: "grep"; readonly pattern: string; readonly path: string | undefined }
	| { readonly kind: "read"; readonly path: string; readonly offset: number | undefined; readonly limit: number | undefined }
	| { readonly kind: "list"; readonly path: string | undefined }
	| {
		readonly kind: "answer";
		readonly found: boolean;
		readonly status: ExplorationStatus;
		readonly answer: string;
		readonly citations: readonly Citation[];
		readonly claims: readonly ExplorationClaim[];
	};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 1_000 && !/[\u0000-\u001f]/u.test(value) ? value : null;
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
			if (typeof value.pattern !== "string" || value.pattern.trim().length === 0 || Buffer.byteLength(value.pattern, "utf8") > 512 || /[\u0000-\u001f]/u.test(value.pattern) || path === null) return undefined;
			return { kind: "grep", pattern: value.pattern, path };
		}
		case "read": {
			const offset = optionalInteger(value.offset);
			const limit = optionalInteger(value.limit);
			if (!optionalString(value.path) || offset === null || limit === null) {
				return undefined;
			}
			return { kind: "read", path: value.path as string, offset, limit };
		}
		case "list": {
			const path = optionalString(value.path);
			if (path === null) return undefined;
			return { kind: "list", path };
		}
		case "answer": {
			const status = value.status ?? (value.found === true ? "found" : value.found === false ? "not_found_in_scope" : undefined);
			if (status !== "found" && status !== "not_found_in_scope" && status !== "incomplete") return undefined;
			if (value.found !== undefined && value.found !== (status === "found")) return undefined;
			let claims: ExplorationClaim[];
			if (value.claims !== undefined) {
				if (!Array.isArray(value.claims) || value.claims.length === 0 || value.claims.length > MAX_CITATIONS) return undefined;
				claims = [];
				for (const claim of value.claims) {
					if (!isRecord(claim) || typeof claim.text !== "string" || !claim.text.trim()) return undefined;
					const citations = parseCitations(claim.citations);
					if (!citations || (status === "found" && citations.length === 0)) return undefined;
					claims.push({ text: claim.text.trim(), citations });
				}
			} else {
				// Legacy answer/citations is one indivisible claim: a rejected quote
				// requires revising the entire answer, never just dropping that quote.
				const citations = parseCitations(value.citations);
				if (typeof value.answer !== "string" || !value.answer.trim() || !citations) return undefined;
				claims = [{ text: value.answer.trim(), citations }];
			}
			const answer = claims.map((claim) => claim.text).join("\n");
			const citations = claims.flatMap((claim) => claim.citations);
			if (citations.length > MAX_CITATIONS || Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES) return undefined;
			return { kind: "answer", found: status === "found", status, answer, citations, claims };
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
		'{"action":"answer","status":"found","claims":[{"text":"one finding","citations":[{"path":"src/file.ts","line":42,"quote":"exact text on that line"}]}]}',
		'{"action":"answer","status":"not_found_in_scope","answer":"No matching result in the inspected files for these literal queries.","citations":[]}',
		'{"action":"answer","status":"incomplete","answer":"More inspection is needed because ...","citations":[]}',
		"",
		"Rules:",
		`- You have at most ${maxSteps} steps. Spend them; do not guess early.`,
		`- Excluded path patterns: ${excludedPaths.length > 0 ? excludedPaths.join(", ") : "none"}. Do not try to bypass an exclusion.`,
		"- grep matches a literal, case-insensitive substring. It is not a regular expression.",
		"- Associate every finding with its own citations. Every citation must verify against the file at delivery time; one invalid citation rejects the entire answer and requires revision.",
		"- Source verification confirms that quoted bytes occur on the cited line, not that they logically prove the claim. Explain uncertainty; do not overstate what the lines establish.",
		"- Never invent a path, a line number, or a quote. If you did not read it, do not cite it.",
		"- Never infer project-wide absence. not_found_in_scope requires actual successful content inspection; report literal queries and paths. A truncated or failed inspection requires incomplete, unless you have a positive cited finding.",
		"- scope metadata always reports truncation and bounds. No hits in a truncated scan does not establish absence. Listing names alone does not inspect file contents.",
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

export type FormattedObservation = { readonly text: string; readonly truncated: boolean };

/** Keep scope metadata ahead of the bounded body, including zero-hit scans. */
function bounded(scope: Readonly<Record<string, unknown>> & { readonly truncated: boolean }, body: string): FormattedObservation {
	const prefix = (outputTruncated: boolean): string => `scope=${JSON.stringify({ ...scope, truncated: scope.truncated || outputTruncated, output_truncated: outputTruncated })}\n`;
	const full = prefix(false) + body;
	if (Buffer.byteLength(full, "utf8") <= OBSERVATION_MAX_BYTES) return { text: full, truncated: scope.truncated };
	const header = prefix(true);
	const marker = "\n[observation truncated; narrow the requested scope]";
	const buffer = Buffer.from(body, "utf8");
	let end = Math.max(0, OBSERVATION_MAX_BYTES - Buffer.byteLength(header + marker, "utf8"));
	while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
	return { text: `${header}${buffer.subarray(0, end).toString("utf8")}${marker}`, truncated: true };
}

export function formatGrepObservation(input: {
	readonly pattern: string;
	readonly path: string;
	readonly scanned: number;
	readonly skipped: number;
	readonly hits: readonly { path: string; line: number; text: string }[];
	readonly truncated: boolean;
}): FormattedObservation {
	const lines = input.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`);
	return bounded({ kind: "grep", path: input.path, pattern: input.pattern, scanned_files: input.scanned, skipped_files: input.skipped, hits: input.hits.length, truncated: input.truncated },
		input.hits.length === 0 ? "No matching line in the inspected scope. This does not establish project-wide absence." : `${input.hits.length} hits:\n${lines.join("\n")}`);
}

export function formatReadObservation(input: {
	readonly path: string;
	readonly firstLine: number;
	readonly lines: readonly string[];
	readonly eof: boolean;
	readonly truncated: boolean;
}): FormattedObservation {
	const numbered = input.lines.map((line, index) => `${input.firstLine + index}: ${line}`);
	return bounded({ kind: "read", path: input.path, first_line: input.firstLine, last_line: input.firstLine + input.lines.length - 1, eof: input.eof, truncated: input.truncated || !input.eof || input.firstLine > 1 }, numbered.join("\n"));
}

export function formatListObservation(input: {
	readonly path: string;
	readonly entries: readonly string[];
	readonly truncated: boolean;
}): FormattedObservation {
	return bounded({ kind: "list", path: input.path, entries: input.entries.length, truncated: input.truncated }, input.entries.join("\n"));
}

export function stepsRemainingNotice(remaining: number): string {
	return remaining <= 1
		? "This is your last step. Reply with the answer action now, citing only what you actually read."
		: `${remaining} steps remain.`;
}
