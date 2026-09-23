/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	estimateTokens,
	findCutPoint,
	sessionEntryToContextMessages,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionBoundaryDraft,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatSavingsCount, showSolPiSavings } from "../../tui.ts";
import { runtimeRoot } from "../../runtime-paths.ts";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	type CompactionDecision,
} from "./economics.ts";
import { collectUserDirectives, collectUserReferences } from "./directives.ts";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts";
import {
	appendOnlineState,
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	recordBoundary,
	recordCompaction,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
	type OnlineState,
	type ProgressSummary,
} from "./state.ts";
import {
	HISTORY_DEFAULT_LIMIT,
	HISTORY_MAX_LIMIT,
	readHistoryEntry,
	searchHistory,
} from "./history.ts";
import { appendNote, listNotes, readNote, readNotesIndex, writeNote } from "./notes.ts";
import { registerOnlineTools, type PlanUpdateInput } from "./tools.ts";
import { formatWindowFragment, selectCompactionMode, windowIdentity, type WindowResetInput } from "./window.ts";
import { appendWindowLedger } from "./window-ledger.ts";

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;
export const BOUNDARY_COMPACTION_INSTRUCTIONS =
	"Preserve completed work, verification results, important decisions, and remaining work.";
export const POST_COMPACTION_PLAN_REMINDER =
	"Online context compaction finished. The parent task is still active. " +
	"Before continuing work, call update_plan with a fresh plan for the remaining work.";
/** Paths are cheap; the exploration needed to rediscover them is not. */
export const CONTINUATION_FILES_MAX = 8;
const CONTINUATION_FILE_MAX_BYTES = 200;

export type OnlineContextCompactOptions = {
	readonly cacheWriteReadRatio?: number | null;
	readonly keepRecentTokens?: number;
};

type PendingBoundary = { readonly toolCallId: string };
type SelectedCompaction = { readonly decision: CompactionDecision };
type CacheDebt = { readonly debtTokens: number; readonly repaymentTokens: number };
type PendingReset = { readonly windowNumber: number; readonly fragment: string; readonly checkpoint: WindowResetInput };

export function resolveKeepRecentTokens(value: number | undefined): number {
	const resolved = value ?? DEFAULT_KEEP_RECENT_TOKENS;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error("Online Context Compact keepRecentTokens must be a positive safe integer");
	}
	return resolved;
}

function resolveCacheWriteReadRatio(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("Online Context Compact cacheWriteReadRatio must be finite and non-negative");
	}
	return value;
}

/**
 * Most recently recorded changed files, newest first.
 *
 * A compaction removes the edits themselves from the window, so the model wakes
 * up knowing that work happened but not where. Left to itself it re-derives the
 * answer by searching, which spends a large part of what the compaction just
 * saved. The paths are the smallest thing that turns that search back into a
 * targeted read.
 */
export function recentChangedFiles(progress: readonly ProgressSummary[]): readonly string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	for (let index = progress.length - 1; index >= 0; index -= 1) {
		for (const candidate of progress[index]?.filesChanged ?? []) {
			const path = candidate.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
			if (path.length === 0 || Buffer.byteLength(path, "utf8") > CONTINUATION_FILE_MAX_BYTES) continue;
			if (seen.has(path)) continue;
			seen.add(path);
			files.push(path);
			if (files.length >= CONTINUATION_FILES_MAX) return files;
		}
	}
	return files;
}

export function formatPostCompactionContinuation(files: readonly string[]): string {
	if (files.length === 0) return POST_COMPACTION_PLAN_REMINDER;
	return [
		POST_COMPACTION_PLAN_REMINDER,
		`Files already changed in this session: ${files.join(", ")}. ` +
			"Their contents are no longer in context, so re-read one before editing it again rather than searching for what changed.",
	].join("\n");
}

function tokenEstimate(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 4);
}

function result(text: string, details: Readonly<Record<string, unknown>>): AgentToolResult<Readonly<Record<string, unknown>>> {
	return { content: [{ type: "text", text }], details };
}

function progressSummary(input: PlanUpdateInput, completedStepId: string): ProgressSummary | undefined {
	const step = input.steps.find((item) => item.id === completedStepId);
	if (!step || !input.progress) return;
	return {
		stepId: step.id,
		goal: step.goal,
		filesChanged: [...input.progress.files_changed],
		verification: [...input.progress.verification],
		decisions: [...input.progress.decisions],
		nextWork: input.steps.filter((item) => item.status !== "completed").map((item) => item.goal),
	};
}

function compactionMessageCount(entries: readonly SessionEntry[], startIndex: number, endIndex: number): number {
	let count = 0;
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (entry && entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0) count++;
	}
	return count;
}

function branchAfterAbort(entries: readonly SessionEntry[]): SessionEntry[] {
	const last = entries.at(-1);
	const markerProvider = ["sol", "pi"].join("-");
	return [
		...entries,
		{
			type: "message",
			id: "sol-pi-online-context-compact-abort-marker",
			parentId: last?.id ?? null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: markerProvider,
				provider: markerProvider,
				model: "aborted",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: 0,
			},
		} as SessionEntry,
	];
}

function nativeCompactionFeasible(entries: readonly SessionEntry[], keepRecentTokens: number): boolean {
	const path = branchAfterAbort(entries);
	let startIndex = 0;
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type !== "compaction") continue;
		const keptIndex = path.findIndex((item) => item.id === entry.firstKeptEntryId);
		startIndex = keptIndex >= 0 ? keptIndex : index + 1;
		break;
	}

	const cut = findCutPoint(path, startIndex, path.length, keepRecentTokens);
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const historyMessages = historyEnd > startIndex ? compactionMessageCount(path, startIndex, historyEnd) : 0;
	const prefixMessages =
		cut.isSplitTurn && cut.turnStartIndex >= 0
			? compactionMessageCount(path, cut.turnStartIndex, cut.firstKeptEntryIndex)
			: 0;
	return historyMessages > 0 || prefixMessages > 0;
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createOnlineContextCompactExtension(options: OnlineContextCompactOptions = {}): ExtensionFactory {
	const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens);
	const cacheWriteReadRatio = resolveCacheWriteReadRatio(options.cacheWriteReadRatio);

	return (pi) => {
		let state: OnlineState = initialOnlineState();
		let restored = false;
		let observedMessages: readonly AgentMessage[] = [];
		let pendingBoundary: PendingBoundary | undefined;
		let selected: SelectedCompaction | undefined;
		let activeDebt: CacheDebt | undefined;
		let pendingReset: PendingReset | undefined;
		// A model-requested window reset. Unlike the economic boundary it does not
		// depend on a priced decision, but it is still applied at the next idle
		// settlement so the tool never aborts the turn that called it.
		let resetRequested = false;
		// State included in a turn_end boundary is persisted by Pi before the next
		// request. Do not use it early: if boundary validation rejects the draft,
		// restore the last committed state from the session branch instead.
		let pendingBoundaryState: OnlineState | undefined;
		let compactionInFlight = false;

		const restore = (context: ExtensionContext): void => {
			state = restoreOnlineState(context.sessionManager.getBranch());
			restored = true;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			pendingReset = undefined;
			pendingBoundaryState = undefined;
			resetRequested = false;
			compactionInFlight = false;
		};
		const ensureRestored = (context: ExtensionContext): void => {
			if (!restored) restore(context);
		};
		const save = (): void => appendOnlineState(pi, state);
		// Window numbers count compactions, not context resets. `state.epoch` also
		// advances on a correction, which rebuilds the plan without producing a
		// checkpoint, so numbering windows by it would leave gaps and point each
		// fragment at a predecessor that never existed.
		const nextWindowNumber = (): number => state.nativeCompactionCount + 1;
		// The window fragment may only carry a short note index; a missing or
		// unreadable notes directory degrades to "no notes" rather than failing.
		const noteIndex = async (context: ExtensionContext): Promise<readonly string[]> => {
			try {
				return await readNotesIndex(runtimeRoot(context));
			} catch {
				return [];
			}
		};
		// Report and act on one budget snapshot. Pi may have no usage just after a
		// reset, or its estimate may be smaller than the current projected context.
		const contextBudget = (context: ExtensionContext) => {
			const usage = context.getContextUsage();
			const visible = observedMessages.reduce((total, message) => total + estimateTokens(message), 0);
			const estimated = visible + tokenEstimate(context.getSystemPrompt());
			const reported = usage?.tokens;
			const useReported = validPositiveInteger(reported) && reported >= estimated;
			return {
				tokens: useReported ? reported : estimated,
				tokenSource: useReported ? "pi_usage" : "local_estimate",
				window: validPositiveInteger(usage?.contextWindow)
					? usage.contextWindow
					: validPositiveInteger(context.model?.contextWindow) ? context.model.contextWindow : null,
			};
		};

		registerOnlineTools(pi, {
			updatePlan: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Plan update was aborted");
				const steps = parsePlanSteps(input.steps);
				if (!steps || steps.length === 0) throw new Error("Plan must contain at least one valid step");

				const transition = analyzePlanTransition(state.plan, steps);
				const completedIds = transition.completedSteps.map((step) => step.id);
				if (completedIds.length > 0) {
					state = recordBoundary(state, steps, progressSummary(input, completedIds[0] ?? ""));
					if (!pendingBoundary) pendingBoundary = { toolCallId: input.toolCallId };
				} else if (JSON.stringify(state.plan) !== JSON.stringify(steps)) {
					state = { ...state, plan: [...steps] };
				}
				save();

				return result(
					[formatPlanSnapshot(steps), ...transition.advice].join("\n"),
					{
						boundary: completedIds.length > 0,
						completed_step_ids: completedIds,
						progress_recorded: completedIds.length > 0 && input.progress !== undefined,
						task_status: "active",
						plan: steps,
					},
				);
			},
			noteWrite: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Note write was aborted");
				const entry = await writeNote(runtimeRoot(input.context), input.slug, input.body);
				return result(`Recorded note "${entry.slug}" (${entry.bytes} bytes).`, {
					op: "write",
					slug: entry.slug,
					bytes: entry.bytes,
					task_status: "active",
				});
			},
			noteAppend: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Note append was aborted");
				const entry = await appendNote(runtimeRoot(input.context), input.slug, input.body);
				return result(`Appended to note "${entry.slug}" (now ${entry.bytes} bytes).`, {
					op: "append",
					slug: entry.slug,
					bytes: entry.bytes,
					task_status: "active",
				});
			},
			noteRead: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Note read was aborted");
				const root = runtimeRoot(input.context);
				const text = await readNote(root, input.slug);
				if (text === undefined) {
					const available = (await listNotes(root)).map((entry) => entry.slug);
					throw new Error(
						`No note named "${input.slug}". Available notes: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
					);
				}
				return result(text, {
					op: "read",
					slug: input.slug,
					found: true,
					bytes: Buffer.byteLength(text, "utf8"),
				});
			},
			newContext: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Context reset was aborted");
				// Pi refuses to compact a session that has nothing to archive, so a
				// request it could not honor is declined here rather than recorded and
				// dropped at settlement.
				if (!nativeCompactionFeasible(input.context.sessionManager.getBranch(), keepRecentTokens)) {
					return result(
						"Not enough recorded history to start a new window yet, so nothing was reset. Keep working and call new_context again once the context is actually filling up.",
						{ op: "new_context", requested: false, reason: "native_not_compactable", task_status: "active" },
					);
				}
				resetRequested = true;
				return result(
					"Context window reset requested. It is applied once the current turn settles: the recorded plan, progress, and note index become the checkpoint of the new window, and no summarization request is sent.",
					{ op: "new_context", requested: true, task_status: "active" },
				);
			},
			contextRemaining: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Context usage read was aborted");
				const { tokens, window, tokenSource } = contextBudget(input.context);
				const percent = window === null ? null : tokens / window * 100;
				const remaining = window === null ? null : Math.max(0, window - tokens);
				const text =
					remaining === null
						? `Context: ${tokens} tokens used; the context window size is unknown.`
						: `Context: ${tokens} of ${window} tokens used (${percent === null ? "?" : percent}%), ${remaining} tokens remaining. Use new_context to start a fresh window from the recorded plan, progress, and notes.`;
				return result(`${text} Token counts are estimates (${tokenSource}).`, {
					op: "get_context_remaining",
					tokens,
					token_source: tokenSource,
					context_window: window,
					remaining_tokens: remaining,
					percent,
					task_status: "active",
				});
			},
			historySearch: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("History search was aborted");
				// getBranch() keeps recall on the current path: it still reaches work a
				// compaction removed from the window, but never resurfaces a branch the
				// user forked or rewound away from.
				const entries = input.context.sessionManager.getBranch();
				const limit = input.limit ?? HISTORY_DEFAULT_LIMIT;
				const search = searchHistory(entries, input.query, limit);
				if (search.total === 0) {
					return result(`No recorded history matches "${input.query}".`, {
						op: "history_search",
						query: input.query,
						total: 0,
						hits: [],
					});
				}
				const lines = search.hits.map(
					(hit) => `- ${hit.id} [${hit.kind}] #${hit.index}: ${hit.snippet}`,
				);
				const note = search.truncated
					? ` (showing ${search.hits.length} of ${search.total}; narrow the query or raise limit up to ${HISTORY_MAX_LIMIT})`
					: "";
				return result(
					`${search.total} matches for "${input.query}"${note}:\n${lines.join("\n")}\nRead one with history_read id.`,
					{
						op: "history_search",
						query: input.query,
						total: search.total,
						hits: search.hits.map((hit) => ({ id: hit.id, index: hit.index, kind: hit.kind })),
					},
				);
			},
			historyRead: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("History read was aborted");
				const found = readHistoryEntry(input.context.sessionManager.getBranch(), input.id, input.offset, input.limit);
				if (!found) throw new Error(`Unknown history entry id "${input.id}". Use history_search to find an id.`);
				const next = found.nextOffset === null ? "" : `\nContinue with history_read id="${input.id}" offset=${found.nextOffset}.`;
				return result(`[${found.kind}] #${found.index} (bytes ${found.offset}-${found.endOffset} of ${found.totalBytes})\n${found.text}${next}`, {
					op: "history_read",
					id: input.id,
					kind: found.kind,
					offset: found.offset,
					next_offset: found.nextOffset,
					total_bytes: found.totalBytes,
					bytes: Buffer.byteLength(found.text, "utf8"),
				});
			},
		});

		pi.on("session_start", (_event, context) => restore(context));
		pi.on("session_before_tree", () => (compactionInFlight ? { cancel: true } : undefined));
		pi.on("session_tree", (_event, context) => restore(context));

		pi.on("context", (event, context) => {
			ensureRestored(context);
			observedMessages = [...event.messages];
		});

		pi.on("before_provider_request", (_event, context) => {
			ensureRestored(context);
			if (pendingBoundaryState) {
				state = pendingBoundaryState;
				pendingBoundaryState = undefined;
				compactionInFlight = false;
			}
			state = recordProviderRequest(state, contextBudget(context).tokens);
			save();
		});

		pi.on("input", (event, context) => {
			if (event.streamingBehavior !== "steer" && !event.text.startsWith("CORRECTION:")) {
				return { action: "continue" as const };
			}
			ensureRestored(context);
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			pendingBoundaryState = undefined;
			state = recordCorrection(state);
			save();
			return { action: "continue" as const };
		});

		pi.on("turn_end", async (event, context) => {
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			const requestedReset = resetRequested;
			if (requestedReset) resetRequested = false;
			if (!boundary && !requestedReset) return;
			const toolResult = boundary === undefined
				? undefined
				: event.toolResults.find((item) => item.toolCallId === boundary.toolCallId);
			if (
				event.message.role !== "assistant" ||
				event.message.stopReason === "error" ||
				event.message.stopReason === "aborted" ||
				context.signal?.aborted ||
				(boundary !== undefined && (!toolResult || toolResult.isError))
			) {
				if (requestedReset) resetRequested = true;
				return;
			}

			const { tokens: writeTokens, window: contextWindowTokens } = contextBudget(context);
			const fixedTokens = tokenEstimate(context.getSystemPrompt());
			const archiveTokens = Math.max(0, writeTokens - fixedTokens - keepRecentTokens);
			const averageContextTokenIncrement =
				state.positiveContextDeltaCount === 0
					? null
					: state.positiveContextDeltaTotal / state.positiveContextDeltaCount;
			const priced = boundary
				? decideCompaction({
					writeTokens,
					archiveTokens,
						memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
					contextTokens: writeTokens,
					completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
					remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
					averageContextTokenIncrement,
					contextWindowTokens,
					priorCompactionCount: state.nativeCompactionCount,
					carriedDebtTokens: state.cacheDebtTokens,
					cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
					cacheWriteReadRatio,
					economics: DEFAULT_COMPACTION_ECONOMICS,
				})
				: {
						writeTokens,
						archiveTokens,
						memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
						contextTokens: writeTokens,
						completedBoundaryRequestCounts: null,
						requestsPerBoundaryMean: null,
						requestsPerBoundaryLowerBound: null,
						unboundedExpectedRemainingRequests: null,
						averageContextTokenIncrement: null,
						windowRequestUpperBound: null,
						expectedRemainingRequests: null,
						breakevenRequests: null,
						combinedBreakevenRequests: null,
						effectiveHorizonRequests: null,
						cacheWriteReadRatio,
						incrementalCacheCostRatio: null,
						priorCompactionCount: state.nativeCompactionCount,
						carriedDebtTokens: state.cacheDebtTokens,
						cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
						compact: false,
						reason: "horizon_unavailable" as const,
					};
			const decision: CompactionDecision =
				priced.compact && !nativeCompactionFeasible(context.sessionManager.getBranch(), keepRecentTokens)
					? { ...priced, compact: false, reason: "native_not_compactable" }
					: priced;
			const structural = requestedReset ||
				(decision.compact && selectCompactionMode({ plan: state.plan, progress: state.pendingProgress }) === "reset");
			if (structural) {
				const continuationFiles = recentChangedFiles(state.pendingProgress);
				const windowNumber = nextWindowNumber();
				const checkpoint: WindowResetInput = {
					windowNumber,
					plan: state.plan,
					progress: state.pendingProgress,
					notesIndex: await noteIndex(context),
					directives: collectUserDirectives(context.sessionManager.getBranch()),
					userReferences: collectUserReferences(context.sessionManager.getBranch()),
				};
				const reset: PendingReset = { windowNumber, checkpoint, fragment: formatWindowFragment(checkpoint) };
				const writeTokens = requestedReset ? contextBudget(context).tokens : decision.writeTokens;
				const archiveTokens = requestedReset
					? Math.max(0, writeTokens - tokenEstimate(context.getSystemPrompt()) - keepRecentTokens)
					: decision.archiveTokens;
				const memoTokens = tokenEstimate(reset.fragment);
				const nextState = recordCompaction(state, {
					debtTokens: state.cacheDebtTokens + writeTokens * Math.max(0, (cacheWriteReadRatio ?? 1) - 1),
					repaymentTokens: Math.max(0, archiveTokens - memoTokens),
				});
				const identity = windowIdentity(windowNumber);
				const details = {
					solPiWindow: {
						version: 1,
						mode: "reset",
						windowNumber,
						windowId: identity.windowId,
						previousWindowId: identity.previousWindowId,
						checkpoint,
					},
				};
				try {
					await appendWindowLedger(runtimeRoot(context), {
						event: "reset",
						reason: "manual",
						windowNumber,
						windowId: identity.windowId,
						previousWindowId: identity.previousWindowId,
						firstKeptEntryId: "retain-none",
						tokensBefore: writeTokens,
						fragmentBytes: Buffer.byteLength(reset.fragment, "utf8"),
						at: new Date().toISOString(),
					});
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`[onlinecontextcompact] window ledger write failed: ${reason}`);
				}
				const removed = Math.max(0, archiveTokens - memoTokens);
				if (removed > 0) showSolPiSavings(context, "Online Context Compact", formatSavingsCount(removed, "context tokens removed"));
				const drafts: SessionBoundaryDraft[] = [
					{ type: "compaction", summary: reset.fragment, firstKeptEntryId: null, details },
					{
						type: "custom_message",
						customType: "sol-pi-online-context-compact",
						content: formatPostCompactionContinuation(continuationFiles),
						display: false,
					},
					{ type: "custom", customType: ONLINE_STATE_ENTRY, data: nextState },
				];
				pendingBoundaryState = nextState;
				compactionInFlight = true;
				return { entries: drafts, continue: true };
			}
			if (!decision.compact) return;

			selected = { decision };
			context.abort();
		});

		pi.on("agent_settled", async (_event, context) => {
			if (pendingBoundaryState) {
				state = restoreOnlineState(context.sessionManager.getBranch());
				pendingBoundaryState = undefined;
				compactionInFlight = false;
				return;
			}
			const pending = selected;
			selected = undefined;
			const requestedReset = resetRequested;
			if (!pending && !requestedReset) return;
			if (requestedReset) resetRequested = false;
			// The priced path already cleared this check at turn_end; a reset that
			// arrives on its own has not, and Pi throws rather than no-ops when there
			// is nothing to archive.
			if (!pending && !nativeCompactionFeasible(context.sessionManager.getBranch(), keepRecentTokens)) {
				return;
			}

			// Read before the compaction runs: session_compact clears pendingProgress,
			// so by the time the continuation is sent these paths are gone. They are
			// the one thing the model cannot cheaply rediscover on the other side.
			const continuationFiles = recentChangedFiles(state.pendingProgress);

			// Windowed handoff: when structured state can rebuild the handoff, hand Pi a
			// synthetic compaction result so no summarization request is sent. An
			// explicit reset is honored even without priced savings.
			if (requestedReset || selectCompactionMode({ plan: state.plan, progress: state.pendingProgress }) === "reset") {
				const windowNumber = nextWindowNumber();
				const checkpoint: WindowResetInput = {
					windowNumber,
					plan: state.plan,
					progress: state.pendingProgress,
					notesIndex: await noteIndex(context),
					directives: collectUserDirectives(context.sessionManager.getBranch()),
					userReferences: collectUserReferences(context.sessionManager.getBranch()),
				};
				pendingReset = { windowNumber, checkpoint, fragment: formatWindowFragment(checkpoint) };
			}

			// No summary model call does not mean no cache rebuild. Carry unpaid
			// debt even for explicit resets and window-protection overrides.
			const writeTokens = pending?.decision.writeTokens ?? contextBudget(context).tokens;
			const memoTokens = pendingReset ? tokenEstimate(pendingReset.fragment) : DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE;
			activeDebt = {
				debtTokens: state.cacheDebtTokens + writeTokens * Math.max(0, (cacheWriteReadRatio ?? 1) - 1),
				repaymentTokens: Math.max(0,
					(pending?.decision.archiveTokens ?? Math.max(0, writeTokens - tokenEstimate(context.getSystemPrompt()) - keepRecentTokens)) - memoTokens),
			};
			// A reset carries no priced decision, so measure what it is about to
			// archive the same way turn_end does; otherwise it reports no savings at
			// all.
			const archiveTokens = pending
				? pending.decision.archiveTokens
				: Math.max(0, writeTokens - tokenEstimate(context.getSystemPrompt()) - keepRecentTokens);
			let compacted = false;
			let compactionError: Error | undefined;
			try {
				compactionInFlight = true;
				await new Promise<void>((resolve) => {
					let finished = false;
					const finish = (): void => {
						if (finished) return;
						finished = true;
						resolve();
					};
					context.compact({
						customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS,
						onComplete: (compaction) => {
							try {
								compacted = true;
								const removed = Math.max(0, archiveTokens - tokenEstimate(compaction.summary));
								if (removed > 0) {
									showSolPiSavings(
										context,
										"Online Context Compact",
										formatSavingsCount(removed, "context tokens removed"),
									);
								}
							} finally {
								finish();
							}
						},
						onError: (error) => {
							compactionError = error;
							finish();
						},
					});
				});
				compactionInFlight = false;
				if (
					compactionError &&
					compactionError.name !== "AbortError" &&
					compactionError.message !== "Compaction cancelled"
				) {
					throw compactionError;
				}

				if (compacted) {
					// Pi 0.87.0: sendMessage({triggerTurn:true}) from agent_settled
					// pushes a deferred action that Pi awaits in _emitAgentSettled.
					// No settlement barrier is needed — Pi keeps the process alive
					// until the deferred continuation run completes.
					pi.sendMessage(
						{
							customType: "sol-pi-online-context-compact",
							content: formatPostCompactionContinuation(continuationFiles),
							display: false,
						},
						{ triggerTurn: true },
					);
				}
			} finally {
				compactionInFlight = false;
				activeDebt = undefined;
				pendingReset = undefined;
				pendingBoundaryState = undefined;
			}
		});

		pi.on("session_before_compact", async (event, context) => {
			const intent = pendingReset;
			pendingReset = undefined;
			const windowNumber = intent?.windowNumber ?? nextWindowNumber();
			const identity = windowIdentity(windowNumber);
			try {
				await appendWindowLedger(runtimeRoot(context), {
					event: intent ? "reset" : "summary",
					reason: event.reason,
					windowNumber,
					windowId: identity.windowId,
					previousWindowId: identity.previousWindowId,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					fragmentBytes: intent ? Buffer.byteLength(intent.fragment, "utf8") : 0,
					at: new Date().toISOString(),
				});
			} catch (error) {
				// Fail open: an audit-trail problem must never block compaction.
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`[onlinecontextcompact] window ledger write failed: ${reason}`);
			}
			if (!intent) return;
			return {
				compaction: {
					summary: intent.fragment,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						solPiWindow: {
							version: 1,
							mode: "reset",
							windowNumber,
							windowId: identity.windowId,
							previousWindowId: identity.previousWindowId,
							checkpoint: intent.checkpoint,
						},
					},
				},
			};
		});

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			if (pendingBoundaryState) {
				state = pendingBoundaryState;
				pendingBoundaryState = undefined;
			} else {
				state = recordCompaction(
					state,
					// fromExtension describes who supplied the summary, not who paid
					// for the rebuild. Only our in-flight request owns activeDebt.
					activeDebt ?? { debtTokens: state.cacheDebtTokens, repaymentTokens: 0 },
				);
			}
			save();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			pendingReset = undefined;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
		});

		pi.on("session_shutdown", () => {
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			pendingReset = undefined;
			pendingBoundaryState = undefined;
			resetRequested = false;
			compactionInFlight = false;
		});
	};
}
