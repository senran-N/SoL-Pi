/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The small compatibility boundary between SoL-Pi and Pi.  Feature code should
 * ask this module for capabilities and nested model completions instead of
 * reaching into Pi's model registry independently.
 */
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { complete as compatComplete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PiCapabilities {
	readonly modelRegistryFind: boolean;
	readonly modelRegistryComplete: boolean;
	readonly modelRegistryAuth: boolean;
	readonly contextUsage: boolean;
	readonly nativeCompaction: boolean;
	readonly sessionTree: boolean;
	readonly uiStatus: boolean;
}

export function detectPiCapabilities(context: ExtensionContext): PiCapabilities {
	const registry = context.modelRegistry as unknown as Record<string, unknown>;
	const manager = context.sessionManager as unknown as Record<string, unknown>;
	const ui = context.ui as unknown as Record<string, unknown>;
	return Object.freeze({
		modelRegistryFind: typeof registry.find === "function",
		modelRegistryComplete: typeof registry.complete === "function",
		modelRegistryAuth: typeof registry.getApiKeyAndHeaders === "function",
		contextUsage: typeof context.getContextUsage === "function",
		nativeCompaction: typeof context.compact === "function",
		sessionTree: typeof manager.getBranch === "function" && typeof manager.getEntries === "function",
		uiStatus: typeof ui.setStatus === "function",
	});
}

export type CompatibleModelRegistry = {
	readonly find?: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly complete?: (
		model: Model<Api>,
		context: Context,
		options?: ProviderStreamOptions,
	) => Promise<AssistantMessage>;
	readonly getApiKeyAndHeaders: (model: Model<Api>) => Promise<ResolvedCompatAuth>;
};

export type ResolvedCompatAuth =
	| {
			readonly ok: true;
			readonly apiKey?: string;
			readonly baseUrl?: string;
			readonly env?: Record<string, string>;
			readonly headers?: Record<string, string | null>;
	  }
	| { readonly ok: false; readonly error: string };

export class PiCapabilityError extends Error {
	override readonly name = "PiCapabilityError";
}

function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

export interface NestedModelRequest {
	readonly provider: string;
	readonly modelId: string;
	readonly context: Context;
	readonly options: ProviderStreamOptions;
	readonly compatComplete?: typeof compatComplete;
}

/** Resolve and call a model through Pi, with the old compat path as a fallback. */
export async function completeNestedModel(
	extensionContext: ExtensionContext,
	request: NestedModelRequest,
): Promise<AssistantMessage> {
	const registry = extensionContext.modelRegistry as unknown as CompatibleModelRegistry;
	const model = registry.find?.(request.provider, request.modelId);
	if (!model) throw new PiCapabilityError(`Model is unavailable: ${request.provider}/${request.modelId}`);
	request.options.signal?.throwIfAborted();
	if (typeof registry.complete === "function") {
		return registry.complete(model, request.context, request.options);
	}
	if (typeof registry.getApiKeyAndHeaders !== "function") {
		throw new PiCapabilityError("Pi does not expose a compatible model authentication API");
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new PiCapabilityError(auth.error);
	const legacyModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	const headers = stringHeaders(auth.headers);
	request.options.signal?.throwIfAborted();
	return (request.compatComplete ?? compatComplete)(legacyModel, request.context, {
		...request.options,
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(headers === undefined ? {} : { headers }),
		...(auth.env === undefined ? {} : { env: auth.env }),
	});
}

export function formatCapabilities(capabilities: PiCapabilities): string[] {
	return Object.entries(capabilities).map(([name, supported]) => `${supported ? "✓" : "!"} ${name}`);
}
