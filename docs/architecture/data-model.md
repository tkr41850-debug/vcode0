# Data Model

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Work Unit Hierarchy: Milestone → Feature → Task

```text
Milestone (organizational / progress unit)
├── Feature A
│   ├── Task 1
│   ├── Task 2
│   └── Task 3
├── Feature B (depends on Feature A)
│   └── Task 4
└── Feature C
    ├── Task 5
    └── Task 6
```

**Milestone** — an organizational / progress unit. It owns a set of features, gives users a human-facing grouping for planning and tracking, and can optionally be queued explicitly as a scheduler steering target. Multiple milestones may be queued. It does **not** participate in dependency edges in this version of the model.

**Feature** — the primary unit in the execution DAG. Features depend only on other features. Each feature belongs to exactly one milestone, owns exactly one feature branch, and exposes two state axes. A feature may represent either a user-visible implementation slice or, where justified, a shared interface/contract prerequisite that later implementation features depend on.

### Work Control

Work control tracks where the feature is in the GSD planning / execution flow.

```text
discussing → researching → planning → executing → ci_check → verifying → awaiting_merge
                                                           ↘         ↘
                                                            replanning

awaiting_merge --(after collaboration control reaches `merged`)--> summarizing ─→ work_complete
                                                         \--(budget mode)--> work_complete

structural or repeated failure → replanning
```

- **discussing** — blocking modal in the TUI. The orchestrator launches a discuss-phase agent and waits for user answers. Skipped in `budget` token profile.
- **researching** — scouts the codebase and relevant docs to inform planning. Skipped in `budget` token profile.
- **planning** — decomposes the feature into tasks, assigns weights, and declares inter-task deps.
- **executing** — tasks dispatch to workers in parallel per the feature-local DAG frontier. The feature branch may be red during `executing`.
- **ci_check** — heavy branch-level verification after the last task lands or after approved replan work lands. By default the feature branch should be green before leaving `ci_check` and entering `verifying`, though a loose feature-level policy may relax that boundary.
- **verifying** — agent-level review that checks whether the feature branch actually satisfies the feature spec, not just whether CI passes.
- **awaiting_merge** — local implementation and spec review are complete; the feature is waiting for collaboration control to carry it through merge-train integration into `main`.
- **summarizing** — after collaboration control reaches `merged`, a `light`-tier model writes a feature summary for downstream context injection. While this phase is active and the feature has no summary text yet, summary availability is treated as waiting.
- **replanning** — recovery phase entered after verify-shaped failures, repeated unresolved same-feature conflict handling, or a structural integration mismatch. Approved replan work lands on the same feature branch before the feature retries `ci_check` and `verifying`.
- **work_complete** — feature implementation has merged and summarization outcome is derived from current state: if summary text exists it is available, and if no summary text exists the summary was skipped. Overall feature `done` is derived only after collaboration control reaches `merged`.

### Collaboration Control

Collaboration control tracks how the feature coordinates with branches, the merge train, and shared files.

```text
none → branch_open → merge_queued → integrating → merged
                             ↓
                          conflict

branch_open / merge_queued / conflict → cancelled
```

- **none** — feature branch not opened yet.
- **branch_open** — feature branch exists as the integration surface; tasks may squash-merge into it. The feature worktree is provisioned lazily and only when a feature-phase run needs a checkout (`featurePhaseRequiresFeatureWorktree`: phases `execute | verify | ci_check | summarize`); the planning phases `discuss | research | plan | replan` use proposal/inspection hosts and skip it.
- **merge_queued** — feature is waiting in the integration queue.
- **integrating** — feature branch is rebasing / running merge-train verification against the latest `main`.
- **merged** — feature branch landed on `main` and is cleaned up.
- **conflict** — feature-level collaboration issue blocks normal progress. While a feature is in `conflict`, suspend task runs for that feature until the conflict is cleared.
- **cancelled** — feature participation in the branch / merge lifecycle has been explicitly stopped. Cancellation clears `runtimeBlockedByFeatureId`, marks task and feature-phase runs cancelled, aborts in-flight task runs, freezes the current work phase, and keeps the feature out of normal scheduling until it is explicitly restored. Cancelled tasks may still retain `suspended` / overlap metadata so existing worktrees remain understandable and potentially reusable later.

Feature and milestone `status` fields are derived reporting values, not independent authority. Feature status is derived from collaboration control plus frontier task outcomes; milestone status is derived from child feature statuses. A feature becomes `done` only when `workControl = "work_complete"` and `collabControl = "merged"`. A feature becomes `failed` when all frontier tasks are failed. `partially_failed` is a derived display status (not part of `UnitStatus`) computed when some frontier tasks have failed but dispatchable work remains — it is used for TUI display and scheduler deprioritization (sort key #4) but never stored or transitioned through the FSM.

The baseline uses typed prefixed IDs to distinguish graph unit classes at compile time:
- milestones: `m-${string}`
- features: `f-${string}`
- tasks: `t-${string}`

This keeps graph references scalar and persistence-friendly while making dependency legality and ownership relations explicit in the type surface.

Containment and sibling order are child-owned in the baseline:
- `Feature.milestoneId` + `Feature.orderInMilestone` define feature membership and order within a milestone
- `Task.featureId` + `Task.orderInFeature` define task membership and order within a feature
- parent collections are derived by filtering children by owner and sorting by the child order field

The baseline expects relatively small sibling sets (roughly `<= 50` features per milestone and `<= 50` tasks per feature), so simple child-order rewrites are acceptable. The warning system should surface cardinality growth if that assumption stops holding.

**Task** — the atomic unit of work. Executed by a single worker process. Tasks may depend only on other tasks within the same feature. Task execution progress is part of work control; branch suspension / merge coordination is part of collaboration control.

### Data Model

```typescript
type MilestoneId = `m-${string}`;
type FeatureId = `f-${string}`;
type TaskId = `t-${string}`;

interface Milestone {
  id: MilestoneId;
  name: string;
  description: string;
  status: UnitStatus;              // derived aggregate status for reporting
  order: number;                   // display order only; not an execution dependency
  steeringQueuePosition?: number;  // ordered scheduler override; absent = not queued (effective ∞)
}

interface Feature {
  id: FeatureId;
  milestoneId: MilestoneId;        // exactly one authoritative milestone per feature
  orderInMilestone: number;        // authoritative sibling order within the owning milestone
  name: string;
  description: string;
  dependsOn: FeatureId[];          // feature ids only
  status: UnitStatus;              // persisted lifecycle/reporting status
  workControl: FeatureWorkControl;
  collabControl: FeatureCollabControl;
  featureBranch: string;           // e.g. feat-<slugified-name>-<feature-id>
  featureTestPolicy?: TestPolicy;
  mergeTrainManualPosition?: number;  // manual override bucket position when explicitly ordered
  mergeTrainEnteredAt?: number;
  mergeTrainEntrySeq?: number;        // stable ordering tie-breaker for current queue entry
  mergeTrainReentryCount?: number;
  summary?: string;
  tokenUsage?: TokenUsageAggregate;   // lifetime aggregate across all task/model calls in the feature
  roughDraft?: string;                // seed text captured before `discussing` (rough idea / ticket body)
  discussOutput?: string;             // raw markdown blob persisted by discuss-phase completion
  researchOutput?: string;            // raw markdown blob persisted by research-phase completion
  featureObjective?: string;          // planner-baked feature-level objective (written on plan approval)
  featureDoD?: string[];              // planner-baked definition-of-done bullets for the feature
  verifyIssues?: VerifyIssue[];       // typed issues (any source); cleared on next approved replan
  mainMergeSha?: string;              // commit sha on main of the most recent successful integration merge
  branchHeadSha?: string;             // latest commit sha on the feature branch
}

interface Task {
  id: TaskId;
  featureId: FeatureId;            // exactly one authoritative owning feature per task
  orderInFeature: number;          // authoritative sibling order within the owning feature
  description: string;
  dependsOn: TaskId[];             // task ids within the same feature only
  status: TaskStatus;              // work_control execution status
  collabControl: TaskCollabControl;
  workerId?: string;
  worktreeBranch?: string;
  taskTestPolicy?: TestPolicy;
  result?: TaskResult;
  weight?: TaskWeight;             // estimated cost/complexity for critical path
  tokenUsage?: TokenUsageAggregate; // lifetime aggregate across retries, failures, and resumes
  reservedWritePaths?: string[];   // planner-reserved edit paths for scheduling overlap checks
  blockedByFeatureId?: FeatureId;  // cross-feature overlap: which feature blocks this task
  sessionId?: string;              // compatibility/task-facing session pointer; agent_runs.session_id stays authoritative
  consecutiveFailures?: number;    // tracks failures for stuck detection / crashloop backoff
  suspendedAt?: number;            // when the task was suspended
  suspendReason?: TaskSuspendReason; // why the task was suspended
  suspendedFiles?: string[];       // files involved in the suspension
  objective?: string;              // planner-baked task objective (one-liner what to achieve)
  scope?: string;                  // planner-baked scope boundary (what is in / out of scope)
  expectedFiles?: string[];        // planner-baked list of files the task is expected to touch
  references?: string[];           // planner-baked reference pointers (paths, URLs, knowledge ids)
  outcomeVerification?: string;    // planner-baked how-to-verify text (commands, assertions)
  branchHeadSha?: string;          // latest commit sha on the task worktree branch
}

type VerifyIssue =
  | {
      source: 'verify';
      id: string;
      severity: 'blocking' | 'concern' | 'nit';
      location?: string;
      description: string;
      suggestedFix?: string;
    }
  | {
      source: 'ci_check';
      id: string;
      severity: 'blocking' | 'concern' | 'nit';
      phase: 'feature' | 'post_rebase';
      checkName: string;
      command: string;
      exitCode?: number;
      output?: string;              // truncated to 4KB
      description: string;
    }
  | {
      source: 'rebase';
      id: string;
      severity: 'blocking' | 'concern' | 'nit';
      conflictedFiles: string[];
      description: string;
    };

// Persisted VerifyIssue[] payload total capped at 32KB with
// severity-ranked retention (blocking > concern > nit,
// most-recent first within severity). Per-ci_check `output`
// truncated to 4KB before retention is applied.

interface IntegrationState {
  featureId: FeatureId;                    // singleton: only one integration in-flight
  expectedParentSha: string;               // main's sha when rebase began; checked again before merge
  featureBranchPreIntegrationSha: string;  // feature branch sha before rebase
  featureBranchPostRebaseSha?: string;     // feature branch sha after rebase, before merge; used by startup reconciliation
  configSnapshot: string;                  // JSON snapshot of current verification config
  intent: 'integrate' | 'cancel';
  startedAt: number;
}

type AgentRunHarnessKind = "pi-sdk" | "claude-code";

interface BaseAgentRun {
  id: string;
  phase: AgentRunPhase;
  runStatus: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  sessionId?: string;
  harnessKind?: AgentRunHarnessKind;   // runtime backend that owns the resumable session
  workerPid?: number;                  // last local worker pid reported by the harness
  workerBootEpoch?: number;            // orchestrator boot epoch that observed workerPid
  harnessMetaJson?: string;            // optional harness-specific recovery blob
  payloadJson?: string;
  tokenUsage?: TokenUsageAggregate;    // normalized usage for this run row
  restartCount: number;
  maxRetries: number;
  retryAt?: number;
}

interface TaskAgentRun extends BaseAgentRun {
  scopeType: "task";
  scopeId: TaskId;
}

interface FeaturePhaseAgentRun extends BaseAgentRun {
  scopeType: "feature_phase";
  scopeId: FeatureId;
}

type AgentRun = TaskAgentRun | FeaturePhaseAgentRun;

interface TokenUsageAggregate {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;         // 0 when the provider does not expose this separately
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
  byModel: Record<string, ModelUsageAggregate>; // key: `${provider}:${model}`
}

interface ModelUsageAggregate {
  provider: string;
  model: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
}

type UnitStatus = "pending" | "in_progress" | "done" | "failed" | "cancelled";

// Derived display status — includes partially_failed for TUI and scheduler
type DerivedUnitStatus = UnitStatus | "partially_failed";

type FeatureWorkControl =
  | "discussing"
  | "researching"
  | "planning"
  | "executing"
  | "ci_check"
  | "verifying"
  | "awaiting_merge"
  | "summarizing"
  | "replanning"
  | "work_complete";

type FeatureCollabControl =
  | "none"
  | "branch_open"
  | "merge_queued"
  | "integrating"
  | "merged"
  | "conflict"
  | "cancelled";

type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "stuck"
  | "done"
  | "failed"
  | "cancelled";

type TaskCollabControl =
  | "none"
  | "branch_open"
  | "suspended"
  | "merged"
  | "conflict";

type TestPolicy = "loose" | "strict";

type AgentRunPhase =
  | "execute"
  | "discuss"
  | "research"
  | "plan"
  | "ci_check"
  | "verify"
  | "summarize"
  | "replan";

type AgentRunStatus =
  | "ready"
  | "running"
  | "retry_await"
  | "await_response"
  | "await_approval"
  | "completed"
  | "failed"
  | "cancelled";

// State ownership rule:
// - tasks.status is coarse DAG/work progress only
// - tasks.collabControl is coordination only
// - agent_runs owns retry/help/approval/manual execution detail
// - blocked is derived for UI/reporting from run status + retry timing + collaboration state,
//   not persisted as a task enum

type RunOwner = "system" | "manual";

type RunAttention = "none" | "crashloop_backoff";
```

### Scheduling Levels

The feature graph determines which features can run. Milestones are organizational / steering units: they do not unblock execution and they do not create dependency edges. A user may queue multiple milestones to steer scheduler attention. The scheduler operates on a unified frontier of `SchedulableUnit` values covering both task execution and feature-phase agent work. See [graph-operations.md](./graph-operations.md) for the canonical scheduling priority order, combined graph metrics, work-type tiers, and the orchestrator tick model.

Feature IDs below are illustrative placeholders that show dependency shape only.

```text
Feature graph:
  F-<feature-a> ──→ F-<feature-b> ──→ F-<feature-c>
                        ↑
  F-<feature-d> ────────┘

Ready frontier: [F-<feature-a>, F-<feature-d>]  (no unmet feature deps)
Queued milestones: [M1, M3]
Priority ordering over ready work:
  1. milestoneQueuePosition(unit.milestoneId)   // ∞ if not queued
  2. workTypeTier(unit.phase)                   // verify > execute > plan > summarize
  3. -criticalPathWeight(unit)                  // combined graph max depth
  4. partially-failed deprioritization
  5. reservation overlap penalty
  6. retry-eligible before fresh
  7. stable fallback (age — when the unit became ready, tracked by scheduler)
No queued milestones: start from the global ready frontier and sort by work-type tier then critical path
After F-<feature-a> + F-<feature-d> done: [F-<feature-b>]
After F-<feature-b> done: [F-<feature-c>]

Within F-<feature-a>:
  Task <a>, Task <b>, Task <c>  (all independent → all dispatched in parallel)
```

### Git Branch Model

```text
main
└── feat-<slugified-name>-<feature-id>
    ├── feat-<slugified-name>-<feature-id>-<task-id-a>
    ├── feat-<slugified-name>-<feature-id>-<task-id-b>
    └── feat-<slugified-name>-<feature-id>-<task-id-c>
```

- A feature branch is created when that branch is requested (`WorktreeProvisioner.ensureFeatureBranch` at the `branch_open` transition); the baseline branch name is `feat-<slugified-name>-<feature-id>`. The feature worktree is created separately and lazily — only when a feature-phase run needs a checkout (phases `execute | verify | ci_check | summarize`, gated by `featurePhaseRequiresFeatureWorktree` in `src/orchestrator/scheduler/dispatch.ts`).
- Task worktrees branch from the current HEAD of the owning feature branch and use the baseline branch name `feat-<slugified-name>-<feature-id>-<task-id>`.
- Worker `submit(summary, filesChanged)` is the explicit task-complete signal. Worker `confirm()` is only a progress acknowledgement; the orchestrator treats terminal results with `completionKind === 'submitted'` as landed task work on the feature branch.
- After the last task lands, or after approved replan work lands, the feature enters `ci_check` on the feature branch; only after that boundary passes does the feature enter agent-level `verifying`.
- If `verifying` passes, feature work control becomes `awaiting_merge` and collaboration control may move to `merge_queued`.
- After collaboration control reaches `merged`, the feature either enters blocking `summarizing` or, in budget mode, moves directly to `work_complete` without writing summary text.
- The merge train serializes feature-branch integration into `main`.
