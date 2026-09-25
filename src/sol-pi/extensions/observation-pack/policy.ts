/* SPDX-License-Identifier: MIT */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateRemainingRequests } from "../online-context-compact/economics.ts";
import { restoreOnlineState } from "../online-context-compact/state.ts";

export const DEFAULT_PACK_CACHE_RATIO = 12.5;

export type PackingDecision = {
	readonly pack: boolean;
	readonly reason: "stable_projection" | "first_projection" | "window_pressure" | "economic" | "horizon_unknown" | "cache_rebuild";
	readonly contextTokens: number;
	readonly savedTokens: number;
	readonly expectedRequests: number | null;
	readonly breakevenRequests: number;
};

/** A conservative forecast, not a claim about provider caching or money saved. */
export function packingDecision(input: {
	context: ExtensionContext;
	messages: readonly AgentMessage[];
	savedTokens: number;
	cacheWriteReadRatio: number;
	stable: boolean;
	firstProjection: boolean;
}): PackingDecision {
	const usage = input.context.getContextUsage();
	const localTokens = Math.ceil((JSON.stringify(input.messages).length + input.context.getSystemPrompt().length) / 4);
	const reported = usage?.tokens;
	const contextTokens = Math.max(localTokens, typeof reported === "number" && Number.isFinite(reported) ? reported : 0);
	const reportedWindow = usage?.contextWindow;
	const window = typeof reportedWindow === "number" && Number.isFinite(reportedWindow) && reportedWindow > 0
		? reportedWindow : input.context.model?.contextWindow;
	const pressure = typeof window === "number" && Number.isFinite(window) && window > 0 &&
		contextTokens >= window - Math.min(16_384, Math.floor(window * 0.2));
	const state = restoreOnlineState(input.context.sessionManager.getBranch());
	const remaining = state.plan.filter((step) => step.status !== "completed").length;
	const horizon = remaining > 0 && state.completedBoundaryRequestCounts.length > 0
		? estimateRemainingRequests({
			completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
			remainingBoundaries: remaining, scale: 1, standardDeviationK: 1,
			contextTokens, contextWindowTokens: window ?? null,
			averageContextTokenIncrement: state.positiveContextDeltaCount > 0
				? state.positiveContextDeltaTotal / state.positiveContextDeltaCount : null,
		}).expectedRemainingRequests : null;
	const savedTokens = Math.max(0, input.savedTokens);
	// Charge the entire current prefix, deliberately overestimating partial invalidation.
	const breakevenRequests = savedTokens > 0
		? contextTokens * Math.max(0, input.cacheWriteReadRatio - 1) / savedTokens : Number.MAX_SAFE_INTEGER;
	const reason = input.stable ? "stable_projection" : input.firstProjection ? "first_projection" : pressure ? "window_pressure"
		: breakevenRequests === 0 || (horizon !== null && horizon >= breakevenRequests) ? "economic"
		: horizon === null ? "horizon_unknown" : "cache_rebuild";
	return { pack: savedTokens > 0 && reason !== "horizon_unknown" && reason !== "cache_rebuild",
		reason, contextTokens, savedTokens, expectedRequests: horizon, breakevenRequests };
}
