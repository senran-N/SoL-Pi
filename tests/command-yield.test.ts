/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createCommandYieldExtension,
	registerCommandYield,
	YIELD_MARKER,
} from "../src/sol-pi/extensions/command-yield/index.ts";
import { createYieldingOperations } from "../src/sol-pi/extensions/command-yield/operations.ts";
import { createRegistry, type Registry } from "../src/sol-pi/extensions/command-yield/registry.ts";
import {
	countLines,
	estimateTokens,
	placeholderFor,
} from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { FakePi, fakeContext, FakeSessionManager } from "./helpers.ts";

const YIELD_MS = 20;

interface FakeRun {
	readonly command: string;
	readonly timeout: number | undefined;
	aborted: boolean;
	emit(text: string): void;
	finish(exitCode: number | null): void;
	fail(message: string): void;
}

/** Inner backend that never spawns anything, so a test drives the command by hand. */
function createFakeShell(): { operations: BashOperations; runs: FakeRun[] } {
	const runs: FakeRun[] = [];
	const operations: BashOperations = {
		exec(command, _cwd, options) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const run: FakeRun = {
					command,
					timeout: options.timeout,
					aborted: false,
					emit: (text) => options.onData(Buffer.from(text, "utf8")),
					finish: (exitCode) => {
						if (settled) return;
						settled = true;
						resolve({ exitCode });
					},
					fail: (message) => {
						if (settled) return;
						settled = true;
						reject(new Error(message));
					},
				};
				options.signal?.addEventListener("abort", () => {
					run.aborted = true;
					run.finish(null);
				});
				runs.push(run);
			});
		},
	};
	return { operations, runs };
}

async function started(runs: FakeRun[], count = 1): Promise<void> {
	await vi.waitFor(() => expect(runs).toHaveLength(count));
}

/** The inner backend settles a handle asynchronously; wait for that to land. */
async function settledAs(registry: Registry, handle: string, status: string): Promise<void> {
	await vi.waitFor(() =>
		expect(registry.list().find((entry) => entry.id === handle)?.status).toBe(status),
	);
}

function toolResultText(result: unknown): string {
	const content = (result as { content: { type: string; text: string }[] }).content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function setup(yieldTimeMs = YIELD_MS) {
	const { operations, runs } = createFakeShell();
	const pi = new FakePi();
	const runtime = registerCommandYield(pi.asExtensionApi(), { yieldTimeMs, inner: operations });
	const context = fakeContext(new FakeSessionManager());
	const call = async (name: string, params: Record<string, unknown> = {}) =>
		pi.tool(name).execute(`call-${name}`, params, undefined, undefined, context);
	return { pi, runs, runtime, call, context };
}

describe("Command Yield operations", () => {
	it("stays out of the way when the command finishes inside its deadline", async () => {
		const { operations, runs } = createFakeShell();
		const registry = createRegistry();
		const yielding = createYieldingOperations({ registry, yieldTimeMs: 10_000, inner: operations });

		const chunks: string[] = [];
		const result = yielding.exec("echo hi", "/work", { onData: (data) => chunks.push(data.toString("utf8")) });
		await started(runs);
		runs[0]?.emit("hi\n");
		runs[0]?.finish(0);

		expect(await result).toEqual({ exitCode: 0 });
		expect(chunks.join("")).toBe("hi\n");
		// Nothing outlived the turn, so nothing is left to manage.
		expect(registry.list()).toEqual([]);
	});

	it("forwards a failing exit code untouched", async () => {
		const { operations, runs } = createFakeShell();
		const yielding = createYieldingOperations({ registry: createRegistry(), yieldTimeMs: 10_000, inner: operations });

		const result = yielding.exec("false", "/work", { onData: () => {} });
		await started(runs);
		runs[0]?.finish(3);

		expect(await result).toEqual({ exitCode: 3 });
	});

	it("passes an explicit timeout through, so it stays destructive", async () => {
		const { operations, runs } = createFakeShell();
		const yielding = createYieldingOperations({ registry: createRegistry(), yieldTimeMs: 10_000, inner: operations });

		const result = yielding.exec("sleep 60", "/work", { onData: () => {}, timeout: 5 });
		await started(runs);
		expect(runs[0]?.timeout).toBe(5);
		runs[0]?.fail("timeout:5");

		await expect(result).rejects.toThrow("timeout:5");
	});

	it("yields a handle instead of blocking, and keeps the command running", async () => {
		const { operations, runs } = createFakeShell();
		const registry = createRegistry();
		const yielding = createYieldingOperations({ registry, yieldTimeMs: YIELD_MS, inner: operations });

		const chunks: string[] = [];
		const result = yielding.exec("npm run dev", "/work", { onData: (data) => chunks.push(data.toString("utf8")) });
		await started(runs);
		runs[0]?.emit("booting");

		expect(await result).toEqual({ exitCode: 0 });
		const output = chunks.join("");
		expect(output).toContain("booting");
		expect(output).toContain(YIELD_MARKER);
		// The trailer starts on its own line even though the output had no newline.
		expect(output).toContain("booting\n[sol-pi:command-yield]");

		const live = registry.list();
		expect(live).toHaveLength(1);
		expect(live[0]?.status).toBe("running");
		expect(output).toContain(`handle=${live[0]?.id}`);
		expect(runs[0]?.aborted).toBe(false);
	});

	it("kills the command when the turn is interrupted before the yield", async () => {
		const { operations, runs } = createFakeShell();
		const yielding = createYieldingOperations({ registry: createRegistry(), yieldTimeMs: 10_000, inner: operations });
		const controller = new AbortController();

		const result = yielding.exec("sleep 60", "/work", { onData: () => {}, signal: controller.signal });
		await started(runs);
		controller.abort();

		expect(await result).toEqual({ exitCode: null });
		expect(runs[0]?.aborted).toBe(true);
	});

	it("detaches from the call signal once it has yielded", async () => {
		const { operations, runs } = createFakeShell();
		const registry = createRegistry();
		const yielding = createYieldingOperations({ registry, yieldTimeMs: YIELD_MS, inner: operations });
		const controller = new AbortController();

		await yielding.exec("npm run dev", "/work", { onData: () => {}, signal: controller.signal });
		controller.abort();

		// The handle owns the command now; the next turn's abort must not reach it.
		expect(runs[0]?.aborted).toBe(false);
		expect(registry.list()[0]?.status).toBe("running");
	});
});

describe("Command Yield tools", () => {
	it("returns only output produced since the last read", async () => {
		const { runs, runtime, call } = setup();
		const yielded = await runtime.bashOperations.exec("tail -f log", "/work", { onData: () => {} });
		expect(yielded).toEqual({ exitCode: 0 });
		const handle = runtime.registry.list()[0]?.id ?? "";

		runs[0]?.emit("first\n");
		const first = toolResultText(await call("exec_wait", { handle }));
		expect(first).toContain("status=running");
		expect(first).toContain("first");

		runs[0]?.emit("second\n");
		const second = toolResultText(await call("exec_wait", { handle }));
		expect(second).toContain("second");
		expect(second).not.toContain("first");
	});

	it("caps one increment and leaves the rest pending", async () => {
		const { runs, runtime, call } = setup();
		await runtime.bashOperations.exec("build", "/work", { onData: () => {} });
		const handle = runtime.registry.list()[0]?.id ?? "";

		runs[0]?.emit("line\n".repeat(600));
		const first = toolResultText(await call("exec_wait", { handle }));
		expect(first.split("\n").length).toBeLessThanOrEqual(401);
		expect(first).toMatch(/[1-9]\d* bytes pending/u);

		const second = toolResultText(await call("exec_wait", { handle }));
		expect(second).toContain("line");
	});

	it("never splits a multi-byte character across two increments", async () => {
		const { runs, runtime, call } = setup();
		await runtime.bashOperations.exec("build", "/work", { onData: () => {} });
		const handle = runtime.registry.list()[0]?.id ?? "";

		// One long line of three-byte characters, so the byte cap lands mid-character.
		const source = "编译中".repeat(3_000);
		runs[0]?.emit(source);

		let collected = "";
		for (let read = 0; read < 5; read += 1) {
			const text = toolResultText(await call("exec_wait", { handle }));
			collected += text.slice(text.indexOf("]\n", text.indexOf("]\n") + 1) + 2);
			if (!/[1-9]\d* bytes pending/u.test(text)) break;
		}
		expect(collected).not.toContain("�");
		expect(collected).toBe(source);
	});

	it("reports a clean exit and then a failing one as a tool error", async () => {
		const clean = setup();
		await clean.runtime.bashOperations.exec("ok", "/work", { onData: () => {} });
		const cleanHandle = clean.runtime.registry.list()[0]?.id ?? "";
		clean.runs[0]?.emit("done\n");
		clean.runs[0]?.finish(0);
		await settledAs(clean.runtime.registry, cleanHandle, "exited");
		const settled = toolResultText(await clean.call("exec_wait", { handle: cleanHandle }));
		expect(settled).toContain("status=exited");
		expect(settled).toContain("done");

		const broken = setup();
		await broken.runtime.bashOperations.exec("pytest", "/work", { onData: () => {} });
		const brokenHandle = broken.runtime.registry.list()[0]?.id ?? "";
		broken.runs[0]?.emit("FAILED test_x\n");
		broken.runs[0]?.finish(1);
		await settledAs(broken.runtime.registry, brokenHandle, "exited");
		await expect(broken.call("exec_wait", { handle: brokenHandle })).rejects.toThrow("exit_code=1");
	});

	it("rejects a handle it never issued", async () => {
		const { call } = setup();
		await expect(call("exec_wait", { handle: "exec_ffffffffffff" })).rejects.toThrow("Unknown command handle");
		await expect(call("exec_wait", { handle: "../etc/passwd" })).rejects.toThrow("Unknown command handle");
	});

	it("lists live commands and stops one on request", async () => {
		const { runs, runtime, call } = setup();
		await runtime.bashOperations.exec("npm run dev", "/work", { onData: () => {} });
		const handle = runtime.registry.list()[0]?.id ?? "";

		const listed = toolResultText(await call("exec_list"));
		expect(listed).toContain(handle);
		expect(listed).toContain("status=running");
		expect(listed).toContain("npm run dev");

		const killed = toolResultText(await call("exec_kill", { handle }));
		expect(killed).toContain("status=killed");
		expect(runs[0]?.aborted).toBe(true);
	});

	it("says so when the command had already finished", async () => {
		const { runs, runtime, call } = setup();
		await runtime.bashOperations.exec("build", "/work", { onData: () => {} });
		const handle = runtime.registry.list()[0]?.id ?? "";
		runs[0]?.finish(0);
		await settledAs(runtime.registry, handle, "exited");

		const killed = toolResultText(await call("exec_kill", { handle }));
		expect(killed).toContain("nothing was stopped");
		expect(killed).toContain("status=exited");
	});
});

describe("Command Yield with the other mechanisms", () => {
	it("keeps the handle reachable after Observation Pack replaces a huge yielded result", async () => {
		const { operations, runs } = createFakeShell();
		const registry = createRegistry();
		const yielding = createYieldingOperations({ registry, yieldTimeMs: YIELD_MS, inner: operations });

		const chunks: string[] = [];
		const result = yielding.exec("npm run build", "/work", {
			onData: (data) => chunks.push(data.toString("utf8")),
		});
		await started(runs);
		runs[0]?.emit("compiling module\n".repeat(2_000));
		await result;

		const text = chunks.join("");
		const handle = registry.list()[0]?.id ?? "";
		const observation = {
			id: "obs_0123456789abcdef01234567",
			contentHash: "hash",
			filePath: "/tmp/obs",
			toolName: "bash",
			text,
			bytes: Buffer.byteLength(text, "utf8"),
			lines: countLines(text),
			tokens: estimateTokens(text),
		};

		// The trailer is the tail of the output, and the placeholder keeps the tail,
		// so packing a huge yielded result cannot strand the running command.
		expect(placeholderFor(observation)).toContain(`handle=${handle}`);
	});
});

describe("Command Yield against real processes", () => {
	it("passes a fast command through and yields on one that never exits", async () => {
		const registry = createRegistry();
		const yielding = createYieldingOperations({ registry, yieldTimeMs: 500 });

		const fast: string[] = [];
		const fastResult = await yielding.exec("echo fast", process.cwd(), {
			onData: (data) => fast.push(data.toString("utf8")),
		});
		expect(fastResult).toEqual({ exitCode: 0 });
		expect(fast.join("")).toContain("fast");
		expect(fast.join("")).not.toContain(YIELD_MARKER);
		expect(registry.list()).toEqual([]);

		// No output and no exit: the case that used to hold a turn open forever.
		const slow: string[] = [];
		const slowResult = await yielding.exec("sleep 30", process.cwd(), {
			onData: (data) => slow.push(data.toString("utf8")),
		});
		expect(slowResult).toEqual({ exitCode: 0 });
		expect(slow.join("")).toContain(YIELD_MARKER);

		const handle = registry.get(registry.list()[0]?.id ?? "");
		expect(handle?.status).toBe("running");
		if (handle) {
			registry.kill(handle);
			await vi.waitFor(() => expect(handle.status).toBe("killed"), { timeout: 10_000 });
		}
	}, 30_000);
});

describe("Command Yield registration", () => {
	it("replaces the active shell tool and adds the handle tools", () => {
		const pi = new FakePi();
		registerCommandYield(pi.asExtensionApi(), { yieldTimeMs: YIELD_MS });
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["bash", "exec_wait", "exec_list", "exec_kill"]);
	});

	it("replaces powershell when that is the live shell", () => {
		const pi = new FakePi();
		pi.activeTools = ["powershell", "read", "edit"];
		registerCommandYield(pi.asExtensionApi(), { yieldTimeMs: YIELD_MS });
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual([
			"powershell",
			"exec_wait",
			"exec_list",
			"exec_kill",
		]);
	});

	it("takes its commands down when the session ends", async () => {
		const { operations, runs } = createFakeShell();
		const pi = new FakePi();
		const { factory, runtime } = createCommandYieldExtension({ yieldTimeMs: YIELD_MS, inner: operations });
		factory(pi.asExtensionApi());

		await runtime.bashOperations.exec("npm run dev", "/work", { onData: () => {} });
		expect(runtime.registry.list()[0]?.status).toBe("running");

		await pi.emit("session_shutdown", { type: "session_shutdown" }, fakeContext(new FakeSessionManager()));
		expect(runs[0]?.aborted).toBe(true);
		expect(runtime.registry.list()[0]?.status).toBe("killed");
	});
});
