/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createOnlineContextCompactExtension, formatWindowFragment, HISTORY_TRUNCATION_MARKER,
	readHistoryEntry, restoreOnlineState, WINDOW_FRAGMENT_MAX_BYTES } from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

function completeText(entries: FakeSessionManager["entries"], id: string): string {
	let offset = 0;
	let text = "";
	for (;;) {
		const page = readHistoryEntry(entries, id, offset, 256)!;
		expect(page.text).not.toContain("\uFFFD");
		text += page.nextOffset === null ? page.text : page.text.slice(0, -(HISTORY_TRUNCATION_MARKER.length + 1));
		if (page.nextOffset === null) return text;
		expect(page.nextOffset).toBeGreaterThan(offset);
		offset = page.nextOffset;
	}
}

describe("recoverable window checkpoints", () => {
	it("paginates the entire UTF-8 text including large tool arguments", () => {
		const manager = new FakeSessionManager();
		const command = "尾部😀".repeat(8_000);
		const id = manager.appendMessage(fauxAssistantMessage({ type: "toolCall", id: "t", name: "bash", arguments: { command } }));
		expect(completeText(manager.entries, id)).toBe(`[tool bash] ${JSON.stringify({ command })}`);
		expect(() => readHistoryEntry(manager.entries, id, -1)).toThrow(/offset/u);
		expect(() => readHistoryEntry(manager.entries, id, 999_999)).toThrow(/offset/u);
		expect(() => readHistoryEntry(manager.entries, id, 0, 1)).toThrow(/limit/u);
	});

	it("prioritizes current work and newest evidence over completed history", () => {
		const fragment = formatWindowFragment({ windowNumber: 1, userReferences: [],
			plan: [ ...Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, goal: "old".repeat(200), status: "completed" as const })),
				{ id: "current", goal: "finish current work", status: "in_progress" },
				{ id: "next", goal: "run verification", status: "pending" } ],
			progress: Array.from({ length: 20 }, (_, i) => ({ stepId: `${i}`, goal: `goal-${i}`, filesChanged: [],
				verification: [`verified-${i}`], decisions: [], nextWork: [] })),
		});
		expect(Buffer.byteLength(fragment)).toBeLessThanOrEqual(WINDOW_FRAGMENT_MAX_BYTES);
		expect(fragment).toContain("checkpoint-w1");
		expect(fragment).toContain("[in_progress] current: finish current work");
		expect(fragment).toContain("[pending] next: run verification");
		expect(fragment).toContain("verified-19");
	});

	it("keeps full intermediate instructions and unpaid debt across two owned resets and reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-checkpoint-"));
		try {
			const manager = new FakeSessionManager([], "session-a", root);
			for (const content of ["start " + "x".repeat(3_000), "不要修改 vendor/；不要发布。", "continue"]) {
				manager.appendMessage({ role: "user", content, timestamp: Date.now() });
			}
			manager.appendMessage(fauxAssistantMessage("work " + "y".repeat(3_000)));
			const pi = new FakePi(manager);
			createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
			let context: ExtensionContext;
			let ordinal = 0;
			context = fakeContext(manager, { isIdle: () => true, getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
				compact(options = {}) {
					void (async () => {
						const result = await pi.emit("session_before_compact", { type: "session_before_compact", reason: "manual", preparation: {
							firstKeptEntryId: manager.entries[0]!.id, tokensBefore: 100_000,
						} }, context) as { compaction: Pick<CompactionEntry, "summary" | "firstKeptEntryId" | "tokensBefore" | "details"> };
						const compactionEntry: CompactionEntry = { ...result.compaction, type: "compaction", id: `c${++ordinal}`,
							parentId: manager.getLeafId(), timestamp: new Date().toISOString() };
						manager.entries.push(compactionEntry);
						await pi.emit("session_compact", { type: "session_compact", fromExtension: true, compactionEntry }, context);
						options.onComplete?.(result.compaction);
					})().catch((error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))));
				},
			});
			const execute = pi.tool("new_context").execute;
			for (let i = 1; i <= 2; i++) {
				await execute(`reset-${i}`, {}, undefined, undefined, context);
				await pi.emit("agent_settled", { type: "agent_settled" }, context);
				const checkpoint = JSON.parse(completeText(manager.entries, `checkpoint-w${i}`));
				expect(checkpoint.userReferences[1]).toMatchObject({ id: manager.entries[1]!.id, text: "不要修改 vendor/；不要发布。" });
				expect(restoreOnlineState(manager.entries).cacheDebtTokens).toBe(i * 100_000 * 11.5);
			}
			const reloaded = new FakePi(manager);
			createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(reloaded.asExtensionApi());
			await reloaded.emit("session_start", { type: "session_start" }, context);
			const prior = restoreOnlineState(manager.entries);
			await reloaded.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
			expect(restoreOnlineState(manager.entries).cacheDebtTokens).toBe(prior.cacheDebtTokens - prior.cacheDebtRepaymentTokens);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
