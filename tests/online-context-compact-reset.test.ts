/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, type CompactOptions, type ContextUsage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createOnlineContextCompactExtension,
	windowLedgerPath,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { restoreOnlineState } from "../src/sol-pi/extensions/online-context-compact/state.ts";
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

	it("selects the larger local estimate with one usage read", async () => {
		const manager = new FakeSessionManager();
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension()(pi.asExtensionApi());
		const messages = buildSessionMessages();
		const expectedTokens = messages.reduce((total, message) => total + estimateTokens(message), 0) + 100;
		const getContextUsage = vi.fn(() => ({ tokens: 100, contextWindow: 2_000, percent: 5 }));
		const context = fakeContext(manager, { getContextUsage, getSystemPrompt: () => "s".repeat(400) });
		await pi.emitContext(messages, context);

		const result = await (pi.tool("get_context_remaining").execute as Execute)("budget", {}, undefined, undefined, context);
		expect(result.details).toMatchObject({
			tokens: expectedTokens,
			remaining_tokens: 2_000 - expectedTokens,
			percent: expectedTokens / 2_000 * 100,
			token_source: "local_estimate",
		});
		expect(getContextUsage).toHaveBeenCalledOnce();
	});

	it.each([
		{ headroom: 16_385, protectsWindow: false },
		{ headroom: 16_384, protectsWindow: true },
	])("keeps reporting, accounting and the window gate consistent at $headroom tokens of headroom", async ({ headroom, protectsWindow }) => {
		const manager = new FakeSessionManager();
		const messages: AgentMessage[] = [
			{ role: "user", content: "x".repeat(24_000), timestamp: Date.now() },
			assistant("y".repeat(24_000)),
		];
		for (const message of messages) manager.appendMessage(message);
		const pi = new FakePi(manager);
		// No cache ratio: only window protection can open the gate here.
		createOnlineContextCompactExtension({ keepRecentTokens: 1 })(pi.asExtensionApi());
		const expectedTokens = messages.reduce((total, message) => total + estimateTokens(message), 0) + 100;
		const window = expectedTokens + headroom;
		const getContextUsage = vi.fn(() => ({ tokens: 100, contextWindow: window, percent: 0 }));
		const abort = vi.fn();
		const context = fakeContext(manager, { getContextUsage, abort, getSystemPrompt: () => "s".repeat(400) });
		await pi.emitContext(messages, context);

		const budget = await (pi.tool("get_context_remaining").execute as Execute)("budget", {}, undefined, undefined, context);
		expect(budget.details).toMatchObject({ tokens: expectedTokens, remaining_tokens: headroom, token_source: "local_estimate" });
		expect(getContextUsage).toHaveBeenCalledTimes(1);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		expect(restoreOnlineState(manager.entries).lastContextTokens).toBe(expectedTokens);
		expect(getContextUsage).toHaveBeenCalledTimes(2);

		const plan = pi.tool("update_plan").execute as Execute;
		await plan("open", { steps: OPEN }, undefined, undefined, context);
		await plan("done", { steps: DONE, progress: PROGRESS }, undefined, undefined, context);
		await pi.emit("turn_end", {
			type: "turn_end", turnIndex: 1, message: assistant("boundary"),
			toolResults: [{ role: "toolResult", toolCallId: "done", toolName: "update_plan", content: [], isError: false, timestamp: Date.now() }],
		}, context);
		expect(getContextUsage).toHaveBeenCalledTimes(3);
		expect(abort).toHaveBeenCalledTimes(protectsWindow ? 1 : 0);
	});

	it.each([undefined, { tokens: null, contextWindow: 0, percent: null }])(
		"falls back to the model window when Pi has no usable window: %j",
		async (usage) => {
			const pi = new FakePi();
			createOnlineContextCompactExtension()(pi.asExtensionApi());
			const context = fakeContext(pi.sessionManager, {
				getContextUsage: () => usage,
				getSystemPrompt: () => "s".repeat(400),
				model: { contextWindow: 8_000 } as ExtensionContext["model"],
			});
			const result = await (pi.tool("get_context_remaining").execute as Execute)("budget", {}, undefined, undefined, context);
			expect(result.details).toMatchObject({ tokens: 100, context_window: 8_000, remaining_tokens: 7_900, percent: 1.25 });
		},
	);

	it("recomputes the percentage when usage is unknown just after compaction", async () => {
		const pi = new FakePi();
		createOnlineContextCompactExtension()(pi.asExtensionApi());
		const context = fakeContext(pi.sessionManager, {
			getContextUsage: () => ({ tokens: null, contextWindow: 2_000, percent: null }),
			getSystemPrompt: () => "s".repeat(400),
		});
		const result = await (pi.tool("get_context_remaining").execute as Execute)("budget", {}, undefined, undefined, context);
		expect(result.details).toMatchObject({ tokens: 100, remaining_tokens: 1_900, percent: 5, token_source: "local_estimate" });
	});

	it("does not report negative remaining tokens for an overfull window", async () => {
		const pi = new FakePi();
		createOnlineContextCompactExtension()(pi.asExtensionApi());
		const context = fakeContext(pi.sessionManager, {
			getContextUsage: () => ({ tokens: 2_500, contextWindow: 2_000, percent: Number.NaN }),
		});
		const result = await (pi.tool("get_context_remaining").execute as Execute)("budget", {}, undefined, undefined, context);
		expect(result.details).toMatchObject({ tokens: 2_500, remaining_tokens: 0, percent: 125, token_source: "pi_usage" });
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
			isIdle: () => true,
			getSystemPrompt: () => "test prompt",
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
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
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
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
	});

	it("declines instead of scheduling a compaction Pi cannot perform", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-newcontext-empty-"));
		const manager = new FakeSessionManager([], "session-a", root);
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());

		const compact = vi.fn();
		const context = fakeContext(manager, {
			compact,
			isIdle: () => true,
			getSystemPrompt: () => "test prompt",
		});

		await pi.emit("session_start", { type: "session_start" }, context);
		const newContext = pi.tool("new_context").execute as Execute;
		const declined = await newContext("call-1", {}, undefined, undefined, context);

		expect(declined.details).toMatchObject({
			op: "new_context",
			requested: false,
			reason: "native_not_compactable",
		});
		expect(declined.content[0]?.text).toContain("Not enough recorded history");

		// The request was never recorded, so settlement stays quiet.
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		expect(compact).not.toHaveBeenCalled();
	});

	it("numbers windows by compaction, so a correction in between does not skip one", async () => {
		// A correction starts a new epoch without producing a checkpoint. If window
		// numbers followed the epoch, the second window would call itself w3 and
		// point at a w2 that never existed.
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-window-numbering-"));
		const manager = new FakeSessionManager([], "session-a", root);
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());

		let compactions = 0;
		const fragments: string[] = [];
		let context: ExtensionContext;
		const compact = (options: CompactOptions = {}): void => {
			compactions += 1;
			const id = compactions;
			void (async () => {
				const before = (await pi.emit(
					"session_before_compact",
					{
						type: "session_before_compact",
						reason: "manual",
						willRetry: false,
						preparation: { firstKeptEntryId: `kept-${id}`, tokensBefore: 195_000 },
					},
					context,
				)) as { compaction?: { summary: string } } | undefined;
				if (before?.compaction) fragments.push(before.compaction.summary);
				await pi.emit(
					"session_compact",
					{
						type: "session_compact",
						fromExtension: true,
						reason: "manual",
						willRetry: false,
						compactionEntry: {
							type: "compaction",
							id: `compact-${id}`,
							parentId: manager.getLeafId(),
							timestamp: new Date().toISOString(),
							summary: "handoff",
							firstKeptEntryId: `kept-${id}`,
							tokensBefore: 195_000,
						},
					},
					context,
				);
				options.onComplete?.({ summary: "handoff", firstKeptEntryId: `kept-${id}`, tokensBefore: 195_000 });
			})();
		};
		context = fakeContext(manager, {
			abort: vi.fn(),
			compact,
			isIdle: () => true,
			getSystemPrompt: () => "test prompt",
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});

		const runPlan = pi.tool("update_plan").execute as Execute;
		const newContext = pi.tool("new_context").execute as Execute;
		const openWindow = async (round: number): Promise<void> => {
			await runPlan(`plan-open-${round}`, { steps: OPEN }, undefined, undefined, context);
			await runPlan(`plan-done-${round}`, { steps: DONE, progress: PROGRESS }, undefined, undefined, context);
			await newContext(`reset-${round}`, {}, undefined, undefined, context);
			await pi.emit("agent_settled", { type: "agent_settled" }, context);
			await vi.waitFor(() => expect(fragments).toHaveLength(round));
		};

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);

		await openWindow(1);
		// A steered correction between the two windows bumps the epoch only.
		await pi.emit(
			"input",
			{ type: "input", text: "CORRECTION: take the other approach", streamingBehavior: "steer" },
			context,
		);
		await openWindow(2);

		expect(fragments[0]?.startsWith('<sol-pi-window id="w1" number="1" first="w0" previous="w0">')).toBe(true);
		expect(fragments[1]?.startsWith('<sol-pi-window id="w2" number="2" first="w0" previous="w1">')).toBe(true);

		const ledger = readFileSync(windowLedgerPath(sessionRoot(root)), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(ledger.map((record) => record.windowId)).toEqual(["w1", "w2"]);
		expect(ledger.map((record) => record.previousWindowId)).toEqual(["w0", "w1"]);
	});
});
