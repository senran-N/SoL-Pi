/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	ReceiptCache,
	RECEIPT_CACHE_MAX_ENTRIES,
	RECEIPT_CACHE_MAX_ENTRY_BYTES,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/cache.ts";
import type { ProviderResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/provider.ts";

function receipt(outputText = "verified receipt"): ProviderResult {
	return {
		errorMessage: undefined, provider: "test", model: "test", ok: true,
		outputText, stopReason: "stop",
		usage: { input: 100, output: 10, totalTokens: 110, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("bounded receipt cache", () => {
	it("evicts the least recently used receipt and refreshes hits and replacements", () => {
		const cache = new ReceiptCache();
		for (let index = 0; index < RECEIPT_CACHE_MAX_ENTRIES; index += 1) cache.set(String(index), receipt());
		expect(cache.get("0")).toBeDefined();
		cache.set("1", receipt("updated"));
		cache.set("new", receipt());
		expect(cache.get("2")).toBeUndefined();
		expect(cache.get("0")).toBeDefined();
		expect(cache.get("1")?.outputText).toBe("updated");
		cache.delete("0");
		expect(cache.get("0")).toBeUndefined();
		expect(cache.get("new")).toBeDefined();
	});

	it("bounds the UTF-8 serialized result, not just output characters", () => {
		const cache = new ReceiptCache();
		const overhead = Buffer.byteLength(JSON.stringify(receipt("")), "utf8");
		const atLimit = receipt("x".repeat(RECEIPT_CACHE_MAX_ENTRY_BYTES - overhead));
		expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(RECEIPT_CACHE_MAX_ENTRY_BYTES);
		cache.set("at-limit", atLimit);
		cache.set("too-large", receipt(`${atLimit.outputText}x`));
		cache.set("multibyte", receipt("界".repeat(Math.ceil(RECEIPT_CACHE_MAX_ENTRY_BYTES / 3))));
		cache.set("metadata", { ...receipt(), model: "x".repeat(RECEIPT_CACHE_MAX_ENTRY_BYTES) });
		expect(cache.get("at-limit")).toBeDefined();
		expect(cache.get("too-large")).toBeUndefined();
		expect(cache.get("multibyte")).toBeUndefined();
		expect(cache.get("metadata")).toBeUndefined();
	});
});
