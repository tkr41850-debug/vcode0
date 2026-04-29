# Feature Candidates

Deferred product/runtime features that are intentionally out of baseline scope.

Use these notes when current docs mention future capability that is not implemented yet.

Entries are grouped by theme. Files live under the matching subfolder.

## Coordination

Multi-feature / multi-task coordination — merge train ordering, cross-feature suspension, replan policies, mid-flight integration cancellation.

- [Arbitrary Merge-Train Manual Ordering](./coordination/arbitrary-merge-train-manual-ordering.md)
- [Cross-Family Replanner](./coordination/cross-family-replanner.md)
- [Graceful Integration Cancellation](./coordination/graceful-integration-cancellation.md)
- [In-Flight Feature Split & Merge](./coordination/in-flight-split-merge.md)
- [Merge-Step File-Filtering Audit](./coordination/merge-step-file-filtering-audit.md)
- [Merge-Train Niceness](./coordination/merge-train-niceness.md)
- [Per-Task Cross-Feature Suspension](./coordination/per-task-cross-feature-suspension.md)

## Lifecycle

Per-feature / per-task lifecycle — cancel, kill, and timeout knobs.

- [Soft Cancel](./lifecycle/soft-cancel.md)
- [User Feature Kill](./lifecycle/user-feature-kill.md)
- [Generalized Phase Timeouts](./lifecycle/phase-timeouts.md)
- [Long Verification Timeouts](./lifecycle/long-verification-timeouts.md)

## Runtime

Worker pool, IPC, harness, scheduling, persistence, repair, and budget levers.

- [Advanced Budget Controls](./runtime/advanced-budget-controls.md)
- [Advanced IPC Guarantees](./runtime/advanced-ipc-guarantees.md)
- [Centralized Conversation Persistence](./runtime/centralized-conversation-persistence.md)
- [Claude Code Harness](./runtime/claude-code-harness.md)
- [Distributed Runtime](./runtime/distributed-runtime.md)
- [Extended Repair Profiles](./runtime/extended-repair-profiles.md)
- [Verify Nit Task Pool](./runtime/verify-nit-task-pool.md)
- [Worker Scheduling Policies](./runtime/worker-scheduling-policies.md)

## Data model

Validation, typing, structured outputs, and proposal-state ergonomics.

- [Graph Dependency Overload Typing](./data-model/graph-dependency-overload-typing.md)
- [Proposal Editing and Toggling](./data-model/proposal-editing-and-toggling.md)
- [Proposal Operation No-Op Cleanup](./data-model/proposal-op-noop-cleanup.md)
- [Runtime ID Validation and Factories](./data-model/runtime-id-validation.md)
- [Structured Feature-Phase Outputs](./data-model/structured-feature-phase-outputs.md)

## Interop

External pattern borrows and cross-tool compatibility surfaces.

- [`absurd` Evaluation](./interop/absurd-evaluation.md)
- [`absurd` Pattern Borrow](./interop/absurd-pattern-borrow.md)
- [AGENTS.md Interop](./interop/agents-md-interop.md)
- [Git-Tracked Markdown State Exports](./interop/git-tracked-markdown-state-exports.md)
- [SARIF Output for VerifyIssue](./interop/sarif-verifyissue-output.md)
