/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderSolPiTool } from "../../tui.ts";
import { PLAN_STATUSES, type PlanStep } from "./plan.ts";

export type PlanProgress = {
	readonly files_changed: readonly string[];
	readonly verification: readonly string[];
	readonly decisions: readonly string[];
};

export type PlanUpdateInput = {
	readonly toolCallId: string;
	readonly steps: readonly PlanStep[];
	readonly progress: PlanProgress | undefined;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type NoteWriteInput = {
	readonly toolCallId: string;
	readonly slug: string;
	readonly body: string;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type NoteReadInput = {
	readonly toolCallId: string;
	readonly slug: string;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type ContextToolInput = {
	readonly toolCallId: string;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type HistorySearchInput = {
	readonly toolCallId: string;
	readonly query: string;
	readonly limit: number | undefined;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type HistoryReadInput = {
	readonly toolCallId: string;
	readonly id: string;
	readonly offset: number | undefined;
	readonly limit: number | undefined;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type OnlineToolHandlers = {
	readonly updatePlan: (input: PlanUpdateInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly noteWrite: (input: NoteWriteInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly noteAppend: (input: NoteWriteInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly noteRead: (input: NoteReadInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly newContext: (input: ContextToolInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly contextRemaining: (input: ContextToolInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly historySearch: (input: HistorySearchInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
	readonly historyRead: (input: HistoryReadInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
};

type SolPiTheme = Parameters<typeof renderSolPiTool>[0];

const noteSlugSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	description: 'Lowercase slug matching [a-z0-9][a-z0-9-]{0,63}, for example "api-surface".',
});

const noteBodySchema = Type.String({
	minLength: 1,
	maxLength: 32_768,
	description: "Note body, stored verbatim on disk and never summarized.",
});

const WINDOW_SAVING = "windowed handoff instead of lossy summarization";
const HISTORY_SAVING = "local read-only session recall";

const NOTE_TOOL_SUMMARY =
	"durable note that survives context compaction. Use it for facts, paths, decisions, or open questions that the plan and progress records cannot carry";

const NOTE_TOOL_GUIDELINES = [
	'Use a short slug such as "api-surface" or "open-questions".',
	"note_write replaces the whole note; note_append adds to the end of it.",
	"After a compaction, read the notes index in the window fragment and pull a body back with note_read.",
];

const progressSchema = Type.Object(
	{
		files_changed: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 128 }),
		verification: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
		decisions: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
	},
	{ additionalProperties: false },
);

const planStepSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 16_384 }),
		goal: Type.String({ minLength: 1, maxLength: 16_384 }),
		status: Type.Union(PLAN_STATUSES.map((status) => Type.Literal(status))),
	},
	{ additionalProperties: false },
);

export function registerOnlineTools(pi: ExtensionAPI, handlers: OnlineToolHandlers): void {
	pi.registerTool({
		name: "update_plan",
		label: "Update plan",
		description:
			"Replace the complete working plan. A newly completed step becomes a safe point where SoL-Pi may compact context if doing so is economical.",
		promptSnippet: "Keep the working plan current",
		promptGuidelines: [
			"Send the complete plan on every update_plan call.",
			"Keep at most one step in_progress and mark finished steps completed.",
			"When completing a step, include concise progress evidence when available.",
		],
		renderShell: "self",
		parameters: Type.Object(
			{
				steps: Type.Array(planStepSchema, { minItems: 1, maxItems: 128 }),
				progress: Type.Optional(progressSchema),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.updatePlan({
				toolCallId,
				steps: params.steps,
				progress: params.progress,
				signal,
				context,
			}),
		renderCall(params, theme) {
			const completed = params.steps.filter((step) => step.status === "completed").length;
			return renderSolPiTool(
				theme,
				"Online Context Compact",
				"compacts only when projected savings are positive",
				new Text(theme.fg("dim", `Plan: ${params.steps.length} steps, ${completed} completed`), 0, 0),
			);
		},
		renderResult(result, { isPartial }, theme) {
			const boundary = (result.details as { boundary?: boolean } | undefined)?.boundary === true;
			return renderSolPiTool(
				theme,
				"Online Context Compact",
				"compacts only when projected savings are positive",
				new Text(
					theme.fg(isPartial ? "warning" : "dim", isPartial ? "Updating plan..." : boundary ? "Progress boundary recorded" : "Plan recorded"),
					0,
					0,
				),
			);
		},
	});

	pi.registerTool({
		name: "note_write",
		label: "Write note",
		description: `Create or overwrite a ${NOTE_TOOL_SUMMARY}.`,
		promptSnippet: "Store durable notes that survive compaction",
		promptGuidelines: NOTE_TOOL_GUIDELINES,
		renderShell: "self",
		parameters: Type.Object({ slug: noteSlugSchema, body: noteBodySchema }, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.noteWrite({ toolCallId, slug: params.slug, body: params.body, signal, context }),
		renderCall(params, theme) {
			return renderNoteTool(theme, `write ${params.slug}`);
		},
		renderResult(result, { isPartial }, theme) {
			return renderNoteResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "note_append",
		label: "Append note",
		description: `Add to the end of a ${NOTE_TOOL_SUMMARY}.`,
		promptSnippet: "Append to durable notes that survive compaction",
		promptGuidelines: NOTE_TOOL_GUIDELINES,
		renderShell: "self",
		parameters: Type.Object({ slug: noteSlugSchema, body: noteBodySchema }, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.noteAppend({ toolCallId, slug: params.slug, body: params.body, signal, context }),
		renderCall(params, theme) {
			return renderNoteTool(theme, `append ${params.slug}`);
		},
		renderResult(result, { isPartial }, theme) {
			return renderNoteResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "note_read",
		label: "Read note",
		description: `Read back a ${NOTE_TOOL_SUMMARY}.`,
		promptSnippet: "Read back a durable note",
		promptGuidelines: NOTE_TOOL_GUIDELINES,
		renderShell: "self",
		parameters: Type.Object({ slug: noteSlugSchema }, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.noteRead({ toolCallId, slug: params.slug, signal, context }),
		renderCall(params, theme) {
			return renderNoteTool(theme, `read ${params.slug}`);
		},
		renderResult(result, { isPartial }, theme) {
			return renderNoteResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "get_context_remaining",
		label: "Context remaining",
		description:
			"Report how much of the context window is still available. Call it before a long run to decide whether to start a new window with new_context.",
		promptSnippet: "Check the remaining context budget",
		promptGuidelines: [
			"Use get_context_remaining instead of guessing how full the context is.",
			"When the remaining budget is small and the work is still long, call new_context to start a fresh window from the recorded plan, progress, and notes.",
		],
		renderShell: "self",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (toolCallId, _params, signal, _onUpdate, context) =>
			await handlers.contextRemaining({ toolCallId, signal, context }),
		renderCall(_params, theme) {
			return renderContextTool(theme, "check remaining context");
		},
		renderResult(result, { isPartial }, theme) {
			return renderContextResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "new_context",
		label: "New context window",
		description:
			"Start a new context window without summarizing. The recorded plan, progress, and note index become the checkpoint of the new window; nothing is lost to a lossy summary. Applied when the current turn settles.",
		promptSnippet: "Start a new context window from the recorded state",
		promptGuidelines: [
			"Call new_context once the current step is finished and recorded, not in the middle of editing.",
			"Write anything important into a note first; only the note index, the plan, and the recorded progress carry over.",
		],
		renderShell: "self",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (toolCallId, _params, signal, _onUpdate, context) =>
			await handlers.newContext({ toolCallId, signal, context }),
		renderCall(_params, theme) {
			return renderContextTool(theme, "start a new window");
		},
		renderResult(result, { isPartial }, theme) {
			return renderContextResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "history_search",
		label: "Search session history",
		description:
			"Search this session's recorded history, including work that a compaction already removed from the window. Read-only, local, and bounded.",
		promptSnippet: "Search earlier session history",
		promptGuidelines: [
			"Use history_search before asking the user to repeat something that happened earlier in this session.",
			"Use history_read with a hit id to read that entry in full.",
		],
		renderShell: "self",
		parameters: Type.Object(
			{
				query: Type.String({ minLength: 1, maxLength: 512 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.historySearch({ toolCallId, query: params.query, limit: params.limit, signal, context }),
		renderCall(params, theme) {
			return renderContextTool(theme, `search history for ${params.query}`, HISTORY_SAVING);
		},
		renderResult(result, { isPartial }, theme) {
			return renderContextResult(result, isPartial, theme, HISTORY_SAVING);
		},
	});

	pi.registerTool({
		name: "history_read",
		label: "Read session history",
		description: "Read a recorded session entry or checkpoint-wN. Read-only UTF-8 byte pages; follow next_offset until null to recover the full text.",
		promptSnippet: "Read one earlier session entry",
		promptGuidelines: ["Use history_read instead of guessing what an earlier entry said."],
		renderShell: "self",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 128 }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-8 byte offset returned as next_offset; default 0." })),
			limit: Type.Optional(Type.Integer({ minimum: 128, maximum: 24_000, description: "Page byte budget, default 24000." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.historyRead({ toolCallId, id: params.id, offset: params.offset, limit: params.limit, signal, context }),
		renderCall(params, theme) {
			return renderContextTool(theme, `read history entry ${params.id}`, HISTORY_SAVING);
		},
		renderResult(result, { isPartial }, theme) {
			return renderContextResult(result, isPartial, theme, HISTORY_SAVING);
		},
	});
}

function renderContextTool(theme: SolPiTheme, action: string, saving = WINDOW_SAVING): ReturnType<typeof renderSolPiTool> {
	return renderSolPiTool(theme, "Online Context Compact", saving, new Text(theme.fg("dim", action), 0, 0));
}

function renderContextResult(
	result: AgentToolResult<unknown>,
	isPartial: boolean,
	theme: SolPiTheme,
	saving = WINDOW_SAVING,
): ReturnType<typeof renderSolPiTool> {
	const op = (result.details as { op?: string } | undefined)?.op ?? "context";
	return renderSolPiTool(
		theme,
		"Online Context Compact",
		saving,
		new Text(theme.fg(isPartial ? "warning" : "dim", isPartial ? "Checking context..." : `${op} handled`), 0, 0),
	);
}

function renderNoteTool(theme: SolPiTheme, action: string): ReturnType<typeof renderSolPiTool> {
	return renderSolPiTool(
		theme,
		"Online Context Compact",
		"durable notes survive compaction",
		new Text(theme.fg("dim", `Note ${action}`), 0, 0),
	);
}

function renderNoteResult(
	result: AgentToolResult<unknown>,
	isPartial: boolean,
	theme: SolPiTheme,
): ReturnType<typeof renderSolPiTool> {
	const op = (result.details as { op?: string } | undefined)?.op ?? "note";
	return renderSolPiTool(
		theme,
		"Online Context Compact",
		"durable notes survive compaction",
		new Text(
			theme.fg(isPartial ? "warning" : "dim", isPartial ? "Updating note..." : `Note ${op} complete`),
			0,
			0,
		),
	);
}
