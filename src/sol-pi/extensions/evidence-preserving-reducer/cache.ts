/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ProviderResult } from "./provider.ts";

// Retain only accepted provider receipts, never raw diagnostic logs. A response
// can exceed its requested token budget, so bound bytes as well as entry count.
export const RECEIPT_CACHE_MAX_ENTRIES = 32;
export const RECEIPT_CACHE_MAX_ENTRY_BYTES = 64 * 1024;

/** In-memory LRU owned by one extension instance and one session runtime root. */
export class ReceiptCache {
	private readonly entries = new Map<string, ProviderResult>();

	get(key: string): ProviderResult | undefined {
		const value = this.entries.get(key);
		if (value) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	set(key: string, value: ProviderResult): void {
		if (Buffer.byteLength(JSON.stringify(value), "utf8") > RECEIPT_CACHE_MAX_ENTRY_BYTES) return;
		this.entries.delete(key);
		this.entries.set(key, value);
		while (this.entries.size > RECEIPT_CACHE_MAX_ENTRIES) {
			this.entries.delete(this.entries.keys().next().value!);
		}
	}
}
