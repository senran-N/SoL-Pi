/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadSolPiConfig, type SolPiConfig } from "./config.ts";
import { registerActionFusion } from "./extensions/action-fusion/index.ts";
import { registerCommandYield } from "./extensions/command-yield/index.ts";
import { registerEvidencePreservingReducer } from "./extensions/evidence-preserving-reducer/index.ts";
import { registerObservationPack } from "./extensions/observation-pack/index.ts";
import { registerOnlineContextCompact } from "./extensions/online-context-compact/index.ts";
import { registerScopedExploration } from "./extensions/scoped-exploration/index.ts";
import { registerUsageReport } from "./usage/index.ts";

export function registerConfiguredFeatures(pi: ExtensionAPI, config: SolPiConfig): void {
	/*
	 * Command Yield first: it owns the shell execution backend, and Action
	 * Fusion has to run a fused `then_run` through the same one or a fused
	 * long command would still block the turn.
	 */
	const commandYield = config.commandYield
		? registerCommandYield(pi, { yieldTimeMs: config.commandYieldTimeMs })
		: undefined;
	if (config.actionFusion) {
		registerActionFusion(pi, commandYield ? { bashOptions: { operations: commandYield.bashOperations } } : {});
	}
	if (config.observationPack) registerObservationPack(pi);
	if (config.evidencePreservingReducer) {
		registerEvidencePreservingReducer(pi, {
			reducerModel: config.evidencePreservingReducerModel,
			reducerProvider: config.evidencePreservingReducerProvider,
		});
	}
	if (config.onlineContextCompact) registerOnlineContextCompact(pi, config.cacheWriteReadRatio);
	if (config.scopedExploration) {
		registerScopedExploration(pi, {
			explorerModel: config.scopedExplorationModel,
			explorerProvider: config.scopedExplorationProvider,
			maxSteps: config.scopedExplorationMaxSteps,
		});
	}
	if (config.actionFusion || config.observationPack || config.evidencePreservingReducer ||
		config.onlineContextCompact || config.commandYield || config.scopedExploration) registerUsageReport(pi);
}

export type SolPiConfigLoader = (ctx: ExtensionContext) => SolPiConfig;

export function createSolPiExtension(
	loadConfig: SolPiConfigLoader = (ctx) => loadSolPiConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()),
): ExtensionFactory {
	return (pi) => {
		let initialized = false;
		pi.on("session_start", (_event, ctx) => {
			if (initialized) return;
			initialized = true;
			registerConfiguredFeatures(pi, loadConfig(ctx));
		});
	};
}

export default function solPiExtension(pi: ExtensionAPI): void {
	createSolPiExtension()(pi);
}
