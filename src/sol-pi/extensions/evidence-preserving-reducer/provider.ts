/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { complete as completeCompat } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeNestedModel } from "../../pi-compat.ts";
import { trackModelCall } from "../../usage/ledger.ts";
import type { ArchiveObject } from "./archive.ts";
import type { ReducerConfig } from "./config.ts";
import { reducerInput, reducerInstructions } from "./receipt.ts";

export type CompatComplete = typeof completeCompat;

export interface NormalizedUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface ProviderResult {
	readonly errorMessage: string | undefined;
	readonly model: string;
	readonly ok: boolean;
	readonly outputText: string;
	readonly provider: string;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly usage: NormalizedUsage;
}

export class ReducerModelUnavailableError extends Error {
	override readonly name = "ReducerModelUnavailableError";
}

function responseOutputText(response: AssistantMessage): string {
	return response.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
}

function normalizedUsage(response: AssistantMessage): NormalizedUsage {
	return {
		input: response.usage.input,
		output: response.usage.output,
		cacheRead: response.usage.cacheRead,
		cacheWrite: response.usage.cacheWrite,
		totalTokens: response.usage.totalTokens,
	};
}

function operationSignal(parent: AbortSignal | undefined, timeoutMs: number): {
	readonly cleanup: () => void;
	readonly signal: AbortSignal;
} {
	const controller = new AbortController();
	const relayAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) relayAbort();
	else parent?.addEventListener("abort", relayAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException("Reducer model call timed out", "AbortError")),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", relayAbort);
		},
	};
}

/** Use the configured reducer model and Pi-managed authentication for the reducer call. */
export async function callReducer(
	config: ReducerConfig,
	command: string,
	isError: boolean,
	archive: ArchiveObject,
	body: string,
	context: ExtensionContext,
	compatComplete: CompatComplete = completeCompat,
): Promise<ProviderResult> {
	const operation = operationSignal(context.signal, config.timeoutMs);
	try {
		const response = await trackModelCall(context, "reducer", { provider: config.reducerProvider, model: config.reducerModel }, async (dispatched) => {
			const requestContext: Context = {
				systemPrompt: reducerInstructions(),
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: reducerInput(command, isError, archive, body) }],
						timestamp: Date.now(),
					},
				],
			};
			const model = (context.modelRegistry as { find?: (provider: string, modelId: string) => { maxTokens: number } | undefined }).find?.(
				config.reducerProvider,
				config.reducerModel,
			);
			if (!model) throw new ReducerModelUnavailableError(`Reducer model is unavailable: ${config.reducerProvider}/${config.reducerModel}`);
			dispatched();
			return completeNestedModel(context, {
				provider: config.reducerProvider,
				modelId: config.reducerModel,
				context: requestContext,
				options: {
					cacheRetention: "none" as const,
					maxTokens: Math.min(config.maxOutputTokens, model.maxTokens),
					sessionId: config.runId,
					signal: operation.signal,
					timeoutMs: config.timeoutMs,
				},
				compatComplete,
			});
		}, operation.signal);
		return {
			errorMessage: response.errorMessage,
			model: response.model,
			ok: response.stopReason === "stop" || response.stopReason === "length",
			outputText: responseOutputText(response),
			provider: response.provider,
			stopReason: response.stopReason,
			usage: normalizedUsage(response),
		};
	} finally {
		operation.cleanup();
	}
}
