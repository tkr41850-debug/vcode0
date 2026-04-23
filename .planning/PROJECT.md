# gvc0 — DAG-First Autonomous Agent Orchestrator

## What This Is

gvc0 is a local, single-user autonomous coding orchestrator built on pi-sdk (`@mariozechner/pi-agent-core`). A power user types a natural-language prompt, a planner agent drafts a DAG of features and tasks, and the system executes features in parallel — each task runs as its own pi-sdk `Agent` process in an isolated git worktree, squash-merging commits onto a long-lived feature branch that is serialized into `main` via a merge train. The user watches and steers the live DAG from a terminal UI.

## Core Value

**From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — while the user watches, edits, re-plans, and answers agent asks live in a single TUI.**

If everything else slips, this loop — prompt → live DAG → features merging cleanly to `main` — must feel coherent and trustworthy.

## Requirements

### Validated

(None yet — existing partial implementation is treated as reference, not ground truth; v1 ships to validate.)

### Active

#### Core execution
- [ ] REQ-PLAN-01: Top-level planner agent turns a prompt into a feature DAG (create / edit / split / merge features within a milestone) via inline chat with the user
- [ ] REQ-PLAN-02: Feature-level planner agent turns a feature into a task DAG (create / edit tasks within a feature) via inline chat
- [ ] REQ-PLAN-03: Re-invoking a planner is additive only — never touches running or completed work
- [ ] REQ-PLAN-04: On planner re-invocation, user picks "continue prior chat" or "fresh session"
- [ ] REQ-PLAN-05: Manual DAG edits (user in TUI) always win over planner; planner treats them as constraints
- [ ] REQ-PLAN-06: Planner prompts are persisted as an audit log alongside the features they created (no persistent "goal" entity)
- [ ] REQ-PLAN-07: When the top-level planner proposes an edit on a feature whose feature-level planner is currently running, the proposal view flags this and accepting cancels the running feature-level planner (it retries on the new shape)
- [ ] REQ-EXEC-01: Each task runs as a child process pi-sdk `Agent` in its own worktree (`feat-<name>-<feature-id>-<task-id>`)
- [ ] REQ-EXEC-02: Tasks produce exactly one squash-merge commit on their feature branch when they complete
- [ ] REQ-EXEC-03: Worker IPC is NDJSON over stdio (subject to research validation of alternatives)
- [ ] REQ-EXEC-04: Task failure is handled heuristically — transient errors auto-retry with backoff; semantic failures park in the inbox
- [ ] REQ-EXEC-05: Global worker-count cap governs concurrent parallelism (configurable, sane default)
- [ ] REQ-EXEC-06: Feature dependencies enforce "wait for merge to `main`" semantics — strictest, simplest
- [ ] REQ-MERGE-01: Merge train serializes feature-branch integration into `main`; `main` never in a bad state
- [ ] REQ-MERGE-02: Queue head rebases onto latest `main`, runs merge-train verification, then merges — or is ejected for repair
- [ ] REQ-MERGE-03: Re-entry count is capped (configurable, default 10); on cap, the feature is parked in the inbox for user decision
- [ ] REQ-MERGE-04: Verification before merge = an agent review (not tests / not type-check); documented explicitly

#### TUI / interaction
- [ ] REQ-TUI-01: Primary TUI surfaces: feature DAG graph, inbox, merge-train status, per-task live transcript — all first-class
- [ ] REQ-TUI-02: Inbox is the unified "things waiting on you" surface — agent `await_response` / `request_help` asks, merge conflicts, auth expiry, destructive-action approvals, orphan-worktree cleanup after crash, re-entry-cap parkings, and similar system-attention items
- [ ] REQ-TUI-03: Manual graph editing — create / edit / split / merge / cancel / remove / reorder / reweight features and tasks from the TUI
- [ ] REQ-TUI-04: Config editing menu inside the TUI (no hand-editing JSON)
- [ ] REQ-TUI-05: Three cancel levers surfaced: cancel-task-preserve-worktree, cancel-task-clean-worktree, cancel-feature-abandon-branch
- [ ] REQ-TUI-06: TUI is usable by power users — docs-aligned, event-driven pi-tui feel, not a newcomer-polished product

#### Inbox / pause-resume
- [ ] REQ-INBOX-01: Agent-initiated `await_response` / `request_help` / similar tool calls route the task to the inbox
- [ ] REQ-INBOX-02: Two-tier pause: the paused task keeps its worker process and worktree for a configurable window (default ~10 min); after the window, the process is released and a checkpoint is persisted (worktree retained)
- [ ] REQ-INBOX-03: Resume after process-release rehydrates by re-spawning a worker that replays the agent transcript
- [ ] REQ-INBOX-04: Answering one inbox item can unblock multiple tasks when appropriate (multi-task unblock is explicitly supported)

#### State / recovery
- [ ] REQ-STATE-01: State split preserved — `work control` (planning/execution phases), `collaboration control` (branch/merge/conflict), `run state` (retry, help/approval waits) on `agent_runs`
- [ ] REQ-STATE-02: Seamless auto-resume on orchestrator crash — on restart, orchestrator rehydrates from SQLite, re-spawns workers for in-flight tasks, replays transcripts where needed; user sees the live state, not a recovery dialog
- [ ] REQ-STATE-03: Milestones are persistent groupings of features; multiple milestones may have in-flight features concurrently; milestone queue steers scheduler priority but does not gate execution
- [ ] REQ-STATE-04: Top-level planner may propose milestone splits / merges; user may also create / edit milestones manually

#### Config / models / cost
- [ ] REQ-CONFIG-01: Single global config — one model per agent role (top-planner, feature-planner, task-worker, verifier)
- [ ] REQ-CONFIG-02: Cost / budget knobs exist and are configurable, but enforcement behavior is deferred to requirements phase once pi-sdk's usage tracking capability is researched
- [ ] REQ-CONFIG-03: Pause thresholds, re-entry cap, worker-count cap, and model assignments are all user-editable (TUI + file)

#### Clarity / docs
- [ ] REQ-DOC-01: Execution flow is documented end-to-end — who triggers what, when (event queue, dispatch, feature-phase agents, worker lifecycle)
- [ ] REQ-DOC-02: State shape is documented with one canonical diagram covering the three axes and their valid combinations
- [ ] REQ-DOC-03: Coordination semantics (lock/claim/suspend/resume/rebase) are documented with decision tables, not prose

### Out of Scope (v1)

- **Public CLI / distribution polish** — source-checkout install only (`git clone` + `npm run dev`); npm / binary packaging deferred
- **Public goal entity / goal history UI** — replaced by per-feature audit log of planner prompts
- **Budget *enforcement* behavior** — tracking + display only in v1; enforcement semantics chosen later
- **Merge train throughput optimizations** — speculative parallel rebase+verify, batch merges, looser `main` invariants — deferred (acknowledged bottleneck risk)
- **Arbitrary persistent manual merge-train ordering** — already deferred as feature candidate; v1 stays with the simple override bucket
- **In-flight split/merge** — only pre-execution + pre-branch splits/merges; in-flight variant is an existing deferred feature candidate
- **Multi-repo / cross-repo orchestration** — v1 runs inside a single target repo
- **Generic UI polish for newcomers** — power-user tool; prioritize clarity and density over friendliness
- **System-initiated inbox items beyond the listed set** — only the explicit list (agent asks, conflicts, auth expiry, approvals, orphan cleanup, re-entry cap) in v1

## Context

**Lineage.** gvc0 is the TypeScript remake of GSD-2, rebuilt on `@mariozechner/pi-agent-core` (pi-sdk). The thesis shift: sequential-default → DAG-first with max parallelism at every level.

**pi-sdk coupling.** Agents are pi-sdk `Agent` instances. Inbox triggers are pi-sdk agent tool calls (`await_response`, `request_help`, and similar in `docs/agent-prompts/`). The write prehook (path lock claim) is pi-sdk-specific and currently only intercepts writes — non-write side effects are not coordinated.

**Existing code is reference, not baseline.** Partial implementation has: orchestrator lock release, worker IPC, claim-lock, merge-train scaffolding, scheduler tick loop, combined-graph metrics, FSM guards. User's stance: churn is fine; rewrite what's not working; the design is directionally sound but under-specified at edges.

**Design strengths (retain):**
- DAG with features-over-features and tasks-over-tasks-within-a-feature
- Serial event queue with async feature-phase agents
- Combined virtual graph for critical-path metrics
- State split (work control / collab control / run state)
- Milestones as steering buckets, not dependency nodes
- Reservation overlap as scheduling penalty + runtime overlap via push-based write prehook
- Work-type priority tiers (verify > execute > plan > summarize) — finish features before starting new ones

**Primary pain.** Execution flow, state shape, and coordination semantics are all individually defensible but collectively opaque. Symptom: returning to the code after a break requires re-learning too many small contracts. Fix target: clarity, not redesign.

**Existing documentation** (retain, update, cross-link):
`ARCHITECTURE.md`, `CLAUDE.md`, `docs/README.md`, `docs/architecture/*`, `docs/operations/*`, `docs/reference/*`, `docs/agent-prompts/*`, `specs/*`. Deferred work already catalogued under `docs/feature-candidates/`, `docs/optimization-candidates/`, `docs/concerns/`, `docs/compare/`.

**Tooling.** Existing `gsd-tools` binary (local GSD workflow SDK) is used by planning agents. Note: the `gsd-sdk` binary on PATH is gvc0's own in-project SDK — unrelated name collision.

## Constraints

- **Tech stack**: TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ES modules, Node >= 24, pi-sdk (`@mariozechner/pi-agent-core`), better-sqlite3, simple-git, Vitest, Biome + ESLint — match existing `CLAUDE.md`
- **Architecture boundaries**: `@core/*` (pure), `@app/*`, `@orchestrator/*`, `@agents/*`, `@runtime/*`, `@persistence/*`, `@tui/*`; core must not depend on runtime/persistence/tui
- **Runtime locus**: gvc0 runs *inside* the target repo; state directory and worktrees live beside the repo's workdir
- **User**: Small set of power users; not a public CLI; source install only in v1
- **Correctness invariant**: `main` is never red — merge train is the sole path to `main`; every merge is rebased onto current `main` and passes merge-train verification before advancing
- **DAG shape invariant**: Features depend only on features; tasks depend only on tasks within the same feature; milestones group features but are never dependency nodes
- **Concurrency discipline**: All graph mutations flow through the single serial event queue — no ad-hoc locking; feature-phase agents post results back as events
- **Planner authority**: Planner is additive only on re-invocation; manual user edits always win
- **Design stance**: Existing code may be rewritten freely if cleaner rewrites serve the clarity goal — nothing is precious

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| No persistent "goal" entity; prompts are ephemeral | Simpler state model; features + DAG are the persistent units. Prompts persist as per-feature audit log instead. | — Pending |
| Milestones are persistent groupings of features; multiple may overlap in execution | Milestones steer scheduler priority without gating execution; user can have parallel workstreams | — Pending |
| Two planners: top-level (features) + feature-level (tasks) | Strategic vs tactical separation; different prompts, different context | — Pending |
| Planner re-invocation is additive only | Avoids disturbing in-flight or completed work; predictable behavior | — Pending |
| Manual DAG edits always win over planner | User is the ultimate authority; planner adapts | — Pending |
| Top-level edit on an in-progress-planning feature aborts the feature-level planner (visible in proposal view) | Resolves the two-planner collision cleanly | — Pending |
| Inbox is the unified "things waiting on you" surface | One surface for agent asks, conflicts, approvals, auth, orphans, re-entry parkings — keeps TUI focused | — Pending |
| Two-tier pause: keep worker process for configurable window (default ~10 min), then release to checkpoint | Responsive short-wait for quick answers; resource release when user is AFK | — Pending |
| Task output = one squash-merge commit on feature branch (via worktree) | Matches existing design; simplifies merge-train semantics | — Pending |
| Process-per-task via pi-sdk `Agent` | Existing pattern; research should validate resume / replay fidelity | — Pending |
| Single global config for per-role models (top-planner / feature-planner / task-worker / verifier) | Simple; avoids over-configuration; per-role keeps cost sane | — Pending |
| Feature deps enforce "wait for merge to `main`" | Strictest, simplest semantics; `main` is always the valid baseline for downstream | — Pending |
| Merge train is strictly serial; `main` invariant is strict | Correctness over throughput; throughput optimizations are a known deferred concern | ⚠️ Revisit if bottleneck |
| Verification (pre-merge) = an agent review | Not tests, not type-check; docs must state this explicitly | — Pending |
| Merge-train re-entry cap (configurable, default 10) before parking feature in inbox | Prevents silent infinite fail-retry loops | — Pending |
| Seamless auto-resume on orchestrator crash | High-bar UX; specs already scope the contract | — Pending |
| Planner prompts persist as per-feature audit log | Preserves user intent without creating a goal state machine | — Pending |
| Source-checkout distribution in v1 | Power-user audience; no packaging investment yet | — Pending |
| Config editable from a TUI menu | Nice UX; removes JSON-editing friction for the one product surface users touch daily | — Pending |
| Existing partial implementation is reference, not baseline | User explicitly allows rewrite; clarity > preservation | — Pending |
| Primary v1 focus is clarity (flow / state / coordination docs + TUI) — not new capability | Pain is opacity, not missing features; cleanup first, scale later | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-23 after initialization*
