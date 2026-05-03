# 11-02 Summary — Documentation Drift Checks

## Completed work

Added executable documentation drift coverage in `test/unit/docs/drift.test.ts` and aligned the protected docs with shipped code behavior.

### State axes

- Protected every shipped `AgentRunStatus` from `src/core/types/runs.ts`.
- Documented checkpointed wait transitions for help and approval waits.
- Aligned the composite-domain claim with the exhaustive FSM test: `10 × 7 × 8 = 560 combinations`.
- Removed stale `10 × 7 × 6 = 420` and six-run-state wording.

### Execution flow and coordination

- Documented `gvc0 explain feature|task|run <id>` as a read-only branch before TUI startup, scheduler startup, and runtime worker composition.
- Consolidated coordination decision-table docs around the six protected families: Lock, Claim, Suspend, Resume, Rebase, and Re-entry.
- Protected runtime-blocking authority wording: `Feature.runtimeBlockedByFeatureId` is scheduling authority; task-level `blockedByFeatureId` is reconstruction/UI display metadata.
- Aligned merge-train verification docs with shipped fallback resolution: `mergeTrain -> feature -> empty defaults`.

### Data model and TUI reference

- Removed unshipped branch-SHA fields from the data-model reference.
- Replaced the stale source-discriminated `VerifyIssue` doc with the shipped flat shape from `src/core/types/verification.ts`.
- Added `runtimeBlockedByFeatureId` to the documented `Feature` shape.
- Updated the data-model `AgentRunStatus` list with checkpointed wait states.
- Updated the TUI reference with shipped CLI entrypoints, overlays, graph hotkeys, and operational slash commands.

## Drift checks added

`test/unit/docs/drift.test.ts` now protects:

- run-status coverage in `docs/foundations/state-axes.md`
- checkpointed wait transition text
- composite-domain cardinality and stale cardinality removal
- read-only pre-TUI `gvc0 explain` ordering against `src/main.ts`
- coordination decision-table family/source visibility
- merge-train verification fallback wording
- data-model fields against `src/core/types/domain.ts`
- flat `VerifyIssue` shape against `src/core/types/verification.ts`
- TUI entrypoints, hotkeys, overlays, and slash-command surface against shipped TUI code

## Verification

Passed:

```text
npx vitest run test/unit/docs/drift.test.ts
PASS (12) FAIL (0)

npm run typecheck
> tsc --noEmit

npm run check
Checked 313 files in 91s. No fixes applied.
Checked 313 files in 21s. No fixes applied.
Checked 313 files in 32s. No fixes applied.
> tsc --noEmit
Test Files 92 passed | 2 skipped (94)
Tests 1967 passed | 3 skipped (1970)
```

## Handoff

11-02 closes the executable documentation drift slice. Phase 11 plan 11-03 still owns the concerns-to-tests map and newcomer narrative documentation.
