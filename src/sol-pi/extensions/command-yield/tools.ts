/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The three tools that act on a yielded command: collect more of its output,
 * see what is still alive, and stop it.
 *
 * `exec_wait` returns only the bytes produced since the last yield. Re-sending
 * the whole buffer on every poll is exactly the waste the other SoL-Pi
 * mechanisms exist to prevent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderSolPiTool } from "../../tui.ts";
import { COMMAND_RESULT_SCHEMA } from "./command-results.ts";
import { MAX_YIELD_TIME_MS, MIN_YIELD_TIME_MS } from "./config.ts";
import { type Handle, type HandleSnapshot, isHandleId, type Registry } from "./registry.ts";

const WAIT_MAX_BYTES = 16 * 1024;
const WAIT_MAX_LINES = 400;
const WAIT_HEADER_RESERVE_BYTES = 1024;
const WAIT_HEADER_LINES = 3;

const WAIT_LIMITS = {
	maxBytes: WAIT_MAX_BYTES - WAIT_HEADER_RESERVE_BYTES,
	maxLines: WAIT_MAX_LINES - WAIT_HEADER_LINES,
};

function elapsedSeconds(snapshot: HandleSnapshot): number {
	return Math.max(0, Math.round(((snapshot.settledAt ?? Date.now()) - snapshot.startedAt) / 1000));
}

function describe(snapshot: HandleSnapshot): string {
	const parts = [`handle=${snapshot.id}`, `status=${snapshot.status}`, `elapsed=${elapsedSeconds(snapshot)}s`];
	if (snapshot.exitCode !== undefined && snapshot.exitCode !== null) parts.push(`exit_code=${snapshot.exitCode}`);
	if (snapshot.error) parts.push(`error=${JSON.stringify(snapshot.error)}`);
	return parts.join(" ");
}

function resolveHandle(registry: Registry, id: string): Handle {
	if (!isHandleId(id)) throw new Error(`Unknown command handle: ${id}`);
	const handle = registry.get(id);
	if (!handle) throw new Error(`Unknown command handle: ${id}`);
	return handle;
}

export interface CommandYieldToolOptions {
	readonly registry: Registry;
	/** Default wait budget, shared with the foreground deadline. */
	readonly yieldTimeMs: number;
}

export function registerCommandYieldTools(pi: ExtensionAPI, options: CommandYieldToolOptions): void {
	const { registry, yieldTimeMs } = options;

	pi.registerTool({
		name: "exec_wait",
		label: "Wait For Command",
		description:
			"Collect output a yielded command produced since the last time it was read, and report whether it is still running. Returns as soon as there is new output or the command ends.",
		promptSnippet: "Resume a command that yielded its handle instead of blocking the turn",
		promptGuidelines: [
			"A yielded command is still running: nothing was lost and nothing was killed.",
			"Raise exec_wait's yield_time_ms exponentially across successive waits, up to minutes, rather than polling in a tight loop.",
			"Judge whether a command is alive from its handle status, never from how its output reads.",
		],
		renderShell: "self",
		parameters: Type.Object({
			handle: Type.String({ description: "Handle from a command-yield trailer or exec_list" }),
			yield_time_ms: Type.Optional(
				Type.Integer({
					minimum: MIN_YIELD_TIME_MS,
					maximum: MAX_YIELD_TIME_MS,
					description: `How long to wait for more output before yielding again, default ${yieldTimeMs}`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const handle = resolveHandle(registry, params.handle);
			const budget = Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, params.yield_time_ms ?? yieldTimeMs));
			await registry.wait(handle, budget);

			const increment = registry.take(handle, WAIT_LIMITS);
			const snapshot = registry.snapshot(handle);
			const header = [
				`[exec_wait ${describe(snapshot)} command_sha256=${snapshot.commandSha256} category=${snapshot.diagnosticCategory} start_byte=${increment.startOffset} end_byte=${increment.endOffset} new_bytes=${increment.bytes} new_lines=${increment.lines}]`,
				snapshot.status === "running"
					? `[still running; ${increment.remainingBytes} bytes pending, call exec_wait again with a larger yield_time_ms or exec_kill to stop it]`
					: increment.remainingBytes > 0
						? `[process finished; ${increment.remainingBytes} bytes pending; call exec_wait again to collect the remaining output]`
						: `[finished; 0 bytes pending]`,
			].join("\n");
			const dropped =
				increment.droppedBytes > 0
					? `\n[${increment.droppedBytes} bytes of older output were dropped to bound memory]`
					: "";
			const artifact = snapshot.outputPath ? `\n[full_output=${JSON.stringify(snapshot.outputPath)}]` : "";
			const text = `${header}${artifact}${dropped}\n${increment.text}`;
			const details = { ...snapshot, newBytes: increment.bytes, newLines: increment.lines,
				commandYield: { schema: COMMAND_RESULT_SCHEMA, ...snapshot,
					startByte: increment.startOffset, endByte: increment.endOffset, outputComplete: snapshot.status !== "running" && increment.remainingBytes === 0 } };

			// A command that failed must still read as a failure to the agent and
			// to every mechanism that keys off an errored tool result.
			if (snapshot.status === "failed" || snapshot.status === "killed" || (typeof snapshot.exitCode === "number" && snapshot.exitCode !== 0)) {
				throw new Error(text);
			}
			return { content: [{ type: "text", text }], details };
		},
		renderCall(params, theme) {
			const base = new Text(theme.fg("dim", `Wait for ${params.handle}`), 0, 0);
			return renderSolPiTool(theme, "Command Yield", "blocked turn time avoided", base);
		},
	});

	pi.registerTool({
		name: "exec_list",
		label: "List Commands",
		description: "List every command that yielded a handle in this session, with its status and pending output.",
		promptSnippet: "List commands that yielded a handle, including ones still running",
		renderShell: "self",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const snapshots = registry.list();
			const text =
				snapshots.length === 0
					? "[exec_list] No command has yielded a handle in this session."
					: [
							`[exec_list count=${snapshots.length}]`,
							...snapshots.map(
								(snapshot) =>
									`${describe(snapshot)} pending_bytes=${snapshot.pendingBytes} category=${snapshot.diagnosticCategory} command_sha256=${snapshot.commandSha256}`,
							),
						].join("\n");
			return { content: [{ type: "text", text }], details: { handles: snapshots } };
		},
		renderCall(_params, theme) {
			const base = new Text(theme.fg("dim", "List yielded commands"), 0, 0);
			return renderSolPiTool(theme, "Command Yield", "live command inventory", base);
		},
	});

	pi.registerTool({
		name: "exec_kill",
		label: "Kill Command",
		description: "Stop a yielded command and its whole process tree.",
		promptSnippet: "Stop a command that yielded a handle",
		renderShell: "self",
		parameters: Type.Object({
			handle: Type.String({ description: "Handle from a command-yield trailer or exec_list" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const handle = resolveHandle(registry, params.handle);
			const wasRunning = registry.snapshot(handle).status === "running";
			registry.kill(handle);
			if (wasRunning) await registry.wait(handle, MIN_YIELD_TIME_MS);
			const snapshot = registry.snapshot(handle);
			const text = wasRunning
				? `[exec_kill ${describe(snapshot)}]`
				: `[exec_kill ${describe(snapshot)}]\n[the command had already finished; nothing was stopped]`;
			return { content: [{ type: "text", text }], details: snapshot };
		},
		renderCall(params, theme) {
			const base = new Text(theme.fg("dim", `Kill ${params.handle}`), 0, 0);
			return renderSolPiTool(theme, "Command Yield", "stuck command released", base);
		},
	});
}
