---
phase: 05
plan: 04
subsystem: feature-lifecycle
tags:
  - verify-repair
  - commit-gate
  - trailer-audit
  - retry-policy
  - persistence
requires:
  - 05-03 (git-backed verify diff, persisted verification summaries, verify contract tests)
provides:
  - verify-failure fan-out into `executing_repair` tasks instead of direct replanning
  - orchestrator-side submitted-completion gate keyed on trailer-valid commit observation
  - `AgentRun.trailerObservedAt` persistence with first-observation-wins semantics
  - end-to-end verify fail → repair → verify pass proof plus persistence/store coverage
affects:
  - 06 (merge-train can reuse `trailerObservedAt` for commit auditing and the same repair-task fan-out pattern for ejections)
  - 07 (replan/inbox flows inherit bounded `no_commit` escalation semantics)
tech-stack:
  added: []
  patterns:
    - "Verify verdicts mutate the graph only through orchestrator fan-out helpers; verify agents stay review-only"
    - "Submitted task completion is accepted only after a prior `commit_done(trailerOk:true)` observation for the same run"
    - "Audit timestamps on agent runs use first-write-wins SQL updates (`CASE WHEN trailer_observed_at IS NULL THEN ? ELSE trailer_observed_at END`)"
key-files:
  created:
    - src/persistence/migrations/0007_agent_runs_trailer_observed_at.sql
    - test/unit/orchestrator/verify-repairs.test.ts
    - test/unit/orchestrator/commit-gate.test.ts
  modified:
    - src/orchestrator/features/index.ts
    - src/orchestrator/scheduler/events.ts
    - src/core/types/runs.ts
    - src/orchestrator/ports/index.ts
    - src/persistence/sqlite-store.ts
    - src/persistence/codecs.ts
    - src/persistence/queries/index.ts
    - src/runtime/retry-policy.ts
    - test/integration/feature-phase-agent-flow.test.ts
    - test/integration/feature-lifecycle-e2e.test.ts
    - test/integration/worker-retry-commit.test.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/unit/persistence/migrations.test.ts
    - test/unit/persistence/sqlite-store.test.ts
key-decisions:
  - "Verify failures now route through `enqueueVerifyRepairs(...)`, not direct replanning, so SC4 is satisfied by real repair execution rather than an abstract replan handoff."
  - "`repair_needed` without actionable blocking/concern issues still synthesizes one fallback repair task from `failedChecks` / `repairFocus` / `summary`; a zero-task `executing_repair` feature would otherwise deadlock before ci_check re-entry."
  - "`no_commit` is handled directly in `scheduler/events.ts` with `decideRetry(...)` at the rejection site; first offense re-queues within budget, exhaustion escalates to inbox."
  - "`trailerObservedAt` is append-like audit state: only the first trailer-valid commit observation is persisted, later commits may update `lastCommitSha` but must not rewrite the first observation timestamp."
patterns-established:
  - "Scheduler acceptance tests that model submitted completions must seed `setTrailerObservedAt(...)` before a `result(completionKind='submitted')` frame when the run is expected to land successfully"
  - "Persistence verification for new agent-run audit columns should include both migration shape (`PRAGMA table_info`) and explicit store round-trip coverage"
requirements-completed: [REQ-MERGE-04]
duration: ~3h including verification/debug closeout
completed: 2026-04-25
---

# Phase 5 Plan 04: Verify-Repair Loop + Commit Gate Summary

**Verify failures now re-enter execution as concrete repair tasks, submitted task completions are commit-audited via trailer observation, and the full repair → re-verify loop is proven end-to-end.**

## Performance

- **Duration:** ~3h including validation/debug closeout
- **Started:** 2026-04-24T23:00:00Z (approx)
- **Completed:** 2026-04-25T04:08:40Z
- **Tasks:** 4 planned workstreams plus 4 closeout fixes
- **Files modified:** 15

## Accomplishments

- Rewired verify failure handling in `FeatureLifecycleCoordinator` so `repair_needed` verdicts create concrete `repairSource='verify'` tasks, preserve one-verdict/one-attempt semantics, and re-enter the lifecycle through `executing_repair` instead of jumping straight to `replanning`.
- Added `AgentRun.trailerObservedAt` end-to-end: type, port, codec, SQL migration, SQLite store setter/getter, and scheduler-side `commit_done(trailerOk:true)` observation recording with first-write-wins semantics.
- Hardened the scheduler result path so `completionKind='submitted'` is rejected unless a trailer-valid commit was previously observed for the same run; the rejection emits `task_completion_rejected_no_commit`, uses bounded retry semantics for `no_commit`, and escalates to inbox only after retry budget exhaustion.
- Closed the verification loop with unit, integration, E2E, migration, store, and full-branch checks, including the repair-loop E2E and stale scheduler-loop harness updates required by the new contract.

## Task Commits

No plan-specific commits yet. The implementation and verification are present in the working tree.

**Plan metadata:** None yet — this summary is written from the validated working tree state.

## Files Created/Modified

- `src/orchestrator/features/index.ts` — adds `enqueueVerifyRepairs(...)`, fallback repair-task synthesis, location→`reservedWritePaths` mapping, and the rewired `completePhase('verify')` path.
- `src/orchestrator/scheduler/events.ts` — records trailer observation on `commit_done`, rejects hallucinated submitted completions, appends `task_completion_rejected_no_commit`, and performs direct retry-policy routing at the rejection site.
- `src/runtime/retry-policy.ts` — treats `no_commit` as retryable within budget, then escalates once attempts are exhausted.
- `src/core/types/runs.ts` — adds `trailerObservedAt?: number` to `BaseAgentRun`.
- `src/orchestrator/ports/index.ts` — adds `setTrailerObservedAt(...)` and `getTrailerObservedAt(...)` to the store port.
- `src/persistence/migrations/0007_agent_runs_trailer_observed_at.sql` — additive nullable `trailer_observed_at` migration.
- `src/persistence/sqlite-store.ts` — implements prepared statements plus first-write-wins persistence/readback for `trailerObservedAt`.
- `src/persistence/codecs.ts` and `src/persistence/queries/index.ts` — add codec and row-shape support for `trailer_observed_at`.
- `test/unit/orchestrator/verify-repairs.test.ts` — pins severity filtering, fallback repair-task synthesis, location mapping, and cap semantics.
- `test/unit/orchestrator/commit-gate.test.ts` — pins no-commit rejection, trailer-valid acceptance, trailer-missing symmetry, and `no_commit` retry behavior.
- `test/integration/feature-phase-agent-flow.test.ts` — flips the stale verify-repair assertion to `executing_repair`, persists verify verdict payloads, and proves the task completion commit gate end-to-end.
- `test/integration/feature-lifecycle-e2e.test.ts` — adds the repair-loop E2E proving verify fail → repair task → ci_check re-entry → verify pass → awaiting_merge.
- `test/unit/persistence/migrations.test.ts` and `test/unit/persistence/sqlite-store.test.ts` — add explicit migration/store coverage for `trailerObservedAt`.
- `test/unit/orchestrator/scheduler-loop.test.ts` — updates the shared store mock and three stale acceptance-path tests to seed trailer observations before successful submitted completions.

## Decisions Made

1. **Fallback repair tasks are mandatory when verify requests repair but supplies no actionable issue list.** The implementation chose one synthesized task using the best available signal from `failedChecks`, `repairFocus`, or `summary`, because a zero-task `executing_repair` feature would never land work and therefore never re-enter `ci_check`.
2. **`no_commit` retry routing lives in the orchestrator, not the worker pool.** The rejection originates from scheduler-side corroboration failure, so the code calls `decideRetry(...)` directly in `events.ts` instead of trying to synthesize a fake worker error frame.
3. **Trailer observation is separate from last-commit tracking.** `lastCommitSha` can keep moving on later commits, but `trailerObservedAt` records the first proof that this run produced a trailer-valid commit.
4. **Scheduler-loop unit fixtures must model trailer observation explicitly.** Once the completion gate became real, synthetic `submitted` completions in tests had to seed `setTrailerObservedAt(...)` or they would correctly be rejected.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Contract correction] `no_commit` rejection is retry-first, not fail-first**
- **Found during:** Task 3 (scheduler gate + retry-policy wiring)
- **Issue:** The 05-04 plan text still described an immediate failed-task path, but the implemented system correctly treats `no_commit` as a bounded retryable semantic failure.
- **Fix:** Wired `scheduler/events.ts` to call `decideRetry(...)` directly. Within budget the task returns to `status='ready'` and the run moves to `runStatus='retry_await'`; only exhaustion marks the run failed and appends an inbox item.
- **Files modified:** `src/orchestrator/scheduler/events.ts`, `src/runtime/retry-policy.ts`, `test/unit/orchestrator/commit-gate.test.ts`
- **Verification:** Unit tests pin retry vs escalation; integration tests prove the first-offense retry behavior; full `npm run check` passes.
- **Committed in:** Not yet committed

**2. [Rule 1 - Deadlock prevention] `repair_needed` without actionable issues now synthesizes one fallback repair task**
- **Found during:** Task 1 (verify-repair helper design)
- **Issue:** The plan text left open a zero-task `executing_repair` lane, but that would never re-enter `ci_check` because no repair work could land.
- **Fix:** Added `describeFallbackVerifyRepair(...)` and always create one repair task when the filtered issue list is empty.
- **Files modified:** `src/orchestrator/features/index.ts`, `test/unit/orchestrator/verify-repairs.test.ts`, `test/integration/feature-lifecycle-e2e.test.ts`
- **Verification:** Nit-only / issue-less repair cases are pinned in unit and integration tests; the repair-loop E2E reaches `awaiting_merge`.
- **Committed in:** Not yet committed

**3. [Rule 3 - Blocking] Full-suite scheduler-loop tests were stale after the new commit gate landed**
- **Found during:** Phase-closeout full `npm run check`
- **Issue:** Three scheduler-loop acceptance-path tests still emitted synthetic submitted completions without any prior trailer observation, so they now failed under the correct contract.
- **Fix:** Updated the shared store mock to persist trailer observations and seeded `setTrailerObservedAt(...)` in the three stale acceptance-path tests.
- **Files modified:** `test/unit/orchestrator/scheduler-loop.test.ts`
- **Verification:** `test/unit/orchestrator/scheduler-loop.test.ts` passes again; branch-level `npm run check` is green.
- **Committed in:** Not yet committed

**4. [Rule 1 - Verification gap] Added explicit persistence tests for `trailerObservedAt`**
- **Found during:** Phase-closeout verification writing
- **Issue:** The migration/store wiring existed, but verification evidence was still indirect.
- **Fix:** Added `PRAGMA table_info('agent_runs')` coverage in migration tests and a store round-trip test that proves first-write-wins persistence.
- **Files modified:** `test/unit/persistence/migrations.test.ts`, `test/unit/persistence/sqlite-store.test.ts`
- **Verification:** Both tests pass; full `npm run check` remains green.
- **Committed in:** Not yet committed

---

**Total deviations:** 4 auto-fixed (3 Rule 1 corrections, 1 Rule 3 blocking follow-up)
**Impact on plan:** All deviations tightened the implementation to the actual correctness envelope. No scope creep; each fix was either necessary to prevent deadlock, align the retry contract with real code, or make full-suite verification honest.

## Issues Encountered

- The original repair-loop work exposed a verify rerun session bug: rerunning a completed verify phase reused stale session state. That was fixed by clearing completed-phase session state before rerun so the new repair-loop E2E could execute against a fresh verify session.
- Full branch verification surfaced stale scheduler-loop harness assumptions after the completion gate became real. The fix was to teach the mock store about trailer observations and seed successful submitted-completion paths explicitly.
- Phase-closeout verification initially relied on indirect persistence evidence; dedicated migration/store tests were added so the summary and verification report could cite explicit coverage for `trailerObservedAt`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 5 now satisfies all five roadmap success criteria across 05-01 through 05-04.
- Phase 6 can build directly on this work: `trailerObservedAt` is available for merge-train commit auditing, and the verify-repair fan-out path is reusable for merge-train ejection/repair flows.
- Branch verification is green (`npm run check` passes) with 10 non-fatal Biome warnings still reported by the current lint configuration.

---
*Phase: 05-feature-lifecycle*
*Completed: 2026-04-25*
