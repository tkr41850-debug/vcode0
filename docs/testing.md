# gsd2 Testing

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
- ordered milestone steering queue vs autonomous scheduler selection
- merge-train queue ordering and state transitions
- work control vs collaboration control type transitions

### Integration Tests: pi-sdk Faux Provider

Integration tests use pi-sdk's `fauxModel` + scripted `FauxResponse` sequences as the `streamFn`. This runs a real `Agent` loop with real tool dispatch — no API calls, deterministic responses.

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { fauxStreamFn, fauxModel } from "../test/utils/faux-stream.js";

test("worker calls submit after passing verification", async () => {
  const agent = new Agent({
    initialState: { model: fauxModel, tools: workerTools },
    streamFn: fauxStreamFn([
      { toolCalls: [{ name: "submit", args: { summary: "done", filesChanged: [] } }] },
      { text: "Task complete." },
    ]),
  });
  await agent.prompt("Implement the feature.");
});
```

Integration test targets:
- Worker submit → task-level verification pass/fail loop
- Task worktree merge into feature branch
- Feature branch full verification before queueing
- Earlier queued milestones sort ahead of later queued milestones without bypassing dependencies
- Non-queued work falls into the effective `∞` bucket and backfills idle workers
- Clearing the milestone steering queue returns scheduler selection to autonomous critical-path mode
- Feature branch enters merge train; serialized integration to `main`
- Merge-train full verification after rebase onto latest `main`
- Same-feature file-lock suspend/resume IPC flow
- Cross-feature conflict surfaces at integration time, not task suspension time
- Planner builds valid DAG via tool calls
- Scheduler dispatches correct frontier after task completion
- Crash recovery: orphaned `running` tasks reset or resumed on startup with feature branch preserved
- Slow verification warnings for task / feature / merge-train checks
- Feature churn warnings after repeated verification failures, queue ejections, or repair loops
- Stuck detection and replanning transitions

## Scenario Specs

Scenario specs live under `specs/test_*.md` and are intended for later conversion into executable tests.

- [test_feature_branch_lifecycle](../specs/test_feature_branch_lifecycle.md) — task worktrees branch from and merge back into feature branches.
- [test_merge_train_ordering](../specs/test_merge_train_ordering.md) — completed feature branches queue and integrate to `main` one at a time, with milestone steering handled separately before queueing.
- [test_merge_train_conflict_handling](../specs/test_merge_train_conflict_handling.md) — cross-feature overlap becomes an integration conflict.
- [test_fs_lock_detection](../specs/test_fs_lock_detection.md) — same-feature overlap triggers suspension.
- [test_fs_lock_resume](../specs/test_fs_lock_resume.md) — suspended tasks resume against the updated feature branch.
- [test_stuck_detection_replan](../specs/test_stuck_detection_replan.md) — work-control stuck state enters replanning.
- [test_crash_recovery](../specs/test_crash_recovery.md) — restart preserves feature-branch authority and resumes or resets tasks correctly.

### Test Utilities

```text
gsd2/
├── test/
│   ├── utils/
│   │   ├── faux-stream.ts    -- fauxModel + fauxStreamFn (wraps pi-sdk faux provider)
│   │   ├── graph-builders.ts -- helpers to build test FeatureGraphs
│   │   └── store-memory.ts   -- in-memory Store (no SQLite needed in tests)
│   ├── unit/
│   └── integration/
```
