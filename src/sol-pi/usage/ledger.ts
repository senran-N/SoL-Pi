/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeRoot } from "../runtime-paths.ts";

export const USAGE_SCHEMA = "sol-pi-usage/1";
export const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
export type Tokens = Record<(typeof TOKEN_FIELDS)[number], number>;
export type CallStatus = "pending" | "ok" | "error" | "aborted" | "not_sent";
export type Component = "main" | "reducer" | "explorer" | "summary" | "reset";
export type UsageRecord = {
	readonly id: string;
	readonly component: Component;
	readonly provider: string;
	readonly model: string;
	readonly status: CallStatus;
	readonly tokens: Tokens | null;
	/** Pi's recorded cost estimate, not a provider invoice. Zero prices are ambiguous. */
	readonly costEstimateUsd: number | null;
	readonly durationMs: number | null;
};

type AuxiliaryRecord = UsageRecord & { readonly schema: typeof USAGE_SCHEMA; readonly startedAt: string };
export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
export const usageLedgerPath = (root: string): string => join(root, "usage.jsonl");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Copy only numeric fields. Never persist provider objects, prompts or error text. */
export function tokenUsage(value: unknown): Tokens | null {
	if (!object(value) || !TOKEN_FIELDS.every((field) => nonnegative(value[field]))) return null;
	return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, value[field]])) as Tokens;
}

export function usageMetrics(value: unknown, failed: boolean): Pick<UsageRecord, "tokens" | "costEstimateUsd"> {
	let tokens = tokenUsage(value);
	// Pi often synthesizes an all-zero usage for an interrupted request. That
	// is not evidence the server did no work or will not bill it.
	if (failed && tokens && Object.values(tokens).every((count) => count === 0)) tokens = null;
	const cost = object(value) && object(value.cost) ? value.cost.total : undefined;
	return { tokens, costEstimateUsd: nonnegative(cost) && cost > 0 ? cost : null };
}

export class UsageLedgerError extends Error {
	override readonly name = "UsageLedgerError";
}

async function appendRecord(root: string, record: AuxiliaryRecord): Promise<void> {
	try {
		await mkdir(root, { recursive: true });
		const path = usageLedgerPath(root);
		await withFileMutationQueue(path, () => appendFile(path, `${JSON.stringify(record)}\n`, "utf8"));
	} catch {
		// Do not copy filesystem/provider error messages, which can contain secrets.
		throw new UsageLedgerError("Could not persist SoL-Pi usage. Inspect the session's usage.jsonl before retrying a model call.");
	}
}

/**
 * Write intent before doing work. A crash or failed final write leaves a pending
 * record with unknown usage rather than making the attempted call disappear.
 * The callback marks the call immediately before entering Pi's provider API.
 */
export async function trackModelCall(
	context: ExtensionContext,
	component: "reducer" | "explorer",
	route: { readonly provider: string; readonly model: string },
	call: (dispatched: () => void) => Promise<AssistantMessage>,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const root = runtimeRoot(context);
	const started = performance.now();
	const pending: AuxiliaryRecord = {
		schema: USAGE_SCHEMA, id: randomUUID(), startedAt: new Date().toISOString(), component,
		provider: route.provider, model: route.model, status: "pending", tokens: null, costEstimateUsd: null, durationMs: null,
	};
	await appendRecord(root, pending);
	let dispatched = false;
	let response: AssistantMessage;
	try {
		signal?.throwIfAborted();
		response = await call(() => { dispatched = true; });
	} catch (error) {
		await appendRecord(root, { ...pending,
			status: !dispatched ? "not_sent" : signal?.aborted ? "aborted" : "error",
			tokens: dispatched ? null : zeroTokens(), costEstimateUsd: dispatched ? null : 0,
			durationMs: Math.max(0, performance.now() - started),
		});
		throw error;
	}
	const status: CallStatus = response.stopReason === "aborted" ? "aborted" :
		response.stopReason === "error" || response.stopReason === "pending" ? "error" : "ok";
	await appendRecord(root, { ...pending, status,
		...usageMetrics(response.usage, status !== "ok"), durationMs: Math.max(0, performance.now() - started),
	});
	return response;
}

function parseRecord(value: unknown): AuxiliaryRecord | undefined {
	if (!object(value) || value.schema !== USAGE_SCHEMA || typeof value.id !== "string" || !value.id ||
		(value.component !== "reducer" && value.component !== "explorer") ||
		typeof value.provider !== "string" || typeof value.model !== "string" || typeof value.startedAt !== "string" ||
		!(["pending", "ok", "error", "aborted", "not_sent"] as unknown[]).includes(value.status) ||
		(value.durationMs !== null && !nonnegative(value.durationMs)) ||
		(value.costEstimateUsd !== null && !nonnegative(value.costEstimateUsd)) ||
		(value.tokens !== null && tokenUsage(value.tokens) === null)) return undefined;
	return value as AuxiliaryRecord;
}

/** Missing is normal for old sessions; corrupt lines are an explicit coverage gap. */
export async function readUsageLedger(root: string): Promise<{
	readonly records: readonly UsageRecord[]; readonly invalidRecords: number;
}> {
	const records = new Map<string, AuxiliaryRecord>();
	let invalidRecords = 0;
	const stream = createReadStream(usageLedgerPath(root), { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			let record: AuxiliaryRecord | undefined;
			try { record = parseRecord(JSON.parse(line)); } catch { /* counted below */ }
			if (!record) { invalidRecords++; continue; }
			const previous = records.get(record.id);
			if (previous && (previous.component !== record.component || previous.provider !== record.provider ||
				previous.model !== record.model || previous.startedAt !== record.startedAt)) {
				invalidRecords++;
				continue;
			}
			// Replayed starts must not erase a terminal outcome.
			if (!previous || record.status !== "pending") records.set(record.id, record);
		}
	} catch (error) {
		if (!object(error) || error.code !== "ENOENT") throw new UsageLedgerError("Could not read SoL-Pi usage ledger.");
	} finally {
		lines.close();
		stream.destroy();
	}
	return { records: [...records.values()], invalidRecords };
}
