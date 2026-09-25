/* SPDX-License-Identifier: MIT */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createObservation, ensureStored, readRecallChunk } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { intentProjection, searchObservations } from "../src/sol-pi/extensions/observation-pack/retrieval.ts";
import { packingDecision } from "../src/sol-pi/extensions/observation-pack/policy.ts";

const root = await mkdtemp(join(tmpdir(), "sol-pi-evaluate-"));
const results = [];
try {
	for (const scenario of [
		{ name: "large structured response", body: JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ id: i, state: i === 3245 ? "TARGET_EVIDENCE" : "healthy" })), null, 2) },
		{ name: "long diagnostic output", body: `${"progress: checked unit\n".repeat(20_000)}TARGET_EVIDENCE: failure code E42\n` },
	]) {
		const start = performance.now();
		const manager = SessionManager.inMemory();
		const message = { role: "toolResult", toolName: "synthetic-output", toolCallId: scenario.name,
			content: [{ type: "text", text: scenario.body }], isError: false, timestamp: Date.now() };
		manager.appendMessage(message);
		const observation = createObservation(message, root);
		assert.ok(observation);
		await ensureStored(observation);
		const projected = intentProjection(observation, "TARGET_EVIDENCE");
		assert.ok(projected.includes("TARGET_EVIDENCE"));
		let recalled = ""; let offset = 0;
		for (;;) {
			const chunk = await readRecallChunk(observation.filePath, offset, { maxBytes: 16_000, maxLines: 400 });
			recalled += chunk.text; offset = chunk.nextOffset;
			if (chunk.eof) break;
		}
		assert.equal(recalled, scenario.body);
		const search = await searchObservations(manager.getBranch(), root, { query: "TARGET_EVIDENCE" });
		assert.ok(search.hits.some((hit) => hit.text.includes("TARGET_EVIDENCE")));
		const context = { getContextUsage: () => ({ tokens: 150_000, contextWindow: 1_000_000 }),
			getSystemPrompt: () => "", sessionManager: manager };
		const decision = packingDecision({ context, messages: [message], savedTokens: 1000,
			cacheWriteReadRatio: 12.5, stable: false, firstProjection: false });
		assert.equal(decision.pack, false);
		assert.equal(decision.reason, "horizon_unknown");
		results.push({ scenario: scenario.name, originalBytes: Buffer.byteLength(scenario.body),
			projectedBytes: Buffer.byteLength(projected), exactRecall: true, evidenceRetrieved: true,
			expensiveUnknownHorizonDeferred: true, elapsedMs: Math.round(performance.now() - start) });
	}
	process.stdout.write(`${JSON.stringify({ schema: "sol-pi-offline-evaluation/1", modelCalls: 0, results,
		limitations: "Synthetic local replay verifies preservation and retrieval only. Byte reduction is not a live task success rate, model token measurement, or net monetary savings." }, null, 2)}\n`);
} finally {
	// mkdtemp creates this exact isolated directory; never remove a supplied project path.
	await rm(root, { recursive: true, force: true });
}
