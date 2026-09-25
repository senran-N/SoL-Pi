/* SPDX-License-Identifier: MIT */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Numeric metadata only. These counts describe local decisions, never billed savings. */
export async function optimizationReport(root: string) {
	const result = {
		observation: { decisions: 0, deferred: 0, projectedResults: 0, uniqueResults: 0, firstPassResults: 0,
			estimatedReplayTokensAvoided: 0, recallBytes: 0, searches: 0, searchBytes: 0 },
		compaction: { decisions: 0, deferred: 0, committed: 0, failed: 0, aborted: 0 },
		invalidRows: 0, unreadableLedgers: 0, truncated: false,
		limitations: [
			"Projection attempts are not proof of provider delivery, prompt-cache hits, or net savings.",
			"Avoided token counts are local estimates. Recall/search bytes and auxiliary calls can offset reductions.",
			"Compare complete workloads using reported cache-read/cache-write tokens, auxiliary usage, correctness, and elapsed time.",
			"The report scans at most 8 MiB across optimization ledgers and does not read archived source content.",
		],
	};
	let bytes = 0;
	const projected = new Set<string>(); const firstPass = new Set<string>(); const committed = new Set<string>();
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
	for (const relative of ["observation-pack/ledger.jsonl", "online-context-compact/windows.jsonl"]) {
		const stream = createReadStream(join(root, relative), { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				bytes += Buffer.byteLength(line) + 1;
				if (bytes > 8 * 1024 * 1024) { result.truncated = true; break; }
				if (!line.trim()) continue;
				let row: Record<string, unknown>;
				try { row = JSON.parse(line); if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(); }
				catch { result.invalidRows++; continue; }
				if (relative.startsWith("observation")) {
					if (row.event === "decision") { result.observation.decisions++; if (row.pack === false) result.observation.deferred++; }
					if (row.event === "placeholder") {
						result.observation.projectedResults++;
						result.observation.estimatedReplayTokensAvoided += number(row.removedTokens);
						if (typeof row.id === "string") { projected.add(row.id); if (row.firstPass === true) firstPass.add(row.id); }
					}
					if (row.event === "recall") result.observation.recallBytes += number(row.bytes);
					if (row.event === "search") { result.observation.searches++; result.observation.searchBytes += number(row.scannedBytes); }
				} else {
					if (row.stage === "decision") result.compaction.decisions++;
					if (row.outcome === "deferred") result.compaction.deferred++;
					if (row.outcome === "failed") result.compaction.failed++;
					if (row.outcome === "aborted") result.compaction.aborted++;
					if (row.stage === "commit" && typeof row.transitionId === "string") committed.add(row.transitionId);
				}
			}
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) result.unreadableLedgers++;
		} finally { lines.close(); stream.destroy(); }
		if (result.truncated) break;
	}
	result.observation.uniqueResults = projected.size; result.observation.firstPassResults = firstPass.size;
	result.compaction.committed = committed.size;
	return result;
}
