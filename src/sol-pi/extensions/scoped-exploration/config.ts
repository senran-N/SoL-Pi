/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { join } from "node:path";
import { DEFAULT_REDUCER_MODEL, DEFAULT_REDUCER_PROVIDER } from "../evidence-preserving-reducer/config.ts";

export const EXPLORATION_SCHEMA = "sol-pi-exploration/1" as const;
/**
 * A line-based receipt, like the reducer's, rather than a tagged envelope.
 *
 * Citation quotes are raw project lines. A checkout that happens to contain the
 * closing tag would let its own content end the envelope early and continue as
 * if SoL-Pi had written what follows, so there is deliberately no tag to close
 * and every quote is rendered as a JSON string.
 */
export const EXPLORATION_RECEIPT_PREFIX = "sol_pi_exploration_v1" as const;

/**
 * The explorer shares Evidence-Preserving Reducer's built-in route by default:
 * both are the same kind of errand - a cheap model reading a lot so the frontier
 * model does not have to - and an installation that configured one sensible
 * nested route should not have to configure a second.
 */
export const DEFAULT_EXPLORER_PROVIDER = DEFAULT_REDUCER_PROVIDER;
export const DEFAULT_EXPLORER_MODEL = DEFAULT_REDUCER_MODEL;

export const DEFAULT_MAX_STEPS = 8;
export const MIN_MAX_STEPS = 1;
export const MAX_MAX_STEPS = 32;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/** What the main window is allowed to receive back. */
export const MAX_ANSWER_BYTES = 2_048;
export const MAX_CITATIONS = 12;
export const MAX_QUOTE_BYTES = 400;

/** What one step inside the exploration is allowed to observe. */
export const OBSERVATION_MAX_BYTES = 4_096;
export const GREP_MAX_HITS = 40;
export const READ_MAX_LINES = 200;
export const LIST_MAX_ENTRIES = 100;

/** Bounds on the walk itself, so a large repository cannot stall a step. */
export const SCAN_MAX_FILES = 2_000;
export const SCAN_MAX_FILE_BYTES = 1_048_576;

export const DEFAULT_EXCLUDED_PATHS: readonly string[] = [
	".env",
	".env.*",
	"**/*credential*",
	"**/*secret*",
	"**/*.pem",
	"**/*.key",
];

export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".pi",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"target",
	".venv",
	"__pycache__",
]);

export interface ExplorationConfig {
	readonly excludedPaths: readonly string[];
	readonly explorerModel: string;
	readonly explorerProvider: string;
	readonly maxOutputTokens: number;
	readonly maxSteps: number;
	readonly storeRoot: string;
	readonly timeoutMs: number;
}

export interface ExplorationConfigOptions {
	readonly excludedPaths?: readonly string[];
	readonly explorerModel?: string;
	readonly explorerProvider?: string;
	readonly maxSteps?: number;
}

export function resolveMaxSteps(value: number | undefined): number {
	const resolved = value ?? DEFAULT_MAX_STEPS;
	if (!Number.isSafeInteger(resolved) || resolved < MIN_MAX_STEPS || resolved > MAX_MAX_STEPS) {
		throw new Error(
			`Scoped Exploration maxSteps must be an integer between ${MIN_MAX_STEPS} and ${MAX_MAX_STEPS}`,
		);
	}
	return resolved;
}

export function loadExplorationConfig(
	runtimeDirectory: string,
	options: ExplorationConfigOptions = {},
): ExplorationConfig {
	return Object.freeze({
		excludedPaths: Object.freeze([...(options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS)]),
		explorerModel: options.explorerModel ?? DEFAULT_EXPLORER_MODEL,
		explorerProvider: options.explorerProvider ?? DEFAULT_EXPLORER_PROVIDER,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		maxSteps: resolveMaxSteps(options.maxSteps),
		storeRoot: join(runtimeDirectory, "scoped-exploration"),
		timeoutMs: DEFAULT_TIMEOUT_MS,
	});
}
