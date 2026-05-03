# Phase 8 Plan 05: Config Editor Menu + Visible Cancel Levers — Research

**Researched:** 2026-04-29
**Domain:** TUI config editing, live config application, runtime/control seams, task/feature cancellation semantics
**Confidence:** HIGH (all findings verified by direct codebase inspection; no external research required)

---

<user_constraints>
## User Constraints (from roadmap, requirements, context, and locked decisions)

### Locked Decisions
- Phase 8 remains command-first and manual-wins: new controls should extend the existing composer/overlay architecture instead of introducing cursor-heavy workflow state.
- UI state stays derived from authoritative application state. Overlay visibility may live in `TuiApp`, but config values and cancel effects must come from real runtime/graph state.
- This slice closes the final open Phase 8 requirements instead of polishing already-shipped surfaces.
- The `@microsoft/tui-test` smoke lane remains blocked by the pre-existing workerpool `SIGSEGV`, so focused unit/type/integration verification is more trustworthy than the smoke runner.

### Canonical Requirement Targets
- `REQ-TUI-04`: Config editing menu inside the TUI.
- `REQ-TUI-05`: Three distinct cancel levers: task-preserve-worktree, task-clean-worktree, feature-abandon-branch.
- `REQ-CONFIG-03`: Pause thresholds, re-entry cap, worker-count cap, and model assignments are user-editable in TUI + file; hot-reloadable keys apply without restart.
- Phase 8 roadmap success criteria also require editing retry cap without restart.

### Immediate Scope Constraint
This slice is **not** just another overlay. The codebase currently has no config persistence API, no live config mutator, no task-level cancel surface, and no branch-abandon flow. The UI work is real, but it is downstream of missing compose/runtime/worktree seams.
</user_constraints>

---

## Summary

Phase 8 has one remaining slice: the config editor menu plus visible cancel controls. The TUI surface itself is straightforward to fit into the existing command/overlay architecture, but the underlying control plane is not yet ready for an honest implementation.

**Primary research conclusion:** 08-05 must span four layers at once:
1. **TUI surface** for config and cancel actions
2. **Compose/TUI deps seam** for reading/updating config and dispatching cancel variants
3. **Runtime / scheduler / agent runtime live-update plumbing** for settings that must apply without restart
4. **Worktree / graph / run-state semantics** for the three cancel levers

Without that plumbing, a config menu would merely save JSON that some subsystems ignore, and the cancel controls would collapse back into the single existing feature-cancel behavior.

The repo already contains enough structure to land 08-05 cleanly, but it does **not** contain the final APIs yet:
- config loads once at boot through `JsonConfigLoader.load()`
- `ConfigSource.watch()` is still a no-op stub
- `workerCap`, `retryCap`, `reentryCap`, and `pauseTimeouts.hotWindowMs` are parsed by schema but several are captured only at construction time
- `models.topPlanner` and `models.taskWorker` are wired, while `models.featurePlanner` and `models.verifier` are not distinctly consumed
- the TUI deps expose `cancelFeature(...)` only; there is no task-preserve, task-clean, feature-abandon-branch, config getter, or config save/apply API

---

## Requirements Crosswalk

| Requirement | Verified current state | Gap to close in 08-05 |
|-------------|------------------------|------------------------|
| REQ-TUI-04 | No config editor surface exists | Add command-first config menu overlay + slash commands |
| REQ-TUI-05 | Only `cancelFeature` exists (`x` / `/cancel`) | Add three distinct visible actions with separate semantics |
| REQ-CONFIG-03 | Schema exists, loader exists, but settings mostly snapshot at startup | Add persistence + live-apply seams for hot keys |
| Phase 8 SC #5 | Roadmap expects model-role, worker cap, pause timeout, retry cap, re-entry cap edits without restart | Wire missing live application and role-specific consumption |

---

## Architectural Responsibility Map

| Capability | Current owner | Verified basis | 08-05 implication |
|------------|---------------|----------------|-------------------|
| Config schema / validation | `src/config/schema.ts` | Root `GvcConfigSchema` | Reuse directly for editable field set |
| Config load | `src/config/load.ts` | `JsonConfigLoader.load()` | Need save/update API in addition to load |
| Config app bootstrap | `src/compose.ts` | `const config = await new JsonConfigLoader().load()` | Need mutable live-config holder instead of load-once snapshot only |
| Worker concurrency | `src/compose.ts` + `LocalWorkerPool` | `maxWorkers = Math.max(1, os.availableParallelism())` | `workerCap` currently ignored; must be wired |
| Retry policy | `src/runtime/retry-policy.ts` + `LocalWorkerPool` | `buildRetryPolicyConfig(config)` at pool construction | Need pool-level update seam if retryCap is hot-editable |
| Pause hot window | `LocalWorkerPoolOptions.hotWindowMs` | passed at pool construction only | Need mutable setter on runtime/pool |
| Merge-train re-entry cap | `FeatureLifecycleCoordinator` / `MergeTrainCoordinator` | constructor takes `reentryCap`; field is readonly | Need update seam if reentryCap is hot-editable |
| Top planner model | `src/agents/runtime.ts::createTopPlannerAgent` | uses `config.models.topPlanner` | Already wired |
| Task worker model | `PiSdkHarness.forkWorker()` | threads `config.models.taskWorker` to env | Already wired for new workers only |
| Feature planner / verifier models | `src/agents/runtime.ts::createAgent` | uses routing ceiling instead of per-role models | Need explicit role wiring |
| Feature cancel | `cancelFeatureRunWork(...)` + `graph.cancelFeature(...)` | existing end-to-end path | Use as base for feature-abandon branch semantics |
| Task cancel | none | no helper beyond `runtime.abortTask()` + `graph.transitionTask(...)` | Need explicit preserve/clean implementation |
| Worktree cleanup | `GitWorktreeProvisioner.removeWorktree(branch)` | task/feature worktree removal exists | Reuse for clean/abandon actions |

---

## Verified Config Surface

### Schema fields that matter for 08-05
From `src/config/schema.ts`:
```ts
models: z.record(AgentRoleEnum, ModelRefSchema),
workerCap: z.number().int().positive().default(4),
retryCap: z.number().int().positive().default(5),
reentryCap: z.number().int().positive().default(10),
pauseTimeouts: PauseTimeoutsSchema,
retry: RetryConfigSchema,
```

The editable surface already exists at the schema layer. The problem is not “what fields should the menu show?” — the problem is “which of those fields actually drive live behavior today?”

### Loader / source state [VERIFIED]
From `src/config/load.ts`:
```ts
export interface ConfigSource extends ConfigLoader {
  watch(): { close(): void };
}
```
```ts
watch(): { close(): void } {
  return {
    close(): void {
      // Phase-2 no-op. Phase 7 replaces with real fs.watch teardown.
    },
  };
}
```

**Conclusion:** there is no current watch-based hot reload path, and there is no save/write helper in the config layer.

### Compose bootstrap state [VERIFIED]
From `src/compose.ts`:
```ts
const config = await new JsonConfigLoader().load();
```

This config object is then threaded into runtime, agent runtime, scheduler, warnings, and verification as a startup snapshot.

---

## Live-Apply Reality by Setting

### 1. `workerCap` — parsed but not wired [VERIFIED]
From `src/compose.ts`:
```ts
const maxWorkers = Math.max(1, os.availableParallelism());
```

`config.workerCap` is not used here. `getWorkerCounts()` also reports against `maxWorkers`, so both scheduling capacity and UI display currently ignore the configured worker cap.

**Implication:** the config editor cannot truthfully claim worker cap is editable/live until `compose.ts`, `LocalWorkerPool`, and worker-count reporting use the config value.

### 2. `pauseTimeouts.hotWindowMs` — wired but snapshot-only [VERIFIED]
From `src/compose.ts`:
```ts
{
  hotWindowMs: config.pauseTimeouts.hotWindowMs,
}
```
From `src/runtime/worker-pool.ts`:
```ts
interface LocalWorkerPoolOptions {
  hotWindowMs?: number;
}
```
```ts
const hotWindowMs = this.options.hotWindowMs;
```

**Implication:** the knob affects behavior, but only through pool construction. A live-edit path needs a mutable option or setter.

### 3. `retryCap` — wired but snapshot-only [VERIFIED]
From `src/runtime/retry-policy.ts`:
```ts
export function buildRetryPolicyConfig(config: GvcConfig): RetryPolicyConfig {
  return {
    maxAttempts: config.retryCap,
    ...
  };
}
```
From `src/compose.ts`:
```ts
{
  store,
  config: buildRetryPolicyConfig(config),
}
```

**Implication:** retry cap is compiled into the pool’s retry deps at construction. If roadmap success criteria require editing retry cap without restart, `LocalWorkerPool` needs an update seam.

### 4. `reentryCap` — wired but snapshot-only [VERIFIED]
From `src/orchestrator/scheduler/index.ts`:
```ts
this.features = new FeatureLifecycleCoordinator(
  graph,
  ports.config.reentryCap,
);
```
From `src/orchestrator/features/index.ts` / `src/core/merge-train/index.ts`:
```ts
constructor(private readonly graph: FeatureGraph, reentryCap?: number) {
  this.mergeTrain = new MergeTrainCoordinator(reentryCap);
}
```
```ts
readonly reentryCap: number | undefined;
```

**Implication:** the feature lifecycle/merge-train stack captures reentry cap once. A live update needs explicit mutability.

### 5. Model assignments — only partially real [VERIFIED]
Top planner is distinct:
```ts
model: `${this.deps.config.models.topPlanner.provider}:${this.deps.config.models.topPlanner.model}`
```
Task worker is distinct via harness env:
```ts
const modelProvider = this.taskWorkerModel?.provider ?? process.env.GVC0_TASK_MODEL_PROVIDER;
const modelId = this.taskWorkerModel?.model ?? process.env.GVC0_TASK_MODEL_ID;
```

But generic feature phases route through:
```ts
model: this.deps.config.modelRouting?.ceiling ?? this.deps.modelId,
```

**Conclusion:** `models.featurePlanner` and `models.verifier` are present in schema but not distinctly honored. 08-05 needs real per-role agent wiring, not just persistence.

---

## Existing TUI Seams and Gaps

### What exists [VERIFIED]
- command registry / graph keybinds in `src/tui/commands/index.ts`
- slash-command routing in `src/tui/app-composer.ts`
- overlay lifecycle in `src/tui/app-overlays.ts`
- derived view models in `src/tui/view-model/index.ts`
- direct feature cancel command on `x` / `/cancel`

### What is missing [VERIFIED]
From `src/tui/app-deps.ts`, there is currently no API for:
- getting current config values
- updating config values
- saving config to file
- applying config live
- cancelling a task while preserving worktree
- cancelling a task and cleaning worktree
- abandoning a feature branch/worktree

**Conclusion:** 08-05 must extend `TuiAppDeps` before any config editor or visible cancel controls can be honest.

---

## Cancellation Reality and Required Semantics

### Current feature cancel [VERIFIED]
The only shipped cancellation path is feature-level:
- TUI: `cancel_feature` keybind `x` / `/cancel`
- Compose: `cancelFeature(featureId)` enqueues `ui_cancel_feature_run_work`
- Scheduler event handler calls `cancelFeatureRunWork(...)`
- `cancelFeatureRunWork(...)` aborts running tasks, marks related runs cancelled, and calls `graph.cancelFeature(featureId)`

From `src/core/graph/feature-mutations.ts`:
```ts
graph.features.set(featureId, { ...rest, collabControl: 'cancelled' });
```
```ts
if (task.featureId === featureId && task.status !== 'done' && task.status !== 'cancelled') {
  graph.tasks.set(taskId, { ...task, status: 'cancelled' });
}
```

**Important:** this does **not** remove worktrees or delete branches. It is run-state/graph cancellation only.

### Task cancellation [VERIFIED GAP]
There is no `cancelTask(...)` helper in the graph layer and no orchestrator event for task-only cancellation. The only relevant primitives are:
- `runtime.abortTask(taskId)`
- `graph.transitionTask(taskId, patch)`
- `worktree.removeWorktree(branch)`

### FSM allows task cancellation [VERIFIED]
From `src/core/fsm/index.ts`:
```ts
['pending', new Set(['ready', 'cancelled'])],
['ready', new Set(['running', 'cancelled'])],
['running', new Set(['ready', 'done', 'failed', 'stuck', 'cancelled'])],
['stuck', new Set(['ready', 'running', 'failed', 'cancelled'])],
['failed', new Set(['cancelled'])],
```

So task-level cancellation is legal, but not yet wrapped in a domain helper.

### Recommended concrete semantics for 08-05

#### A. `cancel-task-preserve-worktree`
- Abort the live task run if running.
- Mark task status `cancelled`.
- Mark task run `cancelled`.
- **Do not remove task worktree.**
- Preserve task branch/worktree on disk for manual inspection or salvage.

#### B. `cancel-task-clean-worktree`
- Do everything from preserve-worktree.
- Additionally remove the task worktree via `GitWorktreeProvisioner.removeWorktree(resolveTaskWorktreeBranch(task))`.
- Do **not** delete feature branch.
- Task remains cancelled in graph/run state.

#### C. `cancel-feature-abandon-branch`
- Reuse current feature cancellation baseline (`cancelFeatureRunWork(...)`).
- Remove feature worktree if present.
- Remove all task worktrees for tasks in the feature.
- Add branch deletion helper(s) for feature and task branches, then delete them as part of abandonment.
- Mark feature/tasks/runs cancelled in authoritative state.

This makes the three levers truly distinct:
- preserve = keep task worktree
- clean = delete task worktree only
- abandon = cancel entire feature and destroy its branch/worktree footprint

### Branch-deletion gap [VERIFIED]
`GitWorktreeProvisioner` exposes `removeWorktree(...)`, but there is no orchestrator-side helper for deleting git branches. 08-05 will need a safe worktree/branch cleanup helper added to the worktree layer.

---

## Recommended 08-05 Architecture

### 1. Add a mutable live-config owner
A small compose-owned config service is the cleanest way to keep current config authoritative and editable.

Recommended responsibilities:
- hold the current `GvcConfig`
- expose `getConfig()`
- expose `updateConfig(patch or nextConfig)` with schema validation
- persist to `gvc0.config.json`
- fan out live updates to interested subsystems

This can stay local to compose/runtime in 08-05 rather than becoming a general persistence subsystem.

### 2. Add explicit live-update seams instead of relying on watch
Because `ConfigSource.watch()` is still a stub, 08-05 should not pretend there is ambient file watching. The TUI update path should be explicit:
- operator edits config in TUI
- compose validates + writes file
- compose calls runtime/scheduler/agent-runtime update hooks
- TUI reflects updated authoritative values

### 3. Add narrow subsystem setters
Likely update methods needed:
- `LocalWorkerPool.setMaxConcurrency(...)` or equivalent worker-cap setter
- `LocalWorkerPool.updateRetryPolicy(...)`
- `LocalWorkerPool.setHotWindowMs(...)`
- `FeatureLifecycleCoordinator.setReentryCap(...)` or `MergeTrainCoordinator.setReentryCap(...)`
- `PiFeatureAgentRuntime` should read model refs from a mutable source or receive role-model updates

### 4. Keep task/feature cancel actions on the command-first TUI surface
The strongest fit is:
- a **Config overlay** for discoverability and current values
- explicit **slash commands** for editing values quickly
- explicit **visible cancel commands/keybind hints** in the composer/help surface

This matches the rest of Phase 8 better than a complex inline form editor.

---

## Concrete Files Likely to Change

| File | Why it matters |
|------|----------------|
| `src/config/load.ts` | add save/write helper or source abstraction extension |
| `src/config/index.ts` | export any new config persistence types/helpers |
| `src/compose.ts` | install live config owner, extend TUI deps, wire cancel variants |
| `src/tui/app-deps.ts` | expose config get/update + distinct cancel methods |
| `src/tui/view-model/index.ts` | add config menu view models and cancel action summaries |
| `src/tui/components/index.ts` | add config overlay/menu component |
| `src/tui/app-overlays.ts` | add config overlay lifecycle |
| `src/tui/commands/index.ts` | add config command/keybinds and visible cancel commands |
| `src/tui/app-command-context.ts` | wire config/cancel controls into command context |
| `src/tui/app-composer.ts` | route `/config*` and cancel commands |
| `src/tui/app.ts` | refresh config overlay from authoritative state |
| `src/runtime/worker-pool.ts` | add live setters for cap/retry/hot-window; add task cancel helper if owned here |
| `src/runtime/contracts.ts` | expose any new runtime control/update methods |
| `src/runtime/harness/index.ts` | if task-worker model updates need live handoff for future runs |
| `src/agents/runtime.ts` | add real feature-planner / verifier role wiring |
| `src/orchestrator/scheduler/index.ts` | live reentry-cap update seam |
| `src/orchestrator/features/index.ts` | mutable merge-train cap seam |
| `src/core/merge-train/index.ts` | mutable cap field or setter |
| `src/runtime/worktree/index.ts` | branch deletion / feature-abandon helpers |
| `test/unit/tui/commands.test.ts` | slash routing and validation |
| `test/unit/tui/view-model.test.ts` | config overlay/view-model rendering |
| `test/unit/runtime/worker-pool.test.ts` | live config update behavior |
| `test/integration/...` | end-to-end config/cancel semantics |

---

## Existing Patterns to Reuse

| Need | Closest analog | Match quality |
|------|----------------|---------------|
| Config overlay lifecycle | inbox / merge-train / transcript overlays | exact |
| Config view-model derivation | `buildInbox(...)`, `buildMergeTrain(...)`, `buildTaskTranscript(...)` | exact |
| Command-first control surface | existing slash commands + keybind registry | exact |
| Feature cancel entrypoint | existing `cancel_feature` command path | strong |
| Worktree cleanup | `GitWorktreeProvisioner.removeWorktree(...)` | strong |
| Live authoritative refresh | `TuiApp.refresh()` overlay guards | exact |

The weak spot is only the live config application path, not the TUI architecture.

---

## Verification Implications

### High-value focused verification
- `npm run typecheck`
- TUI command tests for `/config`, `/config-set`, `/task-cancel-preserve`, `/task-cancel-clean`, `/feature-abandon`
- worker-pool tests for updated hot-window / retry / concurrency behavior
- agent-runtime tests for per-role model selection
- integration tests for task cancel preserve/clean and feature abandon branch/worktree cleanup

### Smoke lane caveat
`test/integration/tui/smoke.test.ts` remains useful as a template, but the `@microsoft/tui-test` runner is still blocked by the pre-existing SIGSEGV crash and should not be treated as a regression signal for 08-05.

---

## Common Pitfalls

### Pitfall 1: shipping a config menu that edits ignored fields
`workerCap`, `featurePlanner`, and `verifier` are currently the biggest risk here. If 08-05 writes them but runtime ignores them, the TUI becomes dishonest.

### Pitfall 2: claiming hot reload while relying on the no-op watch stub
The current config source does not watch files. 08-05 should use explicit save/apply behavior, not implied background watching.

### Pitfall 3: collapsing the three cancel levers into one implementation
Current feature cancel is graph/run cancellation only. Preserve, clean, and abandon must have distinct worktree/branch outcomes.

### Pitfall 4: deleting branches without a dedicated helper
Worktree removal exists; branch deletion does not. Put branch cleanup in the worktree layer so the feature-abandon path stays explicit and testable.

### Pitfall 5: bypassing task FSM validation
Task cancellation is legal through `transitionTask(..., { status: 'cancelled' })`, but 08-05 should wrap it in a coherent helper instead of scattering ad-hoc transitions.

---

## Recommended Scope Split for the Plan

08-05 should be planned as one coherent slice, but internally it has three subproblems:

1. **Live config plumbing**
   - persistence + mutable config owner
   - runtime/scheduler/agent-runtime update hooks
   - real per-role model wiring

2. **TUI config surface**
   - overlay/view model
   - slash commands / optional keybind
   - current-value rendering and inline notices

3. **Distinct cancel levers**
   - task preserve
   - task clean
   - feature abandon branch/worktrees
   - tests for each semantic branch

That structure keeps the slice grounded in actual seams while still matching the roadmap’s single remaining Phase 8 plan.

---

## Sources

### Primary (HIGH confidence — direct codebase inspection)
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/phases/08-tui-surfaces/08-CONTEXT.md`
- `.planning/phases/08-tui-surfaces/08-PATTERNS.md`
- `src/config/load.ts`
- `src/config/index.ts`
- `src/config/schema.ts`
- `src/compose.ts`
- `src/tui/app-deps.ts`
- `src/tui/app.ts`
- `src/tui/app-overlays.ts`
- `src/tui/commands/index.ts`
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/view-model/index.ts`
- `src/runtime/contracts.ts`
- `src/runtime/worker-pool.ts`
- `src/runtime/harness/index.ts`
- `src/runtime/retry-policy.ts`
- `src/runtime/worktree/index.ts`
- `src/agents/runtime.ts`
- `src/orchestrator/scheduler/index.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/orchestrator/features/index.ts`
- `src/core/merge-train/index.ts`
- `src/core/graph/index.ts`
- `src/core/graph/types.ts`
- `src/core/graph/transitions.ts`
- `src/core/graph/feature-mutations.ts`
- `src/core/fsm/index.ts`
- `src/core/types/workflow.ts`
- `test/unit/tui/commands.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/integration/tui/smoke.test.ts`

---

## Metadata

**Confidence breakdown:**
- Config seam analysis: HIGH
- Runtime live-update gap analysis: HIGH
- Cancel-semantics gap analysis: HIGH
- TUI architecture fit: HIGH
- Verification shape: HIGH

**Research date:** 2026-04-29
**Valid until:** 08-05 implementation begins; if runtime/config seams are changed first, re-check compose/runtime conclusions before coding
