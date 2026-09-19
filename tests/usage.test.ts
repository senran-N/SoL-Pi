/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadReducerConfig } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import { callReducer } from "../src/sol-pi/extensions/evidence-preserving-reducer/provider.ts";
import { loadExplorationConfig } from "../src/sol-pi/extensions/scoped-exploration/config.ts";
import { callExplorer } from "../src/sol-pi/extensions/scoped-exploration/provider.ts";
import { runExploration } from "../src/sol-pi/extensions/scoped-exploration/explorer.ts";
import { registerUsageReport } from "../src/sol-pi/usage/index.ts";
import { readUsageLedger, trackModelCall, usageLedgerPath, usageMetrics, zeroTokens } from "../src/sol-pi/usage/ledger.ts";
import { sessionUsage, sumUsage, usageReport } from "../src/sol-pi/usage/report.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { fakeContext, FakePi, FakeSessionManager } from "./helpers.ts";

const model: Model<"openai-responses"> = { id: "metered", provider: "test", name: "test", api: "openai-responses",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"], maxTokens: 1024, contextWindow: 32_000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } };
const route = { model: model.id, provider: model.provider };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(complete: () => Promise<AssistantMessage> = async () => reply()) {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-usage-"));
	roots.push(root);
	const manager = new FakeSessionManager([], "usage-session", root);
	const context = fakeContext(manager, { modelRegistry: { find: () => model, complete } as unknown as ExtensionContext["modelRegistry"] });
	return { root: runtimeRoot(context), context, manager };
}
function reply(text = "answer", overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 100, output: 10, cacheRead: 30, cacheWrite: 5, totalTokens: 145,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.005, total: 0.335 } }, ...overrides };
}
const zeroUsage = { ...zeroTokens(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("usage accounting", () => {
	it("does not equate missing prices or failed zero usage with free calls", () => {
		expect(usageMetrics(zeroUsage, true)).toEqual({ tokens: null, costEstimateUsd: null });
		expect(usageMetrics(zeroUsage, false)).toEqual({ tokens: zeroTokens(), costEstimateUsd: null });
		expect(usageMetrics(undefined, true)).toEqual({ tokens: null, costEstimateUsd: null });
		expect(usageMetrics({ ...zeroUsage, input: -1 }, false).tokens).toBeNull();
		expect(usageMetrics({ ...zeroUsage, cost: { total: Infinity } }, false).costEstimateUsd).toBeNull();
	});

	it("recovers concurrent completed and failed calls exactly once without storing payloads", async () => {
		const { root, context } = await setup();
		await Promise.all(Array.from({ length: 12 }, () => trackModelCall(context, "reducer", route, async (dispatched) => {
			dispatched(); return reply("private response sentinel");
		})));
		await expect(trackModelCall(context, "explorer", route, async (dispatched) => {
			dispatched(); throw new Error("secret error sentinel");
		})).rejects.toThrow("secret error sentinel");
		const ledger = await readUsageLedger(root);
		expect(ledger.invalidRecords).toBe(0);
		expect(ledger.records).toHaveLength(13);
		const totals = sumUsage(ledger.records);
		expect(totals).toMatchObject({ records: 13, errors: 1, unknownUsageRecords: 1, unknownCostRecords: 1,
			reportedTokens: { input: 1200, totalTokens: 1740 } });
		expect(totals.knownCostEstimateUsd).toBeCloseTo(12 * 0.335);
		const raw = await readFile(usageLedgerPath(root), "utf8");
		expect(raw).not.toMatch(/private response sentinel|secret error sentinel/u);
		// Replayed starts and identical terminal records do not double count.
		await appendFile(usageLedgerPath(root), raw);
		expect(await readUsageLedger(root)).toEqual(ledger);
	});

	it("separates dispatch failures, preflight failures and cancellation", async () => {
		const { root, context } = await setup();
		const controller = new AbortController();
		await expect(trackModelCall(context, "reducer", route, async () => { throw new Error("unavailable"); })).rejects.toThrow();
		await expect(trackModelCall(context, "explorer", route, async (sent) => {
			sent(); controller.abort(); throw new Error("aborted");
		}, controller.signal)).rejects.toThrow();
		const call = vi.fn(async () => reply());
		await expect(trackModelCall(context, "explorer", route, call, controller.signal)).rejects.toThrow();
		expect(call).not.toHaveBeenCalled();
		const ledger = await readUsageLedger(root);
		expect(ledger.records.map((row) => row.status)).toEqual(["not_sent", "aborted", "not_sent"]);
		expect(sumUsage(ledger.records)).toMatchObject({ notSent: 2, aborted: 1, unknownUsageRecords: 1, unknownCostRecords: 1 });
	});

	it("reports in-flight/crashed intents and corrupt lines as explicit gaps", async () => {
		const { root, context } = await setup();
		expect(await readUsageLedger(root)).toEqual({ records: [], invalidRecords: 0 });
		let release!: (message: AssistantMessage) => void;
		const waiting = new Promise<AssistantMessage>((resolve) => { release = resolve; });
		let entered!: () => void;
		const entering = new Promise<void>((resolve) => { entered = resolve; });
		const call = trackModelCall(context, "explorer", route, async (sent) => { sent(); entered(); return waiting; });
		await entering;
		try {
			expect(sumUsage((await readUsageLedger(root)).records)).toMatchObject({ pending: 1, unknownUsageRecords: 1, unknownCostRecords: 1 });
		} finally { release(reply()); await call; }
		await appendFile(usageLedgerPath(root), '{"broken":\n{"schema":"future-version"}\n');
		expect((await readUsageLedger(root)).invalidRecords).toBe(2);
		expect(sumUsage((await readUsageLedger(root)).records).pending).toBe(0);
	});

	it("does not dispatch when intent storage fails and does not hide terminal write failures", async () => {
		const { root, context } = await setup();
		await mkdir(usageLedgerPath(root), { recursive: true });
		const call = vi.fn(async () => reply());
		await expect(trackModelCall(context, "reducer", route, call)).rejects.toMatchObject({ name: "UsageLedgerError" });
		expect(call).not.toHaveBeenCalled();
		await rm(usageLedgerPath(root), { recursive: true });
		await expect(trackModelCall(context, "reducer", route, async (sent) => {
			sent();
			await rm(usageLedgerPath(root));
			await mkdir(usageLedgerPath(root));
			return reply();
		})).rejects.toMatchObject({ name: "UsageLedgerError" });
	});

	it("uses all real session branches, routes and native summary usage without counting custom journals twice", () => {
		const manager = SessionManager.inMemory();
		const user = manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		manager.appendMessage(reply());
		manager.branch(user);
		manager.appendMessage(reply("answer", { model: "second-model", stopReason: "error", usage: zeroUsage }));
		manager.appendCustomEntry("sol-pi-evidence-preserving-reducer-v1", { kind: "applied", usage: reply().usage });
		manager.appendCompaction("summary", user, 1000, undefined, false, reply().usage);
		manager.appendCompaction("reset", user, 1000, { solPiWindow: { version: 1, mode: "reset" } }, true);
		const report = usageReport(manager.getEntries(), [], 0);
		expect(report.totals).toMatchObject({ records: 4, errors: 1, unknownUsageRecords: 1, unknownCostRecords: 1,
			reportedTokens: { totalTokens: 290 } });
		expect(report.totals.knownCostEstimateUsd).toBeCloseTo(0.67);
		expect(report.routes.map((row) => row.model)).toEqual(["metered", "second-model", "unrecorded", "unrecorded"]);
		expect(sessionUsage([...manager.getEntries(), ...manager.getEntries()])).toHaveLength(4);
	});

	it("records reducer compat response usage but not authentication or request bytes", async () => {
		const { root, context } = await setup();
		const compatContext = { ...context, modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "credential-sentinel", baseUrl: "https://private.invalid",
				headers: { Authorization: "credential-sentinel" } }),
		} } as unknown as ExtensionContext;
		const archive = await archiveBody(join(root, "archive"), "private-log-sentinel");
		const compat = vi.fn(async () => reply("invalid receipt"));
		const result = await callReducer(loadReducerConfig(root, { reducerProvider: "test", reducerModel: "metered" }),
			"private-command-sentinel", true, archive, "private-log-sentinel", compatContext, compat);
		expect(result.ok).toBe(true);
		expect(compat).toHaveBeenCalledOnce();
		expect((await readUsageLedger(root)).records[0]).toMatchObject({ component: "reducer", status: "ok", costEstimateUsd: 0.335 });
		expect(await readFile(usageLedgerPath(root), "utf8")).not.toMatch(/credential-sentinel|private-command|private-log|invalid receipt|private.invalid/u);
	});

	it("records every real explorer step, including invalid replies and response errors", async () => {
		const complete = vi.fn().mockResolvedValueOnce(reply("invalid"))
			.mockResolvedValueOnce(reply(JSON.stringify({ action: "answer", found: false, answer: "not found", citations: [] })))
			.mockResolvedValueOnce(reply("provider error text", { stopReason: "error" }));
		const { root, context } = await setup(complete);
		const config = loadExplorationConfig(root, { explorerProvider: "test", explorerModel: "metered" });
		const outcome = await runExploration({ config, question: "anything", root, context });
		expect(outcome.steps).toBe(2);
		await expect(callExplorer(config, "prompt", [], context, new AbortController().signal)).rejects.toThrow(/ended with error/u);
		expect((await readUsageLedger(root)).records.map((row) => row.status)).toEqual(["ok", "ok", "error"]);
		expect(sumUsage((await readUsageLedger(root)).records).reportedTokens.totalTokens).toBe(435);
	});

	it("exposes a local report tool and keeps session ledgers isolated", async () => {
		const { root, context, manager } = await setup();
		await trackModelCall(context, "reducer", route, async (sent) => { sent(); return reply(); });
		manager.appendMessage(reply());
		const pi = new FakePi(manager);
		registerUsageReport(pi.asExtensionApi());
		const result = await pi.tool("sol_pi_usage").execute("usage", {}, undefined, undefined, context);
		expect(result.details).toMatchObject({ totals: { records: 2 } });
		manager.sessionId = "other-session";
		expect((await readUsageLedger(runtimeRoot(context))).records).toHaveLength(0);
		expect((await readUsageLedger(root)).records).toHaveLength(1);
		await writeFile(join(root, "ignored.txt"), "no usage here");
	});
});
