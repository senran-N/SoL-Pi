/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The bounded loop that runs one scoped exploration.
 *
 * Reading twenty files to confirm one function signature costs the main window
 * twenty files forever, and the conclusion was one line. This loop moves that
 * reading into a context that is thrown away: the explorer sees the project, the
 * main agent sees the conclusion and the lines it rests on.
 *
 * Every exit is accounted for. The loop ends with a verified answer, or with an
 * explicit failure that names what went wrong - never with a plausible answer
 * that nothing checked.
 */
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { verifyCitations, type Citation, type RejectedCitation } from "./citation.ts";
import { MAX_CITATIONS, type ExplorationConfig } from "./config.ts";
import {
	explorerInstructions,
	explorerTask,
	formatGrepObservation,
	formatListObservation,
	formatReadObservation,
	parseAction,
	stepsRemainingNotice,
	type ExplorationClaim,
	type ExplorationStatus,
	type FormattedObservation,
} from "./protocol.ts";
import { callExplorer, type ExplorerCall, type ExplorerTurn } from "./provider.ts";
import { createTranscript, transcriptPath, type AuditStatus, type ObservationArtifact } from "./transcript.ts";
import { grepFiles, listDirectory, readSlice } from "./search.ts";

export class ExplorationIncompleteError extends Error {
	override readonly name = "ExplorationIncompleteError";
}

export type ExplorationOutcome = {
	readonly explorationId: string;
	readonly found: boolean;
	readonly status: ExplorationStatus;
	readonly claims: readonly ExplorationClaim[];
	readonly answer: string;
	readonly citations: readonly Citation[];
	readonly rejected: readonly RejectedCitation[];
	readonly steps: number;
	readonly observedBytes: number;
	readonly transcriptPath: string;
	readonly coverage: readonly ExplorationCoverage[];
	readonly excludedPaths: readonly string[];
	readonly observations: readonly ObservationArtifact[];
	readonly audit: AuditStatus;
};

export type ExplorationCoverage = {
	readonly kind: "grep" | "read" | "list";
	readonly path: string;
	readonly pattern?: string;
	readonly firstLine?: number;
	readonly lastLine?: number;
	readonly scannedFiles: number;
	readonly skippedFiles: number;
	readonly truncated: boolean;
	readonly failed: boolean;
};

export type ExplorationInput = {
	readonly config: ExplorationConfig;
	readonly question: string;
	readonly root: string;
	readonly context: ExtensionContext;
	readonly signal?: AbortSignal | undefined;
	readonly call?: ExplorerCall;
};

function explorationId(question: string): string {
	const seed = `${question}\0${Date.now()}\0${Math.random()}`;
	return `exp_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16)}`;
}

/** One overall deadline for the exploration, relayed from the turn's own signal. */
function explorationSignal(parent: AbortSignal | undefined, timeoutMs: number): {
	readonly signal: AbortSignal;
	readonly cleanup: () => void;
} {
	const controller = new AbortController();
	const relayAbort = (): void => controller.abort(parent?.reason);
	if (parent?.aborted) relayAbort();
	else parent?.addEventListener("abort", relayAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException("Exploration timed out", "AbortError")),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", relayAbort);
		},
	};
}

type Observation = { readonly formatted: FormattedObservation; readonly coverage: ExplorationCoverage };

async function observe(root: string, action: Exclude<ReturnType<typeof parseAction>, undefined>, excludedPaths: readonly string[]): Promise<Observation> {
	switch (action.kind) {
		case "grep": {
			const found = await grepFiles({ root, pattern: action.pattern, path: action.path, excludedPaths });
			const formatted = formatGrepObservation({ ...found, pattern: action.pattern });
			return { formatted, coverage: { kind: "grep", path: found.path, pattern: action.pattern, scannedFiles: found.scanned, skippedFiles: found.skipped, truncated: formatted.truncated, failed: false } };
		}
		case "read": {
			const slice = await readSlice({ root, path: action.path, excludedPaths, offset: action.offset, limit: action.limit });
			const formatted = formatReadObservation(slice);
			return { formatted, coverage: { kind: "read", path: slice.path, firstLine: slice.firstLine, lastLine: slice.firstLine + slice.lines.length - 1, scannedFiles: slice.lines.length > 0 ? 1 : 0, skippedFiles: 0, truncated: formatted.truncated, failed: false } };
		}
		case "list": {
			const listing = await listDirectory({ root, path: action.path, excludedPaths });
			const formatted = formatListObservation(listing);
			return { formatted, coverage: { kind: "list", path: listing.path, scannedFiles: 0, skippedFiles: 0, truncated: formatted.truncated, failed: false } };
		}
		case "answer":
			throw new Error("answer is not an observable action");
	}
}

export async function runExploration(input: ExplorationInput): Promise<ExplorationOutcome> {
	const call = input.call ?? callExplorer;
	const id = explorationId(input.question);
	const transcript = createTranscript(input.config.storeRoot, id);
	const operation = explorationSignal(input.signal, input.config.timeoutMs);
	const turns: ExplorerTurn[] = [{ role: "user", text: explorerTask(input.question) }];
	const instructions = explorerInstructions(input.config.maxSteps, input.config.excludedPaths);
	let observedBytes = 0;
	const coverage: ExplorationCoverage[] = [];
	const observations: ObservationArtifact[] = [];

	await transcript({
		event: "start",
		explorationId: id,
		question: input.question,
		provider: input.config.explorerProvider,
		model: input.config.explorerModel,
		maxSteps: input.config.maxSteps,
	});

	try {
		for (let step = 1; step <= input.config.maxSteps; step += 1) {
			const reply = await call(input.config, instructions, turns, input.context, operation.signal);
			await transcript({ event: "reply", step, text: reply });
			turns.push({ role: "assistant", text: reply });

			const action = parseAction(reply);
			const remaining = input.config.maxSteps - step;

			if (!action) {
				await transcript({ event: "invalid", step });
				// The reply may have been prose, or a well-formed object with a field
				// outside its range. Saying only "not valid JSON" sends the second
				// case off reformatting text that was already shaped correctly, and
				// a step is too expensive to spend on the wrong fix.
				turns.push({
					role: "user",
					text:
						"That was not a valid action. Reply with exactly one JSON object using one of the listed actions, " +
						"and keep every field in range: offset and limit are positive integers, and an answer carries at most " +
						`${MAX_CITATIONS} citations. ${stepsRemainingNotice(remaining)}`,
				});
				continue;
			}

			if (action.kind === "answer") {
				const check = await verifyCitations(input.root, action.citations, input.config.excludedPaths);
				await transcript({
					event: "answer",
					step,
					found: action.found,
					verified: check.verified.length,
					rejected: check.rejected.map((entry) => ({ ...entry.citation, reason: entry.reason })),
				});
				// Claims are indivisible. Partial citation success cannot rescue the
				// unsupported remainder of either a structured or legacy answer.
				if (check.rejected.length > 0 || (action.found && check.verified.length === 0)) {
					if (remaining < 1) {
						throw new ExplorationIncompleteError(
							"The exploration answered with citations that could not be verified against the files.",
						);
					}
					turns.push({
						role: "user",
						text:
							"The answer was rejected because not every citation verified (or a finding had no citations). " +
							"Re-read the file and revise every affected claim; do not keep a claim by merely dropping its failed citation. " +
							stepsRemainingNotice(remaining),
					});
					continue;
				}
				const inspected = coverage.some((item) => item.kind !== "list" && !item.failed && item.scannedFiles > 0);
				const incomplete = !inspected || coverage.some((item) => item.truncated || item.failed);
				const status: ExplorationStatus = action.found ? "found"
					: action.status === "incomplete" || incomplete ? "incomplete" : "not_found_in_scope";
				// Do not pass through a confident negative written without inspection,
				// or after a bounded scan. Absence has not been established in that case.
				const answer = status === "incomplete" && action.status !== "incomplete"
					? "Exploration incomplete: no verified finding, and the recorded content inspection is missing, truncated, or failed. Absence has not been established."
					: action.answer;
				const claims = answer === action.answer ? action.claims : [];
				if (check.sources.length > 0) {
					const sourceArtifact = await transcript.archive(JSON.stringify(check.sources));
					observations.push(sourceArtifact);
					await transcript({ event: "verification", step, observation: sourceArtifact });
				}
				await transcript({ event: "result", step, status, claims, coverage, audit: transcript.audit() });
				return {
					explorationId: id,
					found: action.found,
					status,
					claims,
					answer,
					citations: check.verified,
					rejected: check.rejected,
					steps: step,
					observedBytes,
					transcriptPath: transcriptPath(input.config.storeRoot, id),
					coverage,
					excludedPaths: input.config.excludedPaths,
					observations,
					audit: transcript.audit(),
				};
			}

			let observation: Observation;
			try {
				observation = await observe(input.root, action, input.config.excludedPaths);
			} catch (error) {
				observation = {
					formatted: { text: `scope=${JSON.stringify({ kind: action.kind, path: action.path ?? ".", truncated: true, failed: true })}\nThat action failed: ${error instanceof Error ? error.message : String(error)}`, truncated: true },
					coverage: { kind: action.kind, path: action.path ?? ".", scannedFiles: 0, skippedFiles: 0, truncated: true, failed: true },
				};
			}
			const observedText = `${observation.formatted.text}\n\n${stepsRemainingNotice(remaining)}`;
			const archived = await transcript.archive(observedText);
			observations.push(archived);
			coverage.push(observation.coverage);
			observedBytes += Buffer.byteLength(observedText, "utf8");
			await transcript({ event: "action", step, action: action.kind, coverage: observation.coverage, observation: archived });
			turns.push({ role: "user", text: observedText });
		}

		throw new ExplorationIncompleteError(
			`The exploration used all ${input.config.maxSteps} steps without producing an answer.`,
		);
	} catch (error) {
		await transcript({ event: "failed", reason: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		operation.cleanup();
	}
}
