# Phase 11 Plan 11-02 Validation Contract

**Phase:** 11-documentation-diagnostic-tooling  
**Plan:** 11-02  
**Created:** 2026-05-02  
**Purpose:** Explicit validation contract for the doc-vs-code drift check, canonical state diagram update, and coordination/execution-flow documentation consolidation slice.

## Validation Architecture

11-02 is validated by adding a Vitest unit test under the existing test infrastructure rather than a separate docs runner.

| Layer | Artifact | Validation Role |
|-------|----------|-----------------|
| Wave 0 test scaffold | `test/unit/docs/drift.test.ts` | Creates executable doc-vs-code assertions that run through existing Vitest globs. |
| Canonical state docs | `docs/foundations/state-axes.md` | Must document shipped run statuses, checkpointed wait transitions, and 10 × 7 × 8 = 560 composite-domain count. |
| Canonical flow docs | `docs/foundations/execution-flow.md` | Must document the 11-01 read-only `gvc0 explain` branch before TUI/runtime startup. |
| Coordination docs | `docs/foundations/coordination-rules.md`, `docs/operations/conflict-coordination.md` | Must keep decision-table semantics aligned with shipped merge-train, re-entry, and runtime-blocking behavior. |
| Detail/reference docs | `docs/operations/verification-and-recovery.md`, `docs/architecture/data-model.md`, `docs/reference/tui.md` | Must not contradict shipped verification config, TypeScript interfaces, or CLI/TUI surfaces. |
| Standard gate | `npm run check` | Must include `test/unit/docs/drift.test.ts` through existing Vitest/package scripts. |

## Requirement Coverage

| Requirement | Required Proof | Automated Command |
|-------------|----------------|-------------------|
| REQ-DOC-01 | Execution-flow docs include the shipped read-only explain branch and remain consistent with verification/recovery flow. | `npx vitest run test/unit/docs/drift.test.ts` |
| REQ-DOC-02 | State-axis docs include current run statuses, checkpointed wait transitions, and 560-domain composite claim. | `npx vitest run test/unit/docs/drift.test.ts test/unit/core/fsm/run-state-axis.test.ts test/unit/core/fsm/composite-invariants.test.ts` |
| REQ-DOC-03 | Coordination semantics remain table-first and match shipped merge-train/re-entry/runtime-blocking behavior. | `npx vitest run test/unit/docs/drift.test.ts` |
| Standard verification | Drift checks run in the normal repository verification path. | `npm run check` |

## Wave 0 Gaps

The executor must close these before considering 11-02 complete:

- [ ] Create `test/unit/docs/drift.test.ts`.
- [ ] Ensure the drift test reads only fixed repo-local Markdown/source paths.
- [ ] Protect the load-bearing docs claims identified in `11-02-RESEARCH.md`.
- [ ] Confirm the drift test runs through existing Vitest globs without adding a new npm script.

## Sampling Plan

- **Per task:** run `npm run typecheck` plus the focused docs drift test for touched docs.
- **State-axis task:** additionally run `test/unit/core/fsm/run-state-axis.test.ts` and `test/unit/core/fsm/composite-invariants.test.ts`.
- **Final plan gate:** run `npm run typecheck`, `npx vitest run test/unit/docs/drift.test.ts`, and `npm run check`.

## Acceptance Gate

11-02 passes validation only when:

1. `test/unit/docs/drift.test.ts` exists and passes.
2. Updated docs satisfy the drift assertions without relaxing the protected shipped-behavior claims.
3. `npm run check` is green and therefore proves the docs drift check is in the standard verification lane.
4. `11-02-SUMMARY.md` records the final assertions, docs updated, verification results, and 11-03 handoff.
