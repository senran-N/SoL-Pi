/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Local audit trail for Online Context Compact window transitions.
 *
 * Every compaction writes one JSONL line, so the handoff that replaced context
 * stays inspectable after the fact. This is deliberately plain text: the point
 * of the windowed handoff is that evidence stays verifiable locally.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CompactionDecision, CompactionReason } from "./economics.ts";

export type WindowLedgerRecord = {
	readonly transitionId: string;
	readonly stage: "decision" | "commit" | "outcome";
	readonly event: "reset" | "summary";
	readonly reason: "manual" | "threshold" | "overflow" | CompactionReason;
	readonly outcome?: "deferred" | "committed" | "rejected" | "aborted" | "failed" | "noop";
	readonly decision?: CompactionDecision;
	readonly windowNumber: number;
	readonly windowId: string;
	readonly previousWindowId: string | null;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly fragmentBytes: number;
	readonly at: string;
};

export function windowLedgerPath(root: string): string {
	return join(root, "online-context-compact", "windows.jsonl");
}

export async function appendWindowLedger(root: string, record: WindowLedgerRecord): Promise<void> {
	const path = windowLedgerPath(root);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `\n${JSON.stringify(record)}\n`, "utf8");
}
