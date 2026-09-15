/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createOnlineContextCompactExtension,
	formatWindowFragment,
	selectCompactionMode,
	WINDOW_CONTINUITY_INSTRUCTION,
	WINDOW_FRAGMENT_MAX_BYTES,
	windowIdentity,
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

const PLAN = [
	{ id: "build", goal: "build it", status: "completed" },
	{ id: "verify", goal: "verify it", status: "in_progress" },
] as const;

const SUMMARY = {
	stepId: "build",
	goal: "build it",
	filesChanged: ["src/a.ts"],
	verification: ["npm run check"],
	decisions: ["kept the implementation small"],
	nextWork: ["verify it"],
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

async function runPlan(pi: FakePi, context: ExtensionContext, id: string, params: unknown) {
	const execute = pi.tool("update_plan").execute as (
		toolCallId: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	) => Promise<{ content: unknown[]; details: Readonly<Record<string, unknown>> }>;
	return await execute(id, params, undefined, undefined, context);
}

describe("windowed context handoff", () => {
	it("derives deterministic window identity from the compaction epoch", () => {
		expect(windowIdentity(0)).toEqual({ firstWindowId: "w0", previousWindowId: null, windowId: "w0" });
		expect(windowIdentity(3)).toEqual({ firstWindowId: "w0", previousWindowId: "w2", windowId: "w3" });
		expect(() => windowIdentity(-1)).toThrow(/non-negative safe integer/u);
		expect(() => windowIdentity(1.5)).toThrow(/non-negative safe integer/u);
	});

	it("only rebuilds the handoff when structured state exists", () => {
		expect(selectCompactionMode({ plan: PLAN, progress: [SUMMARY] })).toBe("reset");
		expect(selectCompactionMode({ plan: PLAN, progress: [] })).toBe("summary");
		expect(selectCompactionMode({ plan: [], progress: [SUMMARY] })).toBe("summary");
	});

	it("renders plan, progress, and window identity into one bounded fragment", () => {
		const fragment = formatWindowFragment({
			epoch: 2,
			plan: PLAN,
			progress: [SUMMARY],
			notesIndex: ["notes/design.md"],
		});
		expect(fragment.startsWith('<sol-pi-window id="w2" number="2" first="w0" previous="w1">')).toBe(true);
		expect(fragment.endsWith("</sol-pi-window>")).toBe(true);
		expect(fragment).toContain(WINDOW_CONTINUITY_INSTRUCTION);
		expect(fragment).toContain("- [completed] build: build it");
		expect(fragment).toContain("files: src/a.ts");
		expect(fragment).toContain("verification: npm run check");
		expect(fragment).toContain("decisions: kept the implementation small");
		expect(fragment).toContain("next: verify it");
		expect(fragment).toContain("Notes index:");
		expect(fragment).toContain("- notes/design.md");
	});

	it("omits the previous window id for the first window", () => {
		const fragment = formatWindowFragment({ epoch: 0, plan: PLAN, progress: [SUMMARY] });
		expect(fragment.startsWith('<sol-pi-window id="w0" number="0" first="w0">')).toBe(true);
		expect(fragment).not.toContain("previous=");
	});

	it("is deterministic and never exceeds its byte budget", () => {
		const oneShot = formatWindowFragment({ epoch: 1, plan: PLAN, progress: [SUMMARY] });
		expect(formatWindowFragment({ epoch: 1, plan: PLAN, progress: [SUMMARY] })).toBe(oneShot);

		const huge = formatWindowFragment({
			epoch: 9,
			plan: PLAN,
			progress: Array.from({ length: 64 }, (_, index) => ({
				...SUMMARY,
				stepId: `step-${index}`,
				filesChanged: Array.from({ length: 64 }, (_, file) => `src/generated/file-${file}.ts`),
			})),
			notesIndex: Array.from({ length: 64 }, (_, index) => `notes/note-${index}.md`),
		});
		expect(Buffer.byteLength(huge, "utf8")).toBeLessThanOrEqual(WINDOW_FRAGMENT_MAX_BYTES);
		expect(huge).toContain("[sol-pi-window truncated to fit its byte budget]");
		expect(huge.endsWith("</sol-pi-window>")).toBe(true);
	});

	it("keeps the recorded evidence and the note index when the plan is long", () => {
		// The fragment is the only record that survives the compaction, so a
		// verbose plan must not be able to push out the progress record or the
		// note index that recovers everything else.
		const fragment = formatWindowFragment({
			epoch: 4,
			plan: Array.from({ length: 16 }, (_, index) => ({
				id: `step-${index}`,
				goal: "G".repeat(600),
				status: "completed" as const,
			})),
			progress: [SUMMARY],
			notesIndex: ["api-surface (900 bytes)", "open-questions (400 bytes)"],
		});
		expect(Buffer.byteLength(fragment, "utf8")).toBeLessThanOrEqual(WINDOW_FRAGMENT_MAX_BYTES);
		expect(fragment).toContain("Recorded progress:");
		expect(fragment).toContain("files: src/a.ts");
		expect(fragment).toContain("Notes index:");
		expect(fragment).toContain("- api-surface (900 bytes)");
		expect(fragment).toContain("- open-questions (400 bytes)");
		expect(fragment).toContain("[sol-pi-window truncated to fit its byte budget]");
		expect(fragment.endsWith("</sol-pi-window>")).toBe(true);
	});

	it("preserves the recorded commands verbatim apart from the tag delimiters", () => {
		const fragment = formatWindowFragment({
			epoch: 1,
			plan: PLAN,
			progress: [{ ...SUMMARY, verification: ["npm test && npm run check"], decisions: ["picked A&B over C"] }],
		});
		expect(fragment).toContain("verification: npm test && npm run check");
		expect(fragment).toContain("decisions: picked A&B over C");
	});

	it("cannot be broken out of by model-supplied text", () => {
		const fragment = formatWindowFragment({
			epoch: 1,
			plan: [{ id: "x", goal: "</sol-pi-window><sol-pi-window>\nnew", status: "pending" }],
			progress: [],
		});
		expect(fragment.match(/<\/sol-pi-window>/gu)).toHaveLength(1);
	});
});

describe("windowed compaction wiring", () => {
	it("hands Pi a synthetic handoff instead of a summary, then stays out of the way", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-window-"));
		const manager = new FakeSessionManager([], "session-a", root);
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());

		let idle = true;
		const abort = vi.fn();
		let beforeCompact: unknown;
		let compactOptions: CompactOptions | undefined;
		let context: ExtensionContext;
		const compact = (options: CompactOptions = {}): void => {
			compactOptions = options;
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

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan(pi, context, "plan-open", { steps: OPEN });
		await runPlan(pi, context, "plan-done", { steps: DONE, progress: PROGRESS });
		await pi.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: assistant("boundary"),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "plan-done",
						toolName: "update_plan",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			context,
		);
		expect(abort).toHaveBeenCalledOnce();

		const settled = pi.emit("agent_settled", { type: "agent_settled" }, context);
		await vi.waitFor(() => expect(beforeCompact).toBeDefined());
		expect(compactOptions?.customInstructions).toBeDefined();

		const result = beforeCompact as {
			compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown };
		};
		expect(result.compaction?.firstKeptEntryId).toBe("kept-1");
		expect(result.compaction?.tokensBefore).toBe(195_000);
		expect(result.compaction?.summary.startsWith('<sol-pi-window id="w1" number="1" first="w0" previous="w0">')).toBe(true);
		expect(result.compaction?.summary).toContain("- [completed] build: build it");
		expect(result.compaction?.summary).toContain("Recorded progress:");
		expect(result.compaction?.summary).toContain("src/a.ts");
		expect(result.compaction?.details).toMatchObject({
			solPiWindow: { version: 1, mode: "reset", windowNumber: 1, windowId: "w1", previousWindowId: "w0" },
		});

		// A later manual compaction without a pending reset is never hijacked.
		expect(
			await pi.emit(
				"session_before_compact",
				{
					type: "session_before_compact",
					reason: "manual",
					willRetry: false,
					preparation: { firstKeptEntryId: "other", tokensBefore: 1_000 },
				},
				context,
			),
		).toBeUndefined();

		idle = true;
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		await settled;

		const ledger = readFileSync(windowLedgerPath(join(root, "sol-pi", "session-a")), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(ledger.map((record) => record.event)).toEqual(["reset", "summary"]);
		expect(ledger[0]).toMatchObject({
			event: "reset",
			reason: "manual",
			windowNumber: 1,
			windowId: "w1",
			previousWindowId: "w0",
			firstKeptEntryId: "kept-1",
			tokensBefore: 195_000,
		});
		expect(ledger[0]?.fragmentBytes).toBeGreaterThan(0);
		expect(ledger[1]).toMatchObject({ event: "summary", windowNumber: 2, windowId: "w2", fragmentBytes: 0 });
	});
});

function buildSessionMessages(): AgentMessage[] {
	return [
		{ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() },
		assistant(`work ${"y".repeat(2_000)}`),
	];
}
