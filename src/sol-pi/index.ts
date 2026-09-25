/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadSolPiConfig, type SolPiConfig } from "./config.ts";
import { createSolPiRuntime } from "./runtime.ts";
import { registerActionFusion } from "./extensions/action-fusion/index.ts";
import { registerCommandYield } from "./extensions/command-yield/index.ts";
import { registerEvidencePreservingReducer } from "./extensions/evidence-preserving-reducer/index.ts";
import { registerObservationPack } from "./extensions/observation-pack/index.ts";
import { registerOnlineContextCompact } from "./extensions/online-context-compact/index.ts";
import { registerScopedExploration } from "./extensions/scoped-exploration/index.ts";
import { registerUsageReport } from "./usage/index.ts";
import { Type } from "typebox";

export function registerConfiguredFeatures(pi: ExtensionAPI, config: SolPiConfig, initialContext?: ExtensionContext): void {
	let runtimeSnapshot = initialContext ? createSolPiRuntime(initialContext, config) : undefined;
	if (Object.values(config).some((value) => value === true)) {
		pi.registerTool({
			name: "sol_pi_diagnostics",
			label: "SoL-Pi Diagnostics",
			description: "Inspect enabled SoL-Pi mechanisms, Pi capability detection, and non-secret compatibility warnings. No model call.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute(_id, _params, signal, _onUpdate, context) {
				signal?.throwIfAborted();
				runtimeSnapshot = createSolPiRuntime(context, config);
				return {
					content: [{ type: "text", text: JSON.stringify(runtimeSnapshot, null, 2) }],
					details: runtimeSnapshot,
				};
			},
		});
	}
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
	if (config.observationPack) registerObservationPack(pi, { cacheWriteReadRatio: config.cacheWriteReadRatio });
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
			excludedPaths: config.scopedExplorationExcludedPaths,
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
			registerConfiguredFeatures(pi, loadConfig(ctx), ctx);
		});
	};
}

export default function solPiExtension(pi: ExtensionAPI): void {
	createSolPiExtension()(pi);
}
