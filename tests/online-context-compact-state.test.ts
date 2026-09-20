/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import { decideCompaction, DEFAULT_COMPACTION_ECONOMICS } from "../src/sol-pi/extensions/online-context-compact/economics.ts";
import {
	appendOnlineState,
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	recordBoundary,
	recordCompaction,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
} from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager } from "./helpers.ts";

const PLAN = [
	{ id: "inspect", goal: "inspect the implementation", status: "completed" as const },
	{ id: "verify", goal: "verify the change", status: "in_progress" as const },
];

const PROGRESS = {
	stepId: "inspect",
	goal: "inspect the implementation",
	filesChanged: ["src/a.ts"],
	verification: ["targeted test passed"],
	decisions: ["keep the change small"],
	nextWork: ["verify the change"],
};

describe("Online Context Compact state snapshots", () => {
	it("starts with a disabled-by-default empty state", () => {
		expect(initialOnlineState()).toEqual({
			version: 1,
			epoch: 0,
			plan: [],
			pendingProgress: [],
			requestCount: 0,
			lastBoundaryRequestCount: 0,
			completedBoundaryRequestCounts: [],
			lastContextTokens: null,
			positiveContextDeltaTotal: 0,
			positiveContextDeltaCount: 0,
			nativeCompactionCount: 0,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("restores the latest valid snapshot and ignores a malformed tail", () => {
		const manager = new FakeSessionManager();
		const pi = new FakePi(manager);
		const state = recordBoundary(recordProviderRequest(initialOnlineState(), 100), PLAN, PROGRESS);
		appendOnlineState(pi.asExtensionApi(), state);
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, { version: 1, plan: "broken" });

		expect(restoreOnlineState(manager.entries)).toEqual(state);
	});

	it("counts requests, positive context growth, and cache-debt repayment", () => {
		const charged = {
			...initialOnlineState(),
			cacheDebtTokens: 300,
			cacheDebtRepaymentTokens: 100,
		};
		const first = recordProviderRequest(charged, 1_000);
		const second = recordProviderRequest(first, 1_250);
		const third = recordProviderRequest(second, 900);

		expect(third).toMatchObject({
			requestCount: 3,
			lastContextTokens: 900,
			positiveContextDeltaTotal: 250,
			positiveContextDeltaCount: 1,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("records one request interval and one progress summary per boundary", () => {
		let state = initialOnlineState();
		state = recordProviderRequest(state, 100);
		state = recordProviderRequest(state, 200);
		state = recordBoundary(state, PLAN, PROGRESS);
		state = recordProviderRequest(state, 300);
		state = recordBoundary(state, PLAN, undefined);

		expect(state.completedBoundaryRequestCounts).toEqual([2, 1]);
		expect(state.lastBoundaryRequestCount).toBe(3);
		expect(state.pendingProgress).toEqual([PROGRESS]);
	});

	it("starts a clean epoch after native compaction and carries its cache debt", () => {
		const before = recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS);
		const after = recordCompaction(before, { debtTokens: 1_200, repaymentTokens: 300 });

		expect(after).toMatchObject({
			epoch: 1,
			pendingProgress: [],
			nativeCompactionCount: 1,
			cacheDebtTokens: 1_200,
			cacheDebtRepaymentTokens: 300,
		});
	});

	it("preserves unpaid cache-rebuild debt across a correction and resume", () => {
		const before = recordCompaction(initialOnlineState(), { debtTokens: 2_000_000, repaymentTokens: 59_000 });
		const corrected = recordCorrection(before);
		const manager = new FakeSessionManager();
		appendOnlineState(new FakePi(manager).asExtensionApi(), corrected);
		const restored = restoreOnlineState(manager.entries);
		expect(restored).toMatchObject({ cacheDebtTokens: 2_000_000, cacheDebtRepaymentTokens: 59_000, nativeCompactionCount: 1 });
		const next = recordProviderRequest(restored, 80_000);
		expect(next.cacheDebtTokens).toBe(1_941_000);
		expect(decideCompaction({
			writeTokens: 80_000,
			archiveTokens: 60_000,
			memoTokens: 1_000,
			contextTokens: 80_000,
			completedBoundaryRequestCounts: [4, 6, 5],
			remainingBoundaries: 4,
			averageContextTokenIncrement: 2_000,
			contextWindowTokens: 200_000,
			priorCompactionCount: next.nativeCompactionCount,
			carriedDebtTokens: next.cacheDebtTokens,
			cacheDebtRepaymentTokens: next.cacheDebtRepaymentTokens,
			cacheWriteReadRatio: 2,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		})).toMatchObject({ compact: false, reason: "deferred_carried_debt" });
	});

	it("drops stale plan history when the user corrects an active run", () => {
		const before = recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS);
		expect(recordCorrection(before)).toMatchObject({
			epoch: 1,
			plan: [],
			pendingProgress: [],
			completedBoundaryRequestCounts: [],
			lastContextTokens: null,
		});
	});
});
