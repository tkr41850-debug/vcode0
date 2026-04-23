# Project Research Summary

**Project:** gvc0 — DAG-First Autonomous Agent Orchestrator
**Domain:** Local single-power-user autonomous coding orchestrator (TypeScript, Node >=24) on pi-sdk
**Researched:** 2026-04-23
**Confidence:** HIGH (existing repo docs + in-tree concerns catalog + locked-in stack) / MEDIUM (for pi-sdk resume/replay specifics and forward 2026-ecosystem bets)

> **Method note**: the parallel `gsd-project-researcher` runs hit upstream streaming timeouts on every attempt. STACK / FEATURES / ARCHITECTURE / PITFALLS were compiled directly from the in-tree docs (`ARCHITECTURE.md`, `docs/architecture/*`, `docs/operations/*`, `docs/concerns/*`, `docs/feature-candidates/*`, `docs/compare/*`, `specs/*`) plus `PROJECT.md` decisions and targeted comparator/library knowledge. The repo already has unusually thorough architecture documentation — most of the research signal exists in-tree and simply needed synthesis.

## Executive Summary

gvc0 is a **local, single-power-user autonomous coding orchestrator** whose thesis is "DAG is the execution model": a user types a prompt, a top-level planner drafts a feature DAG, feature-level planners expand each feature into a task DAG, parallel pi-sdk `Agent` child processes execute tasks in git worktrees, and feature branches land on `main` serially via a strict merge train. The user watches and steers live from a four-surface TUI (feature DAG, inbox, merge-train, task transcript) with full edit rights over the plan.

Research finding: **the existing design (serial event queue + async feature-phase agents, combined critical-path scheduler, strict-main merge train with re-entry counts, three-axis state split, milestones as steering buckets) is directionally sound and matches 2026 best practice for this class of tool**. The primary v1 risk is not architectural — it's *executional density*: too many individually-defensible details that collectively make execution flow, state shape, and coordination semantics opaque. The v1 plan should therefore bias toward **clarifying and completing the existing design**, not redesigning it — with one genuine spike (pi-sdk Agent resume/replay fidelity) that determines whether the two-tier pause mechanism works as specified in PROJECT.md.

Top risks to actively mitigate: (1) merge-train re-entry infinite loops — resolved by a configurable cap (default 10) that parks the feature in the unified inbox; (2) silent token burn from misclassified transient retries — resolved by a hard retry cap and a `worker_runaway` warning signal; (3) pi-sdk Agent replay fidelity for release-to-checkpoint pauses — spike-gated before the inbox UX phase; (4) destructive agent commands escaping the worktree — resolved by a worker pre-hook that restricts writes to the task's worktree cwd.

## Key Findings

### Recommended Stack

The in-tree stack (locked-in via `package.json`) is current and correct for the domain. No changes recommended beyond confirming library-version currency before upgrades.

**Core technologies:**
- **TypeScript ^5.9.3 / Node >=24 ESM** — strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) is the right baseline for a contract-heavy orchestrator.
- **`@mariozechner/pi-agent-core` ^0.66.1 (pi-sdk)** — locked-in agent runtime; provides `Agent` class, tool interface, model routing, usage accounting, `fauxModel` for deterministic tests. **Spike target**: confirm resume/replay fidelity for REQ-INBOX-02/03.
- **`@mariozechner/pi-tui` ^0.66.1** — aligns with user's "pi-tui, event-driven" direction.
- **`better-sqlite3` ^12.8.0** — synchronous API is a feature, matches the serial event queue.
- **`simple-git` ^3.35.2** — worktree support via native git CLI; alternatives (`isomorphic-git`, `nodegit`) don't justify switching.
- **`@sinclair/typebox` ^0.34.49** — runtime schemas for IPC envelopes, config, and agent tool schemas.
- **Vitest ^4.1.4 + Biome ^2.4.10 + ESLint ^10.2.0 + tsx ^4.21.0 + `@microsoft/tui-test` ^0.0.4 (pre-1.0; treat as experimental).**

Full detail: `.planning/research/STACK.md`.

### Expected Features

**Must have (table stakes for v1):**
- Prompt entry + top-level planner → feature DAG
- Feature-level planner → task DAG per feature
- Worker pool with process-per-task pi-sdk `Agent` in git worktrees
- Feature branches + task worktrees + one-commit-per-task (squash merge)
- Merge train (rebase + agent-review verify + "main never red")
- Unified inbox (agent asks, conflicts, approvals, auth expiry, orphan cleanup, re-entry parkings)
- Two-tier pause-resume (hot-keep for configurable window, then checkpoint + release)
- Three cancel levers (task-preserve / task-clean / feature-abandon)
- Additive re-plan; user-always-wins manual DAG edits
- 4-surface TUI + config editor menu
- Seamless crash auto-resume
- Retry transient / inbox semantic
- Per-feature planner prompt audit log
- Global worker cap + single per-role model config
- Clarity docs (execution flow, state shape, coordination semantics)

**Should have (v1.x after validation):**
- Visible per-task usage/cost in TUI
- Rich inbox filters
- Keyboard-nav polish
- Verify-prompt configurability
- Planner style presets
- Feature summary timeline view

**Defer (v2+):**
- In-flight split/merge, arbitrary merge-train manual ordering, distributed runtime, centralized conversation persistence, budget enforcement behavior, per-task model override, multi-repo, standalone binary distribution, and the full `docs/feature-candidates/` catalog.

**Anti-features** (explicitly not built): IDE sidebar integration, multi-user collaboration, cloud execution, plugin marketplace, AI-generated post-hoc commit editing, HTML/web UI, per-task model autoselection, persistent "goal" entity. See `FEATURES.md` for rationale per item.

Full detail: `.planning/research/FEATURES.md`.

### Architecture Approach

Seven-layer boundary model (existing design; validated): TUI → App/Compose → Orchestrator (serial event queue + scheduler + merge-train + conflict coordinators) → Agents (planner/verifier/summarizer prompts + graph mutation tools) → Core (pure contracts: graph, FSM guards, scheduling, metrics, naming) → Runtime (worker pool, IPC bridge, worktree manager, pi-sdk Agent host) → Persistence (SQLite WAL via `better-sqlite3`). Core has no I/O dependencies; adapters own their side effects; orchestrator talks through ports only.

**Major components:**
1. **Core** (`@core/*`) — pure graph types, FSM guards, scheduling rules, combined-graph metrics, warnings, naming utilities. No I/O.
2. **Orchestrator** (`@orchestrator/*`) — serial event queue, scheduler tick loop, feature lifecycle, merge-train coordinator, conflict coordinator, summaries/verification router.
3. **Agents** (`@agents/*`) — top-level planner (feature CRUD), feature-level planner (task CRUD), verifier (agent review), summarizer. Each owns its prompts and tool schemas.
4. **Runtime** (`@runtime/*`) — worker pool, NDJSON/stdio IPC, harness/context assembly, worktree manager.
5. **Persistence** (`@persistence/*`) — SQLite schema, migrations, store port implementation, usage rollups.
6. **TUI** (`@tui/*`) — 4-surface shell + config editor, derived view-models from graph+runs+queue.
7. **App** (`@app/*`) — lifecycle, boot, crash recovery glue, composition root.

Six canonical patterns: hybrid serial core + async feature-phase agents; combined virtual graph for critical-path; work-type priority tiers (verify > execute > plan > summarize); strict-main merge train with re-entry cap; two-layer conflict detection (reservation tick + runtime push); state split (work × collab × run); typed prefixed IDs.

Full detail: `.planning/research/ARCHITECTURE.md`.

### Critical Pitfalls

Top 5 (full list in `PITFALLS.md`, with `docs/concerns/*` cross-references):

1. **Merge-train re-entry starvation / infinite loop** — mitigated by configurable cap (default 10) + inbox parking with re-entry diagnostics. `docs/concerns/merge-train-reentry-*.md`.
2. **Silent token burn via transient-retry misclassification** — mitigated by hard per-task retry cap + `worker_runaway` warning + live per-task usage in TUI.
3. **Pi-sdk Agent resume/replay fidelity for two-tier pause** — **spike-gated**. If replay is insufficient, fallback = persist tool-call outputs alongside transcript so replay short-circuits previously-executed calls.
4. **Agent runs destructive commands / writes outside worktree** — mitigated by worker pre-hook (cwd enforcement, write-path validation) + inbox approval gate on `push --force`, `branch -D`, `reset --hard`.
5. **Stale `.git/index.lock` / orphan worktrees after crash** — mitigated by boot-time sweep + PID-tracked worktree registry + inbox "orphan worktree" triage items.

Additional critical: planner drift (REQ-PLAN-07 resolves), agent-hallucinates-progress-without-commit (worker completion requires commit with trailer), SQLite WAL stalls (batched non-critical writes + WAL tuning), NDJSON parser crash on partial message (line-buffered + schema-validated + quarantine-don't-crash), two-tier pause timer race (user-activity resets timer), state-axis divergence (composite FSM guards).

Full detail: `.planning/research/PITFALLS.md`.

## Implications for Roadmap

Research strongly suggests the following phase structure. Goal: bias toward **clarity + completing existing design** over new capability, with one spike early that unblocks the inbox UX phase.

### Phase 1: Foundations & Clarity
**Rationale:** Pain point #1 from PROJECT.md is opacity of execution flow / state shape / coordination semantics. Fix the vocabulary and docs before building on top.
**Delivers:** Canonical state diagram (work × collab × run) + onboarding narrative; decision tables for coordination rules; consolidated `core/` contracts (types, FSM guards, scheduling rules, naming utilities); unit-test coverage of FSM guards.
**Addresses:** REQ-DOC-01/02/03; underpins all later phases.
**Avoids:** State-axis divergence, terminology thrash.

### Phase 2: Persistence & Port Contracts
**Rationale:** Locks down the Store port and SQLite schema + migrations; tunes WAL for the event-queue write rate. Nothing later can be stable if persistence shape shifts.
**Delivers:** Finalized SQLite schema + migrations; Store port implementation with synchronous calls; usage-rollup queries; WAL tuning config; idempotent boot rehydration.
**Uses:** `better-sqlite3`, typebox schemas.
**Implements:** Persistence layer.
**Avoids:** SQLite WAL stalls.

### Phase 3: Worker Execution Loop (+ Pi-SDK Resume Spike)
**Rationale:** Process-per-task with worktrees is the riskiest runtime contract; the pi-sdk replay fidelity spike belongs here because it informs the inbox UX phase.
**Delivers:** Worker pool; NDJSON IPC bridge with `claim_lock` round-trip; write pre-hook (worktree-cwd enforcement + path validation); worktree manager (add/remove/prune/stale-lock); pi-sdk Agent host inside worker; retry policy; `worker_runaway` signal; **spike outcome**: resume/replay strategy (native pi-sdk vs. persist-tool-outputs fallback).
**Avoids:** Destructive agent commands, silent token burn, NDJSON parser crashes, stale lock files, pi-sdk replay surprises.

### Phase 4: Scheduler Tick + Event Queue
**Rationale:** Now that workers can do atomic work units, wire the serial tick loop that orchestrates them.
**Delivers:** Serial event queue; combined-graph construction + metrics; priority-sort on ready frontier; reservation-overlap detection; dispatch to worker pool; feature-phase dispatch via `SchedulableUnit`.
**Implements:** Scheduler core.
**Avoids:** Concurrent graph mutation races.

### Phase 5: Feature Lifecycle & Feature-Level Planner
**Rationale:** First end-to-end vertical slice: a single feature goes from planning → execution → verify → merge-ready.
**Delivers:** Feature-level planner agent (task CRUD, prompts, tools); feature lifecycle FSM (work control axis); verify phase (agent review) implementation; executing_repair loop.
**Implements:** Agents layer (feature-planner, verifier).
**Avoids:** Agent hallucinates progress (completion requires commit), verify-as-stub regression.

### Phase 6: Merge Train
**Rationale:** The "main never red" invariant can't be validated without the feature vertical slice (Phase 5) working.
**Delivers:** Merge-queue ordering; rebase-then-verify protocol; re-entry count + configurable cap + inbox-parking on cap; merge-train warnings; conflict handling between queued features.
**Avoids:** Re-entry infinite loops, `main` breakage.

### Phase 7: Top-Level Planner + Inbox + Pause/Resume
**Rationale:** The prompt-to-feature-DAG entry surface + the unified inbox + the two-tier pause are user-facing and need the runtime spike (Phase 3) resolved.
**Delivers:** Top-level planner agent; inbox as unified "things waiting on you"; agent asks (`await_response`/`request_help`) routed to inbox; conflicts, approvals, auth expiry, orphan cleanup, re-entry parkings also landing in inbox; two-tier pause (hot-keep + checkpoint); multi-task single-answer unblock; top-level edit cancels active feature-level planner (REQ-PLAN-07).
**Avoids:** Timer race on answer, planner drift.

### Phase 8: TUI Surfaces
**Rationale:** Now that the model is complete, the user-facing surfaces can bind to it. Do feature-DAG first (the spine), then inbox (high-attention), then merge-train, then task transcript.
**Delivers:** 4 primary surfaces; derived view-model stream; keymap; transcript virtualization + render rate-cap (15 Hz); config editor menu (REQ-TUI-04); three cancel levers as visible actions; manual DAG editing ops (create/edit/split/merge/cancel/reorder/reweight).
**Avoids:** TUI flicker, input lag, state divergence between TUI and orchestrator.

### Phase 9: Crash Recovery UX
**Rationale:** Seamless auto-resume is a cross-cutting concern that's cheapest to land *after* the surfaces exist, because the "recovery summary inbox item" needs the inbox and TUI.
**Delivers:** Boot-time rehydration; orphan-worktree sweep + inbox items; `.git/index.lock` cleanup; in-flight worker re-spawn with transcript replay; user-visible recovery summary.
**Avoids:** Silent orphan accumulation, boot-hang on stale locks.

### Phase 10: Re-plan Flows & Manual Edits Polish
**Rationale:** Top-level planner + manual edits exist (Phase 7/8), but the "user always wins" semantics across edge cases (edit during planner, additive re-invocation, planner-session continue-vs-fresh) need a dedicated tightening pass.
**Delivers:** Re-plan UX (continue session / new session picker); manual edit collision handling surfaced in proposal view; per-feature planner prompt audit log reader in TUI.
**Avoids:** Silent planner overwrites of user intent.

### Phase 11: Documentation & Diagnostic Tooling
**Rationale:** Clarity is the v1 goal. A dedicated pass after the system works end-to-end ensures docs + diagnostic CLI reflect shipped behavior, not design intent.
**Delivers:** `gvc0 explain feature/task/run <id>` diagnostic CLI; consolidated canonical state diagram; coordination-rule decision tables; newcomer end-to-end narrative doc; concerns-to-tests map.
**Avoids:** "Works but nobody can reason about it" failure mode.

### Phase 12: Integration & Polish
**Rationale:** End-to-end scenarios, verify-agent prompt tuning, TUI e2e tests (with `@microsoft/tui-test`'s pre-1.0 caveat).
**Delivers:** Scripted end-to-end scenarios for the "prompt → green main" loop; verify-agent prompt calibration (flake-rate audit); TUI e2e smoke tests; public README + source-install runbook.
**Avoids:** "It works on my machine" surprises, regression in core loop.

### Phase Ordering Rationale

- **Foundations before features.** Pain is clarity; fix the vocabulary and docs first (Phase 1).
- **Storage before logic.** Store port must be stable before scheduler and lifecycle layers depend on it (Phase 2 before 4).
- **Spike early.** The pi-sdk replay spike (Phase 3) gates Phase 7's pause/resume — unresolved = dead-end later.
- **One vertical slice before the merge train.** Phase 5 gives us a feature that actually finishes; Phase 6 can then stress the merge logic against real features rather than mocks.
- **Inbox + pause together.** Both depend on the same agent-ask mechanics; bundle in Phase 7 to avoid half-landed UX.
- **TUI after the model is complete.** Derived-from-model view is cheaper when the model is stable.
- **Recovery after surfaces.** Recovery UX writes to the inbox, which must exist.
- **Docs last.** Document what shipped, not what was planned.

### Research Flags

Phases likely needing deeper research during planning:

- **Phase 3:** Pi-sdk Agent resume/replay fidelity — requires a live spike against `@mariozechner/pi-agent-core` internals; outcome shapes REQ-INBOX-02/03 implementation strategy.
- **Phase 6:** Merge-train verification tuning — "agent review" prompts need flake-rate measurement; may need per-project tuning surface in v1.x.
- **Phase 8:** Pi-tui capability for non-trivial TUIs (modal overlays + background streams + event-driven refresh) — a small prototype (~half day) before committing to surface designs.

Phases with standard patterns (skip research-phase):

- **Phase 1:** Documentation + pure core — standard TypeScript; no research needed.
- **Phase 2:** SQLite schema + migrations — well-documented patterns.
- **Phase 4:** Scheduler tick — existing `docs/architecture/graph-operations.md` pseudocode is the contract.
- **Phase 5:** FSM transitions — existing `docs/architecture/data-model.md` covers.
- **Phase 9:** Crash recovery — existing `specs/test_crash_recovery.md` is the spec.
- **Phase 10–12:** Polish + tuning — no novel research.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions are pinned in `package.json`; pi-tui direction is explicit per user memory. |
| Features | HIGH | Core feature set maps cleanly to PROJECT.md's 7 decisions and comparator landscape is stable. |
| Architecture | HIGH | Existing docs are unusually thorough; research validates rather than redesigns. |
| Pitfalls | HIGH | In-tree `docs/concerns/` already catalogs many; PROJECT.md decisions resolve several. |
| Pi-sdk specifics | MEDIUM | `Agent` resume/replay behavior needs live verification — marked as Phase 3 spike. |
| Merge-train throughput | MEDIUM | Known-open concern per PROJECT.md; v1 accepts the bottleneck, deferred optimization. |
| TUI multi-surface patterns | MEDIUM | Pi-tui is the chosen lib; event-driven multi-surface is feasible but small prototype recommended in Phase 8. |
| Comparator details (Devin, Cursor, OpenHands v2026) | MEDIUM | General shape is known; specific 2026-current capabilities should be spot-verified before strategic decisions. |

**Overall confidence:** HIGH for v1 structure; MEDIUM for the specific pi-sdk + pi-tui capability edges that the Phase 3 and Phase 8 spikes address.

### Gaps to Address

- **Pi-sdk replay fidelity** — spike in Phase 3 before implementing two-tier pause.
- **Pi-tui suitability for modal + streaming background** — half-day prototype in Phase 8 before surface design.
- **Verify-agent prompt flake rate** — measurable during Phase 6; may require Phase 12 tuning.
- **Merge-train throughput under "many parallel features"** — accept as known limitation; optimize in v2 (already in `docs/feature-candidates/`).
- **`@microsoft/tui-test` pre-1.0 stability** — restrict e2e to golden-path smoke tests in Phase 12; full e2e deferred.

## Sources

### Primary (HIGH confidence — repo as source of truth)
- `/home/alpine/vcode0/.planning/PROJECT.md` — decisions and scope
- `/home/alpine/vcode0/ARCHITECTURE.md` — design thesis
- `/home/alpine/vcode0/CLAUDE.md` — conventions
- `/home/alpine/vcode0/package.json` — stack version ground truth
- `/home/alpine/vcode0/docs/architecture/*` — canonical architecture (graph-operations, data-model, worker-model, planner, persistence, budget-and-model-routing)
- `/home/alpine/vcode0/docs/operations/*` — verification-and-recovery, conflict-coordination, warnings
- `/home/alpine/vcode0/docs/concerns/*` — cataloged pitfalls (cross-referenced in PITFALLS.md)
- `/home/alpine/vcode0/docs/feature-candidates/*` — deferred-feature catalog (informs v2+)
- `/home/alpine/vcode0/docs/compare/*` — comparator notes
- `/home/alpine/vcode0/specs/*` — scenario specifications (bridging design ↔ tests)

### Secondary (MEDIUM confidence — general knowledge verified against in-tree decisions)
- Pi-sdk ecosystem knowledge (Mario Zechner's `@mariozechner/pi-*` packages)
- 2026 TypeScript stack norms (Biome, Vitest 4, Node 24 ESM)
- Comparator landscape (Claude Code, Codex, Cursor Agent, Aider, OpenHands, SWE-agent, Devin)
- DAG workflow orchestrator patterns (Airflow, Dagster, Prefect, Temporal)
- Merge-queue patterns (GitHub Merge Queue, Bors, Aviator, Graphite)

### Tertiary (LOW confidence — needs live verification before use)
- Specific current versions of comparator products (spot-check for any strategic decision)
- Pi-sdk internal resume/replay semantics (flagged as Phase 3 spike)
- `@microsoft/tui-test` stability at `^0.0.4` (treat as experimental)

---
*Research completed: 2026-04-23*
*Ready for roadmap: yes*
