# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<Pi config directory>/sol-pi.json`, only after Pi marks the project trusted
2. `<Pi agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

For the official Pi distribution, the first two locations normally resolve to `.pi/sol-pi.json` and `~/.pi/agent/sol-pi.json`.

The project file replaces the global file. SoL-Pi does not merge them.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "commandYield": false,
  "commandYieldTimeMs": 10000,
  "scopedExploration": false,
  "scopedExplorationProvider": "provider-id",
  "scopedExplorationModel": "model-id",
  "scopedExplorationMaxSteps": 8,
  "cacheWriteReadRatio": 12.5
}
```

Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `commandYieldTimeMs` may be omitted and then defaults to `10000`; when present it must be an integer between `1000` and `300000`. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. `scopedExplorationProvider` and `scopedExplorationModel` may be omitted and then use the built-in explorer route, which is the same route Evidence-Preserving Reducer defaults to; when present each must be a non-empty string. `scopedExplorationMaxSteps` may be omitted and then defaults to `8`; when present it must be an integer between `1` and `32`. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, invalid yield deadlines, invalid reducer model fields, invalid explorer model fields, and invalid step budgets stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting Pi:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all six mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for Pi's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan`, the durable-note tools `note_write`/`note_append`/`note_read`, the window tools `get_context_remaining`/`new_context`, the recall tools `history_search`/`history_read`, and boundary-driven compaction after the other SoL-Pi context transformers.
- `commandYield`: replaces the execution backend of the active shell tool (`bash` or `powershell`, whichever Pi has live) and registers `exec_wait`, `exec_list`, and `exec_kill`. A command that outlives its deadline returns its output so far plus a handle; the command keeps running and is not killed. When Action Fusion is also enabled, a fused `then_run` uses the same backend and reports `[then_run:running]` instead of `[then_run:succeeded]` when it yields.
- `commandYieldTimeMs`: how long a command may hold the foreground before it yields a handle. A yield is not destructive, so this is short by default; `exec_wait` accepts a larger per-call budget.
- `scopedExploration`: registers the `explore` tool, which answers one project question in a separate context using the configured explorer route.
- `scopedExplorationProvider`: provider namespace used to resolve the explorer model through Pi's model registry.
- `scopedExplorationModel`: model id used for Scoped Exploration.
- `scopedExplorationMaxSteps`: how many actions one exploration may take before it must answer.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses two runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`. The value remains fixed for the session and is not recomputed when the model changes. It drives one runtime decision and is not a cost report.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. After a successful compaction it sends one hidden message with `triggerTurn: true`, which starts a new turn and instructs the assistant to rebuild its plan. That message also names the files the recorded progress already reported as changed, newest first and bounded to eight paths, because a compaction removes the edits themselves from the window: without the paths the assistant re-derives them by searching, which spends back part of what the compaction just saved. A settlement barrier keeps print and JSON modes in the same Pi invocation until that continuation settles, so callers do not need to resume the session or inject `Continue working`. Cancelling or exiting does not schedule an automatic continuation. The programmatic factory exposes only a matching retained-tail value for installations whose Pi compaction setting differs from the default.

When the plan and at least one progress summary are both recorded, the extension answers Pi's `session_before_compact` hook with a synthetic compaction result instead of letting Pi summarize. That checkpoint is a `<sol-pi-window>` fragment rebuilt from the structured state, so repeated compactions cannot erode details that the plan, progress, and note records already captured. The fragment is capped at 4 KB and its sections are not first-come: the recorded progress and the note index each keep a reserved floor of that budget, so a long plan can never push out the evidence or the index that recovers the note bodies. Its first section is the user's own words - the original task and the most recent instruction, quoted rather than summarized, each bounded to 384 bytes. Everything else in the fragment is the assistant's account of the work and can be rebuilt from what it is about to read; a constraint the user stated once cannot, and losing it is silent. Pi still resolves its summarization model and credentials before the hook runs, so the windowed handoff needs a working summarization route even though it sends no summarization request.

The assistant can also ask for a window directly with `new_context` and check the budget with `get_context_remaining`; a requested reset is honored even when the economic gate would decline, but it is applied at the next idle settlement so the tool call never aborts the turn that made it, and it is declined outright when the session has nothing Pi could archive. Each compaction appends one audit line to `<runtimeRoot>/online-context-compact/windows.jsonl`. Windows are numbered by recorded compaction, not by context reset, so a correction that rebuilds the plan without producing a checkpoint never leaves a gap in the ids or makes a fragment point at a predecessor that does not exist. The fragment carries only a bounded index of durable notes; the note bodies live in `<runtimeRoot>/online-context-compact/notes/<slug>.md` and are read back on demand with `note_read`. `history_search`/`history_read` make the same guarantee for the session log itself: they read only the entries Pi already recorded on the current branch, including work a compaction removed from the window but never a branch that was forked or rewound away from, and they bound both a search answer (4 KB) and a single read (24 KB) so recalling the past cannot refill the window.

## Scoped Exploration runtime inputs

The release entry uses the configured explorer route and a step budget; storage comes from the session.

The explorer never reaches Pi's tools. It emits one JSON action per step and SoL-Pi executes it against three read-only primitives - a literal, case-insensitive substring search, a bounded file read, and a directory listing - each confined to the project root, each refusing a path that resolves outside it, and each skipping vendored directories. There is no write, no command, and no network action in the protocol, so the exploration is read-only by construction rather than by permission.

What comes back is checked. Every citation names a path, a line, and a quote, and it survives only when that quote is found at that line at delivery time. A rejected citation is reported as rejected; an answer that claims a finding and has no surviving citation is refused outright rather than handed to the agent as a plausible summary. An exploration that runs out of steps, times out, or cannot resolve its model fails the tool call, which leaves the agent to do the search itself. The full step-by-step transcript is written to `<runtimeRoot>/scoped-exploration/<exploration-id>.jsonl` and its path travels back with the answer, so what the main window did not see is still auditable.

## Command Yield runtime inputs

The release entry uses one runtime input, `commandYieldTimeMs`, and takes everything else from Pi.

A command that finishes inside its deadline is untouched: the same output, the same exit code, the same errors. A command that does not finish has its output so far returned with a trailer that names a handle, and it keeps running. `exec_wait` returns only the bytes produced since the last read, so polling a long command does not re-send its whole log; each increment is capped at 16 KB and 400 lines, and the rest stays pending. Retained output is capped per handle, and anything dropped to stay inside that cap is counted in the next increment rather than silently skipped.

An explicit `timeout` in the shell tool call keeps Pi's destructive meaning and reaches Pi's backend unchanged; the yield deadline is separate and never terminates anything. Before a yield, interrupting the turn kills the process tree through Pi's own teardown. After a yield the command belongs to its handle, so a later turn's interrupt does not reach it; `exec_kill` and session shutdown do. Nothing is written to disk, and command lines are never logged, because a command line can carry a credential.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's default shell behavior, and Command Yield composes Pi's own execution backend through the public `BashToolOptions.operations` seam rather than spawning processes itself, so shell resolution, environment handling, and process-tree teardown stay Pi's. Persistent artifacts are derived from Pi's session directory and session ID.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
