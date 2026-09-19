/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Windowed context handoff for Online Context Compact.
 *
 * A "window" is one compaction epoch. When an extension supplies the compaction
 * result, Pi skips summarization entirely and stores the supplied text as the
 * durable checkpoint. This module builds that text from structured SoL-Pi state
 * instead of a lossy summary-of-a-summary, so repeated compactions cannot erode
 * details that the plan and progress records already captured.
 *
 * Pure functions only; the extension wires them to Pi's lifecycle.
 */
import { DIRECTIVE_MAX_LINE_BYTES, type UserDirectives, type UserReference } from "./directives.ts";
import type { PlanStep } from "./plan.ts";
import type { ProgressSummary } from "./state.ts";

export const WINDOW_FRAGMENT_MAX_BYTES = 4_096;
export const WINDOW_CONTINUITY_INSTRUCTION =
	"The work before this window is one logical chain of events. " +
	"Do not restart from scratch and do not redo completed steps.";

const WINDOW_TAG = "sol-pi-window";
const TRUNCATION_MARKER = "[sol-pi-window truncated to fit its byte budget]";
const MAX_LINE_BYTES = 512;
/**
 * Floors, not quotas: a section gets at least this many bytes when it has that
 * much to say, plus anything an earlier section leaves unused. Without them a
 * long plan eats the whole budget, and what it pushes out is exactly what
 * cannot be reconstructed once the compaction lands: the recorded evidence,
 * and the note index that points at every note body still on disk.
 */
const PROGRESS_RESERVED_BYTES = 1_536;
const NOTES_INDEX_RESERVED_BYTES = 1_152;
/**
 * The plan needs a floor of its own now that a section sits in front of it.
 * Without one it is the only unreserved section, so every byte the quoted user
 * instructions take comes straight out of the remaining work list - which is
 * precisely what the next window steers by.
 */
const PLAN_RESERVED_BYTES = 576;
/** A blank separator plus the section heading; a heading alone is noise. */
const SECTION_HEADING_LINES = 2;

export type CompactionMode = "reset" | "summary";

export type WindowIdentity = {
	readonly firstWindowId: string;
	readonly previousWindowId: string | null;
	readonly windowId: string;
};

export type WindowResetInput = {
	/** The window this reset opens; w0 is the session before any compaction. */
	readonly windowNumber: number;
	readonly plan: readonly PlanStep[];
	readonly progress: readonly ProgressSummary[];
	readonly notesIndex?: readonly string[];
	/** The user's own words, quoted rather than summarized. */
	readonly directives?: UserDirectives;
	/** Full branch user messages with source ids, persisted in compaction details. */
	readonly userReferences?: readonly UserReference[];
};

export type WindowModeInput = {
	readonly plan: readonly PlanStep[];
	readonly progress: readonly ProgressSummary[];
};

/**
 * Window identity is derived from the count of compactions already recorded
 * rather than a random identifier: it is deterministic, survives resume/fork,
 * and needs no extra session state.
 *
 * The number must advance once per compaction and nothing else. Anything that
 * also counts context resets without producing a checkpoint would make
 * `previousWindowId` name a window that never existed, which is worse than no
 * pointer at all: the model would look for a handoff it cannot find.
 */
export function windowIdentity(windowNumber: number): WindowIdentity {
	if (!Number.isSafeInteger(windowNumber) || windowNumber < 0) {
		throw new Error("Online Context Compact window number must be a non-negative safe integer");
	}
	return {
		firstWindowId: "w0",
		previousWindowId: windowNumber > 0 ? `w${windowNumber - 1}` : null,
		windowId: `w${windowNumber}`,
	};
}

/**
 * Rebuild the handoff from structured state only when that state exists. Without
 * a plan and at least one recorded progress summary there is nothing to rebuild,
 * so the caller falls back to Pi's native summarization.
 */
export function selectCompactionMode(input: WindowModeInput): CompactionMode {
	return input.plan.length > 0 && input.progress.length > 0 ? "reset" : "summary";
}

export function formatWindowFragment(input: WindowResetInput): string {
	const identity = windowIdentity(input.windowNumber);
	const attributes = [
		`id="${identity.windowId}"`,
		`number="${input.windowNumber}"`,
		`first="${identity.firstWindowId}"`,
	];
	if (identity.previousWindowId !== null) attributes.push(`previous="${identity.previousWindowId}"`);
	const open = `<${WINDOW_TAG} ${attributes.join(" ")}>`;
	const close = `</${WINDOW_TAG}>`;

	const recovery = input.userReferences === undefined ? "" :
		`\nFull checkpoint: history_read id="checkpoint-w${input.windowNumber}". Read it before acting; follow next_offset to recover omitted state and all ${input.userReferences.length} user instructions (source ids included).`;
	return renderFragment(open, close, sanitize(WINDOW_CONTINUITY_INSTRUCTION) + recovery, [
		{ lines: directiveLines(input.directives), reservedBytes: 0 },
		{ lines: planLines(input.plan), reservedBytes: PLAN_RESERVED_BYTES },
		{ lines: progressLines(input.progress), reservedBytes: PROGRESS_RESERVED_BYTES },
		{ lines: notesLines(input.notesIndex ?? []), reservedBytes: NOTES_INDEX_RESERVED_BYTES },
	]);
}

type Section = { readonly lines: readonly string[]; readonly reservedBytes: number };
type FittedSection = { readonly kept: readonly string[]; readonly used: number; readonly truncated: boolean };

/**
 * First section, and deliberately so. The plan, the progress and the notes can
 * all be rebuilt by the model from what it is about to read; the sentence the
 * user actually typed cannot be rebuilt from anything. Being first means it is
 * filled before any other section can spend the budget.
 */
function directiveLines(directives: UserDirectives | undefined): readonly string[] {
	if (!directives) return [];
	const task = directives.task ? sanitize(directives.task, DIRECTIVE_MAX_LINE_BYTES) : "";
	const latest = directives.latest ? sanitize(directives.latest, DIRECTIVE_MAX_LINE_BYTES) : "";
	const lines = ["", "User instructions (verbatim):"];
	if (task.length > 0) lines.push(`- task: ${task}`);
	if (latest.length > 0) lines.push(`- latest: ${latest}`);
	return lines.length > SECTION_HEADING_LINES ? lines : [];
}

function planLines(plan: readonly PlanStep[]): readonly string[] {
	if (plan.length === 0) return [];
	const lines = ["", "Plan:"];
	const priority = { in_progress: 0, pending: 1, completed: 2 };
	for (const step of [...plan].sort((a, b) => priority[a.status] - priority[b.status])) {
		lines.push(`- [${step.status}] ${sanitize(step.id, 80)}: ${sanitize(step.goal, 320)}`);
	}
	return lines;
}

function progressLines(progress: readonly ProgressSummary[]): readonly string[] {
	if (progress.length === 0) return [];
	const lines = ["", "Recorded progress:"];
	for (const summary of [...progress].reverse()) {
		lines.push(`- ${sanitize(summary.stepId)}: ${sanitize(summary.goal)}`);
		const files = sanitizeAll(summary.filesChanged);
		const verification = sanitizeAll(summary.verification);
		const decisions = sanitizeAll(summary.decisions);
		const nextWork = sanitizeAll(summary.nextWork);
		if (nextWork.length > 0) lines.push(`  next: ${sanitize(nextWork.join("; "))}`);
		if (decisions.length > 0) lines.push(`  decisions: ${sanitize(decisions.join("; "))}`);
		if (verification.length > 0) lines.push(`  verification: ${sanitize(verification.join("; "))}`);
		if (files.length > 0) lines.push(`  files: ${sanitize(files.join(", "))}`);
	}
	return lines;
}

function notesLines(notesIndex: readonly string[]): readonly string[] {
	if (notesIndex.length === 0) return [];
	const lines = ["", "Notes index:"];
	for (const entry of notesIndex) lines.push(`- ${sanitize(entry)}`);
	return lines;
}

function sanitizeAll(values: readonly string[]): readonly string[] {
	return values.map((value) => sanitize(value)).filter((value) => value.length > 0);
}

/**
 * Collapse whitespace, drop the markup that would break the fragment envelope,
 * and bound one line. Only the angle brackets that could close the tag are
 * removed: the fragment is plain prompt text, so stripping anything else would
 * quietly rewrite the very commands and paths the progress record exists to
 * preserve.
 */
function sanitize(text: string, maxBytes = MAX_LINE_BYTES): string {
	const collapsed = text
		.replace(/[<>\u0000-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (Buffer.byteLength(collapsed, "utf8") <= maxBytes) return collapsed;
	let truncated = "";
	for (const character of collapsed) {
		if (Buffer.byteLength(truncated + character, "utf8") > maxBytes - 3) break;
		truncated += character;
	}
	return `${truncated}...`;
}

/** One line plus the newline that follows it in the joined fragment. */
function lineCost(line: string): number {
	return Buffer.byteLength(line, "utf8") + 1;
}

function sectionCost(lines: readonly string[]): number {
	return lines.reduce((total, line) => total + lineCost(line), 0);
}

/** Fill one section in order, stopping at the first line that does not fit. */
function fitSection(lines: readonly string[], budget: number): FittedSection {
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const cost = lineCost(line);
		if (used + cost > budget) {
			// A heading with nothing under it is noise, so drop the section whole.
			if (kept.length <= SECTION_HEADING_LINES) return { kept: [], used: 0, truncated: true };
			return { kept, used, truncated: true };
		}
		kept.push(line);
		used += cost;
	}
	return { kept, used, truncated: false };
}

function renderFragment(open: string, close: string, continuity: string, sections: readonly Section[]): string {
	// The join puts one newline between every pair of parts, so each part except
	// the closing tag carries its own separator. The truncation marker is held
	// back up front so it always has room to be appended.
	let budget =
		WINDOW_FRAGMENT_MAX_BYTES - lineCost(open) - Buffer.byteLength(close, "utf8") - lineCost(TRUNCATION_MARKER);
	const kept: string[] = [];
	if (lineCost(continuity) <= budget) {
		kept.push(continuity);
		budget -= lineCost(continuity);
	}

	let truncated = false;
	for (const [index, section] of sections.entries()) {
		if (section.lines.length === 0) continue;
		let reservedForLater = 0;
		for (const later of sections.slice(index + 1)) {
			reservedForLater += Math.min(sectionCost(later.lines), later.reservedBytes);
		}
		const fitted = fitSection(section.lines, budget - reservedForLater);
		kept.push(...fitted.kept);
		budget -= fitted.used;
		truncated ||= fitted.truncated;
	}
	if (truncated) kept.push(TRUNCATION_MARKER);
	return [open, ...kept, close].join("\n");
}
