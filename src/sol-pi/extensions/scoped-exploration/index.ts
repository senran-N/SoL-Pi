/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Scoped Exploration - answer a question about the project in a context that is
 * thrown away.
 *
 * Finding out where something lives is cheap to do and expensive to keep. The
 * twenty files read on the way to a one-line conclusion stay in the main window
 * for the rest of the session, and no later compaction can separate them from
 * the work that mattered. This mechanism registers one tool, `explore`, which
 * runs a bounded read-only loop against the configured explorer model and
 * returns the conclusion plus the exact lines it rests on.
 *
 * Nothing is trusted on the way back: a citation survives only if the quoted
 * text is at that path and line, and an answer that claims a finding without a
 * single surviving citation is refused rather than delivered.
 *
 * The top-level SoL-Pi config enables this mechanism and selects the explorer
 * route. Authentication stays with Pi; storage comes from the session.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runtimeRoot } from "../../runtime-paths.ts";
import { formatSavingsCount, renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import type { Citation, RejectedCitation } from "./citation.ts";
import { EXPLORATION_RECEIPT_PREFIX, loadExplorationConfig, type ExplorationConfigOptions } from "./config.ts";
import { runExploration, type ExplorationOutcome } from "./explorer.ts";
import type { ExplorerCall } from "./provider.ts";

const QUESTION_MAX_LENGTH = 2_000;
const PATH_MAX_LENGTH = 1_000;
const SAVING_LABEL = "one-line answer instead of a full search in your context";

export type ScopedExplorationOptions = ExplorationConfigOptions & {
	/** Injected in tests; production always uses the configured model route. */
	readonly call?: ExplorerCall;
};

/** Quotes are project bytes, so they are escaped rather than inlined raw. */
function citationLines(citations: readonly Citation[]): readonly string[] {
	return citations.map(
		(citation) => `- path=${citation.path} line=${citation.line} quote=${JSON.stringify(citation.quote.trim())}`,
	);
}

export function formatExplorationResult(outcome: ExplorationOutcome): string {
	const lines = [
		EXPLORATION_RECEIPT_PREFIX,
		`exploration_id=${outcome.explorationId}`,
		`found=${outcome.found}`,
		`steps=${outcome.steps}`,
		`rejected_citations=${outcome.rejected.length}`,
		`transcript=${outcome.transcriptPath}`,
		"answer:",
		outcome.answer,
	];
	if (outcome.citations.length > 0) {
		lines.push("verified_evidence:", ...citationLines(outcome.citations));
	} else if (!outcome.found) {
		lines.push(
			"verified_evidence:",
			"- none; this is a negative result, not a failure to look. Read the transcript before searching the same way again.",
		);
	}
	if (outcome.rejected.length > 0) {
		lines.push(`note=${outcome.rejected.length} citation(s) were discarded because the quote was not at that line`);
	}
	return lines.join("\n");
}

function rejectedDetail(rejected: readonly RejectedCitation[]): readonly Record<string, unknown>[] {
	return rejected.map((entry) => ({
		path: entry.citation.path,
		line: entry.citation.line,
		reason: entry.reason,
	}));
}

export function createScopedExplorationExtension(options: ScopedExplorationOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "explore",
			label: "Explore",
			description:
				"Answer one question about this project in a separate context. The search itself never enters your context; " +
				"you receive a short answer and the exact lines it rests on.",
			promptSnippet: "Delegate a look-around instead of reading your way to it",
			promptGuidelines: [
				"Use it when answering would mean opening several files just to locate something.",
				"Ask one specific question; the answer comes back with file:line evidence.",
				"Do not use it for work that changes files: the exploration is read-only.",
			],
			renderShell: "self",
			parameters: Type.Object(
				{
					question: Type.String({
						minLength: 1,
						maxLength: QUESTION_MAX_LENGTH,
						description: 'One specific question, for example "where is the retry budget applied to uploads?".',
					}),
					path: Type.Optional(
						Type.String({
							minLength: 1,
							maxLength: PATH_MAX_LENGTH,
							description: "Optional directory to start from, relative to the project root.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, context) {
				const config = loadExplorationConfig(runtimeRoot(context), options);
				const question = params.path ? `${params.question}\n\nStart in: ${params.path}` : params.question;
				const outcome = await runExploration({
					config,
					question,
					root: context.cwd,
					context,
					signal,
					...(options.call ? { call: options.call } : {}),
				});

				const text = formatExplorationResult(outcome);
				const avoided = Math.max(0, outcome.observedBytes - Buffer.byteLength(text, "utf8"));
				if (avoided > 0) {
					showSolPiSavings(
						context,
						"Scoped Exploration",
						formatSavingsCount(Math.ceil(avoided / 4), "context tokens avoided"),
					);
				}

				return {
					content: [{ type: "text", text }],
					details: {
						exploration_id: outcome.explorationId,
						found: outcome.found,
						steps: outcome.steps,
						citations: outcome.citations.length,
						rejected: rejectedDetail(outcome.rejected),
						observed_bytes: outcome.observedBytes,
						transcript_path: outcome.transcriptPath,
					},
				};
			},
			renderCall(params, theme) {
				return renderSolPiTool(
					theme,
					"Scoped Exploration",
					SAVING_LABEL,
					new Text(theme.fg("dim", `Exploring: ${params.question}`), 0, 0),
				);
			},
			renderResult(result, { isPartial }, theme) {
				const details = result.details as { steps?: number; citations?: number } | undefined;
				const summary = isPartial
					? "Exploring in a separate context..."
					: `Answered in ${details?.steps ?? 0} steps with ${details?.citations ?? 0} verified citation(s)`;
				return renderSolPiTool(
					theme,
					"Scoped Exploration",
					SAVING_LABEL,
					new Text(theme.fg(isPartial ? "warning" : "dim", summary), 0, 0),
				);
			},
		});
	};
}

export {
	DEFAULT_EXPLORER_MODEL,
	DEFAULT_EXPLORER_PROVIDER,
	DEFAULT_MAX_STEPS,
	EXPLORATION_RECEIPT_PREFIX,
	loadExplorationConfig,
	MAX_MAX_STEPS,
	MIN_MAX_STEPS,
	resolveMaxSteps,
	type ExplorationConfig,
	type ExplorationConfigOptions,
} from "./config.ts";
export { parseCitations, verifyCitations, type Citation, type RejectedCitation } from "./citation.ts";
export { ExplorationIncompleteError, runExploration, type ExplorationOutcome } from "./explorer.ts";
export { parseAction, type ExplorerAction } from "./protocol.ts";
export { ExplorerModelUnavailableError, type ExplorerCall, type ExplorerTurn } from "./provider.ts";
export { grepFiles, listDirectory, readSlice, resolveInside } from "./search.ts";
export { transcriptPath } from "./transcript.ts";

export function registerScopedExploration(pi: ExtensionAPI, options: ScopedExplorationOptions = {}): void {
	createScopedExplorationExtension(options)(pi);
}

export default registerScopedExploration;
