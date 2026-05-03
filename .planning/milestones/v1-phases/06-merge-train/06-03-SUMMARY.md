---
phase: 06-merge-train
plan: 03
subsystem: cross-feature-conflicts

tags:
  - cross-feature
  - merge-train
  - starvation
  - repair-loop
  - scheduler-events
requires:
  - 06-02 (real integration-runner failure/completion events)
provides:
  - symmetric `feature_integration_failed` release of blocked secondary features
  - scheduler and integration coverage proving secondaries are resumed or repaired, not stranded
  - cap-path acceptance proving primary parking does not suppress secondary release
  - concern-doc update aligning merge-train re-entry documentation with shipped behavior
affects:
  - Phase 7 inbox/UI work (merge-train parking and blocked-secondary outcomes are now durable, test-backed inputs)
tech-stack:
  added: []
  patterns:
    - "Keep success and failure release loops structurally identical when both paths reconcile the same cross-feature blockage state"
    - "Cross-feature integration coordination should resume secondaries on clean rebase and create integration repair tasks on conflict or missing-worktree paths; never leave `runtimeBlockedByFeatureId` stranded silently"
key-files:
  created: []
  modified:
    - src/orchestrator/scheduler/events.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/integration/merge-train.test.ts
    - docs/concerns/merge-train-reentry-cap.md
decisions:
  - "`feature_integration_failed` now mirrors `feature_integration_complete` by calling `conflicts.releaseCrossFeatureOverlap(...)` immediately after `features.failIntegration(...)`. The two release loops should stay intentionally identical."
  - "Secondary release still runs when the primary hits the re-entry cap. Parking the primary is not allowed to strand dependent work."
  - "Failure-path repair summaries reuse the same wording as the success path (`Rebase onto main conflicted in ...` / missing-worktree fallback) so downstream UI does not need separate copy branches for symmetric outcomes."
metrics:
  completed: 2026-04-25
---

# Phase 6 Plan 03: Failure-Path Cross-Feature Release Summary

Phase 6's final gap is closed: a primary integration failure no longer leaves blocked secondaries suspended forever. The failure path now releases blocked features through the same conflict-coordination protocol the success path already used.

## What landed

### 1. Symmetric release in `feature_integration_failed`

`src/orchestrator/scheduler/events.ts` now extends the `feature_integration_failed` handler to:

1. call `features.failIntegration(event.featureId, ports, event.error)`
2. call `await conflicts.releaseCrossFeatureOverlap(event.featureId)`
3. process each release result exactly like the success handler

That means secondaries now follow one of three explicit outcomes when the primary fails integration:

- **clean rebase** -> resumed work, blocked state cleared
- **rebase conflict** -> integration repair task created
- **missing worktree** -> integration repair task created

### 2. Stranded-secondary gap closed in tests

The new scheduler-loop coverage proves all key outcomes:

- blocked secondary resumes cleanly after primary failure
- blocked secondary with rebase conflict receives an integration repair task
- blocked secondary with missing worktree receives an integration repair task
- no blocked secondaries -> no spurious repair work

### 3. End-to-end acceptance for SC4 and cap interaction

`test/integration/merge-train.test.ts` now includes end-to-end acceptance proving:

- a blocked secondary is not silently stranded when the primary fails integration
- `main` does not advance on the failure path
- a primary hitting the re-entry cap still parks correctly
- the secondary still receives repair work even when the primary is parked

That last point matters operationally: parking the primary is a human-escalation path, not permission to leave unrelated blocked work hanging.

## Why this matters

Before this change, the merge-train loop had a subtle asymmetry:

- `feature_integration_complete` already released blocked secondaries
- `feature_integration_failed` did not

That meant the cross-feature overlap protocol was only half-implemented. In the unlucky case where the primary failed integration, secondary work could remain suspended with `runtimeBlockedByFeatureId` set and no follow-up event to reconcile it.

The system now behaves consistently on both primary outcomes.

## Validation evidence

Key evidence for the fix lives in:

- `src/orchestrator/scheduler/events.ts`
  - failure handler now includes the same release loop as the success handler
- `test/unit/orchestrator/scheduler-loop.test.ts`
  - resumed-secondary path
  - repair-needed-secondary path
  - blocked-secondary path
  - no-blocked-secondaries path
- `test/integration/merge-train.test.ts`
  - SC4 acceptance: primary failure -> secondary repair, `main` not advanced
  - SC2 acceptance: primary parked at cap while secondary still receives repair work

The phase-closeout branch verification also passed after this work.

## Documentation follow-up included

`docs/concerns/merge-train-reentry-cap.md` is part of the closeout for this plan. The file now reflects the shipped Phase 6 state consistently: infinite re-entry is no longer the concern; the residual concern is bounded churn up to the hard cap and whether earlier warning signals trip before that backstop.

## Current state after this plan

- blocked secondaries are resumed or repaired on both primary success and primary failure
- primary cap parking and secondary release now coexist correctly
- Phase 6's merge-train loop is symmetric enough to verify end-to-end without known starvation holes

## Commits

None yet. The implementation is present in the working tree and validated there.
