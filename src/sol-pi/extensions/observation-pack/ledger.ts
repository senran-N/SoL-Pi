/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { FULL_SENDS, isObservationId } from "./observation.ts";

/**
 * Append-only JSONL record of what the mechanism did on each provider request.
 *
 * The caller derives the ledger path from the active Pi session.
 */
export type Ledger = (entry: Record<string, unknown>) => Promise<void>;

/**
 * Restore projection counts once per runtime root. `request` is a branch-local
 * assistant index, not a send count. Older full rows had no sendNumber; count
 * those rows, while a placeholder row alone proves the allowance was consumed.
 * These are projection attempts, not proof of provider delivery or cache hits.
 */
export async function readProjectionLedger(path: string): Promise<{ counts: Map<string, number>; packed: Set<string>; firstPass: Set<string> }> {
	const counts = new Map<string, number>();
	const packed = new Set<string>();
	const firstPass = new Set<string>();
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let invalidRows = 0;
	try {
		for await (const line of lines) {
			if (line.trim().length === 0) continue;
			let row: unknown;
			try { row = JSON.parse(line); } catch { invalidRows++; continue; }
			if (!row || typeof row !== "object" || Array.isArray(row)) { invalidRows++; continue; }
			const entry = row as Record<string, unknown>;
			if (entry.event !== "full" && entry.event !== "placeholder") continue;
			if (typeof entry.id !== "string" || !isObservationId(entry.id) ||
				(entry.sendNumber !== undefined &&
					(!Number.isSafeInteger(entry.sendNumber) || (entry.sendNumber as number) < 1))) {
				invalidRows++;
				continue;
			}
			const previous = counts.get(entry.id) ?? 0;
			if (entry.event === "placeholder") {
				packed.add(entry.id);
				if (entry.firstPass === true) firstPass.add(entry.id);
			}
			const count = entry.sendNumber as number | undefined;
			counts.set(entry.id, Math.max(previous, count ?? (entry.event === "full" ? previous + 1 : 0),
				entry.event === "placeholder" ? FULL_SENDS + 1 : 0));
		}
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	} finally {
		lines.close();
		stream.destroy();
	}
	if (invalidRows > 0) console.error(`[observationpack] ignored ${invalidRows} invalid ledger rows while restoring send counts`);
	return { counts, packed, firstPass };
}

export async function readSendCounts(path: string): Promise<Map<string, number>> {
	return (await readProjectionLedger(path)).counts;
}

export function createLedger(path: string): Ledger {
	return async (entry) => {
		await mkdir(dirname(path), { recursive: true });
		// Isolate each append from an unterminated (possibly torn) prior row.
		// Do not rewrite old bytes or rely on a separate tail check staying valid.
		await appendFile(path, `\n${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
	};
}
