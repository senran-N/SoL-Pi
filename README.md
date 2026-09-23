<p align="center">
  <img src="assets/sol-pi-hero.png" width="100%" alt="SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses" />
</p>

# ⚡ SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses

<p align="center">
  <a href="#paper"><img src="https://img.shields.io/badge/arXiv-Coming%20soon-B31B1B?logo=arxiv&amp;logoColor=white" alt="arXiv: Coming soon" /></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/Getting%20Started-Install-76B900" alt="Getting Started" /></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Docs-Configuration-555555" alt="Configuration" /></a>
  <a href="https://nvlabs.github.io/SoL-Pi/"><img src="https://img.shields.io/badge/Blog-SoL--Pi-76B900" alt="SoL-Pi Blog" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

> [!NOTE]
> This repository contains the open-source version of SoL-Pi, a standalone extension for [Pi](https://github.com/earendil-works/pi). It is not an official distribution of Pi.

## 💡 TL;DR

**Spend less without making the agent do less useful work.**

SoL-Pi is a standalone extension for Pi that packages four reusable efficiency mechanisms discovered through scaled auto-research loops. It reduces repeated model turns, context replay, oversized observations, and unnecessary long-log reading while preserving the work and evidence an agent needs to finish a task.

SoL-Pi installs on top of an unmodified Pi release. Every mechanism is opt-in and disabled by default.

## Introduction

Long-running coding agents accumulate repeated work. A file edit is often followed by a predictable validation command. Large tool results are replayed long after their first use. Completed subtasks remain in active context, and a frontier model may spend a full request reading a log when only a few lines affect the next decision.

SoL-Pi grew out of a broader question from our auto-research work: before scaling agent loops, can agents first make the harness itself more efficient? The search focused on constrained efficiency: reducing token traffic, inference work, and agent turns without stopping early, skipping verification, or hiding evidence.

The standalone release contains four mechanisms that survived that process. They operate at different parts of the harness and compose through Pi's public extension APIs.

A fifth mechanism, Command Yield, addresses a different failure. Pi's shell tool has no default timeout, so a command that crashed without exiting, deadlocked, or blocked on stdin holds the turn open until someone interrupts it. Command Yield gives the foreground a deadline without giving the command a kill.

A sixth mechanism, Scoped Exploration, addresses what the others cannot reach. Finding out where something lives is cheap to do and expensive to keep: the files opened on the way to a one-line conclusion stay in the window for the rest of the session, and no later compaction can separate them from the work that mattered. Scoped Exploration answers such a question in a context that is thrown away, and returns the conclusion with the exact lines it rests on.

## What SoL-Pi Adds

| Area | Mechanism | What changes |
|---|---|---|
| Tools | **Action Fusion** | An edit or write can run its follow-up validation command in the same tool call. |
| Observations | **ObservationPack** | Repeated large text results, successful or failed, become stable handles with exact paged recall. |
| Delegation | **Evidence-Preserving Reducer** | Long diagnostic logs become compact receipts only when every retained quotation matches the archived source. |
| Context | **Online Context Compact** | Completed plan steps become candidate points for Pi's native compaction, subject to economic and window-pressure checks; after a successful compaction, Pi continues the task in a new turn. |
| Commands | **Command Yield** | A command that outlives its foreground deadline returns what it printed plus a live handle, and keeps running; `exec_wait` collects only what it prints next. |
| Exploration | **Scoped Exploration** | `explore` answers one question about the project in a separate, discarded context and returns a short answer whose every citation is checked against the file before delivery. |
| Accounting | **Usage Report** | `sol_pi_usage` reads Pi's own session records and a metadata-only local ledger of SoL-Pi's auxiliary calls, separating reported tokens and Pi cost estimates from explicit unknowns; it makes no model call and records no prompts or credentials. |

The mechanisms share four rules:

- **No Pi patches.** SoL-Pi imports public Pi APIs and does not vendor the Pi source tree.
- **Explicit opt-in.** A missing configuration leaves every mechanism disabled.
- **Preserve evidence.** Original observations remain available locally, and reducer failures leave the original result unchanged.
- **Use Pi's runtime choices.** Authentication, provider URLs, the main model, and shell behavior remain under Pi's control.

## Technical Details and Core Insights

Read the [SoL-Pi blog](https://nvlabs.github.io/SoL-Pi/) for a deeper look at the technical details, design rationale, and core insights behind SoL-Pi, including how auto-research led to the four efficiency mechanisms and how they work.

## Paper

The arXiv preprint is coming soon.

## Getting Started

### Requirements

- Node.js 22.19 or newer
- npm
- `@earendil-works/pi-coding-agent` 0.87.0

### Install

Install the tested Pi release:

```bash
npm install --global @earendil-works/pi-coding-agent@0.87.0
```

Then install SoL-Pi directly from [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi):

```bash
pi install git:github.com/NVlabs/SoL-Pi
```

To install it only for the current project, use the project-local scope:

```bash
pi install git:github.com/NVlabs/SoL-Pi --local --approve
```

### Configure

SoL-Pi uses a single effective configuration. With the official Pi distribution, it looks for a `sol-pi.json` file in the following locations, in order:

1. `.pi/sol-pi.json` in the current project, if the project is trusted and the file exists;
2. `~/.pi/agent/sol-pi.json` otherwise.

If neither file exists, SoL-Pi uses its built-in defaults. The project-level configuration takes precedence over the user-level configuration; the two files are not merged.

The following conservative configuration enables only the three local mechanisms that make no additional model calls and do not stop an active run:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": false,
  "commandYield": true,
  "cacheWriteReadRatio": 12.5
}
```

Enable additional mechanisms only after reviewing their configuration and security implications. SoL-Pi uses no dedicated environment variables; feature flags, the reducer provider/model route, and the compaction ratio are configured in `sol-pi.json`. See [sol-pi.example.json](sol-pi.example.json) for a template listing every key.

For the complete schema, see [Configuration](docs/configuration.md). Coding agents and automated environments should follow the canonical [agent installation and configuration protocol](agents-install.md), which describes an all-enabled configuration checked with `scripts/check-sol-pi-config.mjs --require-all-enabled`.

## Storage and Security

Observation Pack sends large text-only tool results in full for the first two provider requests, then uses a stable `obs_recall` placeholder. After the first placeholder projection, Pi 0.87's append-only `context_edit` boundary persists that replacement for the active branch without rewriting the raw session message; resume and native compaction therefore do not restore the large text. Image-bearing or mixed-content results remain under Pi's native image normalization and model input-limit handling.

ObservationPack, Evidence-Preserving Reducer, and Scoped Exploration store session-specific archives under:

```text
<session-directory>/sol-pi/<session-id>/
├── observation-pack/
├── evidence-preserving-reducer/
└── scoped-exploration/
```

They archive eligible source material in this directory. The archived copies remain local and are not automatically deleted when the Pi session ends.

Command Yield writes nothing to disk. A yielded command's output is held in memory, capped per handle, and discarded with the session; command lines are never written to a log, because they can carry credentials. A command that yielded a handle is killed when the Pi session shuts down, so it does not outlive the session.

Online Context Compact stores its state in Pi's session log. After a successful compaction, it starts a new turn and automatically continues the active task. Cancelling the run or exiting Pi does not trigger automatic continuation.

Evidence-Preserving Reducer may send eligible diagnostic-log content to its configured reducer model using Pi-managed authentication. Scoped Exploration may send project file content to its configured explorer model the same way, and keeps a full local transcript of every exploration. Review [SECURITY.md](SECURITY.md) before enabling either one. Do not enable them for content that must remain local.

Usage Report is active whenever any mechanism is enabled. It reads Pi's own session records and appends a metadata-only ledger at `<session-directory>/sol-pi/<session-id>/usage.jsonl` for the reducer and explorer calls SoL-Pi dispatches. That ledger stores only route, status, numeric token counts, Pi's recorded cost estimate, and duration; it never records prompts, responses, credentials, or error text. The `sol_pi_usage` tool makes no model call and reports Pi cost estimates, not invoices or a net-savings calculation, with unknown usage and unknown cost counted explicitly.

## Documentation

| Document | Purpose |
|---|---|
| [Configuration](docs/configuration.md) | Config search order, schema, defaults, and trust behavior |
| [Compatibility](docs/compatibility.md) | Supported Pi APIs and standalone integration details |
| [Security](SECURITY.md) | Local storage, remote reduction, and sensitive behavior |
| [Agent installation](agents-install.md) | Reproducible installation and all-enabled validation procedure |

## Development

Install from the lockfile and run the complete source checks:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
node scripts/check-pi-compat.mjs
```

`npm run check` covers TypeScript, the complete test suite, and package inspection. The development dependency set is pinned to Pi 0.87.0; runtime Pi packages remain peer dependencies so Pi owns their installation and upgrades.

## Project Status

SoL-Pi is developed and maintained by NVIDIA as a standalone extension for Pi.

We welcome tested, Pi-compatible extension PRs that improve token efficiency and reduce token cost. Our team will help benchmark contributions, publish results on a regular reporting cycle, and credit authors of accepted PRs as Contributors. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Acknowledgements

SoL-Pi builds on the public extension interfaces provided by [Pi](https://github.com/earendil-works/pi). Pi remains an independent upstream project and is not vendored into this repository.

## License

SoL-Pi is released under the [MIT License](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=NVlabs%2FSoL-Pi&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" />
    <img alt="SoL-Pi star history chart" src="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" width="100%" />
  </picture>
</a>
