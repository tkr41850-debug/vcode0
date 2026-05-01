---
phase: 06-merge-train
plan: 02
subsystem: scheduler-integration

tags:
  - integration-runner
  - rebase
  - verification
  - merge-train
  - scheduler
requires:
  - 06-01 (cap-aware integration failure handling)
provides:
  - `runIntegrationIfPending(...)` production runner for strict-main integration
  - scheduler tick wiring for rebase → verify → merge-or-fail execution
  - explicit failure routing for blocked worktree, rebase conflict, shell verify failure, agent review failure, and fast-forward merge failure
  - dedicated unit coverage for the runner plus scheduler-level happy-path acceptance
affects:
  - 06-03 (primary integration failures now originate from a real runner, so secondary-release logic can be proven end-to-end)
tech-stack:
  added: []
  patterns:
    - "Keep merge-train execution in a dedicated scheduler module rather than inflating `SchedulerLoop.tick()` with git/verification details"
    - "Inject `cwd` into git-backed scheduler helpers so tests can run against temp repos instead of relying on process-global working directory"
key-files:
  created:
    - src/orchestrator/scheduler/integration-runner.ts
    - test/unit/orchestrator/integration-runner.test.ts
  modified:
    - src/orchestrator/scheduler/index.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/integration/merge-train.test.ts
decisions:
  - "Merge-train agent review uses transient run context `{ agentRunId: \`run-integration:${feature.id}\` }` rather than creating a persisted feature-phase `AgentRun` row. This avoids collision with `run-feature:${id}:verify` while keeping the scheduler-side protocol small."
  - "The production tick order is now `reconcilePostMerge -> beginNextIntegration -> runPendingIntegration -> overlap coordination -> warnings -> dispatch`, so integration work executes as part of the same serial scheduler turn."
  - "Runner-specific module mocking lives in `test/unit/orchestrator/integration-runner.test.ts` so `simple-git` / `rebaseGitDir` hoisting does not contaminate the broader scheduler-loop suite."
metrics:
  completed: 2026-04-25
---

# Phase 6 Plan 02: Integration Runner Summary

Phase 6 now has the missing producer side of the merge train: the scheduler can find the currently integrating feature, rebase it onto `main`, run shell and agent verification, fast-forward merge it on success, and emit failure events on any broken step before `main` advances.

## What landed

### 1. `runIntegrationIfPending(...)`

`src/orchestrator/scheduler/integration-runner.ts` is the new production runner for strict-main integration.

It performs this sequence:

1. find the feature whose `collabControl === 'integrating'`
2. derive the feature worktree via `worktreePath(feature.featureBranch)`
3. `rebaseGitDir(featureDir, 'main')`
4. `ports.verification.verifyFeature(feature)`
5. `ports.agents.verifyFeature(feature, { agentRunId: \`run-integration:${feature.id}\` })`
6. `simpleGit(cwd).merge([feature.featureBranch, '--ff-only'])`
7. emit `feature_integration_complete`

Any failure before step 6 emits `feature_integration_failed` with a specific error string and returns without advancing `main`.

### 2. Explicit failure handling for every integration break

The runner now distinguishes the major failure modes Phase 6 needed to surface:

- missing feature worktree (`rebaseGitDir -> { kind: 'blocked' }`)
- rebase conflict (with conflicted file list in the error)
- shell verification failure
- agent review failure
- fast-forward merge failure

All of these route through the same scheduler event surface, which means 06-01's re-entry counting and cap enforcement automatically apply to every ejection.

### 3. Scheduler tick wiring

`src/orchestrator/scheduler/index.ts` now calls `await this.runPendingIntegration(now)` immediately after `this.features.beginNextIntegration()`.

That change closes the gap that previously existed in production: the system already knew how to consume `feature_integration_complete` / `feature_integration_failed`, but nothing emitted them. Phase 6 now includes the missing executor.

## Non-obvious decisions

### Dedicated runner unit test file

The runner uses module-level mocks for `rebaseGitDir` and `simple-git`. Those mocks would have been noisy and fragile inside the already-large `test/unit/orchestrator/scheduler-loop.test.ts`, so the implementation split them into `test/unit/orchestrator/integration-runner.test.ts` and left the scheduler-loop suite focused on scheduler semantics.

### `run-integration:` agent-run prefix

The merge-train agent review is intentionally distinct from feature-phase verify runs. Using `run-integration:${featureId}` prevents collision with `run-feature:${id}:verify` and makes it obvious in logs/tests which verify path is under test.

### `cwd` injection for testability

The runner accepts optional `cwd` so tests can point both worktree resolution and `simpleGit(...)` at a temp repo. The happy-path test explicitly proves `simpleGit` is called with the injected root instead of implicit `process.cwd()` state.

## Validation evidence

Coverage for the runner is explicit and complementary:

- `test/unit/orchestrator/integration-runner.test.ts`
  - no integrating feature -> no-op
  - blocked worktree -> `feature_integration_failed`
  - rebase conflict -> `feature_integration_failed`
  - shell verify failure -> `feature_integration_failed`
  - agent verify failure -> `feature_integration_failed`
  - clean path -> `feature_integration_complete`
- `test/integration/merge-train.test.ts`
  - scheduler integration happy path proves the feature reaches `collabControl='merged'`
  - verifies shell verify, agent verify, and fast-forward merge are all invoked in the happy path
- `test/unit/orchestrator/scheduler-loop.test.ts`
  - preserved the pre-runner state assertions through `NoRunnerSchedulerLoop`, so scheduler-transition tests remain stable while the new runner executes immediately in production ticks

This runner also held under later branch-level `npm run check` verification.

## Current state after this plan

- merge-train integration is no longer a missing production step
- `main` only advances after rebase + shell verify + agent review + fast-forward merge
- all failure cases emit the same scheduler event type and therefore reuse the same downstream repair/cap path
- strict-main behavior is now executable instead of only modeled in event consumers

## Commits

None yet. The implementation is present in the working tree and validated there.
