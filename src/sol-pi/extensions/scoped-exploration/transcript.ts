/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The full record of one exploration, kept out of the model's context.
 *
 * The main window receives a short answer; everything the explorer actually saw
 * stays here. That is the whole point of the mechanism, but it would also make
 * the exploration unauditable, so every step is appended verbatim to a local
 * JSONL file whose path travels back with the answer.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type TranscriptRecord = Readonly<Record<string, unknown>>;
export type Transcript = (record: TranscriptRecord) => Promise<void>;

export function transcriptPath(storeRoot: string, explorationId: string): string {
	return join(storeRoot, `${explorationId}.jsonl`);
}

export function createTranscript(storeRoot: string, explorationId: string): Transcript {
	const path = transcriptPath(storeRoot, explorationId);
	let chain: Promise<void> = Promise.resolve();
	return (record) => {
		chain = chain
			.then(async () => {
				await mkdir(storeRoot, { recursive: true, mode: 0o700 });
				await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			})
			// Fail open: losing the audit line must never fail the exploration.
			.catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`[scopedexploration] transcript write failed: ${reason}`);
			});
		return chain;
	};
}
