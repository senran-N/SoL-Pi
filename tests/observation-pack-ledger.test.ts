/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLedger, readSendCounts } from "../src/sol-pi/extensions/observation-pack/ledger.ts";

const roots: string[] = [];
const id = "obs_0123456789abcdef01234567";

async function ledgerPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "observation-ledger-"));
	roots.push(root);
	return join(root, "ledger.jsonl");
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observation send-count recovery", () => {
	it("treats a missing ledger as an older session", async () => {
		expect(await readSendCounts(await ledgerPath())).toEqual(new Map());
	});

	it("accepts blank separators between appended rows without warning", async () => {
		const path = await ledgerPath();
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const append = createLedger(path);
		await append({ event: "full", id, sendNumber: 1 });
		await append({ event: "full", id, sendNumber: 2 });
		expect(await readSendCounts(path)).toEqual(new Map([[id, 2]]));
		expect(warn).not.toHaveBeenCalled();
	});

	it("reads old full rows without mistaking the branch request index for sends", async () => {
		const path = await ledgerPath();
		await writeFile(path, [
			{ event: "full", id, request: 100 },
			{ event: "recall", id, offset: 0 },
			{ event: "full", id, request: 1 },
		].map((row) => JSON.stringify(row)).join("\n") + "\n");
		expect((await readSendCounts(path)).get(id)).toBe(2);
	});

	it("never lowers explicit counts on replay and recognizes placeholder-only history", async () => {
		const path = await ledgerPath();
		const other = "obs_abcdef0123456789abcdef01";
		await writeFile(path, [
			{ event: "full", id, sendNumber: 2 },
			{ event: "full", id, sendNumber: 2 },
			{ event: "placeholder", id, sendNumber: 10 },
			{ event: "full", id, sendNumber: 1 },
			{ event: "placeholder", id: other },
		].map((row) => JSON.stringify(row)).join("\n") + "\n");
		expect(await readSendCounts(path)).toEqual(new Map([[id, 10], [other, 3]]));
	});

	it("skips invalid counters and a torn tail with a content-free warning", async () => {
		const path = await ledgerPath();
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const invalid = [null, -1, 0, 1.5, "2", 1e30];
		await writeFile(path, [
			JSON.stringify({ event: "full", id, sendNumber: 1 }),
			...invalid.map((sendNumber) => JSON.stringify({ event: "full", id, sendNumber })),
			JSON.stringify({ event: "placeholder", id: "not-an-id" }),
			'{"private":"must-not-be-logged',
		].join("\n"));
		expect(await readSendCounts(path)).toEqual(new Map([[id, 1]]));
		expect(warn).toHaveBeenCalledExactlyOnceWith("[observationpack] ignored 8 invalid ledger rows while restoring send counts");
	});
});
