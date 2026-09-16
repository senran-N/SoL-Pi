/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The yielding shell backend.
 *
 * Pi's shell tool has no default timeout: `ops.exec` resolves when the child
 * exits, so a crashed, deadlocked, or stdin-blocked command blocks the turn
 * forever. This wrapper gives the foreground a deadline without giving the
 * command a death sentence. When the deadline passes first, it returns the
 * output so far plus a handle, and the command keeps running behind it.
 *
 * It composes Pi's own execution backend rather than replacing it, so process
 * tree teardown, shell resolution, and environment handling stay Pi's.
 */

import {
	type BashOperations,
	createLocalBashOperations,
	createLocalPowerShellOperations,
} from "@earendil-works/pi-coding-agent";
import { YIELD_MARKER } from "./config.ts";
import type { Handle, Registry } from "./registry.ts";

export interface YieldingOperationsOptions {
	readonly registry: Registry;
	/** Foreground deadline in milliseconds. */
	readonly yieldTimeMs: number;
	/** Execution backend to wrap. Defaults to Pi's local bash operations. */
	readonly inner?: BashOperations;
}

export function yieldTrailer(handle: Handle, elapsedMs: number): string {
	const seconds = Math.max(1, Math.round(elapsedMs / 1000));
	return [
		`${YIELD_MARKER} still running after ${seconds}s — handle=${handle.id}`,
		"The command was not stopped and no output is lost. Call exec_wait with this handle to collect",
		"what it prints next, or exec_kill to stop it. Raise exec_wait's yield_time_ms exponentially",
		"instead of polling in a tight loop.",
	].join("\n");
}

export function createYieldingOperations(options: YieldingOperationsOptions): BashOperations {
	const inner = options.inner ?? createLocalBashOperations();
	return wrap(inner, options);
}

export function createYieldingPowerShellOperations(options: YieldingOperationsOptions): BashOperations {
	const inner = options.inner ?? createLocalPowerShellOperations();
	return wrap(inner, options);
}

function wrap(inner: BashOperations, options: YieldingOperationsOptions): BashOperations {
	const { registry, yieldTimeMs } = options;

	return {
		async exec(command, cwd, execOptions) {
			const handle = registry.create(command, cwd);
			const startedAt = Date.now();

			/*
			 * The child is aborted through our own controller, never Pi's call
			 * signal directly. Before the yield the two are linked, so an
			 * interrupted turn still kills the tree. After the yield the handle
			 * owns the command, and the next turn's abort must not reach it.
			 */
			const own = new AbortController();
			let foreground = true;
			let endsWithNewline = true;

			const abortForeground = () => {
				if (foreground) own.abort();
			};
			execOptions.signal?.addEventListener("abort", abortForeground, { once: true });
			if (execOptions.signal?.aborted) own.abort();
			handle.abort = () => own.abort();

			const forward = (data: Buffer) => {
				if (data.length > 0) endsWithNewline = data[data.length - 1] === 0x0a;
				execOptions.onData(data);
			};

			const settled = inner
				.exec(command, cwd, {
					...execOptions,
					signal: own.signal,
					onData: (data) => {
						registry.append(handle, data);
						if (foreground) forward(data);
					},
				})
				.then((result) => {
					registry.settle(handle, result.exitCode === null ? "killed" : "exited", result.exitCode);
					return result;
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					registry.settle(handle, message === "aborted" ? "killed" : "failed", null, message);
					throw error;
				});

			// `handle.status` covers the command that settles while the deadline is
			// firing: it finished, so it must report its real result, not a handle.
			const yielded = await race(settled, yieldTimeMs);
			if (!yielded || handle.status !== "running") {
				execOptions.signal?.removeEventListener("abort", abortForeground);
				registry.discard(handle);
				return settled;
			}

			/*
			 * Everything printed so far is already in this tool result, so the
			 * handle's increment cursor starts after it. Bytes that arrive
			 * between the deadline firing and this line are covered because the
			 * cursor is set from the offset the handle has reached right now.
			 */
			foreground = false;
			handle.cursor = handle.endOffset;
			forward(Buffer.from(`${endsWithNewline ? "" : "\n"}${yieldTrailer(handle, Date.now() - startedAt)}\n`, "utf8"));
			// The command keeps running; a non-zero code here would read as failure.
			return { exitCode: 0 };
		},
	};
}

/** Resolves false when `settled` wins, true when the deadline does. */
async function race(settled: Promise<unknown>, yieldTimeMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(true), yieldTimeMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
	});
	try {
		return await Promise.race([settled.then(() => false, () => false), deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
