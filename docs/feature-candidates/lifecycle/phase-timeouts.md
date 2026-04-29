# Feature Candidate: Generalized Phase Timeouts

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

Timeouts are configured per verification layer in `.gvc0/config.json` (`verification.task.timeoutSecs`, `verification.feature.timeoutSecs`). Agent phases (plan, discuss, research, verify, replan, summarize) have no structural timeout and run until completion, worker crash, or manual intervention. Integration steps inherit `verification.feature.timeoutSecs` for their `ci_check` step but have no explicit timeout for rebase or merge themselves.

## Candidate

A unified timeout scheme across all phase levels:

- **Task**: worker run wall time covering both agent work and the verification command bundle.
- **Feature**: per-agent-phase (plan, discuss, research, verify, replan, summarize) and per-`ci_check`.
- **Integration**: rebase, post-rebase `ci_check`, merge.

Each level carries two thresholds:

- `warnAfterSecs`: emit a non-blocking warning when phase run time crosses this mark.
- `timeoutSecs`: kill the run with a typed `timeout` failure, routed through standard failure handling — replanning for verify-shaped phases, retry/backoff for others.

The orchestrator tracks `timeUsed` per phase run against these thresholds and surfaces elapsed time in the TUI.

## Why Deferred

Baseline architecture assumes local-machine workloads where phase wall times are short and operator intervention catches hangs. Adding structured timeouts increases:

- FSM paths for timeout-triggered failure routing
- TUI surface for elapsed-time display
- Config schema and validation
- Crash recovery interaction (timer state must persist or reset on restart)

Practical defaults and operator oversight are sufficient until real workloads reveal hang patterns.

## Related

- [Operations / Verification and Recovery](../../operations/verification-and-recovery.md)
- [Concern: Summarize Retry Loop](../../concerns/summarize-retry-loop.md)
