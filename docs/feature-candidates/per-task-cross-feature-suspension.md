# Feature Candidate: Per-Task Cross-Feature Suspension

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline cross-feature overlap policy uses **per-feature blocking**: when runtime overlap is detected between two features, a feature-level dependency is added (`secondary depends on primary`), and all secondary feature tasks are suspended. The secondary feature resumes only after the primary merges and the secondary feature branch is rebased onto updated `main`.

## Candidate

Replace per-feature blocking with **per-task suspension**: only the secondary feature's tasks that touch the overlapping paths are paused. Non-overlapping tasks in the secondary feature continue running.

The original coordination algorithm (before the per-feature simplification) was:

1. Detect overlap incident between two features.
2. Choose primary and secondary per feature pair.
3. Pause only the secondary tasks that touch overlapped paths.
4. Persist `suspend_reason`, `suspended_files`, and `blocked_by_feature_id` on each paused task.
5. Release active path locks for paused tasks; reservations remain.
6. Let non-overlapping secondary tasks continue.
7. After primary merges, rebase secondary feature branch and resume paused tasks if clean.

### Trade-offs vs Baseline

| | Per-task suspension | Per-feature dependency (baseline) |
|---|---|---|
| Parallelism | Non-overlapping secondary tasks continue | All secondary work blocked |
| Correctness risk | Non-overlapping tasks may produce work that conflicts after rebase | Clean — rebase happens with no active tasks |
| Rebase scope | Must rebase feature branch while some tasks are still running on it | No active tasks — simpler, no mid-flight worktree issues |
| Complexity | Selective suspend/resume, partial dispatch logic, per-task path tracking | One graph edge add/remove |
| Recovery on rebase failure | Active tasks must also be paused retroactively | Already paused — repair is straightforward |

## Why Deferred

Per-feature blocking is simpler and safer:
- Rebasing with no active tasks avoids mid-flight worktree corruption.
- Recovery on rebase failure doesn't require retroactive suspension of tasks that were allowed to continue.
- The parallelism cost is bounded because cross-feature overlap should be uncommon when reservation-based scheduling penalties are working correctly.
- The additional complexity of tracking which tasks touch which paths, selectively suspending/resuming, and handling partial dispatch is not justified until the parallelism cost is observed in practice.

## When to Revisit

Consider this candidate when:
- Cross-feature overlap is observed to be frequent despite reservation penalties.
- Secondary features with many tasks are blocked for long periods while only a small subset of tasks actually overlap.
- Worker utilization drops noticeably due to per-feature blocking.
