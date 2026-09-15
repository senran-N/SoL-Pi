/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createOnlineContextCompactExtension,
	HISTORY_HINT_MAX_BYTES,
	HISTORY_READ_MAX_BYTES,
	HISTORY_TRUNCATION_MARKER,
	readHistoryEntry,
	searchHistory,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

type Execute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: undefined,
	onUpdate: undefined,
	context: ExtensionContext,
) => Promise<{ content: { type: string; text: string }[]; details: Readonly<Record<string, unknown>> }>;

function entry(partial: Omit<SessionEntry, never> & Record<string, unknown>): SessionEntry {
	return partial as unknown as SessionEntry;
}

function historyEntries(): SessionEntry[] {
	return [
		entry({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "Deploy the widget to staging." },
		}),
		entry({
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Running the widget deployment now." },
					{ type: "toolCall", name: "bash", arguments: { command: "deploy-widget --env staging" } },
				],
			},
		}),
		entry({
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "toolResult", content: [{ type: "text", text: "widget deploy failed: missing credentials" }] },
		}),
		entry({
			type: "compaction",
			id: "e4",
			parentId: "e3",
			timestamp: "2026-01-01T00:00:03.000Z",
			summary: "The widget deploy failed and needs credentials.",
			firstKeptEntryId: "e3",
			tokensBefore: 195_000,
		}),
		entry({
			type: "custom",
			id: "e5",
			parentId: "e4",
			timestamp: "2026-01-01T00:00:04.000Z",
			customType: "sol-pi-online-context-state-v1",
			data: { marker: "widget" },
		}),
	];
}

describe("history search", () => {
	it("finds matches across user, assistant, tool, and compaction records", () => {
		const search = searchHistory(historyEntries(), "widget");
		expect(search.total).toBe(4);
		expect(search.hits.map((hit) => hit.id)).toEqual(["e1", "e2", "e3", "e4"]);
		expect(search.hits[2]?.kind).toBe("tool result");
		expect(search.hits[3]?.kind).toBe("compaction");
	});

	it("ignores internal custom entries and matches tool call arguments", () => {
		const deployment = searchHistory(historyEntries(), "deploy-widget");
		expect(deployment.total).toBe(1);
		expect(deployment.hits[0]?.id).toBe("e2");
		expect(deployment.hits[0]?.snippet).toContain("deploy-widget --env staging");

		const internal = searchHistory(historyEntries(), "sol-pi-online-context-state");
		expect(internal.total).toBe(0);
	});

	it("is case-insensitive and reports no match cleanly", () => {
		expect(searchHistory(historyEntries(), "STAGING").total).toBe(2);
		expect(searchHistory(historyEntries(), "kubernetes")).toEqual({ total: 0, hits: [], truncated: false });
	});

	it("caps hits by limit and marks truncation, including a byte budget", () => {
		const limited = searchHistory(historyEntries(), "widget", 2);
		expect(limited.hits).toHaveLength(2);
		expect(limited.truncated).toBe(true);

		const bulky = Array.from({ length: 40 }, (_, index) =>
			entry({
				type: "message",
				id: `b${index}`,
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "assistant", content: `needle ${"x".repeat(400)}` },
			}),
		);
		const bounded = searchHistory(bulky, "needle", 32);
		expect(bounded.truncated).toBe(true);
		expect(bounded.hits.length).toBeLessThan(32);
		const bytes = bounded.hits.reduce((total, hit) => total + Buffer.byteLength(hit.snippet, "utf8") + 32, 0);
		expect(bytes).toBeLessThanOrEqual(HISTORY_HINT_MAX_BYTES);
	});

	it("reads one entry in full and bounds oversized entries", () => {
		const found = readHistoryEntry(historyEntries(), "e3");
		expect(found?.kind).toBe("tool result");
		expect(found?.text).toContain("missing credentials");
		expect(readHistoryEntry(historyEntries(), "missing")).toBeUndefined();

		const huge = entry({
			type: "message",
			id: "huge",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "assistant", content: "z".repeat(HISTORY_READ_MAX_BYTES * 2) },
		});
		const bounded = readHistoryEntry([huge], "huge");
		expect(bounded?.text.endsWith(HISTORY_TRUNCATION_MARKER)).toBe(true);
		expect(Buffer.byteLength(bounded?.text ?? "", "utf8")).toBeLessThanOrEqual(HISTORY_READ_MAX_BYTES);
	});
});

describe("history tools", () => {
	function setup(): { pi: FakePi; context: ExtensionContext } {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-occ-history-"));
		const manager = new FakeSessionManager(historyEntries(), "session-a", root);
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		return { pi, context: fakeContext(manager) };
	}

	it("answers history_search with ids and snippets", async () => {
		const { pi, context } = setup();
		const search = pi.tool("history_search").execute as Execute;
		const result = await search("call-1", { query: "credentials" }, undefined, undefined, context);
		expect(result.content[0]?.text).toContain('2 matches for "credentials"');
		expect(result.content[0]?.text).toContain("- e3 [tool result] #3");
		expect(result.content[0]?.text).toContain("history_read id");
		expect(result.details).toMatchObject({ op: "history_search", total: 2 });
	});

	it("reports an empty search without failing", async () => {
		const { pi, context } = setup();
		const search = pi.tool("history_search").execute as Execute;
		const result = await search("call-1", { query: "kubernetes" }, undefined, undefined, context);
		expect(result.content[0]?.text).toBe('No recorded history matches "kubernetes".');
		expect(result.details).toMatchObject({ op: "history_search", total: 0, hits: [] });
	});

	it("reads an entry through history_read and rejects unknown ids", async () => {
		const { pi, context } = setup();
		const read = pi.tool("history_read").execute as Execute;
		const result = await read("call-1", { id: "e2" }, undefined, undefined, context);
		expect(result.content[0]?.text).toContain("[assistant] #2");
		expect(result.content[0]?.text).toContain("deploy-widget --env staging");
		expect(result.details).toMatchObject({ op: "history_read", id: "e2", kind: "assistant" });

		await expect(read("call-2", { id: "nope" }, undefined, undefined, context)).rejects.toThrow(
			'Unknown history entry id "nope"',
		);
	});
});
