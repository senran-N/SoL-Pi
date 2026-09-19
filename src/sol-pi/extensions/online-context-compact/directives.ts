/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The user's own words, carried across a context window.
 *
 * Everything else in the window fragment is the model's account of the work:
 * the plan it wrote, the progress it recorded. A constraint the user stated
 * once - "leave the vendored tree alone", "do not touch the release branch" -
 * survives a compaction only as whatever the model chose to paraphrase, and
 * repeated compaction produces a paraphrase of a paraphrase. A constraint is
 * exactly the kind of sentence that does not survive that, and it is also the
 * one whose loss is most expensive: the model does not know it dropped it.
 *
 * The compact preview quotes the task and latest instruction. The full handoff
 * also references every user turn on this branch; no heuristic decides that an
 * intermediate constraint is obsolete.
 *
 * Pure functions only; the extension wires them to Pi's lifecycle.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * One quoted line's budget. Two of these plus a heading must still fit in what
 * the fragment has left after the progress, note-index, and plan floors, or this
 * section would be buying the user's words with the plan's remaining steps.
 */
export const DIRECTIVE_MAX_LINE_BYTES = 256;

export type UserDirectives = {
	/** The first thing the user asked for on this branch. */
	readonly task: string | undefined;
	/** The most recent user message, when it is not already the task. */
	readonly latest: string | undefined;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

/**
 * Only real user messages qualify. SoL-Pi's own continuation message is a
 * `custom_message`, not a user turn, so it is excluded by entry type rather
 * than by matching its text.
 */
function userMessageText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: string; content?: unknown };
	if (message.role !== "user") return undefined;
	const text = textFromContent(message.content);
	return text.trim().length > 0 ? text : undefined;
}

export type UserReference = { readonly id: string; readonly text: string };

export function collectUserReferences(entries: readonly SessionEntry[]): readonly UserReference[] {
	return entries.flatMap((entry) => {
		const text = userMessageText(entry);
		return text === undefined ? [] : [{ id: entry.id, text }];
	});
}

export function collectUserDirectives(entries: readonly SessionEntry[]): UserDirectives {
	let task: string | undefined;
	let latest: string | undefined;
	for (const entry of entries) {
		const text = userMessageText(entry)?.trim();
		if (text === undefined) continue;
		task ??= text;
		latest = text;
	}
	return { task, latest: latest === task ? undefined : latest };
}
