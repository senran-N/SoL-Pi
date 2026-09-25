import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createObservationPackExtension, createObservation } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { initialOnlineState, ONLINE_STATE_ENTRY } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(ratio = 12.5) {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-pack-policy-")); roots.push(root);
	const manager = new FakeSessionManager([], "policy", root);
	const pi = new FakePi(manager); createObservationPackExtension({ cacheWriteReadRatio: ratio })(pi.asExtensionApi());
	return { root, manager, pi, context: fakeContext(manager) };
}
function result(body = `${"log line\n".repeat(2000)}needle evidence\n`, id = "output"): ToolResultMessage {
	return { role: "toolResult", toolName: "bash", toolCallId: id, timestamp: Date.now(), isError: false, content: [{ type: "text", text: body }] };
}
function text(message: AgentMessage | undefined): string {
	return message?.role === "toolResult" ? message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") : "";
}

describe("cache-aware packing and archived evidence search", () => {
	it("defers an expensive prefix rewrite without a forecast and records why", async () => {
		const { root, pi, context } = await setup(); const message = result();
		for (let index = 0; index < 5; index++) expect(text((await pi.emitContext([message], context))[0])).toBe(text(message));
		const ledger = await readFile(join(root, "sol-pi/policy/observation-pack/ledger.jsonl"), "utf8");
		expect(ledger).toContain('"reason":"horizon_unknown"');
		expect(ledger).not.toContain("needle evidence");
	});
	it("packs at a hard window reserve without a plan, then keeps the projection stable", async () => {
		const { pi, context } = await setup(); const message = result();
		const pressure = { ...context, getContextUsage: () => ({ tokens: 95_000, contextWindow: 100_000, percent: 95 }) };
		const packed = text((await pi.emitContext([message], pressure))[0]);
		expect(packed).toContain("retrieve: call obs_recall");
		expect(text((await pi.emitContext([message], context))[0])).toBe(packed);
	});
	it("uses an explicit remaining-work forecast to amortize packing", async () => {
		const { manager, pi, context } = await setup(2); const message = result();
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, { ...initialOnlineState(),
			plan: [{ id: "todo", goal: "Finish remaining work", status: "in_progress" }], completedBoundaryRequestCounts: [10, 10, 10] });
		await pi.emitContext([message], context); await pi.emitContext([message], context);
		expect(text((await pi.emitContext([message], context))[0])).toContain("retrieve: call obs_recall");
	});
	it("indexes an explicitly scoped large tool result before its first request and preserves exact bytes", async () => {
		const { root, manager, pi, context } = await setup();
		const message = result(`${"irrelevant output\n".repeat(5000)}needle evidence ☾\n`);
		const assistant = { role: "assistant", content: [{ type: "toolCall", id: "output", name: "bash", arguments: { intent: "needle" } }] } as unknown as AgentMessage;
		manager.appendMessage(assistant); manager.appendMessage(message);
		const projected = text((await pi.emitContext([assistant, message], context))[1]);
		expect(projected).toContain("before its first provider request"); expect(projected).toContain("needle evidence ☾");
		const observation = createObservation(message, join(root, "sol-pi/policy"))!;
		expect(await readFile(observation.filePath, "utf8")).toBe(text(message));
		expect(text((await pi.emitContext([assistant, message], context))[1])).toBe(projected);
		const resumed = new FakePi(manager); createObservationPackExtension()(resumed.asExtensionApi());
		expect(text((await resumed.emitContext([assistant, message], context))[1])).toBe(projected);
	});
	it("does not filter a code read just because its caller supplies intent", async () => {
		const { pi, context } = await setup();
		const message = { ...result("exact code\n".repeat(9000)), toolName: "read" };
		const assistant = { role: "assistant", content: [{ type: "toolCall", id: "output", name: "read", arguments: { intent: "code" } }] } as unknown as AgentMessage;
		expect(text((await pi.emitContext([assistant, message], context))[1])).toBe(text(message));
	});
	it("searches newest-first with bounded pages, exact offsets, and branch-bound cursors", async () => {
		const { manager, pi, context } = await setup();
		manager.appendMessage(result(`${"old filler\n".repeat(1500)}needle old\n`, "old"));
		manager.appendMessage(result(`${"new filler\n".repeat(1500)}needle new ☾\n`, "new"));
		const search = pi.tool("obs_search");
		const first = await search.execute("s1", { query: "needle", limit: 1 }, undefined, undefined, context);
		const a = first.details as { hits: Array<{ id: string; text: string; offset: number }>; next_cursor: string };
		expect(a.hits[0]?.text).toContain("new ☾"); expect(a.next_cursor).toBeTruthy();
		const recall = await pi.tool("obs_recall").execute("r", { id: a.hits[0]!.id, offset: a.hits[0]!.offset }, undefined, undefined, context);
		expect(JSON.stringify(recall.content)).toContain("needle new ☾");
		const next = await search.execute("s2", { query: "needle", limit: 1, cursor: a.next_cursor }, undefined, undefined, context);
		expect(JSON.stringify(next.content)).toContain("needle old");
		manager.entries.pop();
		await expect(search.execute("s3", { query: "needle", cursor: a.next_cursor }, undefined, undefined, context)).rejects.toThrow(/branch or query/u);
	});
	it("reports an incomplete zero-hit scan and lets a cursor reach later evidence", async () => {
		const { manager, pi, context } = await setup();
		manager.appendMessage(result(`${"x".repeat(2 * 1024 * 1024)}\nneedle beyond scan budget\n`));
		const first = await pi.tool("obs_search").execute("s", { query: "needle" }, undefined, undefined, context);
		const page = first.details as { complete: boolean; hits: unknown[]; next_cursor: string };
		expect(page.complete).toBe(false); expect(page.hits).toEqual([]);
		const second = await pi.tool("obs_search").execute("s2", { query: "needle", cursor: page.next_cursor }, undefined, undefined, context);
		expect(JSON.stringify(second.content)).toContain("needle beyond scan budget");
	});
});
