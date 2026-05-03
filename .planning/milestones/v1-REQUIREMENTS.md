# Milestone v1 Requirements Archive

**Archived:** 2026-05-03
**Status:** Shipped / audit passed

---

# Requirements: gvc0

**Defined:** 2026-04-23
**Core Value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — while the user watches, edits, re-plans, and answers agent asks live in a single TUI.

> Requirement IDs match `PROJECT.md`'s `Active` list verbatim (`REQ-<CATEGORY>-<NN>`). This file is the flat, traceable view; PROJECT.md is the narrative source. Keep them in lock-step — if one changes, change both.

## v1 Requirements

### Core execution — planning (REQ-PLAN-*)

- [x] **REQ-PLAN-01**: Top-level planner agent turns a prompt into a feature DAG (create / edit / split / merge features within a milestone) via inline chat with the user
- [x] **REQ-PLAN-02**: Feature-level planner agent turns a feature into a task DAG (create / edit tasks within a feature) via inline chat
- [x] **REQ-PLAN-03**: Re-invoking a planner is additive only — never touches running or completed work
- [x] **REQ-PLAN-04**: On planner re-invocation, user picks "continue prior chat" or "fresh session"
- [x] **REQ-PLAN-05**: Manual DAG edits (user in TUI) always win over planner; planner treats them as constraints
- [x] **REQ-PLAN-06**: Planner prompts are persisted as an audit log alongside the features they created (no persistent "goal" entity)
- [x] **REQ-PLAN-07**: When the top-level planner proposes an edit on a feature whose feature-level planner is currently running, the proposal view flags this; accepting the proposal cancels the running feature-level planner (it retries on the new shape)

### Core execution — workers (REQ-EXEC-*)

- [x] **REQ-EXEC-01**: Each task runs as a child process pi-sdk `Agent` in its own worktree (`feat-<name>-<feature-id>-<task-id>`)
- [x] **REQ-EXEC-02**: Tasks produce exactly one squash-merge commit on their feature branch when they complete (commit carries a gvc0 trailer tying it to the task id)
- [x] **REQ-EXEC-03**: Worker IPC is NDJSON over stdio, schema-validated via `@sinclair/typebox`; malformed messages are quarantined, not fatal
- [x] **REQ-EXEC-04**: Task failure is handled heuristically — transient errors auto-retry with backoff (hard cap); semantic failures park in the inbox
- [x] **REQ-EXEC-05**: Global worker-count cap governs concurrent parallelism (configurable, sane default)
- [x] **REQ-EXEC-06**: Feature dependencies enforce "wait for merge to `main`" semantics — strictest, simplest

### Merge train (REQ-MERGE-*)

- [x] **REQ-MERGE-01**: Merge train serializes feature-branch integration into `main`; `main` is never in a bad state
- [x] **REQ-MERGE-02**: Queue head rebases onto latest `main`, runs merge-train verification, then merges — or is ejected for repair
- [x] **REQ-MERGE-03**: Re-entry count is capped (configurable, default 10); on cap, the feature is parked in the inbox with re-entry diagnostics for user decision
- [x] **REQ-MERGE-04**: Verification before merge is an **agent review** (not tests, not type-check); the verify pi-sdk agent reads the diff against the feature goal and either passes or returns issues for `executing_repair`

### TUI / interaction (REQ-TUI-*)

- [x] **REQ-TUI-01**: Primary TUI surfaces: feature DAG graph, inbox, merge-train status, per-task live transcript — all first-class, bound to a derived view-model stream
- [x] **REQ-TUI-02**: Inbox is the unified "things waiting on you" surface — agent `await_response` / `request_help` asks, merge conflicts, auth expiry, destructive-action approvals, orphan-worktree cleanup after crash, re-entry-cap parkings, and any system attention item
- [x] **REQ-TUI-03**: Manual graph editing — create / edit / split / merge / cancel / remove / reorder / reweight features and tasks from the TUI
- [x] **REQ-TUI-04**: Config editing menu inside the TUI (no hand-editing JSON for common settings)
- [x] **REQ-TUI-05**: Three cancel levers are surfaced as distinct actions: cancel-task-preserve-worktree, cancel-task-clean-worktree, cancel-feature-abandon-branch
- [x] **REQ-TUI-06**: TUI usability targets power users — docs-aligned, event-driven pi-tui idiom, not a newcomer-polished product

### Inbox / pause-resume (REQ-INBOX-*)

- [x] **REQ-INBOX-01**: Agent-initiated `await_response` / `request_help` (and similar pi-sdk tool calls) route the task to the inbox
- [x] **REQ-INBOX-02**: Two-tier pause — the paused task keeps its worker process and worktree for a configurable hot window (default ~10 min) with activity-based reset; after the window, the process is released and a checkpoint is persisted (worktree retained)
- [x] **REQ-INBOX-03**: Resume after process-release rehydrates by re-spawning a worker that replays the agent transcript (strategy gated by Phase 3 pi-sdk spike outcome)
- [x] **REQ-INBOX-04**: Answering one inbox item can unblock multiple tasks when appropriate (multi-task single-answer unblock)

### State / recovery (REQ-STATE-*)

- [x] **REQ-STATE-01**: State split preserved — work control (planning/execution phases), collaboration control (branch/merge/conflict), run state (retry, help/approval waits) on `agent_runs`; composite FSM guards enforce valid cross-axis combinations
- [x] **REQ-STATE-02**: Seamless auto-resume on orchestrator crash — restart rehydrates from SQLite, re-spawns workers for in-flight tasks, replays transcripts where needed, surfaces a recovery-summary inbox item; user sees live state rather than a triage dialog
- [x] **REQ-STATE-03**: Milestones are persistent groupings of features; multiple milestones may have in-flight features concurrently; milestone queue steers scheduler priority but does not gate execution
- [x] **REQ-STATE-04**: Top-level planner may propose milestone splits / merges; user may also create / edit milestones manually

### Config / models / cost (REQ-CONFIG-*)

- [x] **REQ-CONFIG-01**: Single global config — one model per agent role (top-planner, feature-planner, task-worker, verifier)
- [x] **REQ-CONFIG-02**: Cost / budget knobs exist and are configurable (caps per task / feature / global can be set), but enforcement *behavior* is deferred; v1 ships visibility + configurable knobs, not enforcement semantics
- [x] **REQ-CONFIG-03**: Pause thresholds, re-entry cap, worker-count cap, and model assignments are all user-editable (TUI config menu + file); hot-reloadable keys apply without restart

### Clarity / docs (REQ-DOC-*)

- [x] **REQ-DOC-01**: Execution flow is documented end-to-end — who triggers what, when (event queue, dispatch, feature-phase agents, worker lifecycle); one canonical flow diagram
- [x] **REQ-DOC-02**: State shape is documented with one canonical diagram covering the three axes (work × collab × run) and their valid cross-axis combinations
- [x] **REQ-DOC-03**: Coordination semantics (lock / claim / suspend / resume / rebase rules) are documented with decision tables, not prose

## v2 Requirements

Deferred from v1 but committed to the product roadmap. These align with `docs/feature-candidates/` where applicable.

### Distribution (REQ-DIST-*)

- **REQ-DIST-V2-01**: Standalone binary distribution (Node SEA / esbuild bundle)
- **REQ-DIST-V2-02**: npm global package install
- **REQ-DIST-V2-03**: npx one-shot entrypoint

### Budget (REQ-CONFIG-V2-*)

- **REQ-CONFIG-V2-01**: Budget enforcement behavior — caps actually halt work when exceeded, with inbox override
- **REQ-CONFIG-V2-02**: Per-task / per-feature model override

### Merge train (REQ-MERGE-V2-*)

- **REQ-MERGE-V2-01**: Speculative parallel rebase+verify of top-K queued features
- **REQ-MERGE-V2-02**: Batch merges when rebase is no-op
- **REQ-MERGE-V2-03**: Arbitrary persistent manual merge-train ordering (see `docs/feature-candidates/arbitrary-merge-train-manual-ordering.md`)
- **REQ-MERGE-V2-04**: In-flight feature split/merge (see `docs/feature-candidates/in-flight-split-merge.md`)

### Runtime / distribution (REQ-RUN-V2-*)

- **REQ-RUN-V2-01**: Multi-repo / cross-repo orchestration
- **REQ-RUN-V2-02**: Distributed runtime — multi-machine worker pool (see `docs/feature-candidates/distributed-runtime.md`)
- **REQ-RUN-V2-03**: Centralized conversation persistence (see `docs/feature-candidates/centralized-conversation-persistence.md`)
- **REQ-RUN-V2-04**: Claude Code harness (see `docs/feature-candidates/claude-code-harness.md`)
- **REQ-RUN-V2-05**: Advanced IPC guarantees (see `docs/feature-candidates/advanced-ipc-guarantees.md`)

### Operations / scheduling (REQ-OPS-V2-*)

- **REQ-OPS-V2-01**: Extended repair profiles (see `docs/feature-candidates/extended-repair-profiles.md`)
- **REQ-OPS-V2-02**: Long verification timeouts (see `docs/feature-candidates/long-verification-timeouts.md`)
- **REQ-OPS-V2-03**: Phase timeouts (see `docs/feature-candidates/phase-timeouts.md`)
- **REQ-OPS-V2-04**: Worker scheduling policies (see `docs/feature-candidates/worker-scheduling-policies.md`)
- **REQ-OPS-V2-05**: Merge-train niceness / fairness (see `docs/feature-candidates/merge-train-niceness.md`)
- **REQ-OPS-V2-06**: Graceful integration cancellation (see `docs/feature-candidates/graceful-integration-cancellation.md`)
- **REQ-OPS-V2-07**: Per-task cross-feature suspension (see `docs/feature-candidates/per-task-cross-feature-suspension.md`)
- **REQ-OPS-V2-08**: Soft cancel (see `docs/feature-candidates/soft-cancel.md`)
- **REQ-OPS-V2-09**: Structured feature-phase outputs (see `docs/feature-candidates/structured-feature-phase-outputs.md`)
- **REQ-OPS-V2-10**: Proposal editing and toggling (see `docs/feature-candidates/proposal-editing-and-toggling.md`)
- **REQ-OPS-V2-11**: Runtime ID validation (see `docs/feature-candidates/runtime-id-validation.md`)
- **REQ-OPS-V2-12**: Proposal op no-op cleanup (see `docs/feature-candidates/proposal-op-noop-cleanup.md`)
- **REQ-OPS-V2-13**: Graph dependency overload typing (see `docs/feature-candidates/graph-dependency-overload-typing.md`)

### State / UX (REQ-STATE-V2-*, REQ-TUI-V2-*)

- **REQ-STATE-V2-01**: Git-tracked markdown state exports (see `docs/feature-candidates/git-tracked-markdown-state-exports.md`)
- **REQ-TUI-V2-01**: Rich inbox filters (by feature, by severity, by age)
- **REQ-TUI-V2-02**: Feature summary timeline view
- **REQ-TUI-V2-03**: Saved planner "styles" (preferred decomposition granularity)
- **REQ-TUI-V2-04**: Usage / cost display in TUI (tracking exists in v1; display polish in v1.x)
- **REQ-TUI-V2-05**: Verify-agent prompt configurability per feature or milestone
- **REQ-TUI-V2-06**: Keyboard-nav polish / custom keymaps

## Out of Scope

Explicit exclusions. Anti-features and non-goals documented so they don't re-appear.

| Feature | Reason |
|---------|--------|
| IDE sidebar / editor integration (VS Code / JetBrains plugins) | Conflicts with "TUI orchestrator" thesis; every IDE integration doubles surface area and dilutes the DAG-as-execution-model |
| Multi-user collaboration (shared DAG, team inbox) | Single-user local-first is an explicit constraint; shared state implies server + auth + permissions — scope explosion |
| Cloud-hosted execution (SaaS) | Requires secrets in cloud, sandboxing, billing, multi-tenant infra; v1 is local source-install only |
| Plugin / extension marketplace | No users to extend for yet; API surface commitment is premature |
| AI-generated post-hoc commit editing | Conflicts with "task = one commit" atomicity model; adds opacity and history churn |
| Natural-language diff review panel (separate surface) | Fragments attention vs. existing per-task transcript + verify agent |
| Real-time multi-user dashboards | Single user → there is no "everyone" |
| Generic workflow DSL (write your own DAG YAML) | Planner is the DSL; YAML dilutes the "type a prompt" thesis |
| Rich HTML / web UI | Conflicts with pi-tui direction; adds Electron / web-server stack; splits the product's center of gravity |
| Per-task model autoselection (auto-pick Haiku vs Opus) | Adds heuristic that's wrong often enough to lose trust; hidden-complexity tax. Single global per-role config preferred (REQ-CONFIG-01) |
| Persistent "goal" entity with its own UI and lifecycle | Conflicts with REQ-PLAN-06 — goals are ephemeral; milestones are the persistent grouping |
| Public CLI / npm package distribution in v1 | Power-user audience uses source-checkout; packaging investment deferred (REQ-DIST-V2-*) |
| Budget enforcement behavior in v1 | v1 tracks + exposes usage; enforcement semantics deferred (REQ-CONFIG-V2-01) |

## Traceability

Phase mapping derived from `.planning/research/SUMMARY.md` and closed out by Phase 12 plan 12-03. Status rows cite the primary shipped evidence; detailed history lives in per-phase summaries under `.planning/phases/`.

| Requirement | Primary Phase | Status |
|-------------|---------------|--------|
| REQ-PLAN-01 | Phase 7 (Top-level planner + Inbox + Pause/Resume) | Complete — Phase 7 planner flow; 12-01 prompt-to-main proof; `docs/foundations/newcomer.md` |
| REQ-PLAN-02 | Phase 5 (Feature lifecycle + Feature-level planner) | Complete — Phase 5 feature planner; `test/integration/feature-phase-agent-flow.test.ts`; `docs/architecture/planner.md` |
| REQ-PLAN-03 | Phase 7 | Complete — additive planner/proposal semantics; proposal coverage; Phase 7 summaries |
| REQ-PLAN-04 | Phase 7 + Phase 10 | Complete — planner session continue/fresh UX and audit reader from Phase 10 |
| REQ-PLAN-05 | Phase 8 + Phase 10 | Complete — manual TUI graph commands and proposal collision/review surfaces |
| REQ-PLAN-06 | Phase 7 + Phase 10 | Complete — persisted planner audit log plus Phase 10 reader UI |
| REQ-PLAN-07 | Phase 7 + Phase 10 | Complete — collision metadata, cancellation-on-approval behavior, and proposal review overlay |
| REQ-EXEC-01 | Phase 3 (Worker execution loop + spike) | Complete — child worker/worktree model; `test/integration/worker-smoke.test.ts`; 12-01 lifecycle proof |
| REQ-EXEC-02 | Phase 3 + Phase 5 | Complete — commit trailer gate; `test/unit/agents/commit-trailer.test.ts`; 12-01 commit evidence |
| REQ-EXEC-03 | Phase 3 | Complete — NDJSON IPC schema/quarantine tests; `docs/architecture/worker-model.md` |
| REQ-EXEC-04 | Phase 3 + Phase 7 | Complete — retry policy, semantic failure/inbox routing, and help-wait lifecycle coverage |
| REQ-EXEC-05 | Phase 3 + Phase 4 | Complete — worker pool cap, scheduler frontier, and configurable worker cap |
| REQ-EXEC-06 | Phase 4 | Complete — feature dependency merged gate in scheduler plans/tests |
| REQ-MERGE-01 | Phase 6 (Merge train) | Complete — merge-train serialization tests and 12-01 merge-train drain proof |
| REQ-MERGE-02 | Phase 6 | Complete — integration runner rebase/verify/eject paths and merge-train integration tests |
| REQ-MERGE-03 | Phase 6 | Complete — re-entry cap, inbox parking, warning/concerns traceability |
| REQ-MERGE-04 | Phase 5 + Phase 6 | Complete — verify agent contract, integration runner agent review, and 12-01 verify audit |
| REQ-TUI-01 | Phase 8 (TUI surfaces) | Complete — DAG, inbox, merge-train, transcript, config, and review overlays; 12-02 TUI smoke |
| REQ-TUI-02 | Phase 7 + Phase 8 | Complete — unified inbox model and inbox overlay/actions |
| REQ-TUI-03 | Phase 8 | Complete — manual feature/task graph editing commands and TUI command coverage |
| REQ-TUI-04 | Phase 8 | Complete — config overlay/editor and live config persistence |
| REQ-TUI-05 | Phase 8 | Complete — distinct task/feature cancel commands and TUI controls |
| REQ-TUI-06 | Phase 8 | Complete — docs-aligned pi-tui power-user workflow and reference docs |
| REQ-INBOX-01 | Phase 7 | Complete — `request_help`/`await_response` routing into inbox |
| REQ-INBOX-02 | Phase 7 | Complete — hot-window and checkpointed wait states |
| REQ-INBOX-03 | Phase 7 | Complete — replay/respawn resume strategy after checkpointed waits |
| REQ-INBOX-04 | Phase 7 | Complete — inbox fanout/multi-task single-answer unblock |
| REQ-STATE-01 | Phase 1 + Phase 2 | Complete — split state model, persistence, FSM guards, and `docs/foundations/state-axes.md` |
| REQ-STATE-02 | Phase 9 (Crash recovery UX) | Complete — auto-resume, recovery summary inbox item, and rehydration/recovery tests |
| REQ-STATE-03 | Phase 1 + Phase 2 | Complete — milestone graph/persistence model and scheduler steering semantics |
| REQ-STATE-04 | Phase 7 + Phase 8 | Complete — milestone planner/manual graph operations and TUI edit flows |
| REQ-CONFIG-01 | Phase 2 + Phase 3 | Complete — global four-role model config, schema/load tests, runtime model resolution |
| REQ-CONFIG-02 | Phase 2 + Phase 8 | Complete — v1 configurable/visible budget knobs; enforcement explicitly deferred to REQ-CONFIG-V2-01 |
| REQ-CONFIG-03 | Phase 8 | Complete — TUI config editor, hot-reloadable settings, worker/re-entry/pause/model controls |
| REQ-DOC-01 | Phase 1 + Phase 11 | Complete — `docs/foundations/execution-flow.md` and doc drift checks |
| REQ-DOC-02 | Phase 1 + Phase 11 | Complete — `docs/foundations/state-axes.md` and canonical state diagram |
| REQ-DOC-03 | Phase 1 + Phase 11 | Complete — `docs/foundations/coordination-rules.md` decision tables |

**Coverage:**
- v1 requirements: 37 total
- Complete: 37
- Explicit follow-up: 0
- Mapped to phases: 37
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-23*
*Last updated: 2026-05-02 after Phase 12 traceability closeout*
