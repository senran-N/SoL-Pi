/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactOptions, ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createOnlineContextCompactExtension,
	windowLedgerPath,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const;
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const;
const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["npm run check"],
	decisions: ["kept the implementation small"],
};

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function buildSessionMessages(): AgentMessage[] {
	return [
		{ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() },
		assistant(`work ${"y".repeat(2_000)}`),
	];
}

type Execute = (
	toolCallId: string,
	params: unknown,
	signal: undefined,
	onUpdate: undefined,
	context: ExtensionContext,
) => Promise<{ content: { type: string; text: string }[]; details: Readonly<Record<string, unknown>> }>;

function sessionRoot(root: string): string {
	return join(root, "sol-pi", "session-a");
}

describe("get_context_remaining", () => {
	it("reports the remaining context budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-remaining-"));
		const manager = new FakeSessionManager([], "session-a", root);
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		const context = fakeContext(manager, {
			getContextUsage: (): ContextUsage => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});

		const remaining = pi.tool("get_context_remaining").execute as Execute;
		const result = await remaining("call-1", {}, undefined, undefined, context);
		expect(result.content[0]?.text).toContain("195000 of 200000 tokens used");
		expect(result.content[0]?.text).toContain("5000 tokens remaining");
		expect(result.content[0]?.text).toContain("new_context");
		expect(result.details).toMatchObject({
			op: "get_context_remaining",
			tokens: 195_000,
			context_window: 200_000,
			remaining_tokens: 5_000,
			percent: 97.5,
		});
	});

	it("still answers when Pi does not report a context window", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-remaining-unknown-"));
		const manager = new FakeSessionManager([], "session-a", root);
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		const context = fakeContext(manager, { getContextUsage: () => undefined });

		const remaining = pi.tool("get_context_remaining").execute as Execute;
		const result = await remaining("call-1", {}, undefined, undefined, context);
		expect(result.content[0]?.text).toContain("the context window size is unknown");
		expect(result.details).toMatchObject({ context_window: null, remaining_tokens: null });
	});
});

describe("new_context", () => {
	it("resets the window at the next settlement even without priced savings", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-newcontext-"));
		const manager = new FakeSessionManager([], "session-a", root);
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());

		let idle = true;
		const abort = vi.fn();
		let beforeCompact: unknown;
		let compactCalls = 0;
		let context: ExtensionContext;
		const compact = (options: CompactOptions = {}): void => {
			compactCalls += 1;
			void (async () => {
				beforeCompact = await pi.emit(
					"session_before_compact",
					{
						type: "session_before_compact",
						reason: "manual",
						willRetry: false,
						preparation: { firstKeptEntryId: "kept-1", tokensBefore: 195_000 },
					},
					context,
				);
				await pi.emit(
					"session_compact",
					{
						type: "session_compact",
						fromExtension: true,
						reason: "manual",
						willRetry: false,
						compactionEntry: {
							type: "compaction",
							id: "compact-1",
							parentId: manager.getLeafId(),
							timestamp: new Date().toISOString(),
							summary: "handoff",
							firstKeptEntryId: "kept-1",
							tokensBefore: 195_000,
						},
					},
					context,
				);
				options.onComplete?.({
					summary: "handoff",
					firstKeptEntryId: "kept-1",
					tokensBefore: 195_000,
				});
			})();
		};
		context = fakeContext(manager, {
			abort,
			compact,
			isIdle: () => idle,
			getSystemPrompt: () => "test prompt",
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});
		const sendMessage = pi.sendMessage.bind(pi);
		vi.spyOn(pi, "sendMessage").mockImplementation((message, options) => {
			idle = false;
			sendMessage(message, options);
		});

		const runPlan = pi.tool("update_plan").execute as Execute;
		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan("plan-open", { steps: OPEN }, undefined, undefined, context);
		await runPlan("plan-done", { steps: DONE, progress: PROGRESS }, undefined, undefined, context);

		const newContext = pi.tool("new_context").execute as Execute;
		const requested = await newContext("call-1", {}, undefined, undefined, context);
		expect(requested.details).toMatchObject({ op: "new_context", requested: true });

		// No turn_end, so the economic gate has no decision: only the explicit
		// request can drive a compaction here.
		const settled = pi.emit("agent_settled", { type: "agent_settled" }, context);
		await vi.waitFor(() => expect(beforeCompact).toBeDefined());
		expect(compactCalls).toBe(1);

		const result = beforeCompact as { compaction?: { summary: string; details?: unknown } };
		expect(result.compaction?.summary.startsWith('<sol-pi-window id="w1" number="1" first="w0" previous="w0">')).toBe(true);
		expect(result.compaction?.summary).toContain("- [completed] build: build it");
		expect(result.compaction?.details).toMatchObject({
			solPiWindow: { version: 1, mode: "reset", windowNumber: 1, windowId: "w1", previousWindowId: "w0" },
		});

		const ledger = readFileSync(windowLedgerPath(sessionRoot(root)), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({ event: "reset", reason: "manual", windowNumber: 1, windowId: "w1" });
		expect(ledger[0]?.fragmentBytes).toBeGreaterThan(0);

		idle = true;
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		await settled;
	});
});
