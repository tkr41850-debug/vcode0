# Testing

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Testing

### Unit Tests

Vitest unit tests for pure logic — no LLM calls, no child processes.

Key targets:
- `graph/feature-graph.ts` — DAG mutations, cycle detection, frontier computation
- `graph/critical-path.ts` — critical path weight calculation
- `scheduler/retry.ts` — backoff math, jitter bounds
- `scheduler/model-router.ts` — tier selection, ceiling enforcement, budget pressure
- `ipc/ndjson.ts` — message framing, partial line handling
- graph invariant rejection (cycles, cross-feature task deps, dangling refs, illegal mutations)
- ordered milestone steering queue vs autonomous scheduler selection
- critical-path-first ordering within a queue bucket
- merge-train queue ordering and state transitions
- work control vs collaboration control type transitions

### Integration Tests: pi-sdk Faux Provider

Integration tests use pi-sdk's `fauxModel` + scripted `FauxResponse` sequences as the `streamFn`. This runs a real `Agent` loop with real tool dispatch — no API calls, deterministic responses.

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { fauxStreamFn, fauxModel } from "../test/utils/faux-stream.js";

test("worker calls submit then confirm after passing preflight", async () => {
  const agent = new Agent({
    initialState: { model: fauxModel, tools: workerTools },
    streamFn: fauxStreamFn([
      { toolCalls: [{ name: "submit", args: { summary: "done", filesChanged: [] } }] },
      { toolCalls: [{ name: "confirm", args: { summary: "done", filesChanged: [] } }] },
      { text: "Task complete." },
    ]),
  });
  await agent.prompt("Implement the feature.");
});
```

Integration test targets:
- Worker `submit()` → task-level preflight pass/fail loop with concrete failure reasons
- Worker `confirm()` finalizes session closeout and merges the task worktree into the feature branch
- Feature branch heavy `feature_ci` before queueing
- `feature_ci` or agent-level `verifying` failure creates same-branch repair work before queue entry and keeps the feature off `merge_queued`
- Earlier queued milestones sort ahead of later queued milestones without bypassing dependencies
- Non-queued work falls into the effective `∞` bucket and backfills idle workers
- Clearing the milestone steering queue returns scheduler selection to autonomous critical-path mode
- Scheduler dispatches the correct ready frontier after dependency completion
- Critical-path weighting wins within the same milestone bucket
- Reservation-only overlap applies a scheduling penalty rather than a hard block
- Feature branch enters merge train; serialized integration to `main`
- Merge-train full verification after rebase onto latest `main`
- Merge-train failure ejects a feature until repair plus the normal `feature_ci -> verifying` path succeed again under the normal queue policy
- Same-feature file-lock suspend/resume IPC flow
- Same-feature rebase conflict steers the existing task in the real conflicted worktree
- Same-feature conflict resolution that succeeds returns the task to the normal completion path
- Same-feature post-conflict verification failure returns to the ordinary execution / verification loop
- Cross-feature runtime overlap pauses only affected secondary tasks and later resumes them after rebase
- Successful integration repair returns the feature to `awaiting_merge` and merge-ready state under the normal queue policy
- Planner builds valid DAG via tool calls
- Crash recovery: orphaned `running` tasks reset or resumed on startup with feature branch preserved
- Slow verification warnings for task / feature / merge-train checks
- Feature churn warnings after repeated verification failures, queue ejections, or repair loops
- Stuck detection and replanning transitions

## Scenario Specs

Scenario specs live under `specs/test_*.md` and are intended for later conversion into executable tests.

- [test_feature_branch_lifecycle](../specs/test_feature_branch_lifecycle.md) — feature branches/worktrees open on request, task worktrees merge back into them, and retention/cleanup follows the feature lifecycle.
- [test_graph_invariants](../specs/test_graph_invariants.md) — core DAG mutation rules reject cycles, cross-feature task edges, dangling refs, and milestone dependency misuse.
- [test_scheduler_frontier_priority](../specs/test_scheduler_frontier_priority.md) — ready-frontier recomputation, milestone steering, critical-path ordering, and reservation-overlap penalties.
- [test_feature_verification_repair_loop](../specs/test_feature_verification_repair_loop.md) — failed `feature_ci` or agent-level `verifying` stays off the merge queue until same-branch repair plus rerun succeeds.
- [test_merge_train_ordering](../specs/test_merge_train_ordering.md) — completed feature branches queue and integrate to `main` one at a time, with milestone steering handled separately before queueing.
- [test_merge_train_conflict_handling](../specs/test_merge_train_conflict_handling.md) — rebase or merge-train verification failure ejects a feature for same-branch repair and re-entry under the normal queue policy.
- [test_cross_feature_overlap_runtime](../specs/test_cross_feature_overlap_runtime.md) — runtime cross-feature overlap selects primary/secondary ownership, pauses affected secondary work, and resumes after rebase.
- [test_fs_lock_detection](../specs/test_fs_lock_detection.md) — same-feature overlap triggers suspension.
- [test_fs_lock_resume](../specs/test_fs_lock_resume.md) — suspended tasks either resume cleanly or receive exact conflict steering against the updated feature branch.
- [test_conflict_steering](../specs/test_conflict_steering.md) — upstream updates escalate from awareness to sync recommendation, required sync, explicit same-feature conflict steering, and cross-feature runtime coordination after runtime overlap is detected.
- [test_agent_run_wait_states](../specs/test_agent_run_wait_states.md) — run-owned retry/help/approval waits control dispatchability, derived blocked state, and scheduler release behavior.
- [test_feature_summary_lifecycle](../specs/test_feature_summary_lifecycle.md) — post-merge summarizing writes summary text in the normal path while budget mode skips summary creation and relies on derived availability.
- [test_claude_code_harness](../specs/test_claude_code_harness.md) — (feature candidate) Claude Code worker sessions are isolated, resumable, and checkpoint-driven.
- [test_warning_signals](../specs/test_warning_signals.md) — warning thresholds cover slow verification, feature churn, and long blocking.
- [test_stuck_detection_replan](../specs/test_stuck_detection_replan.md) — work-control stuck state enters replanning, supports manual takeover, and waits for approval on replanner proposals.
- [test_crash_recovery](../specs/test_crash_recovery.md) — restart preserves feature-branch authority, run wait states, and authoritative session recovery behavior.

### Test Utilities

```text
gvc0/
├── test/
│   ├── utils/
│   │   ├── faux-stream.ts    -- fauxModel + fauxStreamFn (wraps pi-sdk faux provider)
│   │   ├── graph-builders.ts -- helpers to build test FeatureGraphs
│   │   └── store-memory.ts   -- in-memory Store (no SQLite needed in tests)
│   ├── unit/
│   └── integration/
```
