# 11-03 Summary — Concerns Traceability and Newcomer Narrative

## Completed work

Closed Phase 11's remaining documentation traceability and narrative criteria by connecting every current concern page to executable proof or an explicit deferred gap, then refreshed the single newcomer prompt-to-`main` walkthrough in place.

## Concern-to-test mapping

Added the central map in `docs/operations/testing.md#concerns-to-tests-traceability` and linked it from `docs/concerns/README.md`.

| Concern | Executable proof | Status |
|---|---|---|
| Destructive Ops (non-git) | `test/unit/agents/destructive-ops.test.ts`; `test/integration/destructive-op-approval.test.ts` | Partial: shipped git destructive ops are approval-gated; non-git destructive shell patterns remain deferred/no-direct-coverage. |
| Merge-Train Re-entry Cap | `test/unit/core/merge-train.test.ts`; `test/integration/merge-train.test.ts`; `test/unit/core/warnings.test.ts` | Covered for cap enforcement, inbox escalation, queue behavior, and churn warning signals. |
| Merge-Train Re-entry Starvation | `test/unit/core/merge-train.test.ts`; `test/integration/merge-train.test.ts`; `test/unit/core/warnings.test.ts` | Partial: tested ordering, cap backstop, and warnings; fleet-level fairness/starvation metrics remain deferred/no-direct-coverage. |
| Planner Write-Reservation Accuracy | `test/unit/orchestrator/verify-repairs.test.ts`; `test/unit/core/proposals.test.ts`; `test/unit/orchestrator/scheduler-loop.test.ts` | Partial: reservation propagation and runtime overlap handling are covered; prediction accuracy against actual changed files remains a watchpoint. |
| Summarize Retry Loop | `test/unit/orchestrator/summaries.test.ts`; `test/unit/orchestrator/scheduler-loop.test.ts` | Partial: summarize lifecycle and generic retry redispatch are covered; summarize-specific cap/backoff/escalation remains deferred/no-direct-coverage. |
| Verification and Repair Churn | `test/unit/orchestrator/verify-repairs.test.ts`; `test/integration/feature-lifecycle-e2e.test.ts`; `test/unit/core/warnings.test.ts`; `specs/test_feature_verification_repair_loop.md` | Covered for repair creation, repair cap escalation, e2e verify-repair rerun, and warning/spec coverage of repeated loops. |
| Worker Runaway | `test/integration/worker-smoke.test.ts` | Deferred/no-direct-coverage for runaway mitigation; runtime bootstrap and wait/resume plumbing are covered only. |

Each page under `docs/concerns/*.md` now has an `Executable coverage` section that either links to executable proof or labels the mitigation gap directly.

## Newcomer narrative

Updated `docs/foundations/newcomer.md` as the single prompt-to-`main` narrative. The walkthrough now reflects shipped Phase 8–11 surfaces:

- command-first TUI composer and graph-focus hotkeys
- planner audit and proposal review overlays
- task transcript overlay
- inbox overlay and checkpointed wait states
- merge-train overlay and cap escalation
- config editing surface
- read-only `gvc0 explain feature|task|run <id>` diagnostics

It also removes stale detail about recording a commit SHA directly on the task row and updates the state-matrix link text from 420 to 560 combinations.

## Deferred gaps documented

- Non-git destructive shell commands remain deferred/no-direct-coverage.
- Merge-train starvation has no fleet-level fairness metric yet.
- Planner reservation prediction quality is not measured against actual changed files.
- Summarize retry loops still lack summarize-specific backoff/cap/escalation.
- Worker runaway mitigation lacks wall-clock, idle-progress, provider-retry, and cost-cutoff enforcement.
- Verification reuse/caching remains a deferred optimization.

## Verification

Focused checks passed before the final planning-state update:

```text
npm run format:check
npm run lint
```

Final verification for the whole slice:

```text
npm run check
```

## Handoff

Phase 11 is complete. Phase 12 should now prove the full v1 loop end-to-end: scripted prompt-to-main scenario, verify-agent flake-rate audit, TUI golden-path smoke coverage, source-install runbook, and final v1 traceability green-out.
