# Roadmap: gvc0

## Overview

gvc0's v1 journey is **completing and clarifying** an existing design rather than shipping a new one. The partial implementation, architecture docs, and concerns catalog together describe a sound DAG-first autonomous coding orchestrator on pi-sdk; the gap is executional density — too many individually defensible details that collectively make execution flow, state shape, and coordination semantics opaque. This roadmap therefore starts with foundations and clarity (Phase 1), locks persistence and port contracts (Phase 2), proves the worker + scheduler + merge-train loop bottom-up (Phases 3–6), layers the user-facing planner + inbox + TUI (Phases 7–8), hardens crash recovery (Phase 9), polishes collision and audit-log UX (Phase 10), and finally consolidates documentation + diagnostic tooling + integration scenarios (Phases 11–12). One real spike — pi-sdk Agent resume/replay fidelity — lands in Phase 3 because its outcome gates Phase 7's two-tier pause UX.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (e.g., 2.1): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Foundations & Clarity** — Consolidate core contracts (FSM guards, graph invariants, scheduling rules) and publish the canonical state / flow / coordination docs that end the opacity pain. ✓ 2026-04-23 (3/3 plans, 934 core tests, VERIFICATION PASS)
- [x] **Phase 2: Persistence & Port Contracts** — Lock the Store port + SQLite schema + WAL tuning + typed config schema so nothing downstream rests on shifting ground. ✓ 2026-04-23 (3/3 plans, 106 persistence+config tests, VERIFICATION PASS; 10-min load gate deferred to runbook)
- [x] **Phase 3: Worker Execution Loop (+ Pi-SDK Spike)** — Process-per-task worker, NDJSON IPC with `claim_lock`, write pre-hook, worktree manager, retry policy; decide pi-sdk Agent resume/replay strategy. ✓ 2026-04-23 (5/5 plans, VERIFICATION 6/6 structural PASS, 1520 unit + 26 phase-3 integration tests green. Spike decision: persist-tool-outputs — Agent.continue() throws on assistant-terminated transcripts across all 5 scenarios. Live-provider re-validation deferred to Phase 7/9.)
- [x] **Phase 4: Scheduler Tick + Event Queue** — Serial event queue, combined-graph metrics, priority-sort, reservation-overlap penalty, dispatch to worker pool. ✓ 2026-04-24 (3/3 plans, VERIFICATION 4/5 PASS + 1 PARTIAL. SchedulerEvent union with tick-boundary guard, 7-key priority sort with canonical DAG fixtures, feature-dep merge gate, perf smoke both tiers gated behind LOAD_TEST=1.)
- [ ] **Phase 5: Feature Lifecycle & Feature-Level Planner** — Vertical slice: a feature plans, executes, verifies (agent review), and reaches merge-ready end-to-end.
- [ ] **Phase 6: Merge Train** — Strict-main merge train with rebase + agent-review verify, re-entry cap, inbox parking on cap.
- [ ] **Phase 7: Top-Level Planner + Inbox + Pause/Resume** — Prompt-to-feature-DAG; unified inbox; two-tier pause; additive re-plan; two-planner collision handling.
- [ ] **Phase 8: TUI Surfaces** — Four-surface TUI (feature DAG, inbox, merge-train, task transcript), manual DAG editing, three cancel levers, config editor menu.
- [ ] **Phase 9: Crash Recovery UX** — Seamless auto-resume, orphan-worktree triage, stale-lock sweep, recovery-summary inbox item.
- [ ] **Phase 10: Re-plan Flows & Manual Edits Polish** — Continue-vs-fresh planner session picker, audit-log reader, proposal preview, collision-surface polish.
- [ ] **Phase 11: Documentation & Diagnostic Tooling** — `gvc0 explain` CLI, canonical diagrams matched to shipped code, concerns-to-tests map, newcomer narrative.
- [ ] **Phase 12: Integration & Polish** — End-to-end scenarios, verify-agent flake-rate audit, TUI e2e smoke tests, source-install runbook.

## Phase Details

### Phase 1: Foundations & Clarity
**Goal**: Establish crisp core contracts (types, FSM guards, scheduling rules) and publish canonical docs that eliminate the "execution flow / state shape / coordination semantics are opaque" pain before building on top.
**Depends on**: Nothing (first phase).
**Requirements**: REQ-STATE-01 (core side), REQ-STATE-03 (core graph types), REQ-DOC-01, REQ-DOC-02, REQ-DOC-03
**Success Criteria** (what must be TRUE):
  1. A single canonical state diagram (work × collab × run axes) exists and matches the code's FSM guards
  2. FSM guards in `core/fsm/` are pure functions with unit-test coverage of composite (cross-axis) invariants
  3. `core/*` imports nothing from `runtime/*`, `persistence/*`, or `tui/*` — boundary check runs in CI
  4. Coordination rules (lock / claim / suspend / resume / rebase) are documented as decision tables, not prose
  5. A newcomer can follow the docs from prompt to merge without reading the orchestrator source
**Plans**: TBD (~3 plans)

Plans:
- [ ] 01-01: Core contracts consolidation — graph types, typed IDs, FSM guards, scheduling rules, warning definitions; boundary lint
- [ ] 01-02: Canonical docs pass — state diagram, execution flow narrative, coordination decision tables (cross-reference `docs/architecture/*`)
- [ ] 01-03: Unit tests for FSM composite invariants + naming utilities

### Phase 2: Persistence & Port Contracts
**Goal**: Finalize the Store port and SQLite schema + migrations + WAL tuning + typed config schema so downstream phases cannot be destabilized by persistence changes.
**Depends on**: Phase 1
**Requirements**: REQ-STATE-01 (persistence side), REQ-STATE-03 (persistence side), REQ-CONFIG-01, REQ-CONFIG-02
**Success Criteria**:
  1. Store port + `better-sqlite3` adapter supports all graph / run / milestone / summary / usage-rollup operations with typed schemas
  2. Load test: 100 events/sec for 10 minutes keeps event-queue write P95 < 100ms (WAL tuned)
  3. Idempotent boot rehydration: start → shutdown → start with no in-flight work yields identical graph state
  4. Typed config schema loads + validates per-role model settings, worker cap, retry cap, re-entry cap, pause timeouts, budget knobs
**Plans**: TBD (~3 plans)

Plans:
- [ ] 02-01: SQLite schema + migrations + Store port contract
- [ ] 02-02: WAL tuning + load test harness + idempotent rehydration
- [ ] 02-03: Typed config schema + file loader + hot-reload classification

### Phase 3: Worker Execution Loop (+ Pi-SDK Resume Spike)
**Goal**: A single task runs end-to-end in an isolated worktree via a pi-sdk Agent child process, communicating over NDJSON IPC, with the write pre-hook enforcing safety, and with a proven answer to the pi-sdk resume/replay question.
**Depends on**: Phase 2
**Requirements**: REQ-EXEC-01, REQ-EXEC-02, REQ-EXEC-03, REQ-EXEC-04, REQ-EXEC-05 (worker-pool side), REQ-CONFIG-01 (use)
**Success Criteria**:
  1. A single task runs end-to-end: spawn worker → pi-sdk Agent in worktree → commit with gvc0 trailer → worker cleanup
  2. Write pre-hook rejects writes outside the task worktree directory; `push --force` / `branch -D` / `reset --hard` routed to inbox approval stub
  3. NDJSON IPC parser is line-buffered, schema-validated, survives malformed input (quarantined, not fatal), and detects worker silence via health-check
  4. Retry policy auto-retries transient errors up to configurable hard cap; semantic failures are handed to the (stub) inbox
  5. Pi-sdk Agent resume/replay spike produces a written decision: native pi-sdk replay OR persist-tool-outputs fallback, with reasoning grounded in observed behavior
**Plans**: TBD (~5 plans)

Plans:
- [ ] 03-01: Worktree manager (add / remove / prune / stale-lock sweep) + PID registry
- [ ] 03-02: NDJSON IPC bridge + schema validation + malformed-line quarantine + health-check
- [ ] 03-03: Worker process lifecycle + pi-sdk Agent host + commit-with-trailer contract
- [ ] 03-04: Write pre-hook (`claim_lock` round-trip, cwd enforcement, destructive-op gate stubs)
- [ ] 03-05: Pi-sdk Agent resume/replay spike — measurements + decision doc + minimal implementation of chosen strategy

### Phase 4: Scheduler Tick + Event Queue
**Goal**: Wire the serial event queue + scheduler that orchestrates the Phase 3 worker pool: combined-graph metrics, priority sort, reservation overlap penalty, dispatch.
**Depends on**: Phase 3
**Requirements**: REQ-EXEC-05 (scheduler side), REQ-EXEC-06
**Success Criteria**:
  1. All graph mutations flow through the single serial event queue — boundary test fails if any mutation bypasses it
  2. Combined-graph critical-path metrics (maxDepth, distance) match expected values on canonical test DAGs
  3. Priority sort obeys 7 keys + 1 stable ID tiebreaker (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age → entity ID)
  4. Reservation overlap applies scheduling penalty but does not block; runtime overlap (write pre-hook) routes to coordination
  5. Feature deps enforce "wait for merge to main" — downstream feature dispatches only after upstream's `collab=merged`
**Plans**: 3 plans

Plans:
- [x] 04-01-PLAN.md — Serial event queue hardening + boundary-test infrastructure (AST walker + runtime `__enterTick` guard); enqueue-wake wiring; shutdown handler + exhaustiveness assertion; route-through refactors for compose.ts TUI callbacks and agents/runtime.ts phase-agent mutations. Closes SC1.
- [x] 04-02-PLAN.md — Canonical DAG fixture library (diamond/linear/parallel/deepNested/mixed); 7-key + ID-tiebreaker full-order sort test; reservation-overlap-is-penalty-not-block test; retry-eligibility backoff formula alignment with CONTEXT § H; ROADMAP + graph-operations.md doc reconciliation. Closes SC2, SC3, SC4.
- [x] 04-03-PLAN.md — readyTasks() upstream feature-dep merged gate + dispatch-time defensive guard; comprehensive collab-state test matrix; feature-phase worker-cap verification (REQ-EXEC-05); perf smoke (default 50×20 p95<100ms, LOAD_TEST 100×20 p95<250ms); two-feature E2E with WorkerPool. Closes SC5 + REQ-EXEC-05/06.

### Phase 5: Feature Lifecycle & Feature-Level Planner
**Goal**: A single feature goes plan → execute → verify → merge-ready end-to-end: feature-level planner produces a task DAG, tasks execute, verify phase runs a real agent review, repair loop handles failures.
**Depends on**: Phase 4
**Requirements**: REQ-PLAN-02, REQ-MERGE-04 (initial implementation)
**Success Criteria**:
  1. Feature-level planner agent takes a feature + context and emits a task DAG via typed pi-sdk tool calls (createTask, addDependency, reweight)
  2. Feature lifecycle transitions through planning → executing → ci_check → verifying → awaiting_merge, validated by FSM guards
  3. Verify phase runs a real pi-sdk agent review (not a stub) against the feature branch diff, returning pass or issues
  4. Executing_repair loop turns verify issues into repair tasks; once they land, verify re-runs
  5. Agent "hallucinates progress" case is rejected: task completion without a matching trailer-tagged commit fails
**Plans**: TBD (~4 plans)

Plans:
- [ ] 05-01: Feature-level planner agent + prompt + tool schemas (typebox)
- [ ] 05-02: Feature lifecycle FSM transitions + guard tests
- [ ] 05-03: Verify agent (pi-sdk Agent running review on feature branch diff) + pass/issue protocol
- [ ] 05-04: Executing_repair loop + hallucinated-progress rejection

### Phase 6: Merge Train
**Goal**: Strict-main merge train with rebase + agent-review verify + re-entry cap + inbox parking on cap. `main` never advances to an unverified state.
**Depends on**: Phase 5
**Requirements**: REQ-MERGE-01, REQ-MERGE-02, REQ-MERGE-03, REQ-MERGE-04 (integration)
**Success Criteria**:
  1. Queue head rebases onto latest `main`, runs merge-train verification, and either merges or is ejected for repair (`integrating → branch_open`)
  2. Re-entry count increments on every ejection; at configurable cap (default 10), feature is parked in inbox with full diagnostics
  3. Integration test proves `main` does not advance when merge-train verify fails
  4. Two features with cross-feature conflicts handled via conflict coordination protocol, not silent starvation
  5. Manual override bucket (simple: `mergeTrainManualPosition`) works for user re-prioritization
**Plans**: TBD (~3 plans)

Plans:
- [ ] 06-01: Merge-train queue + ordering (queued-milestone bucket, auto-priority, manual override)
- [ ] 06-02: Rebase + merge-train verify + eject-or-merge protocol; re-entry counting
- [ ] 06-03: Re-entry cap parking + diagnostics payload + cross-feature conflict handoff

### Phase 7: Top-Level Planner + Inbox + Pause/Resume
**Goal**: Full user-facing prompt-to-execution loop: top-level planner drafts features via inline chat; agent asks route to a unified inbox; two-tier pause handles short and AFK waits; planner re-invocation is additive; manual edits win; two-planner collisions handled.
**Depends on**: Phase 6
**Requirements**: REQ-PLAN-01, REQ-PLAN-03, REQ-PLAN-04, REQ-PLAN-06 (persistence), REQ-PLAN-07, REQ-INBOX-01, REQ-INBOX-02, REQ-INBOX-03, REQ-INBOX-04, REQ-STATE-03 (runtime), REQ-STATE-04, REQ-TUI-02 (model side)
**Success Criteria**:
  1. User types a prompt; top-level planner drafts a feature DAG through inline chat (create/edit/split/merge features + milestones)
  2. Re-invoking planner (user picks continue-chat vs fresh-session) never mutates running or completed work — only additive mutations land
  3. Agent `await_response` / `request_help` calls route to the inbox; answering delivers the response back to the waiting worker
  4. Two-tier pause: hot window (configurable, default ~10 min, resets on inbox activity) keeps worker + worktree; expiry checkpoints to disk and releases process; on resume, a fresh worker respawns and replays
  5. One inbox answer can unblock multiple equivalent-question tasks
  6. Top-level edit targeting a feature whose feature-level planner is running flags the collision in proposal view; accepting cancels the feature-level planner, which re-runs on the new shape
  7. Planner prompts persist as per-feature audit log
  8. Inbox entries cover: agent asks, merge conflicts, auth expiry, destructive-action approvals, orphan-worktree cleanup items, re-entry-cap parkings
**Plans**: TBD (~5 plans)

Plans:
- [ ] 07-01: Top-level planner agent + milestone/feature CRUD tools + additive-mutation enforcement
- [ ] 07-02: Inbox domain model + agent-ask routing + multi-task unblock semantics
- [ ] 07-03: Two-tier pause + checkpoint + respawn-with-replay (using Phase 3 spike decision)
- [ ] 07-04: Planner session registry (continue vs fresh) + per-feature audit log
- [ ] 07-05: Edit-during-planning collision detection + proposal-view flagging + cancel-on-accept

### Phase 8: TUI Surfaces
**Goal**: Four-surface TUI bound to derived view-models; manual DAG editing; three cancel levers; config editor; power-user ergonomics.
**Depends on**: Phase 7
**Requirements**: REQ-TUI-01, REQ-TUI-02 (UI side), REQ-TUI-03, REQ-TUI-04, REQ-TUI-05, REQ-TUI-06, REQ-PLAN-05, REQ-CONFIG-03
**Success Criteria**:
  1. Feature DAG, inbox, merge-train, and per-task transcript surfaces render from the derived view-model stream with no state held in UI
  2. Render rate-capped (15 Hz); 10 concurrent task streams produce no observable flicker or input lag
  3. Manual DAG editing (create / edit / split / merge / cancel / remove / reorder / reweight) works from the TUI and correctly wins over planner output
  4. Three cancel levers are distinct, clearly labeled actions (task-preserve-worktree / task-clean-worktree / feature-abandon-branch)
  5. Config editor menu edits model per role, worker cap, pause timeout, retry cap, and re-entry cap without restart (hot-reloadable)
**Plans**: TBD (~5 plans)

Plans:
- [ ] 08-01: Pi-tui shell + surface orchestration + derived view-model stream
- [ ] 08-02: Feature DAG surface + manual edit actions (create/edit/split/merge/cancel/reorder/reweight)
- [ ] 08-03: Inbox surface + merge-train surface
- [ ] 08-04: Per-task transcript surface + render rate-cap + virtualization
- [ ] 08-05: Config editor menu (hot-reload keys) + three cancel levers as visible actions

### Phase 9: Crash Recovery UX
**Goal**: Seamless auto-resume on orchestrator crash — no user triage required on restart.
**Depends on**: Phase 8
**Requirements**: REQ-STATE-02
**Success Criteria**:
  1. `kill -9` during worker commit → restart cleans stale `.git/index.lock` and `.git/worktrees/*/index.lock`, respawns workers, surfaces a recovery-summary inbox item
  2. Orphan worktrees (no live PID) surface in inbox with clean / inspect / keep actions
  3. In-flight workers re-spawn with transcript replay and reach the same logical state (per Phase 3 spike strategy)
  4. Boot never hangs on stale locks; sweep completes within 5 seconds of boot
  5. End-to-end crash test: mid-feature-execution kill → restart → coherent TUI state (no error spam, no lost task)
**Plans**: TBD (~3 plans)

Plans:
- [ ] 09-01: Stale-lock sweep + orphan-worktree detection + PID reconciliation
- [ ] 09-02: In-flight worker respawn + transcript replay path (production hookup of Phase 3 strategy)
- [ ] 09-03: Recovery-summary inbox item + crash fault-injection integration test

### Phase 10: Re-plan Flows & Manual Edits Polish
**Goal**: Tighten the edit / re-plan / audit-log user experience so collisions are always visible and intent is always recoverable.
**Depends on**: Phase 9
**Requirements**: REQ-PLAN-04 (polish), REQ-PLAN-06 (reader UI)
**Success Criteria**:
  1. User can continue a prior planner chat or start a fresh session from the TUI with clear UX — no ambiguity about which session is active
  2. Per-feature planner audit log (prompts that produced the current feature) is readable in the TUI
  3. All manual-edit vs. live-planner collisions surface in the proposal view — no silent planner overwrites
  4. Planner proposals can be previewed (read-only) before accepting or rejecting
**Plans**: TBD (~2 plans)

Plans:
- [ ] 10-01: Planner session picker + continue/fresh UX + audit-log reader surface
- [ ] 10-02: Proposal preview (read-only) + comprehensive collision surfacing

### Phase 11: Documentation & Diagnostic Tooling
**Goal**: Match documentation to the shipped code and build the diagnostic surfaces that make the three-axis state readable at any time.
**Depends on**: Phase 10
**Requirements**: REQ-DOC-01 (final), REQ-DOC-02 (final), REQ-DOC-03 (final)
**Success Criteria**:
  1. `gvc0 explain feature <id>` / `task <id>` / `run <id>` prints a human-readable state-at-a-glance (work × collab × run axes, run history, current blockers)
  2. Execution-flow / state-shape / coordination-semantics docs match shipped behavior — doc-vs-code drift check in CI
  3. Each `docs/concerns/*.md` cross-links to at least one executable test proving the mitigation holds
  4. Newcomer end-to-end narrative doc: a reader goes from "what is gvc0?" to "how does a prompt become a merged PR?" without reading code
**Plans**: TBD (~3 plans)

Plans:
- [ ] 11-01: `gvc0 explain` CLI + view-model reuse for text output
- [ ] 11-02: Doc-vs-code drift check + state diagram update + decision-table consolidation
- [ ] 11-03: Concerns-to-tests map + newcomer narrative doc

### Phase 12: Integration & Polish
**Goal**: Prove the core loop end-to-end; tune verify agent; establish a source-install runbook that a fresh clone can follow.
**Depends on**: Phase 11
**Requirements**: Integration of all v1 requirements (no new REQ-ids)
**Success Criteria**:
  1. Scripted end-to-end scenario runs green: "type a prompt → draft features → execute → answer one inbox item → merge-train drains → main contains expected commits"
  2. Verify agent flake-rate audit: ≥90% consistency on known-good-branch runs across 5 repeats
  3. TUI e2e smoke tests (`@microsoft/tui-test`) cover the golden path
  4. Source-install runbook in README verified by a fresh-clone dry-run: `npm install && npm run tui` leads to a running TUI
  5. All v1 REQ-ids either complete with traceability green, or have an explicit v1.x follow-up
**Plans**: TBD (~3 plans)

Plans:
- [ ] 12-01: End-to-end scripted scenario + verify-agent flake-rate audit
- [ ] 12-02: TUI e2e smoke tests (golden path)
- [ ] 12-03: README / runbook + v1 traceability green-out

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundations & Clarity | 0/TBD (~3) | Not started | - |
| 2. Persistence & Port Contracts | 0/TBD (~3) | Not started | - |
| 3. Worker Execution Loop (+ Spike) | 5/5 | ✓ Complete | 2026-04-23 |
| 4. Scheduler Tick + Event Queue | 3/3 | ✓ Complete | 2026-04-24 |
| 5. Feature Lifecycle & Feature-Level Planner | 0/TBD (~4) | Not started | - |
| 6. Merge Train | 0/TBD (~3) | Not started | - |
| 7. Top-Level Planner + Inbox + Pause/Resume | 0/TBD (~5) | Not started | - |
| 8. TUI Surfaces | 0/TBD (~5) | Not started | - |
| 9. Crash Recovery UX | 0/TBD (~3) | Not started | - |
| 10. Re-plan Flows & Manual Edits Polish | 0/TBD (~2) | Not started | - |
| 11. Documentation & Diagnostic Tooling | 0/TBD (~3) | Not started | - |
| 12. Integration & Polish | 0/TBD (~3) | Not started | - |

---
*Roadmap created: 2026-04-23*
*Last updated: 2026-04-24 — Phase 4 complete (3/3 plans, VERIFICATION 4/5 PASS + 1 PARTIAL). Advancing to Phase 5.*
