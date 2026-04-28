# Comparison with gsd-2

Snapshot taken on 2026-04-08 from public gsd-2 materials only. This is a high-level comparison against the public README/repo/website, not a deep code audit. Worth revisiting as both projects evolve.

## Summary

Our architecture is clearly in the same family as gsd-2, but it pushes harder on parallel DAG execution, explicit branch/integration state, and conflict handling. The closest conceptual mapping is:

- **gsd-2 milestone** ≈ our **milestone**
- **gsd-2 slice** ≈ our **feature**
- **gsd-2 task** ≈ our **task**

The main difference is that our **feature** is not just a planning unit; it is also the primary execution-DAG and integration unit.

## Feature Mapping

| Public gsd-2 feature | Our architecture | Notes |
|---|---|---|
| Milestone → slice → task hierarchy | Milestone → feature → task | Close match. Our `feature` is roughly gsd-2's `slice`, but it also owns dependency edges and branch/integration lifecycle. |
| Autonomous long-running execution | Yes | Covered by scheduler loop, worker pool, retries, crash recovery, and merge train. |
| Step mode / one-unit-at-a-time review | Partial | We have TUI + steering, but no explicitly documented `next one unit then pause` mode yet. |
| Fresh context per task | Yes | Planner-baked `TaskPayload` (objective/scope/expectedFiles/references/outcomeVerification + feature DoD) gives each task a fresh, typed brief. |
| Context engineering / decisions register | Yes | `CODEBASE.md`, `KNOWLEDGE.md`, and `DECISIONS.md`. |
| Git isolation | Yes, stronger | gsd-2 exposes milestone worktrees/branches; we use feature branches plus task worktrees and a merge train. |
| Verification enforcement | Yes, stronger layering | We separate task, feature, and merge-train verification. |
| Auto-fix retry loops | Yes | Task submit failures stay in the agent loop; feature/merge verification failures route through replanning. |
| Crash recovery / resume | Yes | Resumption is documented at the task/worktree/session level. |
| Budget / cost tracking | Yes | Budget ceilings and warning thresholds are documented. |
| Model routing | Yes | Tiered routing with user ceiling and budget pressure exists. |
| Parallel multi-worker orchestration | Yes, stronger | This is one of the main architectural differentiators. |
| Adaptive replanning / roadmap reassessment | Partial | We have feature replanning after failures, but not a clearly documented whole-roadmap reassessment loop after successful units. |
| Headless / CI / cron / JSON query mode | Missing | I do not see documented equivalents yet. |
| Quality gates / milestone validation gate | Partial | We have verification and warnings, but not a higher-level milestone acceptance gate. |
| File-based IPC for orchestration | Different | We use NDJSON stdio transport abstraction rather than the public gsd-2 file-IPC framing. |

## Where Our Architecture Goes Beyond gsd-2

1. **Feature/task DAG as the primary execution model** rather than sequential-by-default flow.
2. **Work control vs collaboration control** as separate state axes.
3. **Serialized merge train** for feature-branch integration into `main`.
4. **Explicit same-feature vs cross-feature conflict protocols**.
5. **Reserved write paths + lazy active path locks** for overlap management.

## Where We Still Trail or Differ

1. **Step-mode UX** is not yet documented as cleanly as gsd-2's public story.
2. **Headless/CI/query control surface** appears missing.
3. **Whole-roadmap reassessment** after successful units is not yet a first-class documented loop.
4. **Milestone acceptance/validation gate** above feature completion is not clearly specified.

## Revisit Notes

This comparison is worth revisiting later, especially if we add any of the following:

- explicit step-mode UX
- headless/CI/query commands
- roadmap reassessment after completed features/milestones
- milestone-level validation gates
- external control/query APIs for orchestration state

## Public References

- <https://github.com/gsd-build/gsd-2>
- <https://gsd.build/>
