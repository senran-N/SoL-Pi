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
import type { PlanStep } from "./plan.ts";
import type { ProgressSummary } from "./state.ts";

export const WINDOW_FRAGMENT_MAX_BYTES = 4_096;
export const WINDOW_CONTINUITY_INSTRUCTION =
	"The work before this window is one logical chain of events. " +
	"Do not restart from scratch and do not redo completed steps.";

const WINDOW_TAG = "sol-pi-window";
const TRUNCATION_MARKER = "[sol-pi-window truncated to fit its byte budget]";
const MAX_LINE_BYTES = 512;

export type CompactionMode = "reset" | "summary";

export type WindowIdentity = {
	readonly firstWindowId: string;
	readonly previousWindowId: string | null;
	readonly windowId: string;
};

export type WindowResetInput = {
	/** Compaction epoch that will begin after this reset (0 is the first window). */
	readonly epoch: number;
	readonly plan: readonly PlanStep[];
	readonly progress: readonly ProgressSummary[];
	readonly notesIndex?: readonly string[];
};

export type WindowModeInput = {
	readonly plan: readonly PlanStep[];
	readonly progress: readonly ProgressSummary[];
};

/**
 * Window identity is derived from the persisted compaction epoch rather than a
 * random identifier: it is deterministic, survives resume/fork, and needs no
 * extra session state.
 */
export function windowIdentity(epoch: number): WindowIdentity {
	if (!Number.isSafeInteger(epoch) || epoch < 0) {
		throw new Error("Online Context Compact window epoch must be a non-negative safe integer");
	}
	return {
		firstWindowId: "w0",
		previousWindowId: epoch > 0 ? `w${epoch - 1}` : null,
		windowId: `w${epoch}`,
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
	const identity = windowIdentity(input.epoch);
	const attributes = [
		`id="${identity.windowId}"`,
		`number="${input.epoch}"`,
		`first="${identity.firstWindowId}"`,
	];
	if (identity.previousWindowId !== null) attributes.push(`previous="${identity.previousWindowId}"`);
	const open = `<${WINDOW_TAG} ${attributes.join(" ")}>`;
	const close = `</${WINDOW_TAG}>`;

	const lines: string[] = [sanitize(WINDOW_CONTINUITY_INSTRUCTION)];
	appendPlan(lines, input.plan);
	appendProgress(lines, input.progress);
	appendNotes(lines, input.notesIndex ?? []);
	return fitLines(open, close, lines);
}

function appendPlan(lines: string[], plan: readonly PlanStep[]): void {
	if (plan.length === 0) return;
	lines.push("", "Plan:");
	for (const step of plan) {
		lines.push(`- [${step.status}] ${sanitize(step.id)}: ${sanitize(step.goal)}`);
	}
}

function appendProgress(lines: string[], progress: readonly ProgressSummary[]): void {
	if (progress.length === 0) return;
	lines.push("", "Recorded progress:");
	for (const summary of progress) {
		lines.push(`- ${sanitize(summary.stepId)}: ${sanitize(summary.goal)}`);
		const files = summary.filesChanged.map((value) => sanitize(value)).filter((value) => value.length > 0);
		const verification = summary.verification.map((value) => sanitize(value)).filter((value) => value.length > 0);
		const decisions = summary.decisions.map((value) => sanitize(value)).filter((value) => value.length > 0);
		const nextWork = summary.nextWork.map((value) => sanitize(value)).filter((value) => value.length > 0);
		if (files.length > 0) lines.push(`  files: ${files.join(", ")}`);
		if (verification.length > 0) lines.push(`  verification: ${verification.join("; ")}`);
		if (decisions.length > 0) lines.push(`  decisions: ${decisions.join("; ")}`);
		if (nextWork.length > 0) lines.push(`  next: ${nextWork.join("; ")}`);
	}
}

function appendNotes(lines: string[], notesIndex: readonly string[]): void {
	if (notesIndex.length === 0) return;
	lines.push("", "Notes index:");
	for (const entry of notesIndex) lines.push(`- ${sanitize(entry)}`);
}

/** Collapse whitespace, drop markup that would break the fragment envelope, and bound one line. */
function sanitize(text: string, maxBytes = MAX_LINE_BYTES): string {
	const collapsed = text
		.replace(/[<>&\u0000-\u001f\u007f]/gu, " ")
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

function fitLines(open: string, close: string, lines: readonly string[]): string {
	// The join adds one newline between every pair of parts, so the open and
	// close tags consume their own bytes plus a separator each.
	let budget = WINDOW_FRAGMENT_MAX_BYTES - Buffer.byteLength(open, "utf8") - Buffer.byteLength(close, "utf8") - 1;
	const kept: string[] = [];
	let truncated = false;
	for (const line of lines) {
		const cost = Buffer.byteLength(line, "utf8") + 1;
		if (cost > budget) {
			truncated = true;
			break;
		}
		kept.push(line);
		budget -= cost;
	}
	if (truncated) {
		const markerCost = Buffer.byteLength(TRUNCATION_MARKER, "utf8") + 1;
		while (kept.length > 0 && markerCost > budget) {
			const removed = kept.pop() ?? "";
			budget += Buffer.byteLength(removed, "utf8") + 1;
		}
		if (markerCost <= budget) kept.push(TRUNCATION_MARKER);
	}
	return [open, ...kept, close].join("\n");
}
