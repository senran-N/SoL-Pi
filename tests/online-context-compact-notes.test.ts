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
	appendNote,
	createOnlineContextCompactExtension,
	formatNoteIndexLine,
	listNotes,
	NOTE_MAX_BYTES,
	notePath,
	notesDirectory,
	readNote,
	readNotesIndex,
	writeNote,
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

function noteRoot(): string {
	return mkdtempSync(join(tmpdir(), "sol-pi-occ-notes-"));
}

/** Matches runtimeRoot() for FakeSessionManager(root, "session-a"). */
function sessionRoot(root: string): string {
	return join(root, "sol-pi", "session-a");
}

describe("durable notes", () => {
	it("never lets a model-supplied slug escape the notes directory", () => {
		const root = noteRoot();
		expect(notePath(root, "api-surface")).toBe(join(notesDirectory(root), "api-surface.md"));
		expect(notePath(root, "a")).toContain("a.md");
		for (const slug of ["../escape", "..", "UPPER", "with space", "dot.name", "", "-leading", "x".repeat(65)]) {
			expect(() => notePath(root, slug)).toThrow(/note slug/u);
		}
	});

	it("writes, appends, reads, and indexes notes on disk", async () => {
		const root = noteRoot();
		expect(await readNote(root, "plan")).toBeUndefined();
		expect(await listNotes(root)).toEqual([]);
		expect(await readNotesIndex(root)).toEqual([]);

		await writeNote(root, "plan", "first line");
		await appendNote(root, "plan", "second line");
		await writeNote(root, "zeta", "other");

		expect(await readNote(root, "plan")).toBe("first line\nsecond line\n");
		expect(readFileSync(notePath(root, "plan"), "utf8")).toBe("first line\nsecond line\n");
		expect(await listNotes(root)).toEqual([
			{ slug: "plan", bytes: Buffer.byteLength("first line\nsecond line\n", "utf8") },
			{ slug: "zeta", bytes: Buffer.byteLength("other\n", "utf8") },
		]);
		const index = await readNotesIndex(root);
		expect(index).toHaveLength(2);
		expect(index[0]).toBe(`plan (${Buffer.byteLength("first line\nsecond line\n", "utf8")} bytes)`);
		expect(index[0]).toBe(formatNoteIndexLine({ slug: "plan", bytes: 23 }));
		expect(index[1]).toMatch(/^zeta \(\d+ bytes\)$/u);
	});

	it("bounds note bodies and keeps a failed append from changing the file", async () => {
		const root = noteRoot();
		await expect(writeNote(root, "plan", "   ")).rejects.toThrow(/must not be empty/u);
		await expect(writeNote(root, "plan", "x".repeat(NOTE_MAX_BYTES + 1))).rejects.toThrow(/must stay under/u);

		await writeNote(root, "plan", "keep me");
		await expect(appendNote(root, "plan", "y".repeat(NOTE_MAX_BYTES))).rejects.toThrow(/would exceed/u);
		expect(await readNote(root, "plan")).toBe("keep me\n");
	});
});

describe("note tools", () => {
	it("registers write/append/read tools that store and return note bodies", async () => {
		const root = noteRoot();
		const manager = new FakeSessionManager([], "session-a", root);
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		const context = fakeContext(manager);

		type Execute = (
			toolCallId: string,
			params: unknown,
			signal: undefined,
			onUpdate: undefined,
			context: ExtensionContext,
		) => Promise<{ content: { type: string; text: string }[]; details: Readonly<Record<string, unknown>> }>;

		const write = pi.tool("note_write").execute as Execute;
		const append = pi.tool("note_append").execute as Execute;
		const read = pi.tool("note_read").execute as Execute;

		const written = await write("call-1", { slug: "design", body: "keep it small" }, undefined, undefined, context);
		expect(written.content[0]?.text).toContain('Recorded note "design"');
		expect(written.details).toMatchObject({ op: "write", slug: "design" });

		const appended = await append("call-2", { slug: "design", body: "no new deps" }, undefined, undefined, context);
		expect(appended.content[0]?.text).toContain('Appended to note "design"');

		const readBack = await read("call-3", { slug: "design" }, undefined, undefined, context);
		expect(readBack.content[0]?.text).toBe("keep it small\nno new deps\n");
		expect(readBack.details).toMatchObject({ op: "read", slug: "design", found: true });

		await expect(read("call-4", { slug: "missing" }, undefined, undefined, context)).rejects.toThrow(
			/No note named "missing".*design/u,
		);
	});
});

describe("notes inside the window fragment", () => {
	it("carries the on-disk note index into the synthetic handoff", async () => {
		const root = noteRoot();
		const manager = new FakeSessionManager([], "session-a", root);
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
		await writeNote(sessionRoot(root), "design-notes", "durable body");

		let idle = true;
		const abort = vi.fn();
		let beforeCompact: unknown;
		let context: ExtensionContext;
		const compact = (options: CompactOptions = {}): void => {
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

		type Execute = (
			toolCallId: string,
			params: unknown,
			signal: undefined,
			onUpdate: undefined,
			context: ExtensionContext,
		) => Promise<{ content: unknown[]; details: Readonly<Record<string, unknown>> }>;
		const runPlan = pi.tool("update_plan").execute as Execute;

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan("plan-open", { steps: OPEN }, undefined, undefined, context);
		await runPlan("plan-done", { steps: DONE, progress: PROGRESS }, undefined, undefined, context);
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
		const settled = pi.emit("agent_settled", { type: "agent_settled" }, context);
		await vi.waitFor(() => expect(beforeCompact).toBeDefined());

		const result = beforeCompact as { compaction?: { summary: string } };
		expect(result.compaction?.summary).toContain("Notes index:");
		expect(result.compaction?.summary).toMatch(/- design-notes \(\d+ bytes\)/u);
		expect(result.compaction?.summary).not.toContain("durable body");

		idle = true;
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		await settled;
	});
});
