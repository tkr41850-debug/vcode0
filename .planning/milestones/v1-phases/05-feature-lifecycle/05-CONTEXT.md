# Phase 5: Feature Lifecycle & Feature-Level Planner — CONTEXT

## Source
- Phase definition: `ROADMAP.md` § Phase 5
- Requirements: `REQ-PLAN-02`, `REQ-MERGE-04` (initial implementation)
- Depends on: Phase 4 (scheduler tick + event queue — shipped)

## Goal (verbatim)
A single feature goes plan → execute → verify → merge-ready end-to-end: feature-level planner produces a task DAG, tasks execute, verify phase runs a real agent review, repair loop handles failures.

## Success Criteria (from ROADMAP)
1. Feature-level planner agent takes a feature + context and emits a task DAG via typed pi-sdk tool calls (createTask, addDependency, reweight).
2. Feature lifecycle transitions through planning → executing → ci_check → verifying → awaiting_merge, validated by FSM guards.
3. Verify phase runs a real pi-sdk agent review (not a stub) against the feature branch diff, returning pass or issues.
4. Executing_repair loop turns verify issues into repair tasks; once they land, verify re-runs.
5. Agent "hallucinates progress" case is rejected: task completion without a matching trailer-tagged commit fails.

## Locked Decisions (from prior phases / PROJECT.md)
- **FSM**: phase order `discussing → researching → planning → executing → ci_check → verifying → awaiting_merge → summarizing → work_complete` is locked. Repair re-enters through `ci_check`, not `verifying`. Repair counter capped by `MAX_REPAIR_ATTEMPTS`.
- **Agent layer**: `AgentRuntime` (`src/agents/runtime.ts`) is the one path that runs pi-sdk Agents for feature phases. All phase-runners go through it.
- **Task DAG tools** already exist (typebox): `addTask`, `removeTask`, `editTask`, `addDependency`, `removeDependency`, `submit` — see `src/agents/tools/schemas.ts`.
- **Verify tools** already exist: `submitVerify` (outcome=pass|repair_needed), `raiseIssue` (severity=blocking|concern|nit).
- **Verify prompt** already exists at `src/agents/prompts/verify.ts`.
- **Dispatch wiring** already routes `plan` → `agents.planFeature`, `ci_check` → `verification.verifyFeature` (shell), `verify` → `agents.verifyFeature` (pi-sdk Agent), `summarize` → `agents.summarizeFeature` in `src/orchestrator/scheduler/dispatch.ts:270-352`.
- **Repair enqueue**: `OrchestratorFeatures.enqueueRepairTask(featureId, source, noun, summary)` already exists with `repairSource` field — takes ONE summary; this phase must extend to multiple issues.
- **Commit trailer** path already exists: `commit_done` messages carry `trailerOk: boolean`, the orchestrator appends `commit_trailer_missing` events when the trailer is missing. This phase must fail the task (not just log).

## Gray Areas — Auto-Answered (skip_discuss=true)

### A. Planner agent: new agent or reuse existing `planFeature`?
**Decision**: **Reuse.** `AgentRuntime.planFeature()` already runs pi-sdk Agent with `plan` prompt + proposal tools (`addTask` / `addDependency` / `editTask` / `removeTask` / `submit`). No new agent class; harden + test the existing path.
**Why**: Meets REQ-PLAN-02 surface with zero new agents. Existing code is already threaded through dispatch.

### B. Verify agent: replace shell-based `ci_check`, or run both?
**Decision**: **Keep both.** `ci_check` stays a fast shell gate (type/lint/test — configurable checks). `verify` is the pi-sdk agent review of diff-vs-goal per REQ-MERGE-04. They are distinct phases in the FSM. Empty `ci_check` config remains permissive.
**Why**: REQ-MERGE-04 is specifically the agent review, not tests. Shell checks are useful fast-fail noise reduction before the agent spends tokens.

### C. Verify agent input surface
**Decision**: Verify agent receives: feature description, success criteria, plan summary, execution evidence (task summaries), verification-shell summary (from ci_check), changed-files list (from `git diff --name-only` against the feature's base `main`). It may call read-side tools (`getFeatureState`, `listFeatureTasks`, `getTaskResult`, `getChangedFiles`, `listFeatureEvents`) before calling `submitVerify`.
**Why**: Current `renderPrompt` already threads most of these in; `getChangedFiles` tool already exists. Diff context is the anchor per REQ-MERGE-04.

### D. Who creates repair tasks when verify fails?
**Decision**: **Orchestrator** converts each `raiseIssue(blocking|concern)` into ONE repair task on the feature. `nit` severity does not create tasks (non-blocking). Verify agent is read-only w.r.t. the graph — it only emits issues + verdict. Mapping:
- `description` = `${issue.description}${location ? ' @ ' + location : ''}${suggestedFix ? '\n\nSuggested: ' + suggestedFix : ''}`
- `weight` = `'small'` (default; agent can still reserve paths on repair tasks)
- `reservedWritePaths` = `[location]` if the location is a file path, else unset
- `repairSource` = `'verify'`
**Why**: Keeps verify agent's contract narrow (review only). Orchestrator owns graph mutations (reinforces Phase 4 single-event-queue invariant). One-repair-per-issue gives clean atomic repair tasks.

### E. Hallucinated-progress rejection — where is the gate?
**Decision**: Gate task completion in the worker message handler. A worker's `task_complete` is only accepted when the orchestrator has seen ≥1 `commit_done` for that `agentRunId` with `trailerOk === true`. If `task_complete` arrives without such a commit, the orchestrator transitions the task to `status=failed` with a dedicated event (`task_completion_rejected_no_commit`) and treats it as a retry-eligible semantic failure (feeds the retry policy). If `trailerOk === false` (trailer missing), the existing `commit_trailer_missing` event also triggers failure.
**Why**: Closes SC5 cleanly. The orchestrator already tracks `lastCommitSha` per run — this adds the inverse check. Retry-policy already distinguishes semantic vs transient (Phase 3 landed `RetryPolicy`).

### F. Repair attempts cap + escalation
**Decision**: Keep existing `MAX_REPAIR_ATTEMPTS` (currently 1). On cap hit: `executing_repair` → `replanning` (already wired in `OrchestratorFeatures.enqueueRepairTask`). No changes to the cap value in Phase 5; configurable override deferred to Phase 7 config editor.
**Why**: Existing logic already enforces cap; Phase 5 adds no new semantics, only makes the path survive real agent traffic.

### G. Verify on empty diff
**Decision**: If `git diff feature-base...HEAD` is empty (no changes on feature branch), verify agent receives `No changes on feature branch vs base.` in `Execution Evidence` and is instructed to submit `repair_needed`. The orchestrator does NOT short-circuit — the agent still runs so it records a verdict.
**Why**: Prevents silent "pass with no work done" bugs. Keeps the single verify path; no special-casing.

### H. Planner prompt tools — permit `reweight`?
**Decision**: The existing `editTask` tool accepts a `weight` patch. No separate `reweight` tool. ROADMAP's "reweight" reference is satisfied by `editTask({taskId, patch:{weight}})`.
**Why**: Avoid duplicate surface. Keep the planner toolset lean.

### I. Feature-dep awareness in planner
**Decision**: Feature-level planner receives the feature's description + objective + DoD + prior discuss/research summaries. It does NOT see other features' task lists (cross-feature isolation). Task-level `reservedWritePaths` remain the only path-level coordination.
**Why**: Feature-local scope is simpler and matches DAG-first thesis (features depend only on features, tasks only on sibling tasks).

### J. Tests — how to prove the end-to-end slice?
**Decision**: Integration test under `test/integration/feature-lifecycle-e2e.test.ts` using pi-sdk `fauxModel` with scripted `FauxResponse` sequences for:
- plan phase: planner emits 2 tasks + 1 dep + submit
- executing phase: LocalWorkerPool runs real workers on faux-executor transcripts; workers emit `claim_lock` + `commit_done` + `task_complete`
- ci_check: permissive (empty checks config)
- verify phase: verify agent runs `submitVerify(repair_needed)` with 1 raiseIssue, then on second run `submitVerify(pass)`
- repair loop: 1 repair task created, executed, re-entry into `ci_check` then `verifying`, pass on second run
- assert feature reaches `awaiting_merge` with `collabControl=branch_open`
Plus unit tests for:
- raiseIssue → repair-task mapping (pure helper)
- hallucinated-progress gate (task_complete without matching commit → failed)
- FSM repair-counter cap → replan escalation
- verify-on-empty-diff path
**Why**: Faux-backed E2E is the project's established pattern. Unit tests anchor each new helper.

### K. CI check command config
**Decision**: Default `verification.feature.checks = []` (permissive). No-op returns ok. Configs may opt in. This matches current behavior.
**Why**: Phase 5 is NOT about defining shell-check policy. That's a user-config decision documented in Phase 8 config editor.

### L. Verify agent model role
**Decision**: Use `roles.verifier` model from config (already supported by `AgentRuntime.createAgent`). No new role key.
**Why**: Per-role model map already lives in the config schema from Phase 2.

### M. Scope of "real pi-sdk agent review" acceptance test
**Decision**: The agent must:
- load a prompt rendered by `verify.ts`
- call `getChangedFiles` or inspect tool output at least conceptually (faux transcript threads it)
- emit at least one `submitVerify` tool call with outcome
- produce a `VerificationSummary` stored in `AgentRun.payloadJson`
The acceptance test asserts the recorded verify run includes a submitVerify toolCall and a summary in store — not that the LLM reasoning is correct.
**Why**: Keeps the contract at "agent ran and produced the right shape", not LLM-quality assertion.

## Scope Fences
- **Out of scope**: merge-train semantics (Phase 6), top-level planner (Phase 7), inbox surface (Phase 7), TUI wiring (Phase 8), crash recovery UX (Phase 9), replan-continue-vs-fresh picker (Phase 10).
- **In scope**: feature-level planner wiring + verify-agent wiring + executing_repair loop with raiseIssue→repair-task mapping + hallucinated-progress gate + end-to-end faux-backed integration.

## Expected Plans (~4)
- **05-01**: Feature-level planner acceptance — FauxModel-backed test that `planFeature` emits a task DAG; harden planner tool surface (edge cases: duplicate addTask, cycle detection rejection); document planner prompt input contract.
- **05-02**: Feature-lifecycle FSM integration — E2E the phase-order happy path using LocalWorkerPool + faux planner/executor agents; stress FSM guards on boundary transitions (verifying→awaiting_merge requires branch_open; awaiting_merge→work_complete requires merged).
- **05-03**: Verify-agent hardening — wire `getChangedFiles` tool call path, empty-diff handling, `submitVerify` contract tests (pass / repair_needed / missing-submit error), verification summary persistence.
- **05-04**: Executing-repair loop + hallucinated-progress gate — orchestrator helper mapping `raiseIssue[]` → repair tasks (one per blocking/concern), task-completion-without-commit → failed transition, repair-cap → replan escalation assertion, E2E showing verify fail → repair → verify pass.

## Cross-Phase Notes
- Phase 6 (merge-train) re-uses the verify agent at merge-train entry (REQ-MERGE-04 integration). Do NOT bake feature-scope assumptions into verify prompt/tools.
- Phase 7 (top-level planner) invokes `replanFeature` on verify-cap escalation. FSM transition to `replanning` already lands in Phase 5 via `enqueueRepairTask` cap branch.
- Phase 9 (crash recovery) depends on `AgentRun` records being the resumable unit — Phase 5 must leave `AgentRun.payloadJson` + `messagesSessionId` populated after each phase run.

## Blockers / Concerns
- None new. `verification-service.ts` (shell path for ci_check) stays; Phase 5 does not touch it.
- Faux-backed E2E test may be slow if worker pool spawns real subprocesses — use `LocalWorkerPool` with in-process faux executor (already exists from Phase 3).
