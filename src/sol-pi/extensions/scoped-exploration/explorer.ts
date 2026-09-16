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
import { MAX_ANSWER_BYTES, MAX_CITATIONS, type ExplorationConfig } from "./config.ts";
import {
	explorerInstructions,
	explorerTask,
	formatGrepObservation,
	formatListObservation,
	formatReadObservation,
	parseAction,
	stepsRemainingNotice,
} from "./protocol.ts";
import { callExplorer, type ExplorerCall, type ExplorerTurn } from "./provider.ts";
import { createTranscript, transcriptPath } from "./transcript.ts";
import { grepFiles, listDirectory, readSlice } from "./search.ts";

export class ExplorationIncompleteError extends Error {
	override readonly name = "ExplorationIncompleteError";
}

export type ExplorationOutcome = {
	readonly explorationId: string;
	readonly found: boolean;
	readonly answer: string;
	readonly citations: readonly Citation[];
	readonly rejected: readonly RejectedCitation[];
	readonly steps: number;
	readonly observedBytes: number;
	readonly transcriptPath: string;
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

function clampAnswer(answer: string): string {
	if (Buffer.byteLength(answer, "utf8") <= MAX_ANSWER_BYTES) return answer;
	const buffer = Buffer.from(answer, "utf8");
	let end = MAX_ANSWER_BYTES - 3;
	while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
	return `${buffer.subarray(0, end).toString("utf8")}...`;
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

async function observe(root: string, action: Exclude<ReturnType<typeof parseAction>, undefined>): Promise<string> {
	switch (action.kind) {
		case "grep": {
			const found = await grepFiles({ root, pattern: action.pattern, path: action.path });
			return formatGrepObservation({ pattern: action.pattern, hits: found.hits, truncated: found.truncated });
		}
		case "read": {
			const slice = await readSlice({ root, path: action.path, offset: action.offset, limit: action.limit });
			return formatReadObservation(slice);
		}
		case "list": {
			const listing = await listDirectory({ root, path: action.path });
			return formatListObservation(listing);
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
	const instructions = explorerInstructions(input.config.maxSteps);
	let observedBytes = 0;

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
				const check = await verifyCitations(input.root, action.citations);
				await transcript({
					event: "answer",
					step,
					found: action.found,
					verified: check.verified.length,
					rejected: check.rejected.map((entry) => ({ ...entry.citation, reason: entry.reason })),
				});
				// A claimed finding with nothing that checks out is the one case the
				// main agent must never receive as an answer. Spend a step asking for
				// real lines; out of steps, fail loudly instead.
				if (action.found && check.verified.length === 0) {
					if (remaining < 1) {
						throw new ExplorationIncompleteError(
							"The exploration answered with citations that could not be verified against the files.",
						);
					}
					turns.push({
						role: "user",
						text:
							"None of those citations were found at the lines you gave. Re-read the file and cite exact lines. " +
							stepsRemainingNotice(remaining),
					});
					continue;
				}
				return {
					explorationId: id,
					found: action.found,
					answer: clampAnswer(action.answer),
					citations: check.verified,
					rejected: check.rejected,
					steps: step,
					observedBytes,
					transcriptPath: transcriptPath(input.config.storeRoot, id),
				};
			}

			let observation: string;
			try {
				observation = await observe(input.root, action);
			} catch (error) {
				observation = `That action failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			observedBytes += Buffer.byteLength(observation, "utf8");
			await transcript({ event: "action", step, action: action.kind, observationBytes: Buffer.byteLength(observation, "utf8") });
			turns.push({ role: "user", text: `${observation}\n\n${stepsRemainingNotice(remaining)}` });
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
