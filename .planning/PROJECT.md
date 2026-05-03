# gvc0 — DAG-First Autonomous Agent Orchestrator

## What This Is

gvc0 is a local, single-user autonomous coding orchestrator built on pi-sdk (`@mariozechner/pi-agent-core`). A power user types a natural-language prompt, a planner agent drafts a DAG of features and tasks, and the system executes features in parallel — each task runs as its own pi-sdk `Agent` process in an isolated git worktree, squash-merging commits onto a long-lived feature branch that is serialized into `main` via a merge train. The user watches and steers the live DAG from a terminal UI.

## Core Value

**From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — while the user watches, edits, re-plans, and answers agent asks live in a single TUI.**

If everything else slips, this loop — prompt → live DAG → features merging cleanly to `main` — must feel coherent and trustworthy.

## Requirements

### Validated

- ✓ REQ-PLAN-01 through REQ-PLAN-07 — v1
- ✓ REQ-EXEC-01 through REQ-EXEC-06 — v1
- ✓ REQ-MERGE-01 through REQ-MERGE-04 — v1
- ✓ REQ-TUI-01 through REQ-TUI-06 — v1
- ✓ REQ-INBOX-01 through REQ-INBOX-04 — v1
- ✓ REQ-STATE-01 through REQ-STATE-04 — v1
- ✓ REQ-CONFIG-01 through REQ-CONFIG-03 — v1
- ✓ REQ-DOC-01 through REQ-DOC-03 — v1

### Active

Fresh active requirements for the next milestone should be defined with `/gsd-new-milestone`. v2 candidate requirements remain available in `.planning/REQUIREMENTS.md` until the next milestone chooses scope.

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


## Current State

**v1 shipped 2026-05-03.** The source-checkout product now delivers the core prompt-to-main loop: top-level prompt planning, feature/task DAG execution, worker/inbox handling, verify-agent review, strict-main merge train, TUI operator surfaces, source-install runbook, and audit-passed traceability. Active next-milestone requirements have not been selected yet.

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
| No persistent "goal" entity; prompts are ephemeral | Simpler state model; features + DAG are the persistent units. Prompts persist as per-feature audit log instead. | ✓ Good |
| Milestones are persistent groupings of features; multiple may overlap in execution | Milestones steer scheduler priority without gating execution; user can have parallel workstreams | ✓ Good |
| Two planners: top-level (features) + feature-level (tasks) | Strategic vs tactical separation; different prompts, different context | ✓ Good |
| Planner re-invocation is additive only | Avoids disturbing in-flight or completed work; predictable behavior | ✓ Good |
| Manual DAG edits always win over planner | User is the ultimate authority; planner adapts | ✓ Good |
| Top-level edit on an in-progress-planning feature aborts the feature-level planner (visible in proposal view) | Resolves the two-planner collision cleanly | — Pending |
| Inbox is the unified "things waiting on you" surface | One surface for agent asks, conflicts, approvals, auth, orphans, re-entry parkings — keeps TUI focused | ✓ Good |
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
| Source-checkout distribution in v1 | Power-user audience; no packaging investment yet | ✓ Good |
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
*Last updated: 2026-05-03 after v1 milestone archive-only completion*
