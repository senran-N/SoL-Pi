/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { TOKEN_FIELDS, usageMetrics, zeroTokens, type Component, type Tokens, type UsageRecord } from "./ledger.ts";

/** Read all branches: switching the active leaf does not undo incurred cost. */
export function sessionUsage(entries: readonly SessionEntry[]): UsageRecord[] {
	const records = new Map<string, UsageRecord>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const status = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" :
				message.stopReason === "pending" || message.stopReason === "deferred" ? "pending" : "ok";
			records.set(entry.id, { id: entry.id, component: "main", provider: message.provider, model: message.model,
				status, ...usageMetrics(message.usage, status !== "ok"), durationMs: null });
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			const details = entry.details as { solPiWindow?: { version?: number; mode?: string } } | undefined;
			const reset = entry.type === "compaction" && details?.solPiWindow?.version === 1 && details.solPiWindow.mode === "reset";
			records.set(entry.id, { id: entry.id, component: reset ? "reset" : "summary",
				// Native summary entries do not identify the route. The current model
				// is not reliable evidence of which model created an old summary.
				provider: "unrecorded", model: "unrecorded", status: "ok", durationMs: null,
				...(reset ? { tokens: zeroTokens(), costEstimateUsd: 0 } : usageMetrics(entry.usage, true)),
			});
		}
	}
	return [...records.values()];
}

export type UsageTotals = {
	records: number;
	errors: number;
	aborted: number;
	pending: number;
	notSent: number;
	reportedTokens: Tokens;
	unknownUsageRecords: number;
	knownCostEstimateUsd: number;
	unknownCostRecords: number;
	recordedDurationMs: number;
};

export function sumUsage(records: readonly UsageRecord[]): UsageTotals {
	const sum: UsageTotals = { records: records.length, errors: 0, aborted: 0, pending: 0, notSent: 0,
		reportedTokens: zeroTokens(), unknownUsageRecords: 0, knownCostEstimateUsd: 0, unknownCostRecords: 0, recordedDurationMs: 0 };
	for (const record of records) {
		if (record.status === "error") sum.errors++;
		if (record.status === "aborted") sum.aborted++;
		if (record.status === "pending") sum.pending++;
		if (record.status === "not_sent") sum.notSent++;
		if (record.tokens === null) sum.unknownUsageRecords++;
		else for (const field of TOKEN_FIELDS) sum.reportedTokens[field] += record.tokens[field];
		if (record.costEstimateUsd === null) sum.unknownCostRecords++;
		else sum.knownCostEstimateUsd += record.costEstimateUsd;
		sum.recordedDurationMs += record.durationMs ?? 0;
	}
	return sum;
}

export function usageReport(session: readonly SessionEntry[], auxiliary: readonly UsageRecord[], invalidRecords: number) {
	const records = [...sessionUsage(session), ...auxiliary];
	const components: Component[] = ["main", "reducer", "explorer", "summary", "reset"];
	const routes = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = JSON.stringify([record.component, record.provider, record.model]);
		const group = routes.get(key) ?? [];
		group.push(record);
		routes.set(key, group);
	}
	return {
		schema: "sol-pi-usage-report/1",
		scope: "all entries in this Pi session plus this session's auxiliary ledger; not a cross-session bill",
		totals: sumUsage(records),
		components: components.map((component) => ({ component, ...sumUsage(records.filter((record) => record.component === component)) })),
		routes: [...routes.values()].slice(0, 32).map((group) => ({ component: group[0]!.component,
			provider: group[0]!.provider, model: group[0]!.model, ...sumUsage(group) })),
		omittedRoutes: Math.max(0, routes.size - 32),
		invalidLedgerRecords: invalidRecords,
		limitations: [
			"Costs are Pi-recorded estimates, not invoices or net savings. Zero/missing prices are unknown, not free.",
			"Token sums cover reported usage only. Errors with zero usage and unfinished calls remain unknown.",
			"Auxiliary coverage starts when this ledger is enabled; older calls and unrecorded main retries cannot be reconstructed.",
			"Native summaries may combine multiple calls; their routes and durations are not recorded by Pi.",
			"Reset rows mean no summary model call, not free cache rebuilding. Later main usage includes reported cache tokens.",
			"Forked sessions may contain copied main history but have a separate auxiliary ledger; do not add session totals as a bill.",
		],
	};
}
