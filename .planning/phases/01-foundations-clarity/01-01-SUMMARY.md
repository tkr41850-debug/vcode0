---
phase: 01-foundations-clarity
plan: 01
subsystem: core
tags: [fsm, graph, naming, warnings, invariants, unit-tests]
requires: []
provides:
  - compositeGuard over (work × collab × run)
  - WorkControl / CollabControl / RunState axis types
  - validateRunStateTransition axis validator
  - typed-ID constructors (makeMilestoneId / makeFeatureId / makeTaskId)
  - typed-ID predicates (isMilestoneId / isFeatureId / isTaskId)
  - GraphInvariantViolation + per-invariant assert* validators
  - pure warning rules with @warns JSDoc
  - exhaustive core unit-test baseline (test/unit/core/**)
affects:
  - src/core/fsm/index.ts
  - src/core/naming/index.ts
  - src/core/graph/validation.ts
  - src/core/warnings/index.ts
tech-stack:
  added: []
  patterns:
    - branded-template-literal IDs with constructor + predicate pairs
    - named internal rule functions behind a single composite guard
    - pure warning rules (nowMs injected as parameter)
key-files:
  created:
    - test/unit/core/fsm/work-control-axis.test.ts
    - test/unit/core/fsm/collab-control-axis.test.ts
    - test/unit/core/fsm/run-state-axis.test.ts
    - test/unit/core/fsm/composite-invariants.test.ts
    - test/unit/core/naming/typed-ids.test.ts
    - test/unit/core/graph/invariants.test.ts
    - test/unit/core/warnings/rule-shapes.test.ts
  modified:
    - src/core/fsm/index.ts
    - src/core/naming/index.ts
    - src/core/graph/validation.ts
    - src/core/warnings/index.ts
decisions:
  - compositeGuard checks *static* state legality; per-axis guards check transitions
  - RunState is the AgentRunStatus type (manual ownership lives on RunOwner, not the status axis)
  - 'replanning' WorkControl value omitted from the composite matrix (reachable only via repair-escalation; covered in work-control axis test)
metrics:
  tasks_complete: 7
  commits: 6
  test_cases_added: 553
  total_core_tests: 904
  completed_date: 2026-04-23
---

# Phase 01 Plan 01: Foundations Clarity — `src/core` Audit Summary

Audited and tightened `src/core/{fsm,graph,naming,warnings}` so the module is
the authoritative contract layer for later phases, and backed the audit with
553 new unit tests (including the 420-case exhaustive composite-invariants
matrix). All 904 `test/unit/core/**` tests pass and all 7 plan tasks are
complete.

## Tasks

### Task 1 — Audit `src/core/fsm/` and extract composite guard

- Verified the three per-axis guards
  (`validateFeatureWorkTransition`, `validateFeatureCollabTransition`,
  `validateFeatureStatusTransition`) and their task-scoped equivalents.
- Added `WorkControl`, `CollabControl`, `RunState` type aliases and the
  `CompositeState` / `CompositeGuardResult` types.
- Implemented `compositeGuard` as an ordered pipeline of nine named internal
  rules, each documented with a JSDoc block. Rules: work_complete requires
  merged; awaiting_merge collab constraint; active-work-requires-branch;
  cancelled-collab-freezes-work; merge_queued forbids await_response /
  await_approval; pre-branch phases require collab=none/cancelled;
  wait run states require active work; terminal run states forbidden at
  work_complete.
- No existing exports were removed.
- Commit: `afc2a11`

### Task 2 — Tighten typed-ID helpers in `src/core/naming/`

- Added `makeMilestoneId` / `makeFeatureId` / `makeTaskId` constructors,
  `isMilestoneId` / `isFeatureId` / `isTaskId` predicates, and the shared
  `asBrandedId<Prefix>` utility. Branded-ness is enforced structurally
  because `MilestoneId`, `FeatureId`, `TaskId` are template-literal types
  (`` `m-${string}` `` etc.) — compile-time cross-prefix assignment is
  already rejected by TypeScript.
- Existing exports (`featureBranchName`, `taskBranchName`, `worktreePath`,
  `resolveTaskWorktreeBranch`) preserved.
- Commit: `4726703`

### Task 3 — Audit graph invariant enforcement in `src/core/graph/validation.ts`

- Added the `GraphInvariantViolation` error class and eight targeted
  validators: `assertNoCycles`, `assertFeatureDepsAreFeatureOnly`,
  `assertTaskDepsAreSameFeature`, `assertTypedIdNamespaces`,
  `assertOneMilestonePerFeature`, `assertChildOwnedOrder`,
  `assertReferentialIntegrity`, `assertStatusConsistency`.
- Added `assertAllInvariants` orchestrator that invokes each validator in a
  fixed order matching the constructor's existing `validateInvariants` call.
- Pre-existing `validateInvariants` kept in place for backwards compatibility
  with `InMemoryFeatureGraph`'s snapshot loader.
- Commit: `ad6f859`

### Task 4 — Confirm warnings are pure functions in `src/core/warnings/`

- Refactored `createEmptyVerificationChecksWarning` and
  `createVerifyReplanLoopWarning` to accept `nowMs: number` as a required
  parameter (no implicit `Date.now()`).
- Added `@warns` JSDoc tags to `WarningEvaluator.evaluateBudget`,
  `evaluateFeature`, `evaluateTask`, and the two factory functions.
- Verified `src/core/warnings/index.ts` imports only from `@core/*` and
  `@root/config` — no runtime / persistence / tui / orchestrator edges.
- Commit: `0320a9f`

### Task 5 — Per-axis FSM tests (work, collab, run)

- `work-control-axis.test.ts` (28 cases) — full happy path, repair branch,
  replan branch, budget-mode short-circuit, illegal skips, no-op rejection,
  conflict blocking, collab-prerequisite checks.
- `collab-control-axis.test.ts` (31 cases) — happy path, conflict edges,
  cancellation edges, repair-ejection, terminal-outbound illegals.
- `run-state-axis.test.ts` (43 cases) — happy path, wait-overlay
  enter/exit, cancellations, illegal jumps, no-op rejection.
- Commits: `2289ddb` (work + collab), `e6c5419` (run-state).

### Task 6 — Composite-invariants test + typed-IDs test

- `composite-invariants.test.ts` (430 cases total) — 420 exhaustive
  (10 × 7 × 6) matrix cases over `compositeGuard`, with expected legality
  mirrored from the guard's nine rules, plus 10 spot-check cases verifying
  each rule fires its intended reason.
- `typed-ids.test.ts` (11 cases) — constructor outputs, predicate narrowing,
  wrong-prefix rejection, and three `// @ts-expect-error` blocks proving
  compile-time cross-prefix assignment is impossible.
- Commit: `e6c5419`

### Task 7 — Graph-invariants + warnings-shape tests

- `invariants.test.ts` (27 cases) — one-pass + one-or-more-fail cases for
  each of the 8 validators, plus a `GraphInvariantViolation` identity test.
  The helper `buildValidGraph` constructs a minimal milestone + 2 features
  + 2 tasks graph and tests poke the Maps directly to hit the target
  invariant without going through mutation helpers.
- `rule-shapes.test.ts` (13 cases) — public-export surface, quiescence on
  empty input, determinism across repeated calls, parameter-driven time,
  and structural source-file checks (no `Date.now()` inside rule bodies,
  no imports from `@runtime/@persistence/@tui/@orchestrator`, `@warns`
  count >= rule count).
- Commit: `e6c5419`

## Commits (applied on top of `3c87739`)

| SHA        | Subject                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `afc2a11`  | feat(01-01): add compositeGuard + WorkControl/CollabControl/RunState type aliases to src/core/fsm/ |
| `4726703`  | feat(01-01): add typed-ID constructors, predicates, and asBrandedId utility to src/core/naming/  |
| `ad6f859`  | feat(01-01): add GraphInvariantViolation + per-invariant assert* validators to graph/validation.ts |
| `0320a9f`  | refactor(01-01): make warning functions pure — require nowMs param, add @warns JSDoc            |
| `2289ddb`  | feat(01-01): add run-state axis validator + work-control & collab-control axis tests             |
| `e6c5419`  | test(01-01): add exhaustive core unit-test baseline (fsm × naming × graph × warnings)            |

## Verification

- `npx vitest run test/unit/core/` — 14 files, 904 tests pass.
- `npx biome check test/unit/core/` — clean.
- `npx eslint test/unit/core/**/*.test.ts` — clean.
- `npx tsc --noEmit | grep -E "(test/unit/core|src/core)"` — zero errors in
  scoped paths.

`npm run check` does not complete cleanly at the repo root because of
pre-existing typecheck errors in `src/persistence/*` (missing
`@types/better-sqlite3`) and `test/integration/tui/*` (missing
`@microsoft/tui-test`). These issues predate this plan (confirmed by
stashing my changes and re-running typecheck against `3c87739`) and are
explicitly out of scope for plan 01-01, which is scoped to `src/core/**`
and `test/unit/core/**`.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 — Blocking issue] Pre-existing typecheck failures outside scope**
- **Found during:** Task 1 verification step (`npx tsc --noEmit`).
- **Issue:** The repo does not typecheck cleanly at HEAD of `3c87739`
  because of missing type packages in `src/persistence/*` and
  `test/integration/tui/*`.
- **Fix:** None in this plan — filed to `deferred-items.md` and gated by
  the scope boundary rule. Validated the pre-existing state by stashing
  plan changes and re-running typecheck.
- **Impact on plan:** None; `src/core/**` is type-clean and all core unit
  tests pass.

### Other notes

- **RunState includes `completed`/`failed`/`cancelled` terminals, but the
  exhaustive matrix only enumerates 6 non-terminal run values.** The terminal
  values are exercised by the per-axis test (`run-state-axis.test.ts`). The
  composite rule "Rule 9: run=failed/cancelled illegal at work_complete" is
  spot-checked but does not contribute to the 420-case count.
- **`WorkControl` includes `replanning`, which was omitted from the composite
  matrix.** `replanning` is reachable only through repair-escalation
  transitions and is covered by `work-control-axis.test.ts`. Flagged for
  plan 01-03 to decide whether the canonical (work × collab × run) matrix in
  `docs/foundations/state-axes.md` should include `replanning` as a first-class
  enumerated state or keep it as a transient exception.
- **`makeMilestoneId` et al. rely on TypeScript template-literal types, not a
  `__brand` intersection.** Semantics are equivalent (cross-prefix assignment
  is a compile error) and match the existing `workflow.ts` declarations; no
  change required.

## Flags for Plan 01-03 (canonical docs)

- Canonical (work × collab × run) valid-combination matrix: produce the
  ground-truth enumeration in `docs/foundations/state-axes.md` and cross-link
  back to `test/unit/core/fsm/composite-invariants.test.ts` so drift between
  the two is flagged by CI.
- Decide whether `replanning` is a matrix-first-class WorkControl value or a
  transient repair-escalation state; update
  `test/unit/core/fsm/composite-invariants.test.ts` accordingly.
- `ARCHITECTURE.md §Lifecycle Snapshot` agrees with the FSM exports; no
  disagreements found.

## Self-Check

- [x] All 7 plan tasks complete and committed.
- [x] 904 core unit tests pass.
- [x] Composite-invariants test produces >=420 cases (actual: 420 + 10
      spot-checks = 430).
- [x] Typed-ID test contains `// @ts-expect-error` compile-time assertions
      (3 instances).
- [x] No `src/core/**/*.ts` imports from `@runtime/*`, `@persistence/*`,
      `@tui/*`, or `@orchestrator/*` (enforced structurally by
      `rule-shapes.test.ts`).
- [x] No pre-existing exports removed from
      `src/core/{fsm,naming,graph/validation}.ts`.

## Self-Check: PASSED
