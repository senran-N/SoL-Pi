import type { ArchiveObject } from "./archive.ts";
import { MAX_EVIDENCE_ITEMS, MAX_QUOTE_CHARS, REDUCER_RECEIPT_SCHEMA } from "./config.ts";

/**
 * Deliberately narrow grammars. Every nonempty line must be understood; unknown
 * stack traces, source excerpts, warnings or formats keep the normal EPR path.
 * No inferred diagnosis and no failure line is dropped for a size budget.
 */
export function deterministicDiagnostics(body: string, archive: ArchiveObject, isError: boolean): string | undefined {
	const evidence = new Map<string, { kind: "failure" | "warning" | "summary"; quote: string }>();
	// Most tool failures are ordinary logs. Reject an unrecognised first line
	// before walking a potentially multi-megabyte stream; this keeps the
	// deterministic fast path cheap when the provider path is required.
	const firstLineEnd = body.search(/\r?\n/u);
	const firstLine = (firstLineEnd < 0 ? body : body.slice(0, firstLineEnd)).replace(/\r$/u, "");
	if (firstLine.trim() && !(
		/^.+(?:\(\d+,\d+\)|:\d+(?::\d+)?):\s*(?:fatal error|error|warning)(?:\s+(?:TS|CS)\d+)?\s*:/iu.test(firstLine) ||
		/^(?:Build succeeded\.|Build FAILED\.|\s*\d+ Warning\(s\)|\s*\d+ Error\(s\)|Found \d+ errors? in .+|Test Files\s+\d+ passed.*|Tests\s+\d+ passed.*|={2,}\s+\d+ passed(?:, \d+ skipped)? in .+={2,})$/u.test(firstLine) ||
		/^\[\d+\/\d+\] (?:Building|Compiling|Linking)\s/iu.test(firstLine) ||
		/^\s*Compiling \S+ v[\d.]+/u.test(firstLine)
	)) return undefined;
	let progress = 0;
	for (const line of body.split("\n")) {
		const normalized = line.replace(/\r$/u, "");
		if (!normalized.trim()) continue;
		const compiler = normalized.match(/^.+(?:\(\d+,\d+\)|:\d+(?::\d+)?):\s*(fatal error|error|warning)(?:\s+(?:TS|CS)\d+)?\s*:/iu);
		const summary = /^(?:Build succeeded\.|Build FAILED\.|\s*\d+ Warning\(s\)|\s*\d+ Error\(s\)|Found \d+ errors? in .+|Test Files\s+\d+ passed.*|Tests\s+\d+ passed.*|={2,}\s+\d+ passed(?:, \d+ skipped)? in .+={2,})$/u.test(normalized);
		if (compiler || summary) {
			if (normalized.length > MAX_QUOTE_CHARS) return undefined;
			const kind = compiler ? compiler[1]?.toLowerCase() === "warning" ? "warning" : "failure"
				: normalized === "Build FAILED." ? "failure" : "summary";
			evidence.set(normalized, { kind, quote: normalized });
			if (evidence.size > MAX_EVIDENCE_ITEMS) return undefined;
		} else if (/^\[\d+\/\d+\] (?:Building|Compiling|Linking)\s/iu.test(normalized)
			|| /^\s*Compiling \S+ v[\d.]+/u.test(normalized)) {
			progress++;
		} else {
			return undefined;
		}
	}
	if (evidence.size === 0 || (isError && ![...evidence.values()].some((item) => item.kind === "failure"))) return undefined;
	if (progress === 0 && evidence.size >= body.split("\n").filter((line) => line.trim()).length) return undefined;
	return JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash,
		status: isError ? "failure" : "success", uncertain: false, evidence: [...evidence.values()] });
}
