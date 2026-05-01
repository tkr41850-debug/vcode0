# Phase 1 — Scheduler hygiene unblock

## Goal

Stop the runaway re-dispatch loop that fires every scheduler tick when a feature-phase run lands in `runStatus='failed'`, and surface the failed state in the TUI so the operator can see it. This phase is independent of the project-planner architecture and ships first to give visibility during the rest of the track's work.

This is a TDD bug fix. Do not expand it into retry-policy redesign, planner-prompt work, or run-state schema changes.

## Scope

**In:** filter `runStatus='failed'` from feature-phase prioritization in `prioritizeReadyWork`; differentiate `failed` from `running`/`blocked` in `deriveFeatureBlocked` and `iconForFeature`; add a regression test that reproduces the loop and proves the filter holds.

**Out:** changing `decideRetry` classification semantics (non-transient errors continue to escalate to `failed`); changing the inbox escalation path; adding new run statuses; changing the `restartCount` bump semantics in pre-dispatch.

## Background

Verified gaps on `main`:

- `prioritizeReadyWork` (`src/core/scheduling/index.ts`) collects feature-phase units and skips runs with `runStatus === 'running'` or those flagged by `isBlockedByRun(...)`. The latter only blocks `await_response | await_approval | retry_await`. **`runStatus='failed'` is not filtered.** This filter site applies to **all** dispatchable feature phases (`discuss | research | plan | replan | ci_check | verify | summarize`), not just planner runs — Step 1.1 fixes the broad path. The production caller is `dispatchReadyWork()` in `src/orchestrator/scheduler/dispatch.ts`.
- `decideRetry` (`src/runtime/retry-policy.ts`) classifies non-transient errors (anything not matching `transientPatterns` — ECONN*, ETIMEDOUT, network, 429, 5xx, rate.limit) as `semantic_failure`. The error from a planner run that didn't call `submit` ("plan phase must call submit before completion") matches none of the transient patterns. The decision is `escalate_inbox: semantic_failure`.
- `feature_phase_error` handler in `src/orchestrator/scheduler/events.ts` writes an `inbox_items` row and sets `runStatus='failed'`.
- Pre-dispatch `restartCount` bump in `dispatchFeaturePhaseUnit` (`src/orchestrator/scheduler/dispatch.ts`) only fires on `runStatus === 'retry_await'`. A failed run is re-dispatched without bumping `restartCount`.
- Combined effect: every tick re-collects the same `failed` run as ready work, re-dispatches it, fails the same way, writes another inbox row, and increments nothing. The runaway is observable in `.gvc0/logs/` and inbox-row counts during reproduction; specific counts vary by reproduction.
- TUI's `deriveFeatureBlocked` (`src/tui/view-model/index.ts`) only flags `await_response | await_approval | retry_await`. `iconForFeature` does **not** derive `⟳` purely from `workControl='planning'`; it falls back to derived unit status, and several feature states render `in_progress`. The visibility bug is real, but the surface is the unit-status fallback, not a hardcoded planning icon. `buildMilestoneTree(...)` also calls `deriveFeatureBlocked(...)` for `displayStatus` and feature `meta.wait` — Step 1.2 must update both call sites, not just `deriveFeatureBlocked` in isolation.
- The TUI does **not** read `inbox_items` today. A static "see inbox" hint is straightforward; anything conditional on real inbox rows requires broader plumbing than Step 1.2's file list — defer the conditional version.

## Steps

Ships as **2 commits**, in order.

---

### Step 1.1 — Filter `failed` feature-phase runs from prioritization

**What:** extend the skip predicate in `prioritizeReadyWork` (`src/core/scheduling/index.ts`) so feature-phase units whose run is in `runStatus='failed'` are excluded. This stops the re-dispatch loop. The `inbox_items` row from the original failure is retained as the operator's signal; no new state is introduced.

**Files:**

- `src/core/scheduling/index.ts` — at the feature-phase collection site, add `run?.runStatus === 'failed'` to the skip condition. The fix applies uniformly to all seven feature-phase kinds.
- `test/unit/core/scheduling.test.ts` — add tests that construct features in each affected phase (sample at minimum: `plan`, `discuss`, `verify`) with a `failed` feature-phase run and assert `prioritizeReadyWork` does not include them.
- `test/unit/core/scheduling.test.ts` — add an explicit `runStatus === 'running'` skip-path test if not already present (verified gap: existing coverage hits `await_response | await_approval | retry_await` but not the `running` skip).
- `test/unit/orchestrator/scheduler-loop.test.ts` — add a regression that drives a feature-phase run to `failed` (semantic_failure path), then runs additional ticks and asserts no further `dispatchRun` calls for the same `(featureId, phase)` pair.

**Tests:**

- Direct prioritization unit test: feature with `workControl='planning'` and a feature-phase run in `runStatus='failed'` produces no `feature_phase` entry in the result. Same for at least one non-planner phase (e.g. `verify`).
- New `runStatus='running'` skip test fills the existing coverage gap.
- Loop regression: drive `feature_phase_error` once via a runtime that throws a non-transient error, then run 3 more scheduler ticks; assert exactly one dispatch happened, exactly one inbox row was written, and the run stays `failed`.
- Existing `runStatus='running'` and `isBlockedByRun` skip paths stay green.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the prioritization filter: (1) `src/core/scheduling/index.ts` skip predicate now excludes `runStatus='failed'` feature-phase runs; (2) the loop regression test fails on pre-fix code and passes on post-fix; (3) inbox-row count stays at one across multiple ticks; (4) no change to task-unit collection behavior. Under 250 words.

**Commit:** `fix(core/scheduling): skip failed feature-phase runs in prioritization`

---

### Step 1.2 — Surface `failed` feature-phase runs in TUI

**What:** extend `deriveFeatureBlocked` to flag `runStatus='failed'` for feature-phase runs and update the icon mapping so failed features render distinct from `⟳ planning`. Operator should see at a glance that the feature is stuck on a failed planner run, with an inbox-pointer hint.

**Files:**

- `src/tui/view-model/index.ts` — extend `deriveFeatureBlocked` to return a typed reason for `failed`; update **both** call sites of `deriveFeatureBlocked` in `buildMilestoneTree(...)` (`displayStatus` and feature `meta.wait`) so failed reason flows to both surfaces; extend `iconForFeature` to map failed feature-phase runs to a distinct symbol (e.g. `✕` or `!`); preserve current behavior for non-failed runs.
- `test/unit/tui/view-model.test.ts` — add coverage for failed-run rendering. Assert reason text mentions inbox via a static "see inbox" hint (no live inbox lookup — the TUI does not read `inbox_items` today, and Step 1.2 does not add that plumbing).
- `docs/reference/tui.md` — if the icon legend is documented, update it. (If not present, skip.)

**Tests:**

- Feature with planning workControl + failed feature-phase run renders with the failed icon and a blocked reason carrying the static "see inbox" hint. Both `displayStatus` and `meta.wait` reflect the failed reason.
- Feature with planning workControl + running feature-phase run keeps existing rendering (no change).
- Feature with `await_approval` keeps existing approval-pending rendering.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the TUI surface: (1) `deriveFeatureBlocked` returns a typed reason for `runStatus='failed'`; (2) `iconForFeature` distinguishes failed from running and from approval-pending; (3) running and approval-pending paths are unchanged; (4) docs/reference/tui.md (if present) is updated to match. Under 250 words.

**Commit:** `feat(tui): surface failed feature-phase runs distinct from blocked`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- Reproducing the original `/init` + `/auto` runaway no longer floods `.gvc0/logs/` with duplicate failures; the operator sees a single failed-run signal in the TUI with an inbox pointer.
- Run a final review subagent across both commits to confirm the filter is narrow, the TUI distinction is correct, and no test/doc drift remains.

## Notes

- **Scope boundary:** do not change the inbox writer in `feature_phase_error`; the dedup is achieved by stopping re-dispatch, not by deduping inbox rows.
- **Why this ships first:** Phase 8 (submit-compliance) addresses the underlying error that drives runs to `failed`. Without Phase 1 first, the rest of the track's interactive testing is hostile because every test failure repeats forever.
- **No new state.** The `failed` runStatus already exists in the lifecycle; this phase only changes who reads it.
