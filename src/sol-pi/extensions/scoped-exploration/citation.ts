/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Citation checking for a scoped exploration.
 *
 * Delegating a search is only worth it if the answer can be trusted without
 * redoing the search, and a fluent answer from a smaller model is exactly the
 * kind of thing that reads as trustworthy whether or not it is. So the answer
 * carries citations, and a citation survives only when the quoted text is found
 * at that path and that line right now. Anything else is dropped and reported as
 * dropped; an answer that claims a finding and has no surviving citation is not
 * returned at all.
 *
 * One citation is one line. A multi-line claim becomes several citations, which
 * keeps the check exact instead of approximate.
 */
import { MAX_CITATIONS, MAX_QUOTE_BYTES } from "./config.ts";
import { lineAt } from "./search.ts";

export type Citation = { readonly path: string; readonly line: number; readonly quote: string };
export type RejectedCitation = { readonly citation: Citation; readonly reason: string };
export type CitationCheck = {
	readonly verified: readonly Citation[];
	readonly rejected: readonly RejectedCitation[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCitations(value: unknown): readonly Citation[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_CITATIONS) return undefined;
	const citations: Citation[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const { path, line, quote } = item;
		if (typeof path !== "string" || path.length === 0) return undefined;
		if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return undefined;
		if (typeof quote !== "string" || quote.trim().length === 0) return undefined;
		if (Buffer.byteLength(quote, "utf8") > MAX_QUOTE_BYTES) return undefined;
		citations.push({ path, line, quote });
	}
	return citations;
}

export async function verifyCitations(root: string, citations: readonly Citation[]): Promise<CitationCheck> {
	const verified: Citation[] = [];
	const rejected: RejectedCitation[] = [];
	for (const citation of citations) {
		let actual: string | undefined;
		try {
			actual = await lineAt(root, citation.path, citation.line);
		} catch (error) {
			rejected.push({ citation, reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (actual === undefined) {
			rejected.push({ citation, reason: "no such line" });
			continue;
		}
		if (!actual.includes(citation.quote.trim())) {
			rejected.push({ citation, reason: "quote not found at that line" });
			continue;
		}
		verified.push(citation);
	}
	return { verified, rejected };
}
