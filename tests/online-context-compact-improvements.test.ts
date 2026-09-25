/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { branchNotes, createOnlineContextCompactExtension, readHistoryEntry, searchHistory, windowLedgerPath, writeNote }
	from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

type Execute = (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, context: ExtensionContext) =>
	Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
const tool = (pi: FakePi, name: string): Execute => pi.tool(name).execute as Execute;
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 0 };
}
function setup(entries: SessionEntry[] = [], id = "session-a", root = mkdtempSync(join(tmpdir(), "sol-pi-occ-improvements-"))) {
	const manager = new FakeSessionManager(entries, id, root);
	const pi = new FakePi(manager);
	createOnlineContextCompactExtension({ keepRecentTokens: 300 })(pi.asExtensionApi());
	const context = fakeContext(manager);
	return { manager, pi, context, root };
}

describe("branch-safe note versions", () => {
	it("rewinds to an old note and rebuilds that exact version in a fork", async () => {
		const { manager, pi, context, root } = setup();
		await tool(pi, "note_write")("w1", { slug: "design", body: "approved design" }, undefined, undefined, context);
		const oldBranch = [...manager.entries];
		await tool(pi, "note_write")("w2", { slug: "design", body: "abandoned future design" }, undefined, undefined, context);
		expect((await tool(pi, "note_read")("r1", { slug: "design" }, undefined, undefined, context)).content[0]?.text).toContain("future");
		manager.getBranch = () => oldBranch;
		await pi.emit("session_tree", { type: "session_tree" }, context);
		expect((await tool(pi, "note_read")("r2", { slug: "design" }, undefined, undefined, context)).content[0]?.text).toBe("approved design\n");
		const fork = setup([...oldBranch], "session-b", root);
		const version = branchNotes(oldBranch).get("design")!;
		const object = join(root, "sol-pi", "session-b", "online-context-compact", "notes", "objects", `${version.contentHash}.md`);
		expect(existsSync(object)).toBe(false);
		expect((await tool(fork.pi, "note_read")("r3", { slug: "design" }, undefined, undefined, fork.context)).content[0]?.text).toBe("approved design\n");
		expect(readFileSync(object, "utf8")).toBe("approved design\n");
		manager.getBranch = () => [];
		await expect(tool(pi, "note_read")("r4", { slug: "design" }, undefined, undefined, context)).rejects.toThrow("on this branch");
	});

	it("requires explicit legacy import and never follows later mutable-file edits", async () => {
		const { manager, pi, context, root } = setup();
		const runtime = join(root, "sol-pi", "session-a");
		await writeNote(runtime, "legacy", "old decision");
		await expect(tool(pi, "note_read")("r1", { slug: "legacy" }, undefined, undefined, context)).rejects.toThrow("import_legacy=true");
		const imported = await tool(pi, "note_read")("r2", { slug: "legacy", import_legacy: true }, undefined, undefined, context);
		expect(imported.details.imported_legacy).toBe(true);
		await writeNote(runtime, "legacy", "future decision");
		expect((await tool(pi, "note_read")("r3", { slug: "legacy" }, undefined, undefined, context)).content[0]?.text).toBe("old decision\n");
		expect(branchNotes(manager.entries).get("legacy")?.body).toBe("old decision\n");
	});
});

describe("paged history and checkpoint retrieval", () => {
	function history(): SessionEntry[] {
		return Array.from({ length: 45 }, (_, index) => ({ type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), message: {
				role: "toolResult", toolName: index % 2 ? "read" : "bash", toolCallId: `t${index}`, content: [{ type: "text", text: `needle evidence ${index}` }],
				isError: false, timestamp: index,
			} }) as SessionEntry);
	}
	it("finds every older hit once while new messages arrive between pages", () => {
		const entries = history();
		const first = searchHistory(entries, "needle", 8);
		expect(first.hits[0]?.id).toBe("e44");
		entries.push({ ...entries[44]!, id: "new", parentId: "e44" } as SessionEntry);
		const ids = first.hits.map((hit) => hit.id);
		let cursor = first.nextCursor;
		while (cursor) {
			const page = searchHistory(entries, "needle", 8, { cursor });
			ids.push(...page.hits.map((hit) => hit.id));
			cursor = page.nextCursor;
		}
		expect(ids).toHaveLength(45);
		expect(new Set(ids).size).toBe(45);
		expect(ids).not.toContain("new");
		expect(ids.at(-1)).toBe("e0");
		expect(() => searchHistory(entries.slice(0, 10), "needle", 8, { cursor: first.nextCursor! })).toThrow("current branch");
	});
	it("combines role, tool, timestamp and source filters and binds cursors to them", () => {
		const entries = history();
		const filters = { role: "toolResult", tool: "bash", source: "message" as const, after: "2026-01-01T00:10:00Z", before: "2026-01-01T00:20:00Z" };
		const found = searchHistory(entries, "needle", 2, filters);
		expect(found.total).toBe(5);
		expect(found.hits.map((hit) => hit.id)).toEqual(["e18", "e16"]);
		expect(searchHistory(entries, "needle", 8, { ...filters, cursor: found.nextCursor! }).hits.map((hit) => hit.id)).toEqual(["e14", "e12", "e10"]);
		expect(() => searchHistory(entries, "needle", 8, { ...filters, tool: "read", cursor: found.nextCursor! })).toThrow("changed filters");
	});
	it("searches full checkpoint state even when its visible fragment omitted the evidence", () => {
		const entry = { type: "compaction", id: "c1", parentId: null, timestamp: new Date(0).toISOString(), summary: "short handoff",
			firstKeptEntryId: null, tokensBefore: 1000, details: { solPiWindow: { windowId: "w1", checkpoint: {
				progress: [{ decisions: ["rare database invariant"], sourceId: "source-evidence" }],
			} } } } as unknown as SessionEntry;
		const found = searchHistory([entry], "rare database", 8, { source: "checkpoint" });
		expect(found.hits[0]?.id).toBe("checkpoint-w1");
		expect(readHistoryEntry([entry], found.hits[0]!.id)?.text).toContain("source-evidence");
	});
});

describe("independent window guard and committed audit", () => {
	function guardSetup() {
		const environment = setup();
		const { manager, pi } = environment;
		manager.appendMessage({ role: "user", content: `Keep the original constraints. ${"old ".repeat(5000)}`, timestamp: 0 });
		const call = { ...assistant("working"), content: [{ type: "toolCall", id: "live-call", name: "bash", arguments: { command: "long-task" } }] } as AgentMessage;
		const callId = manager.appendMessage(call);
		manager.appendMessage({ role: "toolResult", toolCallId: "live-call", toolName: "bash", content: [{ type: "text", text: "working output ".repeat(200) }],
			isError: false, timestamp: 0, details: { id: "exec_abc123", status: "running", pendingBytes: 0 } });
		const compact = vi.fn();
		const context = fakeContext(manager, { compact, getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }) });
		const ledger = () => readFileSync(windowLedgerPath(join(environment.root, "sol-pi", "session-a")), "utf8")
			.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
		return { ...environment, context, compact, callId, ledger,
			turn: { type: "turn_end", turnIndex: 1, message: assistant("settled tool call"), toolResults: [] } };
	}
	it("acts without a plan but preserves the newest complete tool group and command recovery pointer", async () => {
		const { pi, context, callId, ledger, compact, turn } = guardSetup();
		const boundary = await pi.emit("turn_end", turn, context) as { continue: boolean; entries: Array<Record<string, unknown>> };
		expect(boundary.continue).toBe(true);
		const compaction = boundary.entries.find((entry) => entry.type === "compaction")!;
		expect(compaction.firstKeptEntryId).toBe(callId);
		expect(compaction.details).toMatchObject({ solPiWindow: { checkpoint: { plan: [], pendingCommands: [
			{ handle: "exec_abc123", lastKnownStatus: "running" },
		] } } });
		expect(compaction.summary).toContain("exec_list");
		expect(compact).not.toHaveBeenCalled();
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]).toMatchObject({ stage: "decision", reason: "window_protection" });
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		expect(ledger()[1]).toMatchObject({ stage: "commit", outcome: "committed", reason: "window_protection" });
		expect(ledger()[1]?.transitionId).toBe(ledger()[0]?.transitionId);
	});
	it("records rejected boundaries without claiming success", async () => {
		const { pi, context, ledger, turn } = guardSetup();
		await pi.emit("turn_end", turn, context);
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		expect(ledger().map((row) => row.stage)).toEqual(["decision", "outcome"]);
		expect(ledger()[1]?.outcome).toBe("rejected");
		expect(pi.sentMessages).toEqual([]);
	});
	it.each(["error", "aborted"] as const)("never schedules a continuation after assistant %s", async (stopReason) => {
		const { pi, context, compact, turn } = guardSetup();
		await tool(pi, "new_context")("reset", {}, undefined, undefined, context);
		expect(await pi.emit("turn_end", { ...turn, message: { ...turn.message, stopReason } }, context)).toBeUndefined();
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		expect(compact).not.toHaveBeenCalled();
		expect(pi.sentMessages).toEqual([]);
	});
});
