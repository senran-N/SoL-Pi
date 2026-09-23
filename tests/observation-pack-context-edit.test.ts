/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createObservationPackExtension, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const roots: string[] = [];

function result(text: string, toolCallId = "call-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function text(message: AgentMessage): string {
	if (message.role !== "toolResult") throw new Error("expected tool result");
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function largeResult(toolCallId = "call-1"): ToolResultMessage {
	return result(`head\n${"middle\n".repeat(Math.ceil((THRESHOLD_BYTES + 1) / 7))}tail\n`, toolCallId);
}

function extension(): FakePi {
	const pi = new FakePi();
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "observationpack-context-edit-"));
	roots.push(value);
	return value;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("Observation Pack durable context edits", () => {
	it("returns an append-only edit draft after a placeholder projection", async () => {
		const sessionDir = await root();
		const manager = new FakeSessionManager([], "session-a", sessionDir);
		const pi = extension();
		const context = fakeContext(manager);
		const message = largeResult();
		manager.appendMessage(message);

		const projected = await pi.emitContext([message], context);
		const first = await pi.emitContext([message], context);
		const second = await pi.emitContext([message], context);
		const third = await pi.emitContext([message], context);
		expect(text(projected[0]!)).toBe(text(message));
		expect(text(first[0]!)).toBe(text(message));
		expect(text(second[0]!)).toMatch(/^\[large tool result replaced/u);
		expect(text(third[0]!)).toMatch(/^\[large tool result replaced/u);

		const entryId = manager.getBranch()[0]?.id;
		const boundary = await pi.emit(
			"turn_end",
			{
				type: "turn_end",
				entries: [],
				continue: false,
				context: {},
				outcome: "completed",
				message: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
				toolResults: [message],
				messageEntryId: "assistant-1",
				toolResultEntryIds: [entryId],
			},
			context,
		);

		expect(boundary).toMatchObject({ entries: [{ type: "context_edit", targetId: entryId }] });
		const edit = (boundary as { entries: Array<{ type: string; replacement?: { content?: unknown } }> }).entries[0];
		expect(edit?.replacement?.content).toEqual([{ type: "text", text: text(third[0]!) }]);
	});

	it("does not add a second edit when the target is already edited", async () => {
		const sessionDir = await root();
		const message = largeResult();
		const manager = new FakeSessionManager([], "session-a", sessionDir);
		manager.appendMessage(message);
		const pi = extension();
		const context = fakeContext(manager);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);

		const boundary = {
			type: "turn_end",
			entries: [{ type: "context_edit", targetId: manager.getBranch()[0]?.id, replacement: null }],
			continue: false,
			context: {},
			outcome: "completed",
			message: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
			toolResults: [message],
			messageEntryId: "assistant-1",
			toolResultEntryIds: [manager.getBranch()[0]?.id],
		};
		const output = await pi.emit("turn_end", boundary, context);
		expect(output).toBeUndefined();
	});

	it("persists a placeholder edit through a real Pi AgentSession without changing raw history", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "observationpack-agent-session-"));
		roots.push(cwd);
		const agentDir = join(cwd, "agent");
		const largeText = `head\n${"large result line\\n".repeat(Math.ceil((THRESHOLD_BYTES + 1) / 18))}tail`;
		let session: AgentSession | undefined;
		try {
			const faux = fauxProvider({ provider: "observation-pack-session", api: "observation-pack-session-api" });
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("large_output", {}, { id: "large-output-call" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("first follow-up")),
				fauxAssistantMessage(fauxText("second follow-up")),
				fauxAssistantMessage(fauxText("finished")),
			]);
			const extension: ExtensionFactory = (pi) => {
				pi.registerProvider(faux.provider);
				createObservationPackExtension()(pi);
				pi.registerTool({
					name: "large_output",
					label: "Large Output",
					description: "Return a deterministic large text result",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: largeText }], details: undefined };
					},
				});
			};
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"), { id: "observation-pack" });
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [{ name: "observation-pack-session-test", factory: extension }],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Deterministic Observation Pack integration test.",
			});
			await resourceLoader.reload();
			expect(resourceLoader.getExtensions().errors).toEqual([]);
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				model: faux.getModel(),
				thinkingLevel: "off",
				tools: ["large_output"],
				resourceLoader,
				sessionManager,
				settingsManager,
			}));

			await session.prompt("run the large output tool", { expandPromptTemplates: false });
			await session.prompt("continue", { expandPromptTemplates: false });
			await session.prompt("continue again", { expandPromptTemplates: false });

			const branch = sessionManager.getBranch();
			const resultEntry = branch.find((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "large-output-call",
			);
			expect(resultEntry?.type).toBe("message");
			if (!resultEntry || resultEntry.type !== "message" || resultEntry.message.role !== "toolResult") {
				throw new Error("large tool result was not persisted");
			}
			const edit = branch.find((entry) => entry.type === "context_edit" && entry.targetId === resultEntry.id);
			expect(edit?.type).toBe("context_edit");
			expect(resultEntry.message.content).toEqual([{ type: "text", text: largeText }]);
			const projection = sessionManager.buildSessionProjection().messages;
			const projectedResult = projection.find((message) => message.role === "toolResult" && message.toolCallId === "large-output-call");
			expect(text(projectedResult!)).toMatch(/^\[large tool result replaced/u);
			const id = text(projectedResult!).match(/id: (obs_[a-f0-9]{24})/u)?.[1];
			expect(id).toBeTruthy();
			expect(await readFile(join(sessionManager.getSessionDir(), "sol-pi", sessionManager.getSessionId(), "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(largeText);
			expect(session.getLastAssistantText()).toBe("finished");
			expect(session.isIdle).toBe(true);
			expect(faux.state.callCount).toBe(4);
		} finally {
			session?.dispose();
		}
	}, 15_000);
});
