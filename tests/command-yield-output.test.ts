import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, RETAINED_BYTES } from "../src/sol-pi/extensions/command-yield/registry.ts";
import { registerCommandYieldTools } from "../src/sol-pi/extensions/command-yield/tools.ts";
import { FakePi, fakeContext, FakeSessionManager } from "./helpers.ts";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("Command Yield durable output", () => {
	it("retains and exactly drains more than the memory budget after the process exits", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-command-output-")); paths.push(root);
		const registry = createRegistry(); registry.setOutputRoot(join(root, "command-yield"));
		const handle = registry.create("npm test --token=private-test-value", root);
		const first = Buffer.from("开始\n".repeat(120_000)); const second = Buffer.from("error: final diagnostic\n".repeat(25_000));
		const source = Buffer.concat([first, second]); expect(source.length).toBeGreaterThan(RETAINED_BYTES);
		registry.append(handle, first); registry.append(handle, second); registry.settle(handle, "exited", 1);
		expect(handle.chunks.reduce((total, chunk) => total + chunk.length, 0)).toBeLessThanOrEqual(RETAINED_BYTES);
		expect(registry.snapshot(handle).droppedBytes).toBe(0);
		const chunks: string[] = []; let cursor = 0;
		while (registry.snapshot(handle).pendingBytes > 0) {
			const part = registry.take(handle, { maxBytes: 16_384, maxLines: 400 });
			expect(part.startOffset).toBe(cursor); cursor = part.endOffset; chunks.push(part.text);
		}
		expect(Buffer.from(chunks.join(""))).toEqual(source);
		expect(await readFile(handle.outputPath!)).toEqual(source);
		expect(JSON.stringify(registry.snapshot(handle))).not.toContain("private-test-value");
	// A multi-megabyte durable spool is intentionally exercised here. Windows
	// CI can spend considerably longer draining it while other Vitest workers
	// are importing the Pi dependency graph.
	}, 60_000);
	it("keeps a split UTF-8 character pending until its remaining bytes arrive", () => {
		const registry = createRegistry(); const handle = registry.create("npm test", "/work");
		const bytes = Buffer.from("界"); registry.append(handle, bytes.subarray(0, 2));
		expect(registry.take(handle, { maxBytes: 100, maxLines: 10 }).text).toBe("");
		registry.append(handle, bytes.subarray(2));
		expect(registry.take(handle, { maxBytes: 100, maxLines: 10 }).text).toBe("界");
	});
	it("keeps pending final output actionable and does not repeat a command secret in tools", async () => {
		const registry = createRegistry(); const handle = registry.create("npm test --token=private-test-value", "/work");
		registry.append(handle, Buffer.from("line\n".repeat(600))); registry.settle(handle, "exited", 0);
		const pi = new FakePi(); registerCommandYieldTools(pi.asExtensionApi(), { registry, yieldTimeMs: 1000 });
		const context = fakeContext(new FakeSessionManager());
		const first = await pi.tool("exec_wait").execute("wait-1", { handle: handle.id }, undefined, undefined, context);
		const firstText = first.content.map((item) => item.type === "text" ? item.text : "").join("\n");
		expect(firstText).toContain("call exec_wait again to collect the remaining output");
		expect(await reducibleToolResult({ type: "tool_result", toolName: "exec_wait", toolCallId: "wait-1", input: { handle: handle.id }, isError: false, ...first } as ToolResultEvent)).toBeUndefined();
		const listed = await pi.tool("exec_list").execute("list", {}, undefined, undefined, context);
		expect(JSON.stringify([first, listed])).not.toContain("private-test-value");
	});
});
