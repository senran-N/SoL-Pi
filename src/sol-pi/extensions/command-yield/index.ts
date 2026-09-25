/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Command Yield - give the foreground a deadline, not the command a kill.
 *
 * Pi's shell tool waits for the child to exit and has no default timeout, so a
 * command that crashed without exiting, deadlocked, or blocked on stdin holds
 * the turn forever. This mechanism replaces the active shell tool's execution
 * backend with one that returns a partial observation and a live handle when
 * the command outlives its deadline. The command keeps running; the agent gets
 * its turn back and decides what to do with `exec_wait`, `exec_list`, and
 * `exec_kill`.
 *
 * Nothing here forks Pi. The backend is Pi's own, wrapped through the public
 * `BashToolOptions.operations` seam.
 */

import {
	type BashOperations,
	createBashToolDefinition,
	createPowerShellToolDefinition,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { runtimeRoot } from "../../runtime-paths.ts";
import { DEFAULT_COMMAND_YIELD_TIME_MS } from "./config.ts";
import { createYieldingOperations, createYieldingPowerShellOperations } from "./operations.ts";
import { createRegistry, type Registry } from "./registry.ts";
import { registerCommandYieldTools } from "./tools.ts";

export { DEFAULT_COMMAND_YIELD_TIME_MS, MAX_YIELD_TIME_MS, MIN_YIELD_TIME_MS, YIELD_MARKER } from "./config.ts";

export interface CommandYieldOptions {
	readonly yieldTimeMs?: number;
	/** Execution backend to wrap, primarily for tests and embedded runtimes. */
	readonly inner?: BashOperations;
}

export interface CommandYieldRuntime {
	readonly registry: Registry;
	/** Shared with Action Fusion so a fused `then_run` yields the same way. */
	readonly bashOperations: BashOperations;
}

export function createCommandYieldExtension(options: CommandYieldOptions = {}): {
	readonly factory: ExtensionFactory;
	readonly runtime: CommandYieldRuntime;
} {
	const yieldTimeMs = options.yieldTimeMs ?? DEFAULT_COMMAND_YIELD_TIME_MS;
	const registry = createRegistry();
	const bashOperations = createYieldingOperations({ registry, yieldTimeMs, inner: options.inner });

	const factory: ExtensionFactory = (pi: ExtensionAPI) => {
		pi.on("session_start", (_event, context) => {
			registry.setOutputRoot(join(runtimeRoot(context), "command-yield"));
		});
		const active = new Set(pi.getActiveTools());
		// Pi runs one shell tool per platform; replace the one that is live.
		const shells = active.has("powershell") ? ["powershell"] : ["bash"];

		for (const shell of shells) {
			const operations =
				shell === "powershell"
					? createYieldingPowerShellOperations({ registry, yieldTimeMs, inner: options.inner })
					: bashOperations;
			const definition =
				shell === "powershell"
					? createPowerShellToolDefinition(process.cwd(), { operations })
					: createBashToolDefinition(process.cwd(), { operations });
			// Everything else about the tool stays Pi's; only the deadline is new.
			pi.registerTool({
				...definition,
				async execute(toolCallId, params, signal, onUpdate, context) {
					registry.setOutputRoot(join(runtimeRoot(context), "command-yield"));
					return definition.execute(toolCallId, params, signal, onUpdate, context);
				},
				description: `${definition.description} A command still running after ${Math.round(yieldTimeMs / 1000)}s returns its output so far plus a handle and keeps running; continue it with exec_wait or stop it with exec_kill.`,
			});
		}

		registerCommandYieldTools(pi, { registry, yieldTimeMs });

		/*
		 * A yielded command has outlived the turn that started it, so nothing
		 * else will reap it. Leaving it behind is the orphan bug this mechanism
		 * exists to avoid, so the session takes its own children down with it.
		 */
		pi.on("session_shutdown", () => {
			registry.killAll();
		});
	};

	return { factory, runtime: { registry, bashOperations } };
}

export function registerCommandYield(pi: ExtensionAPI, options: CommandYieldOptions = {}): CommandYieldRuntime {
	const { factory, runtime } = createCommandYieldExtension(options);
	factory(pi);
	return runtime;
}
