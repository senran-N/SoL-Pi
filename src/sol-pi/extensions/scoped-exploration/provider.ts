/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The nested model call behind a scoped exploration.
 *
 * This mirrors Evidence-Preserving Reducer's provider path, including its
 * fallback for a Pi build whose model registry exposes no `complete()`. It is a
 * separate copy on purpose: the reducer's call is a verified mechanism with its
 * own tests, and an exploration should not be able to change its behaviour by
 * sharing a helper with it.
 */
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { complete as completeCompat } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trackModelCall } from "../../usage/ledger.ts";
import type { ExplorationConfig } from "./config.ts";

export type CompatComplete = typeof completeCompat;

type ResolvedCompatAuth =
	| {
			readonly ok: true;
			readonly apiKey?: string;
			readonly baseUrl?: string;
			readonly env?: Record<string, string>;
			readonly headers?: Record<string, string | null>;
	  }
	| { readonly ok: false; readonly error: string };

type CompatibleModelRegistry = {
	readonly find?: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly complete?: (
		model: Model<Api>,
		context: Context,
		options?: ProviderStreamOptions,
	) => Promise<AssistantMessage>;
	readonly getApiKeyAndHeaders: (model: Model<Api>) => Promise<ResolvedCompatAuth>;
};

export type ExplorerTurn = { readonly role: "user" | "assistant"; readonly text: string };

export class ExplorerModelUnavailableError extends Error {
	override readonly name = "ExplorerModelUnavailableError";
}

function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

function responseText(response: AssistantMessage): string {
	return response.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
}

export type ExplorerCall = (
	config: ExplorationConfig,
	systemPrompt: string,
	turns: readonly ExplorerTurn[],
	context: ExtensionContext,
	signal: AbortSignal,
) => Promise<string>;

export const callExplorer: ExplorerCall = async (config, systemPrompt, turns, context, signal) => {
	const registry = context.modelRegistry as unknown as CompatibleModelRegistry;
	const response = await trackModelCall(context, "explorer", { provider: config.explorerProvider, model: config.explorerModel }, async (dispatched) => {
		const model = registry.find?.(config.explorerProvider, config.explorerModel);
		if (!model) {
			throw new ExplorerModelUnavailableError(
				`Explorer model is unavailable: ${config.explorerProvider}/${config.explorerModel}`,
			);
		}

		const requestContext: Context = {
			systemPrompt,
			messages: turns.map((turn) => ({
				role: turn.role,
				content: [{ type: "text" as const, text: turn.text }],
				timestamp: Date.now(),
			})),
		} as Context;
		const requestOptions = {
			cacheRetention: "none" as const,
			maxTokens: Math.min(config.maxOutputTokens, model.maxTokens),
			signal,
			timeoutMs: config.timeoutMs,
		};

		if (typeof registry.complete === "function") {
			signal.throwIfAborted();
			dispatched();
			return registry.complete(model, requestContext, requestOptions);
		}
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const legacyModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const headers = stringHeaders(auth.headers);
		signal.throwIfAborted();
		dispatched();
		return completeCompat(legacyModel, requestContext, {
			...requestOptions,
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(headers === undefined ? {} : { headers }),
			...(auth.env === undefined ? {} : { env: auth.env }),
		});
	}, signal);
	if (response.stopReason !== "stop" && response.stopReason !== "length") {
		throw new Error(`Explorer model call ended with ${response.stopReason}; consult sol_pi_usage for recorded usage.`);
	}
	return responseText(response);
};
