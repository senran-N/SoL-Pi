# Pi Compatibility

SoL-Pi is developed and tested against `@earendil-works/pi-coding-agent` 0.85.1. On that release the full test suite, type checking, package inspection, and the public API check pass, and nothing in the suite is skipped: a guard that would otherwise need a privileged filesystem operation uses an equivalent one the platform does allow, so it is exercised rather than stepped over. The suite is 30 files and 248 tests at the time of writing.

Compatibility with the earlier 0.84.2 release rests on a check made before the mechanisms were extended and has not been re-verified since, so treat it as historical rather than a current guarantee. Earlier checks likewise covered the public API surface of Pi 0.81.1, the base used by the original Pi fork. The runtime range is deliberately expressed as a peer dependency because Pi owns installation and upgrade of its packages; it is not a guarantee for every Pi version.

SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- `withFileMutationQueue` for the per-file append serialization the usage ledger shares with Action Fusion
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `agent_settled`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`

## Action Fusion

The built-in edit/write definitions capture their working directory, so SoL-Pi caches one definition per `ctx.cwd`. Its own per-file queue surrounds the built-in mutation and follow-up command. It does not nest Pi's built-in mutation queue.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

A failed tool result participates on the same terms as a successful one. The window fills fastest exactly when something is broken, so a large failing test run or stack trace is packed rather than replayed; the projected result keeps its error flag, the placeholder states the call failed, and the diagnostic text stays recallable byte for byte through `obs_recall`. Mixed-content results and reducer receipts are still passed through untouched.

Object access uses `O_NOFOLLOW` when the platform exposes it. Every opened object is also checked against its pathname identity before any bytes are read or written, and its storage directories are revalidated after the open. This preserves symlink rejection on platforms such as Windows where Node does not expose an atomic no-follow flag.

## Scoped Exploration

Scoped Exploration registers one tool and no event handlers, so it changes nothing about how Pi assembles context. Its nested call resolves the configured explorer provider/model through Pi's model registry on the same path Evidence-Preserving Reducer uses, including the fallback for a build whose registry exposes no `complete()` method. Its filesystem access is its own: three read-only primitives bounded to the project root, never Pi's tools, so an exploration cannot write, run a command, or reach outside the checkout regardless of the surrounding approval mode.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()` when available. For the Pi 0.81.1 fork, which exposes no registry `complete()` method, it resolves authentication for that reducer model through `getApiKeyAndHeaders()` and calls the shared `@earendil-works/pi-ai/compat` completion API. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which are present in both the fork and Pi 0.85.1. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory.

## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers instead of fork-only post-transform observer methods. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

Pi does not expose its active retained-tail compaction setting through the public extension context. The standalone extension therefore uses the Pi 0.85.1 default of 20,000 tokens for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default Pi setting.

Pi 0.85.1's `ExtensionContext.compact()` aborts the active agent before it summarizes, and `agent_settled` fires only once a whole run has drained every turn, retry, auto-compaction, and queued continuation. A plan boundary that selects compaction therefore saves its plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs compaction from the `agent_settled` that stop produces. The handler awaits the compaction's own `onComplete`/`onError` callbacks. On success, the extension sends a hidden reminder through public `ExtensionAPI.sendMessage()` with `triggerTurn: true`, so Pi starts a new turn against the compacted context and rebuilds the plan even when the native summary omits that instruction.

A settlement barrier keeps the original `agent_settled` dispatch open until the triggered continuation settles. Print- and JSON-mode processes therefore complete the compact-and-continue sequence within the same Pi invocation; an outer driver does not need to resume the session or send `Continue working`. This continuation is armed only by a successful boundary compaction. Cancelling or exiting does not schedule one. A Pi build that never emits `agent_settled` starts no boundary compaction.

Pi 0.85.1 does not return a promise from `ExtensionAPI.sendMessage()`. The barrier is therefore verified for standalone SoL-Pi and depends on Pi starting the requested turn synchronously. A later-loaded third-party extension that performs long asynchronous work in its own `agent_settled` handler is outside this guarantee and needs an integration test with that extension set.

Pi reports the session as idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Navigation works normally after the compaction callback settles.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` directly into Online Context Compact's economic check. It does not inspect model price metadata. Changing models during a session does not change the ratio; users who want a different decision policy update the configuration and start a new session.

A window reset stores the full structured checkpoint on the native compaction entry under `details.solPiWindow.checkpoint`, so the short handoff fragment can stay bounded while the complete plan, progress, notes index, and every user directive remain recoverable. `history_read` reads that checkpoint back by the synthetic id `checkpoint-wN` and pages any recorded entry by UTF-8 byte offset (`offset`/`limit`, character-boundary validated, `next_offset` until null). Unpaid cache-rebuild debt is carried across explicit resets and window-protection overrides rather than zeroed on `fromExtension`, because `fromExtension` describes who supplied the summary, not who paid to rebuild the cache.

## Usage Accounting

Usage accounting is read-only and local. The `sol_pi_usage` tool makes no model call: it reads Pi's own session entries for main-model, native-summary, and reset rows, and a metadata-only auxiliary ledger at `<sessionDir>/sol-pi/<sessionId>/usage.jsonl` for the reducer and explorer calls SoL-Pi itself dispatches. The ledger stores only route, status, numeric token counts, Pi's recorded cost estimate, and duration. It never records prompts, responses, credentials, headers, base URLs, or error text; the append path reuses `withFileMutationQueue` for the same per-file serialization Action Fusion uses.

Each auxiliary call writes a `pending` intent before dispatch and a terminal record after, so a crash or a failed final write leaves an explicit unknown rather than an erased call. A replayed start never overwrites a terminal outcome, and duplicated ledger lines reduce to one record on read. Missing usage, all-zero usage on an interrupted call, and zero or absent prices are reported as unknown, never as free. The report separates reported tokens from known cost estimates and from unknown-cost and unknown-usage counts, and states in its own `limitations` that these are Pi estimates, not invoices and not a net-savings calculation. Forked sessions may copy main history but keep a separate auxiliary ledger, so per-session totals must not be summed as a bill.

## Interactive TUI

The lightning savings treatment uses Pi 0.85.1's public `renderCall`,
`renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.

The 0.84.2 backward-compatibility run used an isolated copy of the current source and tests, separate dependencies, and an empty Pi agent directory. Only the copy's four Pi development dependency versions, lockfile, and installation-guide version mentions changed. No source or test changes were needed. The run included all four mechanisms that existed at the time and the native compaction/continuation integration tests; it did not repeat live-provider benchmarks on 0.84.2. Command Yield was added after that run and has not been exercised on 0.84.2.
