# Scenario Specs

This directory holds markdown scenario specs that describe expected orchestration behavior before those cases are turned into executable tests.

Use this page as the canonical scenario index. For testing strategy and faux-provider guidance, see [docs/testing.md](../docs/testing.md).

## Lifecycle / Merge Train

- [test_feature_branch_lifecycle](./test_feature_branch_lifecycle.md) — feature branches/worktrees open on request, task worktrees merge back into them, and cleanup follows the feature lifecycle.
- [test_feature_verification_repair_loop](./test_feature_verification_repair_loop.md) — failed `feature_ci` or agent-level `verifying` creates same-branch repair work before queue entry.
- [test_merge_train_ordering](./test_merge_train_ordering.md) — completed feature branches queue and integrate to `main` one at a time.
- [test_merge_train_conflict_handling](./test_merge_train_conflict_handling.md) — integration rebase or merge-train verification failure ejects a feature for same-branch repair and re-entry.
- [test_feature_summary_lifecycle](./test_feature_summary_lifecycle.md) — post-merge summarizing writes summary text in the normal path while budget mode skips summary creation.

## Scheduler / Graph

- [test_graph_invariants](./test_graph_invariants.md) — DAG mutation rules reject cycles, cross-feature task edges, dangling refs, and milestone dependency misuse.
- [test_graph_contracts](./test_graph_contracts.md) — `FeatureGraph` remains the authoritative mutable DAG surface, derived read model, and queue view.
- [test_scheduler_frontier_priority](./test_scheduler_frontier_priority.md) — ready-frontier recomputation, milestone steering, critical-path ordering, and reservation-overlap penalties.
- [test_package_boundary_contracts](./test_package_boundary_contracts.md) — package ownership and dependency-direction rules across app, core, orchestrator, agents, runtime, git, persistence, and TUI.
- [test_orchestrator_port_contracts](./test_orchestrator_port_contracts.md) — graph plus store/runtime/agent/verification/UI boundaries keep side effects behind orchestration seams.

## Conflict / Overlap

- [test_conflict_steering](./test_conflict_steering.md) — upstream updates escalate from awareness to sync recommendation, required sync, and explicit conflict steering.
- [test_cross_feature_overlap_runtime](./test_cross_feature_overlap_runtime.md) — runtime cross-feature overlap selects primary/secondary ownership, blocks the whole secondary feature, and resumes after rebase.
- [test_same_feature_overlap_detection](./test_same_feature_overlap_detection.md) — same-feature overlap triggers suspension.
- [test_same_feature_overlap_resume](./test_same_feature_overlap_resume.md) — suspended tasks either resume cleanly or receive exact conflict steering against the updated feature branch.

## Runtime / Recovery / Waits

- [test_agent_run_wait_states](./test_agent_run_wait_states.md) — run-owned retry/help/approval waits control dispatchability, derived blocked state, and scheduler release behavior.
- [test_runtime_session_contracts](./test_runtime_session_contracts.md) — session harness, IPC transport, worker messages, and context assembly define the local runtime contract.
- [test_stuck_detection_replan](./test_stuck_detection_replan.md) — stuck work supports manual takeover, help waits, release-to-scheduler rules, and approval-gated replanning.
- [test_crash_recovery](./test_crash_recovery.md) — restart preserves feature-branch authority, run wait states, and authoritative session recovery behavior.

## Warnings / Candidates

- [test_warning_signals](./test_warning_signals.md) — warning thresholds cover slow verification, feature churn, and long blocking.
- [test_claude_code_harness](./test_claude_code_harness.md) — feature-candidate spec for Claude Code worker sessions as an alternate harness backend.
