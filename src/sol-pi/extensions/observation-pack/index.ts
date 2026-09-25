/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * ObservationPack - keep large tool results reachable without replaying them.
 *
 * A large tool result is sent in full for its first few provider requests, then
 * replaced with a short, stable placeholder for every later request. The
 * original bytes are archived by observation id outside the provider context,
 * and the agent pulls exact pages back with the registered `obs_recall` tool.
 *
 * The mechanism never edits history in place. It rewrites only at the
 * projection layer (`pi.on("context")`), so the stored session stays intact and
 * recall keeps working after native compaction or a session resume.
 *
 * Storage lives under the active Pi session directory.
 */

import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBoundaryDraft,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runtimeRoot } from "../../runtime-paths.ts";
import { formatSavingsCount, renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import { createLedger, readProjectionLedger, type Ledger } from "./ledger.ts";
import { DEFAULT_PACK_CACHE_RATIO, packingDecision } from "./policy.ts";
import { intentProjection, observationIntent, searchObservations } from "./retrieval.ts";
import {
	countLines,
	createObservation,
	ensureStored,
	estimateTokens,
	FULL_SENDS,
	isObservationId,
	isPackableTextResult,
	observationPath,
	placeholderFor,
	type RecallChunk,
	readRecallChunk,
} from "./observation.ts";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
	maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
	maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

type PendingContextEdit = {
	readonly toolCallId: string;
	readonly observationId: string;
	readonly placeholder: string;
};

function findObservationTargetId(
	entries: readonly SessionEntry[],
	root: string,
	candidate: PendingContextEdit,
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolCallId !== candidate.toolCallId) continue;
		const observation = createObservation(entry.message, root);
		if (observation?.id === candidate.observationId) return entry.id;
	}
	return undefined;
}

function findObservationTargetFromMessages(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
	root: string,
	candidate: PendingContextEdit,
): string | undefined {
	const messageIndex = messages.findIndex(
		(message) => message.role === "toolResult" && message.toolCallId === candidate.toolCallId,
	);
	if (messageIndex < 0) return undefined;
	const projected = messages[messageIndex];
	if (!projected || projected.role !== "toolResult") return undefined;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolCallId !== projected.toolCallId) continue;
		const observation = createObservation(entry.message, root);
		if (observation?.id === candidate.observationId) return entry.id;
	}
	return undefined;
}

export interface ObservationPackOptions { readonly cacheWriteReadRatio?: number }

export function createObservationPackExtension(options: ObservationPackOptions = {}): ExtensionFactory {
	const ratio = options.cacheWriteReadRatio ?? DEFAULT_PACK_CACHE_RATIO;
	if (!Number.isFinite(ratio) || ratio < 0) throw new Error("Observation Pack cache ratio must be finite and non-negative");
	return (pi: ExtensionAPI) => {
		const countsByRoot = new Map<string, ReturnType<typeof readProjectionLedger>>();
		const countsFor = (root: string): ReturnType<typeof readProjectionLedger> => {
			let counts = countsByRoot.get(root);
			if (!counts) {
				counts = readProjectionLedger(join(root, "observation-pack", "ledger.jsonl")).catch((error: unknown) => {
					// A failed read must not become a permanent empty recovery state.
					countsByRoot.delete(root);
					throw error;
				});
				countsByRoot.set(root, counts);
			}
			return counts;
		};
		const ledgers = new Map<string, Ledger>();
		let pendingContextEdits: readonly PendingContextEdit[] = [];
		let pendingContextRoot: string | undefined;
		const clearPendingContextEdits = (): void => {
			pendingContextEdits = [];
			pendingContextRoot = undefined;
		};
		const ledgerFor = (ctx: ExtensionContext): Ledger => {
			const root = runtimeRoot(ctx);
			let ledger = ledgers.get(root);
			if (!ledger) {
				ledger = createLedger(join(root, "observation-pack", "ledger.jsonl"));
				ledgers.set(root, ledger);
			}
			return ledger;
		};

		pi.registerTool({
			name: "obs_search", label: "Search Observations",
			description: "Search archived large text results on the current session branch, newest first. Returns exact recall offsets and a continuation cursor; no model call.",
			promptSnippet: "Find evidence inside archived tool output before paging through it",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 512 }),
				id: Type.Optional(Type.String()), tool: Type.Optional(Type.String()),
				after: Type.Optional(Type.String({ description: "Inclusive ISO timestamp" })),
				before: Type.Optional(Type.String({ description: "Inclusive ISO timestamp" })),
				cursor: Type.Optional(Type.String({ maxLength: 1024 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const result = await searchObservations(ctx.sessionManager.getBranch(), runtimeRoot(ctx), params);
				await ledgerFor(ctx)({ event: "search", hitCount: result.hits.length, scannedBytes: result.scanned_bytes, complete: result.complete });
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});

		pi.registerTool({
			name: "obs_recall",
			label: "Recall Observation",
			description: "Read a stored large tool result by observation id and byte offset.",
			promptSnippet: "Recall a paged excerpt from a previously replaced large tool result",
			renderShell: "self",
			parameters: Type.Object({
				id: Type.String({ description: "Observation id from a placeholder" }),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, default 0" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!isObservationId(params.id)) throw new Error(`Unknown observation id: ${params.id}`);
				const offset = params.offset ?? 0;
				let chunk: RecallChunk;
				try {
					chunk = await readRecallChunk(observationPath(runtimeRoot(ctx), params.id), offset, RECALL_LIMITS);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") {
						throw new Error(`Unknown observation id: ${params.id}`);
					}
					throw error;
				}
				const header = [
					`[obs_recall id=${params.id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
					`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
				].join("\n");
				const content = `${header}\n${chunk.text}`;
				if (Buffer.byteLength(content, "utf8") > RECALL_MAX_BYTES || countLines(content) > RECALL_MAX_LINES) {
					throw new Error("Recall output exceeded its hard limit");
				}
				await ledgerFor(ctx)({
					event: "recall",
					id: params.id,
					offset,
					bytes: chunk.bytes,
					lines: chunk.lines,
					nextOffset: chunk.nextOffset,
					eof: chunk.eof,
				});
				return {
					content: [{ type: "text", text: content }],
					details: {
						id: params.id,
						offset,
						bytes: chunk.bytes,
						lines: chunk.lines,
						nextOffset: chunk.nextOffset,
						eof: chunk.eof,
					},
				};
			},
			renderCall(params, theme) {
				const offset = params.offset ?? 0;
				const base = new Text(theme.fg("dim", `Recall ${params.id} from byte ${offset}`), 0, 0);
				return renderSolPiTool(theme, "Observation Pack", "full observation replay avoided", base);
			},
			renderResult(result, { isPartial }, theme) {
				const details = result.details as { bytes?: number; lines?: number } | undefined;
				const base = new Text(
					theme.fg(
						isPartial ? "warning" : "dim",
						isPartial
							? "Recalling the requested slice..."
							: `Recalled ${details?.bytes ?? 0} bytes across ${details?.lines ?? 0} lines`,
					),
					0,
					0,
				);
				return renderSolPiTool(theme, "Observation Pack", "full observation replay avoided", base);
			},
		});

		pi.on("context", async (event, ctx: ExtensionContext) => {
			clearPendingContextEdits();
			const projected = [...event.messages];
			const root = runtimeRoot(ctx);
			const edits: PendingContextEdit[] = [];
			let recovered: Awaited<ReturnType<typeof readProjectionLedger>> | undefined;
			// How many provider requests each message has already been part of,
			// counted by the assistant messages that follow it.
			const priorAssistantCounts = new Array<number>(event.messages.length);
			let assistantCount = 0;

			for (let index = event.messages.length - 1; index >= 0; index -= 1) {
				priorAssistantCounts[index] = assistantCount;
				if (event.messages[index]?.role === "assistant") assistantCount += 1;
			}

			const requestIndex = assistantCount + 1;
			for (let index = 0; index < event.messages.length; index += 1) {
				const message = event.messages[index];
				if (!message || !isPackableTextResult(message)) continue;

				try {
					const observation = createObservation(message, root);
					if (!observation) continue;
					await ensureStored(observation);

					recovered ??= await countsFor(root);
					const sentCounts = recovered.counts;
					// Preserve the older session-history fallback when no ledger row
					// exists (e.g. a fork), without shrinking a recovered allowance.
					const previousSends = sentCounts.get(observation.id) ?? priorAssistantCounts[index] ?? 0;
					const stable = recovered.packed.has(observation.id);
					const intent = observationIntent(event.messages, observation, message.toolCallId);
					const firstPass = Boolean(intent && (previousSends === 0 || recovered.firstPass.has(observation.id)));
					const placeholder = firstPass ? intentProjection(observation, intent!) : placeholderFor(observation);
					const placeholderTokens = estimateTokens(placeholder);
					const removedTokens = Math.max(0, observation.tokens - placeholderTokens);
					const decision = packingDecision({ context: ctx, messages: projected, savedTokens: removedTokens,
						cacheWriteReadRatio: ratio, stable, firstProjection: firstPass && previousSends === 0 });
					await ledgerFor(ctx)({ event: "decision", id: observation.id, ...decision, cacheWriteReadRatio: ratio });
					if ((!stable && !firstPass && previousSends < FULL_SENDS && decision.reason !== "window_pressure") || !decision.pack) {
						await ledgerFor(ctx)({
							event: "full",
							id: observation.id,
							request: requestIndex,
							sendNumber: previousSends + 1,
							tool: observation.toolName,
							originalBytes: observation.bytes,
							originalLines: observation.lines,
							originalTokens: observation.tokens,
							isError: observation.isError,
							contentHash: observation.contentHash,
						});
						sentCounts.set(observation.id, previousSends + 1);
						continue;
					}

					await ledgerFor(ctx)({
						event: "placeholder",
						id: observation.id,
						request: requestIndex,
						sendNumber: previousSends + 1,
						tool: observation.toolName,
						originalBytes: observation.bytes,
						originalLines: observation.lines,
						originalTokens: observation.tokens,
						isError: observation.isError,
						placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
						placeholderTokens,
						removedTokens,
						firstPass,
					});
					if (!stable) {
						showSolPiSavings(
							ctx,
							"Observation Pack",
							formatSavingsCount(removedTokens, "context tokens avoided"),
						);
					}
					projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
					edits.push({ toolCallId: message.toolCallId, observationId: observation.id, placeholder });
					sentCounts.set(observation.id, previousSends + 1);
					recovered.packed.add(observation.id);
					if (firstPass) recovered.firstPass.add(observation.id);
				} catch (error) {
					// Fail open: a packing failure must never cost the agent its observation.
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`[observationpack] fail-open for tool result: ${reason}`);
				}
			}

			pendingContextEdits = edits;
			pendingContextRoot = root;
			return { messages: projected };
		});

		pi.on("turn_end", (event, context) => {
			const candidates = pendingContextEdits;
			const candidateRoot = pendingContextRoot;
			clearPendingContextEdits();
			if (candidates.length === 0 || !candidateRoot) return;

			let root: string;
			try {
				root = runtimeRoot(context);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`[observationpack] context edit fail-open: ${reason}`);
				return;
			}
			if (root !== candidateRoot) return;
			const entries: SessionBoundaryDraft[] = [...event.entries];
			const branch = context.sessionManager.getBranch();
			const editedTargets = new Set<string>(
				branch.flatMap((entry) => entry.type === "context_edit" ? [entry.targetId] : []),
			);
			for (const entry of event.entries) {
				if (entry.type === "context_edit") editedTargets.add(entry.targetId);
			}
			for (const candidate of candidates) {
				const targetId = findObservationTargetId(branch, root, candidate) ??
					findObservationTargetFromMessages(branch, event.context.contextMessages, root, candidate);
				if (!targetId || editedTargets.has(targetId)) continue;
				editedTargets.add(targetId);
				entries.push({
					type: "context_edit",
					targetId,
					replacement: { content: [{ type: "text", text: candidate.placeholder }] },
				});
			}
			return entries.length === event.entries.length ? undefined : { entries };
		});

		pi.on("session_start", clearPendingContextEdits);
		pi.on("session_tree", clearPendingContextEdits);
		pi.on("session_shutdown", clearPendingContextEdits);
	};
}

export {
	createObservation,
	FULL_SENDS,
	isPackableTextResult,
	type Observation,
	PLACEHOLDER_EXCERPT_BYTES,
	placeholderFor,
	THRESHOLD_BYTES,
} from "./observation.ts";

export function registerObservationPack(pi: ExtensionAPI, options: ObservationPackOptions = {}): void {
	createObservationPackExtension(options)(pi);
}

export default registerObservationPack;
