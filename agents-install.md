# SoL-Pi Agent Installation and Configuration Protocol

This is the canonical procedure for Codex, Claude Code, and other coding agents that install, configure, or validate SoL-Pi from a full source checkout. Follow the phases in order. Explicit user instructions take precedence. An extracted npm package is not a substitute for the checkout because it does not contain the test suite.

Installation and configuration are complete only when Pi remains unmodified, the repository checks pass, Pi lists the package, all six mechanisms are enabled in one effective `sol-pi.json`, and Pi starts without an extension error.

## Rules

- Do not modify, patch, fork, or vendor upstream Pi. SoL-Pi must load as a standalone extension through Pi's public package interface.
- Use Node.js 22.19 or newer and the tested Pi release `@earendil-works/pi-coding-agent@0.85.1`. Treat a different Pi version as a compatibility change and rerun the full suite before using it.
- Do not clean, reset, switch, or overwrite unrelated repository changes.
- Do not print, log, commit, upload, or include any secret in a command line. Check only whether a credential is present.
- Keep SoL-Pi settings in `sol-pi.json`. The Evidence-Preserving Reducer provider/model route, the Scoped Exploration provider/model route and step budget, and the Command Yield deadline are SoL-Pi settings; provider URLs, credentials, the main agent model, and shell behavior remain Pi settings.
- Keep persistent artifacts under Pi's session-derived `sol-pi/<session-id>/` root; do not configure a separate storage path.

## Inputs

Resolve these values before making changes:

- `sol_pi_root`: absolute path to the intended SoL-Pi checkout;
- `target_project`: project in which Pi will run;
- install scope: project-local or user-wide;
- exact SoL-Pi branch and commit.

Do not guess an ambiguous path or install scope.

## Phase 1: validate the checkout

From `sol_pi_root`, record the repository state without changing it:

```bash
git status --short --branch
git rev-parse HEAD
node --version
npm --version
```

Require Node.js 22.19 or newer. Install from the lockfile and run the source checks:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
node scripts/check-pi-compat.mjs
npx vitest run tests/all-mechanisms.test.ts
```

`npm run check` covers type checking, the complete test suite, and package inspection. `tests/all-mechanisms.test.ts` confirms that one all-enabled configuration registers all six mechanisms against Pi's public extension API. The tests run without a model provider.

Stop if any command fails. Do not hide a failure with `|| true` or replace `npm ci` with an unlocked install.

## Phase 2: install Pi and SoL-Pi

Install the tested Pi release without changing its source:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
pi --version
```

Require `pi --version` to report `0.85.1`.

For a project-local registration, run this from `target_project` and substitute the resolved absolute `sol_pi_root`:

```bash
pi install "/absolute/path/to/SoL-Pi" --local --approve
pi list --approve
```

For a user-wide registration, omit `--local`:

```bash
pi install "/absolute/path/to/SoL-Pi" --approve
pi list --approve
```

The `pi list` output must show the exact SoL-Pi source in the selected scope. Do not install the same checkout in both scopes. A project-local registration must run only in a trusted project; use `--approve` for automated invocations unless trust has already been explicitly persisted.

## Phase 3: configure all six mechanisms

SoL-Pi defaults every mechanism to disabled. For this managed installation, create exactly one effective configuration with every mechanism enabled:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": true,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": true,
  "commandYield": true,
  "commandYieldTimeMs": 10000,
  "scopedExploration": true,
  "scopedExplorationProvider": "provider-id",
  "scopedExplorationModel": "model-id",
  "scopedExplorationMaxSteps": 8,
  "cacheWriteReadRatio": 12.5
}
```

`evidencePreservingReducerProvider` and `evidencePreservingReducerModel` select the nested reducer route that Evidence-Preserving Reducer resolves through Pi's model registry. They default to the built-in reducer route and must be non-empty strings when supplied. Change them only when a different reducer model is intended.

`commandYield` replaces the execution backend of whichever shell tool Pi has active and registers `exec_wait`, `exec_list`, and `exec_kill`. `commandYieldTimeMs` is how long a command may hold the foreground before it returns its output so far plus a live handle; it defaults to `10000` and must be an integer between `1000` and `300000`. Yielding does not stop the command and does not discard output, so the deadline is short on purpose. It is unrelated to the `timeout` a shell tool call may carry: that one still terminates the command, and SoL-Pi passes it to Pi unchanged.

`scopedExploration` registers the `explore` tool, which answers one question about the project inside a separate, discarded context and returns a short answer whose every citation is re-checked against the file before delivery. `scopedExplorationProvider` and `scopedExplorationModel` select that nested route; they default to the built-in explorer route, which is the same route Evidence-Preserving Reducer defaults to, and must be non-empty strings when supplied. `scopedExplorationMaxSteps` is how many read-only actions one exploration may take before it must answer; it defaults to `8` and must be an integer between `1` and `32`.

An exploration reads project files and sends what it selects to the configured explorer model. It is read-only and confined to the project root, but it is not a secrets filter. Do not enable it for a checkout whose contents must stay local.

`cacheWriteReadRatio` is the only pricing-related input SoL-Pi reads. It defaults to `12.5`, accepts any finite non-negative number, and treats `0` as an explicit statement that a cache write adds no cost relative to a cache read. SoL-Pi does not inspect Pi model prices. The value controls one compaction decision and is not a bill estimate. The default follows the GPT-5.6 Sol OpenAI Standard cache-write/read ratio checked on 2026-08-21; see [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Change it when a different policy is required.

Use one location matching the selected scope. Resolve the directory through Pi; the official Pi defaults are shown in parentheses:

- project-local: `<target_project>/<Pi config directory>/sol-pi.json` (`<target_project>/.pi/sol-pi.json`);
- user-wide: `<Pi agent directory>/sol-pi.json` (`~/.pi/agent/sol-pi.json`).

SoL-Pi uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs. Do not assume the defaults when Pi reports different directories.

The project file replaces the user-wide file; the two are not merged. If both exist, inspect them and obtain direction before changing either one. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid reducer model fields, invalid yield deadlines, and invalid ratios must remain fatal.

Do not put provider URL, credentials, shell path, command prefix, storage path, or run ID in `sol-pi.json`. SoL-Pi either reads those values from Pi or derives them from the Pi session.

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer uses the configured reducer provider/model route and Pi-managed authentication. Configure credentials in Pi and do not copy them into `sol-pi.json`.

From `sol_pi_root`, validate the exact effective file:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

Require exit status 0 and retain its JSON output. The check applies SoL-Pi's default values, rejects unknown keys and wrong types, and confirms all six mechanisms are enabled. A partially enabled file can be valid SoL-Pi configuration, but it does not satisfy this all-enabled profile.

## Phase 4: verify the installation

1. Run `pi list --approve` from `target_project` and confirm the expected SoL-Pi source and scope.
2. Run `check-sol-pi-config.mjs --require-all-enabled` against the effective `sol-pi.json`.
3. Re-run `npx vitest run tests/all-mechanisms.test.ts` from `sol_pi_root`.
4. Start Pi with `--offline --approve`, send no prompt, confirm there is no extension load error, and exit.
5. Confirm that the active shell tool is SoL-Pi's Command Yield replacement and that `exec_wait`, `exec_list`, and `exec_kill` are available. Do not add a second shell tool; exactly one of `bash` or `powershell` must be registered.
6. Confirm that `explore` is registered and that its configured explorer route resolves through Pi's model registry.
7. Confirm that upstream Pi was not patched and that the SoL-Pi checkout contains no vendored Pi monorepo source.

## Completion report

Report:

- SoL-Pi absolute path, branch, and commit;
- repository state before and after installation;
- Node, npm, and Pi versions;
- install scope and the exact entry shown by `pi list`;
- effective config path, six enabled flags, EPR reducer provider/model, Scoped Exploration provider/model and `scopedExplorationMaxSteps`, `commandYieldTimeMs`, and `cacheWriteReadRatio`, without secrets;
- every validation command and result;
- any blocker or deviation.

Do not describe the installation as successful if a required check is missing.

## Agent entry files

`agents-install.md` is the single source of truth, but agents do not universally auto-discover arbitrary filenames. Root `AGENTS.md` tells Codex to read this file, while root `CLAUDE.md` imports it for Claude Code. Keep those entry files short and keep executable installation details here.

- [Codex `AGENTS.md` discovery](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code project memory and imports](https://docs.anthropic.com/zh-CN/docs/claude-code/memory)
