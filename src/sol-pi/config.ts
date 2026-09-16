/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_COMMAND_YIELD_TIME_MS,
	MAX_YIELD_TIME_MS,
	MIN_YIELD_TIME_MS,
} from "./extensions/command-yield/config.ts";
import {
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
} from "./extensions/evidence-preserving-reducer/config.ts";
import {
	DEFAULT_EXPLORER_MODEL,
	DEFAULT_EXPLORER_PROVIDER,
	DEFAULT_MAX_STEPS,
	MAX_MAX_STEPS,
	MIN_MAX_STEPS,
} from "./extensions/scoped-exploration/config.ts";

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;

export interface SolPiConfig {
	readonly version: 1;
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly evidencePreservingReducerModel: string;
	readonly evidencePreservingReducerProvider: string;
	readonly onlineContextCompact: boolean;
	readonly commandYield: boolean;
	readonly commandYieldTimeMs: number;
	readonly scopedExploration: boolean;
	readonly scopedExplorationModel: string;
	readonly scopedExplorationProvider: string;
	readonly scopedExplorationMaxSteps: number;
	readonly cacheWriteReadRatio: number;
}

export const DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
	evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
	onlineContextCompact: false,
	commandYield: false,
	commandYieldTimeMs: DEFAULT_COMMAND_YIELD_TIME_MS,
	scopedExploration: false,
	scopedExplorationModel: DEFAULT_EXPLORER_MODEL,
	scopedExplorationProvider: DEFAULT_EXPLORER_PROVIDER,
	scopedExplorationMaxSteps: DEFAULT_MAX_STEPS,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
});

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
	"commandYield",
	"scopedExploration",
] as const;
const STRING_KEYS = [
	"evidencePreservingReducerModel",
	"evidencePreservingReducerProvider",
	"scopedExplorationModel",
	"scopedExplorationProvider",
] as const;
const CONFIG_KEYS = new Set<string>([
	"version",
	...FEATURE_KEYS,
	...STRING_KEYS,
	"cacheWriteReadRatio",
	"commandYieldTimeMs",
	"scopedExplorationMaxSteps",
]);

export function findConfigPath(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): string | undefined {
	if (allowProjectConfig) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "sol-pi.json");
		if (existsSync(projectPath)) return projectPath;
	}

	const globalPath = join(agentDir, "sol-pi.json");
	return existsSync(globalPath) ? globalPath : undefined;
}

export function loadSolPiConfig(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): SolPiConfig {
	const path = findConfigPath(cwd, agentDir, allowProjectConfig);
	if (!path) return DEFAULT_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read SoL-Pi config ${path}: ${reason}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`SoL-Pi config must be a JSON object: ${path}`);
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown SoL-Pi config key: ${key}`);
	}
	if (record.version !== 1) throw new Error(`SoL-Pi config version must be 1: ${path}`);

	for (const key of FEATURE_KEYS) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new Error(`SoL-Pi config ${key} must be boolean: ${path}`);
		}
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		throw new Error(`SoL-Pi config cacheWriteReadRatio must be a finite non-negative number: ${path}`);
	}
	const commandYieldTimeMs = Object.hasOwn(record, "commandYieldTimeMs")
		? record.commandYieldTimeMs
		: DEFAULT_COMMAND_YIELD_TIME_MS;
	if (
		typeof commandYieldTimeMs !== "number" ||
		!Number.isInteger(commandYieldTimeMs) ||
		commandYieldTimeMs < MIN_YIELD_TIME_MS ||
		commandYieldTimeMs > MAX_YIELD_TIME_MS
	) {
		throw new Error(
			`SoL-Pi config commandYieldTimeMs must be an integer between ${MIN_YIELD_TIME_MS} and ${MAX_YIELD_TIME_MS}: ${path}`,
		);
	}
	const scopedExplorationMaxSteps = Object.hasOwn(record, "scopedExplorationMaxSteps")
		? record.scopedExplorationMaxSteps
		: DEFAULT_MAX_STEPS;
	if (
		typeof scopedExplorationMaxSteps !== "number" ||
		!Number.isInteger(scopedExplorationMaxSteps) ||
		scopedExplorationMaxSteps < MIN_MAX_STEPS ||
		scopedExplorationMaxSteps > MAX_MAX_STEPS
	) {
		throw new Error(
			`SoL-Pi config scopedExplorationMaxSteps must be an integer between ${MIN_MAX_STEPS} and ${MAX_MAX_STEPS}: ${path}`,
		);
	}
	const evidencePreservingReducerModel = stringConfigValue(
		record,
		"evidencePreservingReducerModel",
		DEFAULT_REDUCER_MODEL,
		path,
	);
	const evidencePreservingReducerProvider = stringConfigValue(
		record,
		"evidencePreservingReducerProvider",
		DEFAULT_REDUCER_PROVIDER,
		path,
	);
	const scopedExplorationModel = stringConfigValue(record, "scopedExplorationModel", DEFAULT_EXPLORER_MODEL, path);
	const scopedExplorationProvider = stringConfigValue(
		record,
		"scopedExplorationProvider",
		DEFAULT_EXPLORER_PROVIDER,
		path,
	);

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		commandYieldTimeMs,
		evidencePreservingReducerModel,
		evidencePreservingReducerProvider,
		scopedExplorationMaxSteps,
		scopedExplorationModel,
		scopedExplorationProvider,
	}) as SolPiConfig;
}

function stringConfigValue(
	record: Record<string, unknown>,
	key: (typeof STRING_KEYS)[number],
	defaultValue: string,
	path: string,
): string {
	const value = Object.hasOwn(record, key) ? record[key] : defaultValue;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`SoL-Pi config ${key} must be a non-empty string: ${path}`);
	}
	return value;
}
