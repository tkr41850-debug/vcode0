# Phase 5: Feature Lifecycle & Feature-Level Planner — Research

**Researched:** 2026-04-24
**Domain:** Orchestrator feature-phase wiring, pi-sdk Agent integration (planner/verify), repair loop, commit-trailer gate
**Confidence:** HIGH (codebase citations, no external dependencies)

## Summary

Phase 5 wires the existing `AgentRuntime.planFeature` and `AgentRuntime.verifyFeature` paths into a production-quality end-to-end slice. All major building blocks already exist on main: proposal tools and verify tools (typebox), the dispatch router, the FeatureLifecycleCoordinator, repair-task enqueue with cap/replan escalation, and the `commit_done` → `commit_trailer_missing` event trail. The work of Phase 5 is **not building new agents**; it is **closing five specific gaps** in how existing pieces connect.

The highest-impact gaps are (1) `verifying → replanning` today bypasses the `executing_repair` loop entirely (contradicts SC4 and CONTEXT § D), (2) `enqueueRepairTask` accepts one summary but verify produces a `VerifyIssue[]` that needs one-task-per-issue fan-out, (3) no gate today rejects `task_complete` when no trailer-OK `commit_done` has been observed (SC5 hole), (4) the verify prompt renderer does not thread a "Changed Files" block, and (5) `getChangedFiles` today unions `task.result.filesChanged` — not a true git diff. The FSM guard layer is **already complete** for all needed transitions; no new guards are required.

**Primary recommendation:** Plan work as four focused tracks matching CONTEXT "Expected Plans" (05-01 through 05-04). Do not introduce new agent classes, new tools, or new FSM phases. Extend the orchestrator layer (repair fan-out + commit gate) and harden the agent-side prompt/tool threading.

## User Constraints (from CONTEXT.md)

### Locked Decisions (§ A–M)
- **A. Planner agent:** Reuse existing `AgentRuntime.planFeature()` with existing `plan` prompt + proposal tools. No new agent class.
- **B. Verify vs ci_check:** Keep both. `ci_check` is a fast shell gate, `verify` is the pi-sdk agent review per REQ-MERGE-04.
- **C. Verify input surface:** feature description, success criteria, plan summary, execution evidence (task summaries), ci_check summary, changed-files list (`git diff --name-only` against base). May call read-side tools before `submitVerify`.
- **D. Repair creation:** Orchestrator converts each `raiseIssue(blocking|concern)` into ONE repair task. `nit` does not create tasks. Mapping: `description` = issue text (+ location + suggestedFix), `weight` = `'small'`, `reservedWritePaths` = `[location]` if location is a file, `repairSource` = `'verify'`.
- **E. Hallucinated-progress gate:** Worker `task_complete` only accepted when ≥1 `commit_done` with `trailerOk === true` has been seen for that `agentRunId`. Otherwise: `task_completion_rejected_no_commit` event, task → `failed`, feeds retry policy.
- **F. Repair cap:** Keep existing `MAX_REPAIR_ATTEMPTS` (1). On cap hit: `executing_repair` → `replanning` (already wired).
- **G. Empty diff:** Verify agent still runs. Prompt receives `No changes on feature branch vs base.`; agent instructed to emit `repair_needed`. No orchestrator short-circuit.
- **H. Planner tools:** `editTask({patch:{weight}})` satisfies "reweight". No new tool.
- **I. Planner scope:** Feature-local only. No cross-feature task visibility.
- **J. Tests:** Faux-backed E2E at `test/integration/feature-lifecycle-e2e.test.ts` + unit tests for raiseIssue mapping, commit gate, repair cap, empty-diff path.
- **K. ci_check config:** Default `verification.feature.checks = []` (permissive). Unchanged.
- **L. Verify model:** `roles.verifier` from config via `AgentRuntime.createAgent`.
- **M. Acceptance test scope:** Assert agent ran + produced right shape (recorded submitVerify toolCall + `VerificationSummary` in `AgentRun.payloadJson`). Not LLM-quality.

### Claude's Discretion
- Internal helper shape for raiseIssue → repair-task mapping (pure function location and signature).
- How to read back the trailer-OK commit record (new Store method vs in-memory event scan vs existing `lastCommitSha` side channel).
- Whether to thread "Changed Files" as a dedicated labeled block in `renderPrompt` or as part of "Execution Evidence".

### Deferred Ideas (OUT OF SCOPE)
- Merge-train semantics (Phase 6).
- Top-level feature planner (Phase 7).
- Inbox UX surface (Phase 7).
- TUI wiring (Phase 8).
- Crash-recovery UX and resume semantics (Phase 9).
- Replan continue-vs-fresh picker (Phase 10).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-PLAN-02 | Feature-level planner emits a task DAG via typed pi-sdk tool calls (addTask, addDependency, editTask[weight], submit). | `AgentRuntime.planFeature` at `src/agents/runtime.ts:94` already runs pi-sdk Agent with `proposalToolParameters`. Proposal application already rejects cycles via `applyGraphProposal` (`src/orchestrator/proposals/index.ts`). Gap: end-to-end faux-backed assertion and edge-case hardening (duplicate addTask, cycle rejection visible via `skipped[]`). |
| REQ-MERGE-04 (initial) | Verify phase runs a real pi-sdk Agent that reviews feature branch diff vs goal and produces a VerificationSummary. | `AgentRuntime.verifyFeature` at `src/agents/runtime.ts:101` + `runVerifyPhase` at line 225 already wired. `submitVerify` and `raiseIssue` tools exist. Gap: verify prompt does not thread "Changed Files"; `getChangedFiles` is not git-backed; `verifying` completion skips `executing_repair`. |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Plan-phase LLM call + tool dispatch | Agent (`src/agents/runtime.ts` → pi-sdk Agent) | — | pi-sdk owns the agent loop; proposal tools are typebox-defined. |
| Task DAG mutation (addTask/addDependency/etc.) | Orchestrator proposal apply (`src/orchestrator/proposals/index.ts`) | — | Planner emits proposals; orchestrator validates + applies inside scheduler event queue. Planner is read-only w.r.t. graph. |
| Verify-phase LLM call + tool dispatch | Agent (`src/agents/runtime.ts` → pi-sdk Agent) | — | Same pi-sdk host; verify tools defined in `feature-phase-host.ts`. |
| raiseIssue → repair task mapping | Orchestrator (`OrchestratorFeatures`) | — | Verify agent is read-only w.r.t. graph per § D; orchestrator owns all graph mutations. |
| FSM phase transitions (planning→executing→ci_check→verifying→…) | Core FSM (`src/core/fsm/index.ts`) | Coordinator (`src/orchestrator/features/index.ts`) | Guards live in core; coordinator drives transitions. Phase 5 requires no new guards. |
| Commit-trailer gate on task_complete | Runtime (`LocalWorkerPool.onTaskComplete` + scheduler event handler) | Orchestrator (records outcome) | Trailer check is a runtime-layer acceptance rule; orchestrator records the resulting task state transition + event. |
| Task spawn / worker lifecycle | Runtime (`LocalWorkerPool`) | — | Already shipped in Phase 3/4. Phase 5 consumes it unchanged. |
| `git diff` for changed files | Runtime (new helper in `feature-phase-host` or a GitService) | — | Host-side filesystem op; must not block scheduler tick. Currently non-git-backed. |
| VerificationSummary persistence | Persistence (`sqlite-store` via `persistPhaseOutputToFeature`) | Agent runtime | Already wired at `src/agents/runtime.ts:425-460`. |

## Standard Stack

No new dependencies. All required libraries already present.

### Core (existing, reused by Phase 5)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@mariozechner/pi-agent-core` | pinned in `package.json` | Agent loop, tool dispatch, fauxModel | Single agent runtime per project thesis |
| `@sinclair/typebox` | pinned | Tool parameter schemas | All existing tools (`proposalToolParameters`, `featurePhaseToolParameters`) already typebox-based per § H |
| `better-sqlite3` | pinned | Persistence of AgentRun, events, graph | Phase 2 store |
| `vitest` | pinned | Unit + integration tests | Project-standard test runner |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Reuse `AgentRuntime.planFeature` | New `FeaturePlannerAgent` class | Violates § A (decision: reuse). Adds boundary with zero benefit. |
| Extend `enqueueRepairTask` signature to accept `VerifyIssue[]` | New `enqueueVerifyRepairBatch(featureId, issues[])` wrapper | Wrapper is cleaner: keeps existing signature stable, co-locates severity filter + location→path mapping. Recommended. |
| New `trailerOk` column on `agent_runs` | Scan events for commit_done / commit_trailer_missing per agentRunId | New column is O(1) lookup and matches existing `lastCommitSha` write path at `src/persistence/sqlite-store.ts:196`. Recommended. |

## Architecture Patterns

### System Architecture Diagram

```
                                     ┌─────────────────────────────────┐
                                     │    Scheduler (serial queue)     │
                                     │ src/orchestrator/scheduler/     │
                                     │       events.ts:171+406         │
                                     └──────────────┬──────────────────┘
                                                    │
           ┌────────────────────────────┬───────────┼──────────────────┬────────────────────────────┐
           ▼                            ▼           ▼                  ▼                            ▼
┌──────────────────────┐  ┌──────────────────────┐ ┌──────────────────────┐  ┌───────────────────────────────┐
│ dispatchFeaturePhase │  │ feature_phase_complete│ │ worker_message       │  │ task_completion_rejected_     │
│ Unit (plan/ci_check/ │  │   handler (events.ts:│ │   (commit_done,      │  │   no_commit  [NEW EVENT]       │
│ verify/summarize)    │  │   406-450)            │ │    task_complete)   │  │                                │
│ dispatch.ts:237-365  │  └──────────┬───────────┘ │   events.ts:171-280  │  │ Emitted when task_complete     │
└──────────┬───────────┘             │             └──────────┬───────────┘  │ arrives without trailer-OK     │
           │                         │                        │              │ commit_done for agentRunId.    │
           ▼                         ▼                        ▼              └──────────────┬────────────────┘
┌──────────────────────┐  ┌──────────────────────────────────────┐                          │
│ AgentRuntime         │  │ OrchestratorFeatures.completePhase() │ ◀────────────────────────┘
│ .planFeature         │  │ features/index.ts:99-153             │    (treated as retry-eligible
│ .verifyFeature       │  │                                       │    semantic failure → RetryPolicy)
│ runtime.ts:94,101    │  │  ┌─── verify outcome=repair_needed ──┤
└──────────┬───────────┘  │  │    GAP: today goes to replanning; │
           │              │  │    MUST route via enqueue-repair. │
           │              │  └───→ enqueueRepairTask(...)        │
           │              │        features/index.ts:200-237     │
           ▼              │        - one task per VerifyIssue    │
┌──────────────────────┐  │        - severity∈{blocking,concern} │
│ Proposal apply       │  │        - source='verify'             │
│ (plan)               │  │        - cap hit → replanning        │
│ proposals/index.ts   │  └───────────────────────────────────────┘
└──────────────────────┘
```

### Component Responsibilities
| Component | Path | Responsibility |
|-----------|------|----------------|
| `AgentRuntime.planFeature` | `src/agents/runtime.ts:94` | Run pi-sdk Agent with plan prompt + proposal tools |
| `AgentRuntime.verifyFeature` | `src/agents/runtime.ts:101` | Run pi-sdk Agent with verify prompt + verify tools |
| `renderPrompt` | `src/agents/runtime.ts:271-324` | Thread successCriteria, planSummary, executionEvidence, verificationResults |
| `persistPhaseOutputToFeature` | `src/agents/runtime.ts:425-460` | Persist VerifyIssue[] + outcome via `mutateFeature` → scheduler event queue |
| `proposalToolParameters` / `featurePhaseToolParameters` | `src/agents/tools/schemas.ts:1-189` | Typebox schemas for all phase tools |
| `getChangedFiles` host impl | `src/agents/tools/feature-phase-host.ts:97-111` | Aggregates `task.result.filesChanged` (GAP: not git-backed) |
| `submitVerify` / `raiseIssue` host impls | `src/agents/tools/feature-phase-host.ts:152-220` | Collect verdict + issues; auto-downgrade ok=false when blocking/concern present |
| `dispatchFeaturePhaseUnit` | `src/orchestrator/scheduler/dispatch.ts:237-365` | Route plan → `planFeature`, ci_check → shell, verify → `verifyFeature`, summarize → `summarizeFeature` |
| `FeatureLifecycleCoordinator.completePhase` | `src/orchestrator/features/index.ts:99-153` | Happy-path transitions + verify failure handling (GAP: direct to replanning) |
| `FeatureLifecycleCoordinator.enqueueRepairTask` | `src/orchestrator/features/index.ts:200-237` | One repair task + cap detection + replan escalation |
| `validateFeatureWorkTransition` | `src/core/fsm/index.ts:180-293` | FSM guard — all Phase-5 transitions already valid |
| `LocalWorkerPool` | `src/runtime/worker-pool.ts` | Process-per-task spawn, `handleErrorFrame`, `onTaskComplete` |
| `RetryPolicy.decideRetry` | `src/runtime/retry-policy.ts` | retry vs escalate_inbox classification |
| `commit_done` handler | `src/orchestrator/scheduler/events.ts:266-280` | Records `setLastCommitSha`; emits `commit_trailer_missing` when `trailerOk === false` |

### Pattern: Faux-Backed E2E
Precedent: `test/integration/worker-retry-commit.test.ts` (real-git-repo + LocalWorkerPool + InProcessHarness + faux provider). Use this pattern for `test/integration/feature-lifecycle-e2e.test.ts`.

Precedent for phase-agent-only assertions (no worker pool): `test/integration/feature-phase-agent-flow.test.ts` (1008 lines, 8 tests). The existing `verify-repair-needed` case at lines 642-697 currently asserts **the old behavior** — `expect(...filter(t => t.repairSource === 'verify')).toHaveLength(0)` — and **must be updated** in Phase 5 to assert the new executing_repair + repair-task path.

### Anti-Patterns to Avoid
- **Putting graph mutations in the verify agent.** Verify is read-only per § D. Any raiseIssue → task conversion must be orchestrator-side.
- **Short-circuiting empty diff.** § G forbids it — the agent must run and record a verdict.
- **New FSM phase for repair.** `executing_repair` already exists; all needed transitions pass `validateFeatureWorkTransition` today. Adding new guards is scope creep.
- **Treating `last_commit_sha` as the trailer-OK signal.** It is set for both `trailerOk=true` and `trailerOk=false` commits in the current code path — it is a last-seen-SHA marker, not a trailer-gate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tool parameter schemas | JSON Schema by hand | `@sinclair/typebox` via existing `proposalToolParameters` / `featurePhaseToolParameters` | § H locked choice; consistent with existing tool surface |
| pi-sdk Agent loop | Custom message loop | `AgentRuntime.createAgent` wrapper | § A locked; single agent runtime thesis |
| Retry classification | Custom error regex | Existing `RetryPolicy.decideRetry` (`src/runtime/retry-policy.ts`) | Already distinguishes transient vs semantic |
| Tool call recording | Manual extraction | `persistPhaseOutputToFeature` already persists `VerificationSummary` in `AgentRun.payloadJson` | Phase-5 downstream (Phase 9 crash recovery) relies on this path per cross-phase note |
| Cycle rejection in planner proposals | Validator in planner agent | `GraphValidationError` already caught by `applyGraphProposal` with per-op `skipped[]` reason | Structural rejection already in orchestrator; planner test asserts `skipped[]` |
| FSM guard for verifying→replanning or executing_repair→ci_check | New guard case | `validateFeatureWorkTransition` at `src/core/fsm/index.ts:251-284` already covers all paths | Verified by inspection — no gap |

**Key insight:** The feature-lifecycle infrastructure is largely built. Phase 5's burden is **threading** (connect verify issues to repair-task creation, connect commit_done/trailerOk to task acceptance), **prompt hardening** (Changed Files block), and **testing** (faux-backed E2E).

## Per-Criterion Gap Analysis

### SC1 — Feature-level planner emits task DAG via typed tool calls
**Status:** Path exists end-to-end. Needs hardening.
**Existing surface:**
- `AgentRuntime.planFeature` — `src/agents/runtime.ts:94`
- `runProposalPhase('plan', ...)` — runs pi-sdk Agent with `PLAN_PROMPT`
- Proposal tools — `src/agents/tools/schemas.ts` (addTask, removeTask, editTask, addDependency, removeDependency, submit)
- `applyGraphProposal` with per-op `skipped[]` on `GraphValidationError` — `src/orchestrator/proposals/index.ts`
- Dispatch wiring — `src/orchestrator/scheduler/dispatch.ts:289`

**Gaps:**
- (SC1-G1) No E2E test that exercises planner → proposal apply → graph mutation with a scripted faux transcript.
- (SC1-G2) No explicit test that duplicate `addTask` with same alias collapses, nor that a cycle-creating `addDependency` lands in `skipped[]` with a visible reason.
- (SC1-G3) `editTask({patch:{weight}})` is untested against the feature planner flow. Needs at least one transcript step that reweights a task.

**Planner work (05-01):** Add faux-backed acceptance test + edge-case unit tests. No code changes expected to planner runtime.

### SC2 — FSM transitions planning → executing → ci_check → verifying → awaiting_merge
**Status:** Complete in FSM layer. Needs integration coverage.
**Existing surface:**
- `validateFeatureWorkTransition` — `src/core/fsm/index.ts:180-293` — covers all Phase-5 paths (happy-path + repair + replan + cap-escalation).
- PHASE_ORDER constant + REPAIRABLE_PHASES constant already declared.
- `FeatureLifecycleCoordinator.completePhase` — `src/orchestrator/features/index.ts:99-153` — drives transitions via `markPhaseDone` + `advancePhase`.

**Gaps:**
- (SC2-G1) No end-to-end integration test that walks the full phase order with a real LocalWorkerPool.
- (SC2-G2) Boundary assertions missing: `verifying → awaiting_merge` requires `collabControl === 'branch_open'` (see `completePhase:138-143`). No test asserts the collabControl side-effect explicitly.

**Planner work (05-02):** Add `test/integration/feature-lifecycle-e2e.test.ts` with the full walk. Precedent: `worker-retry-commit.test.ts`.

### SC3 — Verify phase runs real pi-sdk agent review against diff
**Status:** Agent plumbing exists. Prompt and tools incomplete for diff surface.
**Existing surface:**
- `AgentRuntime.verifyFeature` — `src/agents/runtime.ts:101`
- `runVerifyPhase` at line 225; throws if `!wasVerifySubmitted` (enforces § M contract).
- `VERIFY_PROMPT` — `src/agents/prompts/verify.ts` (77 lines).
- `renderPrompt` threads successCriteria, planSummary, executionEvidence, verificationResults, priorDecisions — `src/agents/runtime.ts:271-324`.
- `submitVerify`, `raiseIssue`, `getChangedFiles` tools — `src/agents/tools/feature-phase-host.ts:97-220`.
- Verify tool schemas — `src/agents/tools/schemas.ts:166` (getChangedFiles), `submitVerify`, `raiseIssue`.

**Gaps:**
- (SC3-G1) `renderPrompt` does **not** currently thread a labeled "Changed Files" block. Verify prompt § C mandates the changed-files list as anchor.
- (SC3-G2) `getChangedFiles` at `feature-phase-host.ts:97-111` aggregates `task.result.filesChanged` — this is **not** a `git diff --name-only feature-base...HEAD` as § C implies. Two choices:
  - (a) Make it git-backed (read via a new `GitService.diffNames(featureId)` host helper).
  - (b) Keep task-result-union + add a separate git-diff read path that verify may call.
  Default recommendation: (a), minimum surface, matches § C wording. See Open Question O1.
- (SC3-G3) No test asserts `submitVerify` missing → `runVerifyPhase` throw behavior. The guard exists but is uncovered.
- (SC3-G4) Empty-diff path (§ G) has no test. `renderPrompt` has no branch for "no files changed".
- (SC3-G5) `VerificationSummary` persistence to `AgentRun.payloadJson` is wired but lacks a round-trip assertion.

**Planner work (05-03):** Thread "Changed Files" in `renderPrompt`, replace/augment `getChangedFiles` with git backing, add empty-diff branch, add missing-submit and persistence round-trip tests.

### SC4 — Executing_repair loop turns verify issues into repair tasks; verify re-runs after
**Status:** PRIMARY GAP. Current code routes `verifying → replanning` directly, skipping `executing_repair`.
**Current path (BROKEN for SC4):**
- `completePhase('verify', ...)` at `src/orchestrator/features/index.ts:124-136`: when `verification.ok === false`, calls `markPhaseFailed` + `advancePhase(..., 'replanning')`. No repair-task creation.
- This contradicts § D + SC4. Existing `enqueueRepairTask` at lines 200-237 is the correct entry point but only wired for `ci_check` failures (`failCiCheck` at line 196-198 is the sole caller).

**Existing surface for fix:**
- `enqueueRepairTask(featureId, 'verify', noun, summary?)` at lines 200-237 already supports `repairSource === 'verify'` and already handles the cap → replanning branch. It takes ONE summary.
- `VerifyIssue` shape — `src/core/types/verification.ts` — has `id, severity, description, location?, suggestedFix?`.
- `VerificationSummary.issues?: VerifyIssue[]` already populated by verify host before `completePhase` fires.

**Gaps:**
- (SC4-G1) `completePhase('verify')` needs to route `ok === false` through a new `enqueueVerifyRepairs(featureId, issues[])` helper that:
  - Filters to `severity ∈ {blocking, concern}` (drops `nit`).
  - Maps each issue to `{description, weight: 'small', reservedWritePaths?, repairSource: 'verify'}` per § D.
  - Calls `enqueueRepairTask` equivalent per issue.
  - Preserves cap logic (N issues still = 1 repair "attempt" OR N attempts — see Open Question O4).
- (SC4-G2) `reservedWritePaths` derivation from `location`: needs a small helper to detect file-path vs symbol (e.g., `location.includes('/')` or regex for `path:line`).
- (SC4-G3) No test asserts the full fail → repair tasks created → execute → re-enter ci_check → verifying → pass loop with a real LocalWorkerPool. Precedent: extend `feature-phase-agent-flow.test.ts::verify-repair-needed` (line 642-697) and add a new E2E that walks the repair cycle.
- (SC4-G4) The existing test at `feature-phase-agent-flow.test.ts:642-697` asserts `.filter(t => t.repairSource === 'verify').toHaveLength(0)` — this will **flip** in Phase 5; the test must be updated, not added to.
- (SC4-G5) `enqueueRepairTask` counts repair tasks via `countRepairTasks(featureId)` — already defined on the class; fan-out from verify needs to preserve semantics ("one verify verdict = one repair attempt, regardless of issue count").

**Planner work (05-04):** New `enqueueVerifyRepairs` wrapper, rewire `completePhase('verify')` to call it, update the stale assertion, add integration test.

### SC5 — Hallucinated-progress rejection
**Status:** PRIMARY GAP. No gate exists today.
**Existing surface:**
- `commit_done` IPC message carries `trailerOk: boolean`.
- Scheduler event handler at `src/orchestrator/scheduler/events.ts:266-280`: calls `setLastCommitSha` **unconditionally**, emits `commit_trailer_missing` event when `trailerOk === false`. Does **not** fail the task, does **not** track observed trailer-OK per run.
- `task_complete` handler at `events.ts:171-204`: marks task done when `completionKind === 'submitted'`. No cross-check against commit observations.
- `AgentRun` type — `src/core/types/runs.ts` — has **no** `lastCommitSha` or `trailerOk` field. The SQLite column at `src/persistence/sqlite-store.ts:196` (`UPDATE agent_runs SET last_commit_sha = ? WHERE id = ?`) is write-only through the existing port.
- `RetryPolicy.decideRetry` — `src/runtime/retry-policy.ts:1-126` — distinguishes transient retry vs semantic `escalate_inbox`. Semantic failures currently escalate to inbox; they do not loop via in-pool retry.

**Gaps:**
- (SC5-G1) No per-run record of "has a trailer-OK commit_done arrived for this agentRunId?" Options:
  - (a) Add `trailerObservedAt?: number` to `AgentRun` + Store read method (parallels existing `lastCommitSha` write path).
  - (b) Scan events for `commit_done` with `trailerOk=true` by `agentRunId` at task-complete time.
  - (a) is O(1) and matches the port shape; recommended.
- (SC5-G2) `task_complete` handler needs a pre-check: if `trailerObservedAt` unset, emit `task_completion_rejected_no_commit` event with `agentRunId, taskId, reason`, transition task `status → failed`, do not mark `completionKind='submitted'`.
- (SC5-G3) Failure classification: § E says "retry-eligible semantic failure (feeds the retry policy)". Current `RetryPolicy.decideRetry` semantic path is `escalate_inbox`, not in-pool retry. Open question O3: does Phase 5 add a new "hallucinated-progress" error class that the retry policy treats as retriable within attempt budget, or does it use existing `escalate_inbox` semantics (kicking to inbox immediately)?
- (SC5-G4) `commit_trailer_missing` event is emitted today but drives no state change. Phase 5 should fold its effect into the same gate (trailer-missing commit is symmetric to no-commit-at-all).

**Planner work (05-04, same plan as SC4):** Add `AgentRun.trailerObservedAt` + Store read; update `commit_done` handler to set it when `trailerOk=true`; gate `task_complete`; wire retry policy feed.

## Reusable Patterns / Tests to Extend

| Pattern | Location | Phase 5 use |
|---------|----------|------------|
| Faux-backed phase-agent test | `test/integration/feature-phase-agent-flow.test.ts` | Planner acceptance (05-01), verify hardening (05-03) |
| Faux-backed worker-pool test with real git worktree | `test/integration/worker-retry-commit.test.ts` | E2E lifecycle (05-02), repair-loop E2E (05-04) |
| InProcessHarness wrapping WorkerRuntime | `test/integration/harness/in-process-harness.ts` | Both 05-02 and 05-04 |
| `createFauxProvider` + `fauxAssistantMessage` + `fauxToolCall` scripting | `test/helpers/` and pi-sdk imports | All Phase-5 tests |
| Phase-4 scheduler E2E | `test/integration/scheduler-phase4-e2e.test.ts` | Reference for event-queue assertions on new `task_completion_rejected_no_commit` event |
| `enqueueRepairTask` + `failCiCheck` pattern | `src/orchestrator/features/index.ts:196-237` | Mirror shape for `enqueueVerifyRepairs` wrapper |

## Open Questions (for planner)

1. **O1 — `getChangedFiles` source:** Make it true git-backed (`git diff --name-only $base...HEAD` via a new host helper) or keep task-result-union + add a separate git-diff tool? CONTEXT § C says "from `git diff --name-only` against the feature's base `main`" which favors git-backed. Recommendation: git-backed replacement; delete the task-result-union behavior.
2. **O2 — Trailer observation storage:** Add `AgentRun.trailerObservedAt?: number` + Store read method, or scan event log by `agentRunId` at task_complete time? Recommendation: new field (O(1), matches existing `lastCommitSha` write-path; Phase 9 crash-recovery benefits from it being persisted).
3. **O3 — Hallucinated-progress retry classification:** Does `task_completion_rejected_no_commit` feed the existing `RetryPolicy` semantic path (`escalate_inbox`) or a new retry-eligible class? § E says "retry-eligible semantic failure". Recommendation: introduce a `no_commit` failure kind that the retry policy treats as `retry` up to attempt budget, then `escalate_inbox` — otherwise hallucinated-progress goes straight to inbox on first offense, which is harsh.
4. **O4 — Repair-attempt counting under N-issue fan-out:** When verify raises N blocking/concern issues, does that count as 1 repair attempt or N? Existing `countRepairTasks` counts tasks, not attempts. Recommendation: one-verify-verdict = one-repair-attempt regardless of issue count; add a separate "repair batch" marker or compare against `MAX_REPAIR_ATTEMPTS` on verify-verdict count, not task count, to avoid cap-shadowing.
5. **O5 — Verify prompt "Changed Files" threading:** Dedicated labeled block (e.g., `## Changed Files\n- path/a.ts\n- path/b.ts`) or append inside "Execution Evidence"? Recommendation: dedicated block, anchored by `renderPrompt` directly after the plan summary, so verify agent prompt sees: Success Criteria → Plan Summary → Execution Evidence → Changed Files → Verification Results → Prior Decisions.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — Phase 5 adds fields to `agent_runs` (`trailerObservedAt`) but no renames of existing keys. | Migration: add nullable column via existing migrations path. |
| Live service config | None. | — |
| OS-registered state | None. | — |
| Secrets/env vars | None. | — |
| Build artifacts | None. | — |

**Nothing found in most categories:** Phase 5 is purely code + schema. The only runtime-state concern is the new `trailerObservedAt` column (see O2) which needs a migration, not data backfill (old runs are complete and their gate is moot).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `git` CLI | `getChangedFiles` git-backed read (O1) | ✓ (assumed on dev machines; repo is git-backed) | — | — |
| Node >=24 | Base requirement | ✓ per `package.json` | — | — |
| `better-sqlite3` | `agent_runs` schema change | ✓ | pinned | — |

No external services. No new runtimes. Phase 5 is code-only aside from a schema additive migration.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `vitest.config.ts` |
| Quick run command | `npm run test:unit` |
| Full suite command | `npm run check` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-PLAN-02 | Planner emits task DAG via typed tools | integration | `npx vitest run test/integration/feature-phase-agent-flow.test.ts -t plan` | ✅ existing file; add new case |
| REQ-PLAN-02 | Duplicate addTask collapses; cycle lands in skipped[] | unit | `npx vitest run test/unit/orchestrator/proposals.test.ts` | ⚠️ confirm existence — Wave 0 if missing |
| REQ-MERGE-04 | Verify agent runs with rendered prompt + Changed Files | integration | `npx vitest run test/integration/feature-phase-agent-flow.test.ts -t verify` | ✅ existing; update |
| REQ-MERGE-04 | Empty-diff path forces repair_needed | integration | `npx vitest run test/integration/feature-phase-agent-flow.test.ts -t "empty diff"` | ❌ Wave 0 |
| REQ-MERGE-04 | `submitVerify` missing → runVerifyPhase throws | unit | `npx vitest run test/unit/agents/runtime.test.ts` | ⚠️ confirm; Wave 0 if missing |
| REQ-MERGE-04 / SC4 | raiseIssue (blocking, concern) → repair task; nit → no task | unit | `npx vitest run test/unit/orchestrator/features.test.ts` | ⚠️ Wave 0 likely |
| SC4 | Verify fail → executing_repair → repair task exec → verifying pass | integration | `npx vitest run test/integration/feature-lifecycle-e2e.test.ts` | ❌ Wave 0 |
| SC4 | Repair cap hit → replanning | unit | `npx vitest run test/unit/orchestrator/features.test.ts` | ⚠️ may exist for ci_check; extend for verify |
| SC5 | `task_complete` without trailer-OK commit_done → failed | unit | `npx vitest run test/unit/orchestrator/scheduler-events.test.ts` | ⚠️ Wave 0 likely |
| SC5 | `task_completion_rejected_no_commit` event emitted + retry feed | integration | `npx vitest run test/integration/worker-retry-commit.test.ts -t no-commit` | ❌ Wave 0 (extend existing file) |

### Sampling Rate
- **Per task commit:** `npm run test:unit`
- **Per wave merge:** `npm run test`
- **Phase gate:** `npm run check` green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `test/integration/feature-lifecycle-e2e.test.ts` — net-new E2E for SC2 + SC4 walk
- [ ] `test/unit/orchestrator/verify-repairs.test.ts` — new helper for raiseIssue→repair-task mapping
- [ ] `test/unit/orchestrator/commit-gate.test.ts` — SC5 unit-level gate
- [ ] Extend `test/integration/feature-phase-agent-flow.test.ts` with empty-diff + updated repair-needed assertion
- [ ] Extend `test/integration/worker-retry-commit.test.ts` with `no-commit` failure scenario

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — (single-user local orchestrator) |
| V5 Input Validation | yes | Typebox tool schemas (already in place); no new user-input surfaces |
| V6 Cryptography | no | — |

**Phase-5-specific threats:**

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Agent hallucinates task completion without commit | Tampering (agent produces false state) | SC5 gate — trailer-OK commit required before `task_complete` accepted |
| Verify agent emits graph-mutating tool calls | Elevation of privilege (verify is read-only) | § D — verify toolset excludes graph mutators; typebox schemas enforce tool shape |
| Repair-task fan-out exceeds cap | DoS (infinite repair loop) | `MAX_REPAIR_ATTEMPTS` + `countRepairTasks` already enforces cap → replanning |
| Proposal cycle from planner | Tampering | `applyGraphProposal` catches `GraphValidationError` per op into `skipped[]` |

## Cross-Phase Coordination Notes

- **Phase 6 (merge-train):** Will re-use `AgentRuntime.verifyFeature` at merge-train integration entry per ROADMAP REQ-MERGE-04. Do **not** bake feature-scope assumptions into the verify prompt, the `getChangedFiles` helper, or the `submitVerify` contract. Specifically: the changed-files source (O1) should accept a base-ref parameter, not hard-code "feature branch vs main".
- **Phase 7 (top-level planner):** Will invoke `replanFeature` when Phase 5's repair cap escalates to `replanning`. The replan-input context should include the verify issues that triggered the escalation (O4-adjacent). Leave a breadcrumb: when `enqueueVerifyRepairs` hits cap, stash the `VerifyIssue[]` on the feature record for later replan consumption (new field or serialized summary — decision deferred to Phase 7).
- **Phase 9 (crash recovery):** Depends on `AgentRun.payloadJson` + `messagesSessionId` being populated after each phase run. Already wired via `persistPhaseOutputToFeature` at `src/agents/runtime.ts:425-460`. The new `trailerObservedAt` field (O2) similarly helps Phase 9 — on crash mid-task, resume logic can tell "did this task's worker already produce a trailer-OK commit?" in O(1).
- **Phase 10 (continue-vs-fresh picker):** The `enqueueRepairTask` repair-count semantics decided here (O4) become the default for the picker's "carry repairs forward" vs "drop to fresh plan" decision. Keep cap semantics loose enough to override.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `RetryPolicy.decideRetry` semantic path currently goes `escalate_inbox`, not in-pool retry [VERIFIED: `src/runtime/retry-policy.ts:1-126` read] | SC5-G3 | Low — verified by file read |
| A2 | `AgentRun` type has no `lastCommitSha` or trailer field [VERIFIED: `src/core/types/runs.ts` read] | SC5-G1 | Low — verified by file read |
| A3 | `countRepairTasks` counts tasks with `repairSource !== undefined`, not attempts [ASSUMED] | O4 | Medium — if counter is attempt-based, N-issue fan-out doesn't break the cap; planner should verify exact semantics in `src/orchestrator/features/index.ts` |
| A4 | `commit_trailer_missing` event is emitted but does not cause task failure today [VERIFIED: `src/orchestrator/scheduler/events.ts:266-280` read] | SC5-G4 | Low — verified |
| A5 | `applyGraphProposal` pushes cycle-creating ops to `skipped[]` with `GraphValidationError` reason [ASSUMED based on summary] | SC1-G2 | Low — the planner should re-verify via `grep skipped` in `src/orchestrator/proposals/index.ts`; test assertion depends on exact shape |
| A6 | `feature-phase-agent-flow.test.ts::verify-repair-needed` currently asserts zero verify-source repair tasks [VERIFIED: lines 642-697 read in prior session] | SC4-G4 | Low — verified; this test flips in Phase 5 |

## Sources

### Primary (HIGH confidence)
- `src/agents/runtime.ts` (full read) — `planFeature`, `verifyFeature`, `runVerifyPhase`, `renderPrompt`, `persistPhaseOutputToFeature`
- `src/agents/tools/schemas.ts` (full read) — proposal and verify tool shapes
- `src/agents/tools/feature-phase-host.ts` (full read) — host impls for `getChangedFiles`, `submitVerify`, `raiseIssue`
- `src/orchestrator/features/index.ts` (full read) — `completePhase`, `enqueueRepairTask`, `failCiCheck`
- `src/orchestrator/scheduler/events.ts` (full read) — `commit_done` handler, `feature_phase_complete` handler
- `src/orchestrator/scheduler/dispatch.ts` (full read) — `dispatchFeaturePhaseUnit`
- `src/core/fsm/index.ts` (full read) — `validateFeatureWorkTransition`, PHASE_ORDER, REPAIRABLE_PHASES, MAX_REPAIR_ATTEMPTS
- `src/core/types/verification.ts` (read) — `VerificationSummary`, `VerifyIssue`
- `src/core/types/runs.ts` (read) — `AgentRun` shape
- `src/persistence/sqlite-store.ts` (targeted read at `setLastCommitSha`) — `last_commit_sha` column
- `src/runtime/retry-policy.ts` (full read) — `decideRetry`
- `src/runtime/worker-pool.ts` (full read) — `LocalWorkerPool.handleErrorFrame`, `onTaskComplete`
- `test/integration/feature-phase-agent-flow.test.ts` (full read, 1008 lines) — existing test assertions including stale `verify-repair-needed`
- `test/integration/worker-retry-commit.test.ts` (full read) — faux-backed pool+git pattern
- `test/integration/scheduler-phase4-e2e.test.ts` (full read) — scheduler event assertion pattern
- `.planning/phases/05-feature-lifecycle/05-CONTEXT.md` — locked decisions

### Secondary (MEDIUM)
- `.planning/ROADMAP.md` § Phase 5 — Success Criteria source of truth

### Tertiary (LOW / ASSUMED)
- Exact shape of `countRepairTasks` and `applyGraphProposal.skipped[]` (see A3, A5). Planner should cite these directly when writing PLAN.md.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all existing libs verified in-tree
- Architecture (FSM, dispatch, proposals): HIGH — full-file reads of all referenced paths
- Repair fan-out gap (SC4): HIGH — verified `completePhase('verify')` routes direct to replanning at lines 124-136
- Commit gate gap (SC5): HIGH — verified `commit_done` handler does not gate `task_complete`; `AgentRun` has no trailer field
- Tests: HIGH — precedent tests read in full
- Open questions O1-O5: MEDIUM — framed from verified code state, but answers depend on planner judgment
- Assumption A3 (countRepairTasks semantics): needs planner re-verification

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (30 days; codebase is active but Phase-5-relevant files are stable on main)
