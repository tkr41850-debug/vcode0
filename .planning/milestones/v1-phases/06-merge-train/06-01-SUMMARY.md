---
phase: 06-merge-train
plan: 01
subsystem: merge-train

tags:
  - merge-train
  - reentry-cap
  - inbox
  - diagnostics
  - scheduler
requires:
  - 05-04 (repair-task fan-out and commit-backed verification contracts already landed)
provides:
  - cap-aware `MergeTrainCoordinator` enqueue/eject semantics
  - runtime wiring from `ports.config.reentryCap` into `FeatureLifecycleCoordinator`
  - `failIntegration(...)` parking path with `merge_train_cap_reached` inbox items and `merge_train_feature_parked` events
  - unit, scheduler, and integration coverage for cap parking and no re-enqueue behavior
affects:
  - 06-02 (all integration failures now flow through the cap-aware lifecycle path)
  - 06-03 (secondary-release logic must still run when the primary hits the cap)
tech-stack:
  added: []
  patterns:
    - "Thread runtime config into lifecycle coordinators at `SchedulerLoop` construction time rather than reading config ad hoc at failure sites"
    - "Persist operator-facing diagnostics in inbox payloads/events (`reentryCount`, `cap`, `reason`) instead of only warning logs"
key-files:
  created: []
  modified:
    - src/core/merge-train/index.ts
    - src/orchestrator/features/index.ts
    - src/orchestrator/scheduler/index.ts
    - test/unit/core/merge-train.test.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/integration/merge-train.test.ts
decisions:
  - "Cap enforcement on integration failure lives in `FeatureLifecycleCoordinator.failIntegration(...)`, not `MergeTrainCoordinator.ejectFromQueue(...)`, because the failing feature is in `collabControl='integrating'` and the literal `integrating -> branch_open` edge is illegal in the current FSM. The implementation therefore keeps a single inline increment-and-park path."
  - "Features already at or above cap are rejected by `enqueueFeatureMerge(...)` so restart/re-drive paths cannot silently put capped work back into the queue."
  - "Inbox parking uses `kind: 'merge_train_cap_reached'` with `{ reentryCount, cap, reason? }` payload so Phase 7 inbox UI can render actionable diagnostics without reconstructing state from logs."
metrics:
  completed: 2026-04-25
---

# Phase 6 Plan 01: Re-entry Cap Enforcement Summary

Phase 6's hard backstop is now real: repeated merge-train ejections increment `mergeTrainReentryCount`, the configured cap is enforced in runtime behavior, and capped features are parked for manual intervention instead of cycling forever.

## What landed

### 1. Cap-aware merge-train coordinator

`src/core/merge-train/index.ts` now makes the queue itself cap-aware:

- `MergeTrainCoordinator` accepts optional `reentryCap?: number`
- `enqueueFeatureMerge(...)` throws `GraphValidationError` when a feature is already at or above the cap
- `ejectFromQueue(...)` now returns `'ejected' | 'cap_reached'`

The queue ordering logic itself is unchanged: `mergeTrainManualPosition` still wins first, then re-entry count, then entry sequence.

### 2. Runtime wiring from config into lifecycle handling

`src/orchestrator/scheduler/index.ts` now constructs `FeatureLifecycleCoordinator` with `ports.config.reentryCap`, making the already-parsed config field active in production behavior instead of dead configuration.

### 3. Integration-failure parking path

`src/orchestrator/features/index.ts` now turns a capped integration failure into a parked feature instead of a new repair task.

On a capped failure:

- the feature transitions to `collabControl='conflict'`
- queue-local fields are cleared
- `mergeTrainReentryCount` is incremented exactly once
- `ports.store.appendInboxItem(...)` records `kind: 'merge_train_cap_reached'`
- `ports.store.appendEvent(...)` records `eventType: 'merge_train_feature_parked'`
- no integration repair task is created

Below cap, the previous behavior remains intact: the feature receives an integration repair task and continues through the normal repair loop.

## Why the implementation differs from the initial plan

The original plan assumed `failIntegration(...)` could delegate directly to `MergeTrainCoordinator.ejectFromQueue(...)`. In the live FSM, that is not legal for the failing state:

- `ejectFromQueue(...)` performs `merge_queued -> branch_open`
- integration failures occur from `collabControl='integrating'`
- the literal `integrating -> branch_open` edge is not allowed

The implementation therefore keeps the failure-path mutation inline in `FeatureLifecycleCoordinator.failIntegration(...)` and only reuses `MergeTrainCoordinator` for cap configuration and queue-entry guards. This preserves the intended semantics without introducing an invalid FSM edge or double-incrementing the re-entry counter.

## Validation evidence

Coverage for the cap path is explicit at three layers:

- `test/unit/core/merge-train.test.ts`
  - cap-aware `ejectFromQueue(...)` results
  - enqueue rejection at or above cap
  - uncapped behavior preserved
- `test/unit/orchestrator/scheduler-loop.test.ts`
  - parked feature receives inbox item and no repair task
- `test/integration/merge-train.test.ts`
  - scheduler integration path proves a feature at cap is parked and not re-enqueued

This work also held under the later phase-closeout full branch verification.

## Current state after this plan

- `reentryCap` is now enforced at runtime
- capped features are surfaced in inbox state with durable diagnostics
- below-cap failures still create integration repair work
- queue re-entry is blocked once the cap has been reached

## Commits

None yet. The implementation is present in the working tree and validated there.
