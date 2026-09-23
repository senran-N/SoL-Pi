/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Shared coordination state for the standalone SoL-Pi mechanisms. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectPiCapabilities, formatCapabilities, type PiCapabilities } from "./pi-compat.ts";
import { runtimeRoot } from "./runtime-paths.ts";
import type { SolPiConfig } from "./config.ts";

export type SolPiFeatureStatus = "enabled" | "disabled";

export interface SolPiRuntimeSnapshot {
	readonly schema: "sol-pi-runtime/1";
	readonly root: string;
	readonly capabilities: PiCapabilities;
	readonly capabilityLines: readonly string[];
	readonly features: Readonly<Record<string, SolPiFeatureStatus>>;
	readonly warnings: readonly string[];
}

export function createSolPiRuntime(context: ExtensionContext, config: SolPiConfig): SolPiRuntimeSnapshot {
	const capabilities = detectPiCapabilities(context);
	const features: Record<string, SolPiFeatureStatus> = {
		actionFusion: config.actionFusion ? "enabled" : "disabled",
		observationPack: config.observationPack ? "enabled" : "disabled",
		evidencePreservingReducer: config.evidencePreservingReducer ? "enabled" : "disabled",
		onlineContextCompact: config.onlineContextCompact ? "enabled" : "disabled",
		commandYield: config.commandYield ? "enabled" : "disabled",
		scopedExploration: config.scopedExploration ? "enabled" : "disabled",
	};
	const warnings: string[] = [];
	if ((config.evidencePreservingReducer || config.scopedExploration) && !capabilities.modelRegistryFind) {
		warnings.push("nested model features are enabled but Pi exposes no model resolver");
	}
	if ((config.evidencePreservingReducer || config.scopedExploration) && !capabilities.modelRegistryComplete && !capabilities.modelRegistryAuth) {
		warnings.push("nested model features have no compatible Pi completion/authentication path");
	}
	if (config.onlineContextCompact && !capabilities.nativeCompaction) {
		warnings.push("online context compact is enabled but Pi exposes no compaction callback");
	}
	return Object.freeze({
		schema: "sol-pi-runtime/1",
		root: runtimeRoot(context),
		capabilities,
		capabilityLines: formatCapabilities(capabilities),
		features: Object.freeze(features),
		warnings: Object.freeze(warnings),
	});
}
