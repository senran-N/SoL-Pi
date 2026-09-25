/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Evidence-Preserving Reducer - delegate the first read of a long build or test
 * log to the configured reducer model, then verify what comes back.
 *
 * In build and test trajectories only a few lines of a long log change the next
 * decision. This extension archives the raw log, sends it through the reducer
 * provider/model selected by the top-level SoL-Pi config, and accepts the
 * resulting receipt only when every quoted line is found byte for byte in the
 * archive. A receipt that cannot be checked is discarded and the original
 * output reaches the frontier agent untouched.
 *
 * Delegation therefore never requires trusting a fluent summary.
 *
 * The top-level SoL-Pi config enables this mechanism. Provider selection and
 * authentication remain with Pi; storage and run identity come from the session.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { runtimeRoot } from "../../runtime-paths.ts";
import { UsageLedgerError } from "../../usage/ledger.ts";
import { formatSavingsBytes, showSolPiSavings } from "../../tui.ts";
import { archiveBody, archiveRoot } from "./archive.ts";
import { reducibleToolResult } from "./candidate.ts";
import { ReceiptCache } from "./cache.ts";
import {
	DIAGNOSTIC_COMMAND,
	isRecord,
	LIKELY_SECRET,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfig,
	type ReducerConfigOptions,
	sha256,
} from "./config.ts";
import { createJournal, type Journal } from "./journal.ts";
import { callReducer, type ProviderResult } from "./provider.ts";
import { receiptText, validateReceipt } from "./receipt.ts";
import { deterministicDiagnostics } from "./diagnostics.ts";

export interface ReducedToolResult {
	readonly content: ToolResultEvent["content"];
	readonly details: Record<string, unknown>;
	readonly isError: boolean;
}

export type EvidencePreservingReducerOptions = ReducerConfigOptions;

function errorName(error: unknown): string | undefined {
	return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

/** Provider errors can contain request fragments, headers, or credentials. */
function safeProviderError(errorMessage: string | undefined): string | undefined {
	return errorMessage === undefined ? undefined : "Reducer model call returned an error.";
}

export async function reduceToolResult(
	journal: Journal,
	config: ReducerConfig,
	event: ToolResultEvent,
	context: ExtensionContext,
	cache?: ReceiptCache,
): Promise<ReducedToolResult | undefined> {
	if (context.signal?.aborted) return undefined;
	const reducible = await reducibleToolResult(event, dirname(config.storeRoot));
	if (!reducible || reducible.diagnosticCategory === "other") return undefined;
	const { body, command } = reducible;
	const isError = reducible.isError;
	if (Buffer.byteLength(body, "utf8") < config.minBytes) return undefined;
	if (body.length > config.maxChars) {
		journal("fallback", { reason: "source-over-max-chars", sourceChars: body.length, maxChars: config.maxChars });
		return undefined;
	}
	if (LIKELY_SECRET.test(body)) {
		journal("fallback", { reason: "likely-secret" });
		return undefined;
	}

	const archive = await archiveBody(archiveRoot(config), body);
	journal("candidate", {
		toolCallId: event.toolCallId,
		commandSha256: reducible.commandSha256,
		diagnosticCategory: reducible.diagnosticCategory,
		sourceScope: reducible.sourceScope,
		isError,
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		sourceLines: archive.lines,
		sourcePath: archive.path,
	});

	// Identity includes every input to reduction. Tool-call identity and wrapper
	// metadata are deliberately excluded: project onto the current result below.
	const cacheKey = sha256(JSON.stringify([
		REDUCER_RECEIPT_SCHEMA, config.storeRoot, config.runId,
		config.reducerProvider, config.reducerModel, config.maxOutputTokens, reducible.commandSha256, isError, archive.hash,
	]));
	const deterministic = deterministicDiagnostics(body, archive, isError);
	const cached = deterministic ? undefined : cache?.get(cacheKey);
	let provider: ProviderResult;
	try {
		provider = deterministic ? { ok: true, outputText: deterministic, provider: "local", model: "deterministic-diagnostics",
			errorMessage: undefined, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 } }
			: cached ?? await callReducer(config, command, isError, archive, body, context);
	} catch (error) {
		// Falling back must not hide an accounting write failure after a paid call.
		if (error instanceof UsageLedgerError) throw error;
		const name = errorName(error);
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason:
				name === "AbortError"
					? "model-call-timeout"
					: name === "ReducerModelUnavailableError"
						? "reducer-model-unavailable"
						: "model-call-exception",
		});
		return undefined;
	}

	if (deterministic) {
		journal("deterministic", { toolCallId: event.toolCallId, sourceSha256: archive.hash });
	} else if (cached) {
		journal("cache_hit", { toolCallId: event.toolCallId, sourceSha256: archive.hash });
	} else {
		journal("provider_response", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			provider: provider.provider,
			model: provider.model,
			stopReason: provider.stopReason,
			errorMessage: safeProviderError(provider.errorMessage),
			usage: provider.usage,
		});
	}
	if (!provider.ok) {
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason: "model-response-error",
			stopReason: provider.stopReason,
			errorMessage: safeProviderError(provider.errorMessage),
		});
		return undefined;
	}

	const checked = validateReceipt(provider.outputText, archive, body, isError);
	if (!checked.ok) {
		cache?.delete(cacheKey);
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason: checked.reason,
			...(cached ? { cacheHit: true } : { usage: provider.usage }),
		});
		return undefined;
	}
	const receipt = receiptText(command, archive, checked.value, provider, cached !== undefined, reducible.commandSha256, reducible.sourceScope);
	const receiptBytes = Buffer.byteLength(receipt, "utf8");
	if (receiptBytes >= archive.bytes) {
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason: "receipt-not-smaller",
			receiptBytes,
			sourceBytes: archive.bytes,
			...(cached ? { cacheHit: true } : { usage: provider.usage }),
		});
		return undefined;
	}
	journal("applied", {
		toolCallId: event.toolCallId,
		commandSha256: reducible.commandSha256,
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		receiptSha256: sha256(receipt),
		receiptBytes,
		evidenceCount: checked.value.evidence.length,
		uncertain: checked.value.uncertain,
		...(cached ? { cacheHit: true } : { usage: provider.usage }),
	});
	if (!cached && !deterministic) cache?.set(cacheKey, provider);
	showSolPiSavings(context, "Luna Delegating", formatSavingsBytes(archive.bytes - receiptBytes));
	return {
		content: reducible.projectReceipt(receipt),
		isError,
		details: {
			...(isRecord(event.details) ? event.details : {}),
			evidencePreservingReducer: {
				schema: REDUCER_RECEIPT_SCHEMA,
				sourceSha256: archive.hash,
				sourceBytes: archive.bytes,
				receiptSha256: sha256(receipt),
				receiptBytes,
				evidenceCount: checked.value.evidence.length,
				uncertain: checked.value.uncertain,
				cacheHit: cached !== undefined,
				reductionMode: deterministic ? "deterministic" : "model",
				sourceScope: reducible.sourceScope,
			},
		},
	};
}

export function createEvidencePreservingReducerExtension(options: EvidencePreservingReducerOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		// Keep only the current session's state. Switching roots drops retained
		// receipts instead of multiplying the per-cache bound by visited sessions.
		let state: { root: string; config: ReducerConfig; journal: Journal; cache: ReceiptCache } | undefined;
		pi.on("tool_result", (event, context) => {
			let root: string;
			try {
				root = runtimeRoot(context);
			} catch {
				return undefined;
			}
			if (state?.root !== root) {
				const config = loadReducerConfig(root, options);
				state = { root, config, journal: createJournal(pi, config), cache: new ReceiptCache() };
			}
			return reduceToolResult(state.journal, state.config, event, context, state.cache);
		});
	};
}

export type { ArchiveObject } from "./archive.ts";
export {
	DIAGNOSTIC_COMMAND,
	loadReducerConfig,
	REDUCER_EVENT_SCHEMA,
	REDUCER_EVENT_TYPE,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfigOptions,
	type ReducerConfig,
} from "./config.ts";
export { validateReceipt } from "./receipt.ts";

export function registerEvidencePreservingReducer(
	pi: ExtensionAPI,
	options: EvidencePreservingReducerOptions = {},
): void {
	createEvidencePreservingReducerExtension(options)(pi);
}

export default registerEvidencePreservingReducer;
