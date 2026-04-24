# Phase 4: Scheduler Tick + Event Queue — Research

**Researched:** 2026-04-24
**Domain:** Serial event queue + scheduler tick + combined-graph metrics + priority sort + reservation-overlap penalty + feature-dep enforcement + dispatcher consolidation
**Confidence:** HIGH (consolidate + verify + gap-fill — existing code is directionally correct, gaps are narrow and specific)

## Summary of Current State

Phase 4's contract is *substantially implemented* across `src/orchestrator/scheduler/*.ts` (1607 LOC, 7 files) and `src/core/scheduling/index.ts` (636 LOC). The work is NOT greenfield. Phase 4's real job is to close 5 narrow gaps, write a test matrix that locks the 5 success criteria, and reconcile the ROADMAP's "6-key" shorthand with the implementation's 8-key reality.

**What already exists (verified file:line):**
- `SchedulerLoop` class with in-memory `events: SchedulerEvent[]` FIFO, drain-to-empty tick, 1000ms poll + `wakeSleep()` plumbing (`src/orchestrator/scheduler/index.ts:84`)
- `SchedulerEvent` discriminated union with 8 cases (`src/orchestrator/scheduler/index.ts:39–81`)
- `handleSchedulerEvent` dispatching across worker_message, feature_phase_{complete,approval_decision,rerun_requested,error}, feature_integration_{complete,failed} (`src/orchestrator/scheduler/events.ts:39–416`)
- `buildCombinedGraph` — virtual pre/post nodes, executing-feature task-node expansion, cross-feature terminal→root wiring (`src/core/scheduling/index.ts:161–319`)
- `computeGraphMetrics` — O(V+E) maxDepth (reverse DP) + distance (forward DP) with cycle-safe memoization (`src/core/scheduling/index.ts:323–403`)
- `CriticalPathScheduler.prioritizeReadyWork` with 8-key sort (`src/core/scheduling/index.ts:511–592`)
- Reservation-overlap penalty at sort key 5, computed per-tick, binary (`src/core/scheduling/index.ts:478–501, 573–578`)
- Runtime-overlap coordination via `claim_lock` handler (`src/orchestrator/scheduler/claim-lock-handler.ts`) and per-tick `coordinateSameFeature/crossFeatureRuntimeOverlaps` (`src/orchestrator/scheduler/overlaps.ts`)
- Dispatcher with `idleWorkers` cap, run-reader sync, task + feature-phase paths (`src/orchestrator/scheduler/dispatch.ts:448–508`)
- Feature-dep merged-gate **exists in `readyFeatures()`** (`src/core/graph/queries.ts:46–57`) — checks `workControl === 'work_complete' && collabControl === 'merged'` on every upstream feature-dep
- Test coverage: 1102 LOC scheduling tests + 5203 LOC scheduler-loop tests (60+ `it()` blocks)

**What the Phase 4 contract demands that is NOT yet in place:**
1. **Boundary test** for criterion 1 — no such test exists; only the core-import boundary test (`test/unit/core/boundary.test.ts`)
2. **Canonical DAG fixture file** — `test/helpers/scheduler-fixtures.ts` does not exist; fixtures are inline in `scheduling.test.ts`
3. **Perf smoke test** — no ~50 feature × ~20 task tick-latency test exists
4. **`enqueue()` does not call `wakeSleep()`** — up-to-1s latency regression vs. CONTEXT decision J
5. **Feature-dep gate on TASK units** — `readyTasks()` (`src/core/graph/queries.ts:65–103`) does NOT check feature's upstream feature-deps merge state (only feature's own `runtimeBlockedByFeatureId`). This is a real correctness gap for criterion 5 when a feature's `workControl` reaches `executing` before upstream feature-deps have merged.
6. **ROADMAP doc reconciliation** — ROADMAP says "6-key order (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age)" but parenthetical enumerates 7 items; implementation has 7 keys + ID tiebreaker
7. **`shutdown` event handler missing** — `SchedulerEvent` union includes `{ type: 'shutdown' }` but `handleSchedulerEvent` has no branch for it; only test code enqueues it
8. **Exhaustiveness assertion** — no `const _: never = event` at the end of `handleSchedulerEvent` to catch future union additions
9. **Direct graph-mutation test-locks** — no integration-style test that asserts a random inline mutation call fails the build

**Delta summary:** the remediation surface is small (~200–400 LOC of new tests + ~50 LOC of production guard/wake/doc changes). No scheduler rewrite.

**Primary recommendation:** follow the CONTEXT-mandated plan split (04-01 queue+boundary, 04-02 metrics+priority+overlap+docs, 04-03 feature-dep+dispatcher+perf). Prioritize the feature-dep task-gate gap (criterion 5) and the boundary test (criterion 1); these are the two places where the current code silently fails the Phase 4 contract.

## User Constraints (from CONTEXT.md)

### Locked Decisions (prior phases / research)
- Serial event queue is the canonical mutation surface; every graph mutation from any source enters a single FIFO; handlers run to completion synchronously on the tick.
- Combined virtual graph: pre-execution features = single weighted nodes; executing features expand to tasks; inter-feature edges route through upstream terminal tasks into downstream root tasks. Already implemented.
- Work-type tier order: `verify > execute > plan > summarize`.
- Milestones are steering buckets, not dependencies; `steeringQueuePosition` is the outermost priority key.
- Reservation overlap is a *penalty*, not a block; runtime overlap via the write pre-hook `claim_lock` round-trip is the *block*.
- Feature deps use the collab-control axis: downstream features wait on upstream's `collabControl === 'merged'`.
- Worker-count cap governs concurrency (REQ-EXEC-05); scheduler respects `ports.runtime.idleWorkerCount()`.
- Core boundary: `src/core/scheduling/*` must not import `@runtime/*`/`@persistence/*`/`@tui/*`.

### Claude's Discretion (auto-answered gray areas)
- **A. Queue shape:** in-memory `SchedulerEvent[]` FIFO inside SchedulerLoop. No SQLite-backed queue.
- **B. Schema location:** `SchedulerEvent` union in `src/orchestrator/scheduler/events.ts` (currently in `index.ts` — see gap 9 below). No runtime validation inside orchestrator; typebox stays at IPC boundary.
- **C. Boundary test:** AST walker + runtime `__enterTick`/`__leaveTick` guard. AST walk in `test/integration/scheduler-boundary.test.ts`.
- **D. Graph rebuild cadence:** fresh every tick. Incremental deferred. Perf smoke ~50 × ~20 asserts tick < 100ms.
- **E. Priority sort keys:** 7 ordered keys + 1 stable ID tiebreaker. Update ROADMAP + lock with test.
- **F. Reservation-overlap penalty:** binary (0/1). Task-only.
- **G. Feature-dep enforcement:** readiness filter (primary) + dispatch-time defensive guard.
- **H. Retry eligibility:** stateless recomputation from persisted run rows; exponential backoff `min(base * 2^attempts, maxDelay)`.
- **I. Dispatch fairness:** no special fairness layer; sort order alone.
- **J. Tick cadence + wake:** 1000ms poll + event-driven wake via `wakeSleep()` on enqueue.
- **K. Overlap computation:** per-tick inside `prioritizeReadyWork`; no cache.
- **L. Keep existing scheduler code and tighten; no rewrite.**
- **M. Feature-phase vs. task dispatch split retained.**

### Deferred Ideas (OUT OF SCOPE)
- Incremental combined-graph rebuild.
- Multi-tier/proportional reservation-overlap penalty.
- Aging-bonus anti-starvation layer.
- Cross-milestone preemption.
- Per-feature round-robin fairness cap.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-EXEC-05 (scheduler side) | Global worker-count cap governs concurrent parallelism | `dispatch.ts:463` reads `ports.runtime.idleWorkerCount()`; cap lives in `config.workerCap` (schema.ts:156). Dispatch loop break at `dispatch.ts:481` respects the cap. Test `dispatches only up to idle worker capacity` at scheduler-loop.test.ts:907 already covers. Phase 4 verifies this + feature-phase path. |
| REQ-EXEC-06 | Feature dependencies enforce "wait for merge to main" semantics | `readyFeatures()` at queries.ts:46–57 gates on `work_complete + merged`. `readyTasks()` at queries.ts:65–103 does NOT gate on upstream feature-dep merge state — **this is the gap to close in plan 04-03** (see § Per-Criterion 5 below). |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Event queue FIFO | Orchestrator | — | Single mutation serializer; not a pure core concept |
| Combined-graph construction | Core (scheduling) | — | Pure derivation from `FeatureGraph`; no I/O |
| Critical-path metrics | Core (scheduling) | — | Pure DP pass; no I/O |
| Priority sort | Core (scheduling) | — | Pure function over graph + metrics + run reader |
| Reservation-overlap penalty | Core (scheduling) | — | Read-only over `task.reservedWritePaths` |
| Runtime-overlap routing | Orchestrator | Runtime (port) | Requires runtime port + conflict coordinator |
| Dispatch loop | Orchestrator | Runtime (port) | Calls `runtime.dispatchTask`, `runtime.runFeaturePhase` (via `ports.verification`/`ports.agents`) |
| Feature-dep readiness filter | Core (graph queries) | Core (scheduling) | Part of `readyTasks()`/`readyFeatures()` — stays in core |
| Tick loop + wake | Orchestrator | — | Owns `setTimeout` + `wakeSleep` |
| Boundary test | Test infrastructure | — | Walks `src/**` — tooling concern |

## Standard Stack

### Core (already in repo, no new deps required)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typescript` | ^5.9.3 | AST walker compiler API for boundary test | Already a dev dep; provides `ts.createSourceFile` + `ts.forEachChild` for node walking. No need for `ts-morph`. |
| `vitest` | ^4.1.4 | Test framework for all new tests | Project standard (CLAUDE.md) |
| `zod` | ^4.3.6 | Config schema (`retry.baseDelayMs`, `retry.maxDelayMs`, `retryCap`) | Already used at `src/config/schema.ts`; no change needed — the retry config schema landed in Phase 3 plan 03-03 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| TypeScript compiler API (built-in) | `ts-morph` | ts-morph is a nicer wrapper but adds ~15MB dep and buys nothing for a ~30-line AST walker. The existing `test/unit/core/boundary.test.ts` uses plain `readFileSync` + regex; the new mutation-boundary test can use `typescript.createSourceFile` + a short recursive walker. `[VERIFIED: package.json has no ts-morph; typescript 5.9.3 present]` |
| SQLite-backed event queue | in-memory FIFO | Locked by CONTEXT gray area A. Research `ARCHITECTURE.md:99` validates in-memory. SQLite queue reintroduces fsync into hot path. |
| Incremental combined-graph rebuild | fresh-per-tick | Locked by CONTEXT gray area D. Threshold is ~200 nodes (PITFALLS.md:297); v1 stays under with ~50 × ~20 = ~1000 task-nodes worst case actually exceeds — but we can measure, and if perf smoke fails we gate behind LOAD_TEST. |
| `@sinclair/typebox` runtime validation of SchedulerEvent | TS discriminated union only | Locked by CONTEXT gray area B. Events originate inside trusted code; IPC boundary already validates. |

**Installation:** none — no new deps required.

**Version verification:**
```bash
node -e "console.log(require('typescript').version)"  # 5.9.3 — verified 2026-04-24
```

## Architecture Patterns

### System Architecture Diagram (scheduler scope only)

```
               ┌─────────────────────────────────────────────────┐
               │           Event sources (enqueue)               │
               │  ─────────────────────────────────────────────  │
               │  • Worker IPC (compose.ts onTaskComplete)       │
               │  • Feature-phase completion (dispatch.ts)       │
               │  • TUI approval/rerun (compose.ts callbacks)    │
               │  • Feature integration (merge-train Phase 6)    │
               └─────────────────────┬───────────────────────────┘
                                     │ enqueue()
                                     ▼
                     ┌──────────────────────────────┐
                     │   events: SchedulerEvent[]   │  ← FIFO, in-memory
                     │   (SchedulerLoop member)     │
                     └──────────────┬───────────────┘
                                    │ tick(now)
                                    ▼
           ┌──────────────────────────────────────────────────┐
           │               handleEvent (serial drain)         │
           │  while (events.length) handleSchedulerEvent(...) │
           │  • Mutates graph through __enterTick guard       │
           │  • Updates Store / AgentRun status               │
           │  • Enqueues follow-up events                     │
           └──────────────────────────┬───────────────────────┘
                                      ▼
           ┌──────────────────────────────────────────────────┐
           │  summaries.reconcilePostMerge()                  │
           │  features.beginNextIntegration()                 │
           │  coordinateSameFeatureRuntimeOverlaps()          │
           │  coordinateCrossFeatureRuntimeOverlaps()         │
           │  emitWarningSignals(now)                         │
           └──────────────────────────┬───────────────────────┘
                                      ▼
           ┌──────────────────────────────────────────────────┐
           │              dispatchReadyWork(now)              │
           │  1. Check autoExecutionEnabled                   │
           │  2. idleWorkers = runtime.idleWorkerCount()      │
           │  3. ready = prioritizeReadyWork(...)             │
           │     ├─ buildCombinedGraph()  ← fresh every tick  │
           │     ├─ computeGraphMetrics() ← O(V+E)            │
           │     ├─ filter blocked runs + feature-dep gate    │
           │     └─ sort by 7 keys + ID tiebreaker            │
           │  4. for unit of ready.slice(0, idleWorkers):     │
           │       dispatchTaskUnit | dispatchFeaturePhaseUnit│
           └──────────────────────────┬───────────────────────┘
                                      ▼
                     ui.refresh() if fingerprint changed
```

### Recommended Project Structure (existing; keep)

```
src/
├── core/scheduling/index.ts        # pure: buildCombinedGraph, metrics, priority sort
├── core/graph/queries.ts           # readyFeatures/readyTasks — feature-dep gate lives here
├── orchestrator/scheduler/
│   ├── index.ts                    # SchedulerLoop class + SchedulerEvent union
│   ├── events.ts                   # handleSchedulerEvent (big switch)
│   ├── dispatch.ts                 # dispatchReadyWork + dispatchTaskUnit + dispatchFeaturePhaseUnit
│   ├── overlaps.ts                 # coordinateSame/CrossFeatureRuntimeOverlaps (runtime overlap routing)
│   ├── active-locks.ts             # ActiveLocks registry for claim_lock
│   ├── claim-lock-handler.ts       # claim_lock message → ActiveLocks → conflictCoordinator
│   ├── helpers.ts                  # normalizeReservedWritePath, rankCrossFeaturePair
│   └── warnings.ts                 # warning signal emission helpers
test/
├── unit/core/scheduling.test.ts         # 1102 LOC — baseline
├── unit/orchestrator/scheduler-loop.test.ts  # 5203 LOC — baseline
├── helpers/scheduler-fixtures.ts   # ← NEW: canonical DAG fixtures (plan 04-02)
└── integration/scheduler-boundary.test.ts  # ← NEW: AST boundary test (plan 04-01)
```

### Pattern 1: Discriminated union + exhaustiveness assertion
**What:** Every `SchedulerEvent` type handled in `handleSchedulerEvent` via `if (event.type === ...)` chain; final `const _: never = event` statement proves exhaustiveness at compile time.
**When to use:** for the current 8 cases + all future Phase 5/7/9 additions.
**Example:**
```typescript
// At the end of handleSchedulerEvent, after all cases:
// (Phase 4 adds this — currently the function just falls through)
const _exhaustive: never = event;
void _exhaustive;
```
This is how Phase 5 will safely add `feature_plan_tool_call` etc. — compilation fails if a new variant is unhandled.

### Pattern 2: Fresh-per-tick combined graph
**What:** `dispatch.ts:473` calls `computeGraphMetrics(buildCombinedGraph(params.graph))` inline. No memoization.
**When to use:** always, until the ~200 node threshold (PITFALLS.md:297). Phase 4 measures.

### Pattern 3: Readiness filter pattern
**What:** Pure graph queries in `src/core/graph/queries.ts` filter to dispatchable units; scheduler sorts. Filters are "what's eligible"; sort is "what's preferred."
**When to use:** feature-dep gate belongs in the filter, not the sort. Gray area G picks readiness filter (primary) + dispatcher defensive re-check.

### Anti-Patterns to Avoid
- **Mutating graph outside a scheduler tick (bypassing the queue).** PITFALLS.md:273 "never" rank. Boundary test enforces.
- **Caching combined-graph across ticks.** Correctness risk; defer to v2.
- **Using `setImmediate`/`queueMicrotask` to "process events faster."** Undermines FIFO — a single drain-to-empty per tick is the contract.
- **Adding per-feature fairness caps.** Locked out by gray area I; conflicts with "max parallelism at every level."
- **Computing priority sort keys that reference `collabControl`.** Gray area G — keep sort pure; gate in filter.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| AST walker for boundary test | custom tokenizer/regex over TS source | `typescript.createSourceFile` + `ts.forEachChild` | Regex misses variable aliases (`const g = this.graph; g.transitionTask(...)`); proper AST walk resolves through identifiers. |
| Debouncing enqueue + wake | hand-written debouncer | existing `wakeSleep?.()` invocation in `enqueue()` | Current code already has `wakeSleep` pointer at `index.ts:94`; just call it from `enqueue()`. Trivial wiring, no new abstraction. |
| Percentile computation for perf smoke | math library | simple sort + index | `p95 = arr.sort((a,b)=>a-b)[Math.floor(arr.length*0.95)]`; no dep. Perf samples are ≤ 1000 — O(n log n) is fine. |
| Retry backoff timer | wake timer per backoff | recompute `isRetryEligible` every tick | Gray area H. Tick cadence (1s) + exponential backoff (>= 250ms baseline) means eligibility is recomputed frequently enough. No retry-specific event type. |
| Test mocks for FeatureGraph | partial Record mocks | `InMemoryFeatureGraph` from `@core/graph/index` | Existing tests already do this (`graph-builders.ts`); extend with a `scheduler-fixtures.ts` helper for canonical DAG shapes. |

**Key insight:** the scheduler domain has already done the "don't hand-roll" work — `InMemoryFeatureGraph`, `CriticalPathScheduler`, `ActiveLocks`, `ConflictCoordinator`, and `LocalWorkerPool` are all in place. Phase 4 is about testing what exists and closing narrow gaps, not building new abstractions.

## Per-Criterion Gap Analysis

### Criterion 1: All graph mutations flow through the single serial event queue; boundary test fails if any mutation bypasses it.

**Current state (verified):** NO boundary test exists. Mutation sites across `src/` — 72 total:

| File | Count | In-tick? | Notes |
|------|-------|----------|-------|
| `src/orchestrator/features/index.ts` | 14 | YES (`FeatureLifecycleCoordinator` called from `events.ts` / `dispatch.ts` / `tick()`) | All inside tick via coordinators |
| `src/compose.ts` | 12 | BOOT + TUI-triggered | Bootstrap `initializeProjectGraph` (lines 309–323, 332–343) runs before `scheduler.run()`. `toggleMilestoneQueue` (lines 84–87) and `cancelFeatureRunWork` (line 394) run from TUI callbacks — these bypass the queue today |
| `src/core/proposals/index.ts` | 11 | YES (called from `approveFeatureProposal` in `events.ts`) | Inside tick via approval event handler |
| `src/core/merge-train/index.ts` | 7 | YES (called from `FeatureLifecycleCoordinator`) | Inside tick |
| `src/orchestrator/summaries/index.ts` | 6 | YES | `SummaryCoordinator.reconcilePostMerge` called at `index.ts:195` |
| `src/orchestrator/proposals/index.ts` | 6 | YES (event handler) | Inside tick |
| `src/orchestrator/conflicts/same-feature.ts` | 4 | YES | Overlap coordination is per-tick |
| `src/orchestrator/conflicts/cross-feature.ts` | 4 | YES | Overlap coordination is per-tick |
| `src/agents/runtime.ts` | 3 | **NO** (called from agent completion inline — not through queue) | `PiFeatureAgentRuntime.discussFeature` / `researchFeature` etc. mutate graph at lines 427/436/444 during the phase-agent await — this IS bypassing the queue |
| `src/orchestrator/scheduler/index.ts` | 2 | YES | `markTaskRunning` / `markFeaturePhaseRunning` — dispatch hook |
| `src/orchestrator/scheduler/events.ts` | 2 | YES | task transitions on worker result/error |
| `src/orchestrator/services/budget-service.ts` | 1 | unknown — check call site | `replaceUsageRollups` |

**Gap vs. contract:**
1. No automated assertion that new mutation call sites route through the queue — a Phase 5/6/7 engineer adding a mutation inline would not be caught by CI.
2. `src/agents/runtime.ts:427,436,444` ARE bypasses today — but they run during the `await ports.agents.*` call inside `dispatchFeaturePhaseUnit`, which is itself inside the tick. The mutations happen *during* the agent's async call, which from the scheduler's perspective is opaque. These need to either (a) be on the allowlist as a legitimate in-tick async path, or (b) be refactored to emit a result event and let the tick apply the mutation.
3. Bootstrap (`initializeProjectGraph`) happens before `scheduler.run()` — legitimate, must be on allowlist.
4. TUI callbacks (`toggleMilestoneQueue`, `cancelFeature`) happen outside any tick — these are the real bypasses to either route through `enqueue()` or allowlist.

**Concrete remediation approach:**
1. **AST walker** at `test/integration/scheduler-boundary.test.ts`:
   - Use `typescript.createSourceFile` with `ScriptTarget.ESNext`.
   - Walk all `.ts` files under `src/` (exclude `*.test.ts`, `*.spec.ts`).
   - For each `CallExpression` whose target is a `PropertyAccessExpression` with `name.text` in the set of mutation method names (see § Mutation Method Inventory below), capture `fileName:line:column`.
   - Intersect against an allowlist JSON file at `test/integration/scheduler-boundary-allowlist.json`:
     ```json
     {
       "src/compose.ts": ["initializeProjectGraph", "transitionFeatureToPlanning", "cancelFeatureRunWork", "toggleMilestoneQueue"],
       "src/core/proposals/index.ts": ["applyProposalOps"],
       "src/core/merge-train/index.ts": ["*"],
       "src/orchestrator/features/index.ts": ["*"],
       "src/orchestrator/summaries/index.ts": ["*"],
       "src/orchestrator/proposals/index.ts": ["*"],
       "src/orchestrator/conflicts/same-feature.ts": ["*"],
       "src/orchestrator/conflicts/cross-feature.ts": ["*"],
       "src/orchestrator/scheduler/dispatch.ts": ["markTaskRunning", "markFeaturePhaseRunning"],
       "src/orchestrator/scheduler/events.ts": ["*"],
       "src/orchestrator/scheduler/index.ts": ["markTaskRunning", "markFeaturePhaseRunning"],
       "src/orchestrator/services/budget-service.ts": ["*"],
       "src/agents/runtime.ts": ["editFeature_during_phase_agent"]
     }
     ```
   - Error message (per CONTEXT "Specific Ideas"): `"graph mutation at <file>:<line>:<col> bypasses the event queue — route through SchedulerLoop.enqueue() or add to test/integration/scheduler-boundary-allowlist.json"`.

2. **Runtime guard** on `InMemoryFeatureGraph` (no observable side effect in production):
   ```typescript
   // src/core/graph/index.ts — add to InMemoryFeatureGraph
   private _inTick = 0;
   __enterTick(): void { this._inTick++; }
   __leaveTick(): void { this._inTick = Math.max(0, this._inTick - 1); }
   private _assertInTick(method: string): void {
     if (!process.env.GVC_ASSERT_TICK_BOUNDARY) return;  // gated — no prod overhead
     if (this._inTick === 0) {
       throw new Error(`FeatureGraph.${method}() called outside tick — bypass of event queue`);
     }
   }
   ```
   Each mutation method calls `this._assertInTick('createTask')` (etc.) — but ONLY in test/dev when `GVC_ASSERT_TICK_BOUNDARY=1`. Prod path has zero cost.
   `SchedulerLoop.tick()` wraps the drain + dispatch body in `graph.__enterTick() / __leaveTick()`.
   A dedicated vitest integration test at `test/integration/scheduler-tick-guard.test.ts` sets the env var and asserts mutations through the tick body succeed + direct mutations throw.

3. **Combined strategy:** AST walk is static (catches new regressions in code review); runtime guard is dynamic (catches paths reached only at runtime, e.g., via callback closures). Both are cheap.

**Risks / pitfalls:**
- **AST walker false-negatives via aliases** (`const g = this.graph; g.transitionTask(...)`). Mitigate by also matching `PropertyAccessExpression` whose `.name.text` is a mutation method AND whose `.expression` resolves to an identifier of type-annotated `FeatureGraph` (use `ts.TypeChecker` — a real one, not heuristic).
- **Callbacks inside agent runs legitimately mutate** (`src/agents/runtime.ts`). These run during an `await` that IS inside the tick body, so the runtime guard passes. The AST walker must allowlist them explicitly.
- **Allowlist rot.** Every time a mutation site is added, allowlist must update — error message must name the allowlist file to make the fix path obvious (CONTEXT "Specific Ideas").

**Mutation Method Inventory (for AST walker):**
```typescript
const MUTATION_METHODS = new Set([
  'createMilestone', 'createFeature', 'createTask',
  'addDependency', 'removeDependency',
  'splitFeature', 'mergeFeatures',
  'cancelFeature', 'removeFeature',
  'changeMilestone', 'editFeature',
  'addTask', 'editTask', 'removeTask',
  'reorderTasks', 'reweight',
  'queueMilestone', 'dequeueMilestone', 'clearQueuedMilestones',
  'transitionFeature', 'transitionTask',
  'updateMergeTrainState', 'replaceUsageRollups',
]);
```
(23 methods total — verified from `src/core/graph/types.ts:157–193`.)

### Criterion 2: Combined-graph critical-path metrics match expected values on canonical test DAGs.

**Current state (verified):** `computeGraphMetrics` has unit tests at `test/unit/core/scheduling.test.ts:350–527` covering:
- `maxDepth` for linear graph (line 351)
- `maxDepth` for diamond graph (line 386)
- `distance` for linear graph (line 431)
- `distance` with max across predecessors (line 466)
- Single-node graph (line 511)

Fixtures are inline in the test file, not reusable.

**Gap vs. contract:**
- No `parallel-siblings` fixture.
- No `deep-nested` fixture (chain of >4 features, multiple tasks each).
- No `mixed feature+task` cross-layer fixture (pre-execution feature depended on by executing feature, etc.).
- No shared `test/helpers/scheduler-fixtures.ts` — fixtures are not reusable by plan 04-03 perf smoke or Phase 5/9 tests.
- **CONTEXT "Specific Ideas":** fixtures should be reusable by Phase 5 verify-agent tests and Phase 9 crash-recovery tests — so they must live in `test/helpers/` not inline.

**Concrete remediation approach:**

Create `test/helpers/scheduler-fixtures.ts` exporting:

| Fixture | Shape | Expected `maxDepth` (medium weight = 10) | Expected `distance` |
|---------|-------|------------------------------------------|---------------------|
| `diamond(size=4)` | t-1 → {t-2, t-3} → t-4 | t-1: 30, t-2/3: 20, t-4: 10 | t-1: 0, t-2/3: 10, t-4: 20 |
| `linearChain(n=5)` | t-1 → t-2 → t-3 → t-4 → t-5 | t-1: 50, t-2: 40, ..., t-5: 10 | t-1: 0, t-2: 10, ..., t-5: 40 |
| `parallelSiblings(k=4)` | t-1 → {t-2..t-5} | t-1: 20, t-2..5: 10 | t-1: 0, t-2..5: 10 |
| `deepNested(depth=3)` | 3 features chained, 3 tasks each, terminal→root wiring | maxDepth of root of f-1 includes weights of all features' tasks | distance tracks per feature |
| `mixedFeatureTask` | f-a (pre-exec, virtual node) → f-b (executing, expanded tasks) | virtual:f-a: sum(f-a task weights) + maxDepth of f-b root task | distance 0 for root virtual node |
| `prePostMixed` | f-a (executing) + f-b (post-execution, virtual:post) depending on f-a terminals | cross-layer wiring | |

Each fixture returns `{ graph: InMemoryFeatureGraph, expectedMetrics: Map<string, NodeMetrics> }`. Tests call `computeGraphMetrics(buildCombinedGraph(graph))` and assert per-node.

**Risks / pitfalls:**
- **Weight default drift.** Tasks default to `'medium'` = 10 (`TASK_WEIGHT_VALUE.medium`). Fixtures MUST explicitly set weights or document default.
- **Post-execution virtual-node ID scheme.** Current code at `scheduling/index.ts:179–181` uses `virtual:<featureId>:post` for post, `virtual:<featureId>` for pre. Fixtures + expected-metric maps must match.
- **Pre-execution weight includes task count.** `scheduling/index.ts:186–195` sums task weights into the virtual node; if tasks haven't been created yet, default = medium. Fixtures with no tasks must expect `TASK_WEIGHT_VALUE.medium`.

### Criterion 3: Priority sort obeys the documented key order (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age + stable ID tiebreaker).

**Current state (verified):** Implementation has 8 keys at `src/core/scheduling/index.ts:512–591`:
1. Milestone queue position (line 513)
2. Work-type tier (line 534)
3. Critical-path maxDepth (line 553)
4. Partially-failed deprioritization (line 564)
5. Reservation-overlap penalty (line 573)
6. Retry-eligible before fresh (line 580)
7. Readiness age (line 585)
8. ID tiebreaker (line 588) — alphabetical `localeCompare`

This matches CONTEXT gray area E exactly: **7 semantic keys + 1 stable ID tiebreaker**.

Existing tests at `test/unit/core/scheduling.test.ts:529–871` cover keys 1–7 + 8 individually:
- Key 1 milestone (line 530)
- Key 2 work-type tier (line 570)
- Key 3 critical-path (line 606)
- Key 4 partial-failed (line 651)
- Key 5 reservation overlap (line 689)
- Key 6 retry-eligible (line 743)
- Key 7 age stable (line 790)
- Key 8 ID tiebreaker (line 833)

**Gap vs. contract:**
- No single "full key order" test that asserts all 8 keys fire in the right sequence on a richly-ambiguous fixture (CONTEXT gray area E: "lock the exact order against a canonical fixture").
- ROADMAP line 87 says "6-key order (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age)" but that parenthetical enumerates 7 items. Doc is miscounted.
- `docs/architecture/graph-operations.md:207–216` documents 7 keys — correct but doesn't call out the ID tiebreaker.

**Concrete remediation approach:**

1. **New unit test** `locks the 7-key + ID-tiebreaker order`:
   - Fixture: 9 schedulable units constructed such that changing *any one* key's value changes the resulting sort position of one pair — and nothing else. Each pair tests exactly one key in isolation.
   - Assert the full ordered list matches an expected array (exact string IDs).
   - This is the "regression-proof" test — any future key reorder or addition shows up as a diff on a single string array.
   - Place in `test/unit/core/scheduling.test.ts` under a new `describe('priority key order — canonical 7+1 fixture')`.

2. **ROADMAP.md doc fix** (plan 04-02 final task):
   - Phase 4 Success Criterion 3: "Priority sort obeys the documented key order (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age + stable ID tiebreaker)" — 7 semantic keys + 1 ID tiebreaker. Matches CONTEXT already.
   - `docs/architecture/graph-operations.md:207–216` — add row 8 for ID tiebreaker.

3. **Retry eligibility correctness adjacency (gray area H):** current `isRetryEligible` at `scheduling/index.ts:609–614` checks `task.status === 'stuck' || task.status === 'failed'` — it does NOT check `retry_await` runStatus + `retryAt` timing. This is divergent from CONTEXT gray area H which defines eligibility via `AgentRun.runStatus === 'retry_await' && retryAt <= now && attempts < cap`. Check this tension — whether the task.status path IS the right signal here, or whether the sort key should delegate to the run reader. Verify with the planner; might be a separate correction in 04-03.

**Risks / pitfalls:**
- **Key 6 retry semantics drift.** `isBlockedByRun` at `scheduling/index.ts:405–418` excludes `retry_await` tasks whose `retryAt > now` from the ready list entirely — so by the time a task reaches the sort, it IS retry-eligible. The sort's "retry vs fresh" key then only distinguishes retry-eligible stuck/failed tasks from healthy fresh tasks. This might be correct but the semantics need a comment.
- **Over-coupling sort to run-reader.** Sort currently reads from `run` minimally (key 6 is implicit via status). Keep sort pure — don't add another runReader.getExecutionRun call in the sort body.

### Criterion 4: Reservation overlap applies scheduling penalty but does not block; runtime overlap (write pre-hook) routes to coordination.

**Current state (verified):**
- **Reservation-overlap penalty (correct, binary, per-tick):** `scheduling/index.ts:478–501` computes `overlappingTaskIds` per tick inside `prioritizeReadyWork`; sort key 5 at line 573 applies `1` for overlapping tasks, `0` otherwise. Non-blocking by construction: overlapping tasks stay in the `units` array and can still dispatch if higher-priority work drains.
- **Runtime-overlap routing (correct, push-based):** `claim-lock-handler.ts` handles `claim_lock` messages. On denial, routes to `ConflictCoordinator.handleSameFeatureOverlap` or `handleCrossFeatureOverlap` (lines 111–203). Separately, `overlaps.ts` runs on every tick to catch overlaps that missed the push path (e.g., two already-running tasks whose reservations weren't checked at dispatch).

**Gap vs. contract:**
- No single integration test that directly demonstrates the *invariant*: reservation overlap → sort penalty (not filter); runtime overlap → coordinator path. Both paths have separate tests today.
- The existing test `deprioritizes items with reservation overlap` at `scheduling.test.ts:689` asserts the sort penalty but does not assert that the overlapping task STILL DISPATCHES when there's capacity beyond the non-overlapping items.
- Need a test: "reservation-overlapping task dispatches when only overlapping work remains" — ensures the penalty is not accidentally a block.

**Concrete remediation approach:**

1. **Integration test** `reservation overlap is penalty, not block` at `test/unit/core/scheduling.test.ts`:
   - Two tasks, both ready; both reserve the same path; both have identical priority on keys 1–4.
   - With `idleWorkers = 2`, both dispatch (penalty doesn't remove from ready list).
   - With `idleWorkers = 1`, the one whose ID sorts first by key 8 dispatches; the other stays ready.

2. **Integration test** `runtime overlap routes via claim_lock, not penalty`:
   - Simulate a running task holding a path lock via `ActiveLocks.tryClaim`.
   - A second task's worker sends `claim_lock` for the same path.
   - Assert: the second task is NOT added to `runtimeBlockedByFeatureId` filter via reservation; it goes through the conflictCoordinator call path.

3. **Existing tests to leave in place (they cover correctly):**
   - `suspends lower-priority running tasks when same-feature runtime overlap appears` (scheduler-loop.test.ts:1143)
   - `suspends only overlapping component inside same feature` (scheduler-loop.test.ts:1193)

**Risks / pitfalls:**
- **The two overlap detectors (tick-based at `overlaps.ts` and push-based at `claim-lock-handler.ts`) can double-fire.** If a push-based claim_lock denial runs in the same tick that the tick-based coordinator also detects the overlap, could they trigger two `conflicts.handleSameFeatureOverlap` calls? Review the idempotency of `ConflictCoordinator.handleSameFeatureOverlap`. (Not a Phase 4 bug to fix, but flag for the test design.)

### Criterion 5: Feature deps enforce "wait for merge to main" — downstream feature dispatches only after upstream's `collab=merged`.

**Current state (verified — THIS IS THE BIGGEST GAP):**

`readyFeatures()` at `src/core/graph/queries.ts:46–57`:
```typescript
for (const depId of feature.dependsOn) {
  const dep = graph.features.get(depId);
  if (
    dep === undefined ||
    dep.workControl !== 'work_complete' ||
    dep.collabControl !== 'merged'
  ) {
    allDepsDone = false;
    break;
  }
}
```
✓ Already correctly gates feature-phase dispatch on upstream `work_complete + merged`.

`readyTasks()` at `src/core/graph/queries.ts:65–103`:
```typescript
// Current logic:
// - task.status === 'ready'
// - task.collabControl !== 'suspended'/'conflict'
// - feature.collabControl !== 'cancelled'
// - feature.runtimeBlockedByFeatureId === undefined (or repair-source exception)
// - task's own task-deps done
//
// MISSING: feature's upstream feature-dep merged-gate.
```
✗ Does NOT check `feature.dependsOn[*].workControl === 'work_complete' && collabControl === 'merged'`.

**Why this is a real gap:** A downstream feature's `workControl` can transition from `planning` → `executing` (via proposal approval or FSM transition) without the FSM checking upstream feature-dep merge state. Once in `executing`, its tasks become ready. `readyTasks()` returns them. Dispatch happens. The "wait for merge to main" invariant is broken at the task layer.

Whether this actually happens in practice depends on whether `FeatureLifecycleCoordinator` or other transitioners ever push a feature to `executing` before upstream deps merge. The safest interpretation: gate tasks explicitly; don't rely on the transition path.

**CONTEXT "Specific Ideas":** `"Feature-dep readiness filter: should short-circuit on any upstream collabControl !== 'merged' (not just 'rebased' or 'integrating') — the only dispatch-unblocking collab state is merged."` confirms this reading.

**Concrete remediation approach:**

1. **Readiness filter (primary) — `src/core/graph/queries.ts:readyTasks`:**
   Add upstream-feature merged gate:
   ```typescript
   // Inside readyTasks, after existing feature.runtimeBlockedByFeatureId check:
   let upstreamFeaturesMerged = true;
   for (const depFeatureId of feature.dependsOn) {
     const depFeature = graph.features.get(depFeatureId);
     if (
       depFeature === undefined ||
       depFeature.workControl !== 'work_complete' ||
       depFeature.collabControl !== 'merged'
     ) {
       upstreamFeaturesMerged = false;
       break;
     }
   }
   if (!upstreamFeaturesMerged) continue;
   ```
   This is the exact pattern from `readyFeatures()` applied at the task layer.

2. **Dispatch-time defensive guard — `src/orchestrator/scheduler/dispatch.ts:dispatchReadyWork`:**
   Before `dispatchTaskUnit(...)` or `dispatchFeaturePhaseUnit(...)`, re-assert invariant:
   ```typescript
   function hasUnmergedFeatureDep(graph: FeatureGraph, featureId: FeatureId): boolean {
     const feature = graph.features.get(featureId);
     if (!feature) return false;
     for (const depId of feature.dependsOn) {
       const dep = graph.features.get(depId);
       if (!dep || dep.workControl !== 'work_complete' || dep.collabControl !== 'merged') {
         return true;
       }
     }
     return false;
   }
   // Inside dispatch loop:
   const featureId = unit.kind === 'task' ? unit.featureId : unit.feature.id;
   if (hasUnmergedFeatureDep(params.graph, featureId)) {
     console.warn(`[scheduler] refusing to dispatch ${schedulableUnitKey(unit)} — upstream feature-dep not merged`);
     continue;  // defensive — filter already caught this; log and skip, don't throw
   }
   ```
   CONTEXT gray area G: "logs and no-ops rather than throwing".

3. **Tests:**
   - `test/unit/core/scheduling.test.ts`: Two-feature chain fixture; upstream at `workControl=executing` / `collabControl=branch_open` — downstream tasks NOT ready. Flip upstream to `work_complete + merged` — downstream tasks become ready on the next call.
   - Same shape across all collab-control intermediate states: `branch_open`, `merge_queued`, `integrating`, `rebased`, `conflict`, `cancelled` — in ALL of these, downstream tasks remain blocked. Only `merged` unblocks.
   - `test/unit/orchestrator/scheduler-loop.test.ts`: add a "dispatch-time guard log" test — if a unit somehow slips through the filter (synthetic: directly invoke dispatcher with a stale graph), assert it's logged and skipped.

**Risks / pitfalls:**
- **Double-filtering cost.** `readyTasks()` iterates `graph.tasks.values()` and may add O(deps) per feature lookup. At ~50 × ~20 scale, this is ~1000 tasks × ~5 deps = ~5000 map lookups per tick — well under 1ms. Not a concern.
- **Cancelled upstream features.** If `dep.collabControl === 'cancelled'`, the downstream SHOULD NOT be forever blocked. Current `readyFeatures()` logic treats `cancelled` the same as "not merged". This matches the CONTEXT "Specific Ideas" literally ("only 'merged' unblocks") but means downstream features are deadlocked if upstream is cancelled. **This is out of scope for Phase 4** — it's a Phase 7 (cancellation cascade) or Phase 10 (re-plan flows) concern. Phase 4 should match existing `readyFeatures()` behavior and flag the semantic question for the planner.
- **Re-plan / top-level additive merges.** REQ-PLAN-03 says re-invoking the planner is additive. If a new feature is added with a dep on an already-merged feature, `readyTasks()` will correctly unblock its tasks. No special handling needed.

## Runtime State Inventory

N/A — Phase 4 is a consolidate + gap-fill phase. No rename/migration. Skip.

## Common Pitfalls

### Pitfall 1: `enqueue()` does not call `wakeSleep()` — up to 1s event latency
**What goes wrong:** A TUI callback enqueues an approval decision; the user sees the decision take up to 1s to apply. Perceived-lag regression vs. the intent of gray area J.
**Why it happens:** `SchedulerLoop.enqueue()` at `index.ts:118–120` is a simple `this.events.push(event)`. The `wakeSleep` pointer exists but is only set to `undefined` inside `sleep()` — never called to wake the loop.
**How to avoid:** Add `this.wakeSleep?.()` to `enqueue()`. Trivial — ~2 LOC.
**Warning signs:** Tests using `vi.useFakeTimers()` already bake in the 1s latency; they don't currently exercise an "enqueue wakes the loop" assertion. Plan 04-01 adds this test.

### Pitfall 2: `shutdown` event is declared but never handled
**What goes wrong:** Code enqueues `{ type: 'shutdown' }` (tests do this at scheduler-loop.test.ts:408, 595); handler falls through all `if` branches silently. No error, no shutdown. Relies on `this.running = false` path via `stop()`.
**Why it happens:** Placeholder added when the SchedulerEvent union was originally designed; no production enqueue site was ever added.
**How to avoid:** Either (a) remove `shutdown` from the union (tests would need update) or (b) add an explicit branch in `handleSchedulerEvent` that `this.running = false`. Gray area B says no runtime validation but DOES expect exhaustiveness — with the `const _: never = event` pattern, the missing branch is a compile error today if we add the assertion. Recommend option (b) + exhaustiveness assertion.
**Warning signs:** Silent test pass at scheduler-loop.test.ts:595 shows this today.

### Pitfall 3: `autoExecutionEnabled` defaults `true` but compose.ts `prepare(mode)` overrides it
**What goes wrong:** A scheduler-loop test that constructs `SchedulerLoop` directly (without calling `prepare`) will see `autoExecutionEnabled=true` and dispatch — even if the test intends observe-only mode.
**Why it happens:** Constructor at `index.ts:95` defaults `autoExecutionEnabled = true`; `compose.ts:268` sets it from `mode === 'auto'` at `prepare` time. Direct-construction tests bypass `prepare`.
**How to avoid:** Boundary-test and perf-smoke fixtures MUST explicitly call `setAutoExecutionEnabled(true/false)` before asserting dispatch behavior. Document this in `scheduler-fixtures.ts`.
**Warning signs:** `scheduler-loop.test.ts:765` already does this for the "skips dispatch when auto execution is disabled" test.

### Pitfall 4: Combined-graph rebuild cost at ~50 × ~20 exceeds PITFALLS.md ~200-node threshold
**What goes wrong:** Naively, ~50 features × ~20 tasks = ~1000 task nodes. PITFALLS.md:297 flags ~200 total nodes as the incremental-invalidation trigger. Perf smoke may fail at this scale.
**Why it happens:** The threshold in PITFALLS.md was stated as a heuristic; actual perf depends on edge density and weight of the topological DP.
**How to avoid:** Run the smoke test with an honest fixture (sparse cross-feature deps, typical task count). If p95 > 100ms, gate test behind `LOAD_TEST=1` env var (matching Phase 2 convention at `test/integration/persistence/load.test.ts`) and keep the optimization as a deferred item in `docs/optimization-candidates/`.
**Warning signs:** CI flakes on Phase 4 perf smoke.

### Pitfall 5: `agents/runtime.ts` mutates graph inline during `await ports.agents.*`
**What goes wrong:** `PiFeatureAgentRuntime.discussFeature` / `researchFeature` / `planFeature` mutate `graph.editFeature(...)` at lines 427, 436, 444 — during the `await` inside `dispatchFeaturePhaseUnit`. From the scheduler's perspective, the mutation happens inside the tick body, but through an opaque async call, not the event queue.
**Why it happens:** Feature-phase agents need to update feature fields (discussOutput, researchOutput, etc.) as they produce results. Emitting these as SchedulerEvents would mean a separate event per field update.
**How to avoid:** This is a semantic question for the planner — is "inside tick async" legitimately "through the queue"? CONTEXT gray area C's AST walker allowlist needs an explicit entry for these call sites, and the runtime guard (since `__enterTick` is active during the async await) passes naturally. Document that `agents/runtime.ts` mutations are in-tick but-not-through-queue.
**Warning signs:** None today; boundary test will surface the question.

### Pitfall 6: Retry eligibility signal mismatch
**What goes wrong:** Sort key 6 `isRetryEligible(unit)` at `scheduling/index.ts:609–614` checks `task.status === 'stuck' || task.status === 'failed'` — it does NOT cross-reference the AgentRun's `runStatus === 'retry_await'` or `retryAt` timing. CONTEXT gray area H says eligibility = `runStatus === 'retry_await' && retryAt <= now && attempts < cap`.
**Why it happens:** The sort has no runReader handle for individual tasks at sort time (only at filter time via `isBlockedByRun`). The current implementation equates task.status ∈ {stuck, failed} with "has failed before" = retry-eligible, which is a proxy.
**How to avoid:** Two options — (a) accept the proxy and document it (task.status IS set to `stuck`/`failed` via the lifecycle coordinator after the run goes to `retry_await`), (b) pipe a per-unit retry hint through. Recommendation: (a) with a comment and a test. Document the invariant: by the time a task reaches `ready` from `stuck/failed`, its AgentRun is ready to re-dispatch — the filter already threw out blocked runs.
**Warning signs:** Any test asserting that a `stuck` task without a corresponding AgentRun retry_await row sorts ahead would expose the proxy.

## Code Examples

### Boundary test — AST walker (plan 04-01)
```typescript
// test/integration/scheduler-boundary.test.ts
// Source: project's own test/unit/core/boundary.test.ts pattern (readFileSync + regex)
// extended with typescript.createSourceFile for CallExpression walking.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import allowlist from './scheduler-boundary-allowlist.json' with { type: 'json' };

const MUTATION_METHODS = new Set([
  'createMilestone', 'createFeature', 'createTask',
  'addDependency', 'removeDependency',
  'splitFeature', 'mergeFeatures',
  'cancelFeature', 'removeFeature',
  'changeMilestone', 'editFeature',
  'addTask', 'editTask', 'removeTask',
  'reorderTasks', 'reweight',
  'queueMilestone', 'dequeueMilestone', 'clearQueuedMilestones',
  'transitionFeature', 'transitionTask',
  'updateMergeTrainState', 'replaceUsageRollups',
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

interface MutationSite { file: string; line: number; col: number; method: string; enclosingFn: string; }

function findMutationSites(file: string): MutationSite[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const sites: MutationSite[] = [];
  function visit(node: ts.Node, enclosing: string) {
    let nextEnclosing = enclosing;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const name = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        ? node.name?.getText(sf) : undefined;
      nextEnclosing = name ?? enclosing;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (MUTATION_METHODS.has(method)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        sites.push({ file, line: line + 1, col: character + 1, method, enclosingFn: nextEnclosing });
      }
    }
    ts.forEachChild(node, (c) => visit(c, nextEnclosing));
  }
  visit(sf, '<module>');
  return sites;
}

describe('scheduler event-queue boundary', () => {
  const SRC = 'src';
  const sites = walkTsFiles(SRC).flatMap(findMutationSites);

  it.each(sites)('$file:$line graph.$method() is allowlisted', (site) => {
    const fileAllow = (allowlist as Record<string, string[]>)[site.file] ?? [];
    const allowed = fileAllow.includes('*') || fileAllow.includes(site.enclosingFn);
    expect(
      allowed,
      `graph mutation at ${site.file}:${site.line}:${site.col} bypasses the event queue — route through SchedulerLoop.enqueue() or add to test/integration/scheduler-boundary-allowlist.json`,
    ).toBe(true);
  });
});
```

### `enqueue()` wake wiring (plan 04-01)
```typescript
// src/orchestrator/scheduler/index.ts — 2-line change
enqueue(event: SchedulerEvent): void {
  this.events.push(event);
  this.wakeSleep?.();  // NEW: event-driven wake (gray area J)
}
```

### Feature-dep task gate (plan 04-03)
```typescript
// src/core/graph/queries.ts — readyTasks, added block
// After existing feature.runtimeBlockedByFeatureId check, BEFORE existing task-dep loop:
let upstreamFeaturesMerged = true;
for (const depFeatureId of feature.dependsOn) {
  const depFeature = graph.features.get(depFeatureId);
  if (
    depFeature === undefined ||
    depFeature.workControl !== 'work_complete' ||
    depFeature.collabControl !== 'merged'
  ) {
    upstreamFeaturesMerged = false;
    break;
  }
}
if (!upstreamFeaturesMerged) continue;
```

### Exhaustiveness assertion (plan 04-01)
```typescript
// src/orchestrator/scheduler/events.ts — append at end of handleSchedulerEvent
// After the last if-branch (currently falls off):
const _exhaustive: never = event;
void _exhaustive;
// This fails compile if a new SchedulerEvent variant is added without a handler.
// Safe because existing branches return explicitly.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `SchedulerEvent` declared inline in `index.ts` | keep in `index.ts` OR move to `events.ts` (gray area B says `events.ts`) | CONTEXT gray area B | Doc change + small refactor; non-behavioral |
| `enqueue()` without wake | `enqueue()` with `this.wakeSleep?.()` | plan 04-01 | Up-to-1s event latency → <1ms |
| Inline DAG fixtures in scheduling.test.ts | Shared `test/helpers/scheduler-fixtures.ts` | plan 04-02 | Reusable by Phase 5/9 tests |
| No boundary test | AST walker + runtime `__enterTick` guard | plan 04-01 | Catches regression that would silently break serial event queue invariant |
| Task-dep gate only | Task-dep + upstream feature-dep merged gate | plan 04-03 | Closes "wait for merge to main" at task layer |
| ROADMAP says "6-key order" | 7 keys + 1 stable ID tiebreaker | plan 04-02 doc reconciliation | Matches CONTEXT gray area E |

**Deprecated/outdated:**
- ROADMAP.md line 87 "6-key order" shorthand — reconcile in plan 04-02.
- `shutdown` event type without handler — either wire or remove in plan 04-01.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `src/agents/runtime.ts:427,436,444` mutations happen *during* `ports.agents.*` async await, inside `dispatchFeaturePhaseUnit` → therefore inside the tick body from the scheduler's perspective | §Criterion 1 remediation | If actually not inside the tick, these are real bypasses; boundary test will surface on dev-gated runtime guard. Verified only by reading the call chain at `dispatch.ts:262–353`; not by running the guard. |
| A2 | Retry eligibility at sort key 6 uses `task.status ∈ {stuck, failed}` as a proxy for "AgentRun has been through `retry_await`" — this proxy holds because the lifecycle coordinator sets task.status = failed only AFTER the run enters retry_await | §Pitfall 6 | If the proxy doesn't hold (a task marked stuck/failed without a corresponding retry_await run), sort key 6 fires spuriously. Existing test at scheduling.test.ts:743 passes — proxy seems stable. |
| A3 | Perf-smoke target of ~50 features × ~20 tasks = 1000 task nodes will complete a tick in < 100ms given the current O(V+E) DP | §Pitfall 4 | If it misses, gate behind `LOAD_TEST=1`. No correctness risk; just deferred optimization signal. |
| A4 | TUI callbacks (`toggleMilestoneQueue`, `cancelFeatureRunWork`) are the only real "outside-tick" bypasses — bootstrap (`initializeProjectGraph`) is legitimate because it runs before `scheduler.run()` | §Criterion 1 | If other bypasses exist that the grep missed, they'll show in the boundary test. |
| A5 | `readyFeatures()` already correctly gates on upstream feature merged-state — no change needed there; only `readyTasks()` is the gap | §Criterion 5 | Verified by reading queries.ts:46–57. Not verified that no external code path skips this (e.g., a test helper that injects tasks directly — check during plan 04-03). |
| A6 | Config shape at plan-time: `config.retryCap` (maxAttempts), `config.retry.baseDelayMs`, `config.retry.maxDelayMs` — NOT `config.retry.{baseBackoffMs,maxBackoffMs,maxAttempts}` as CONTEXT§H implied | §Retry eligibility | Verified at `src/config/schema.ts:121–146`. CONTEXT§H text is a mild mis-reference; the semantics match (exponential with cap), just the field names differ. Planner should reference the real field names in plans. |

## Environment Availability

Phase 4 is purely TypeScript + unit/integration test work. External dependencies confirmed:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `node` ≥ 24 | test + type-check | ✓ | repo engines requirement | — |
| `typescript` compiler API | AST boundary test (plan 04-01) | ✓ | 5.9.3 | — |
| `vitest` | all tests | ✓ | ^4.1.4 | — |
| `ts-morph` | alternative AST lib (not chosen) | ✗ | — | Use built-in `typescript` API |

No blocking dependencies. No new packages required.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.4 |
| Config file | `vitest.config.ts` (with `tsconfigPaths: true`) |
| Quick run command | `npm run test:unit -- test/unit/core/scheduling.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-EXEC-05 | Worker-count cap governs concurrency (scheduler side) | unit | `npm run test:unit -- test/unit/orchestrator/scheduler-loop.test.ts` — `dispatches only up to idle worker capacity` | ✓ exists (scheduler-loop.test.ts:907). Plan 04-03 extends to feature-phase units. |
| REQ-EXEC-06 | Downstream feature tasks wait for upstream's `collab=merged` | unit | `npm run test:unit -- test/unit/core/scheduling.test.ts` — new `feature-dep merged gate` describe block | ❌ Plan 04-03 |
| SC-1 | All graph mutations flow through the event queue | integration | `npm run test:integration -- test/integration/scheduler-boundary.test.ts` | ❌ Plan 04-01 |
| SC-2 | Combined-graph metrics match expected on canonical DAGs | unit | `npm run test:unit -- test/unit/core/scheduling.test.ts` — new `canonical DAG fixtures` describe block | ❌ Plan 04-02 (fixtures + tests) |
| SC-3 | Priority sort obeys 7-key + ID order | unit | `npm run test:unit -- test/unit/core/scheduling.test.ts` — new `priority key order — canonical 7+1 fixture` describe block | ❌ Plan 04-02 (full-order test; individual-key tests already exist) |
| SC-4 | Reservation overlap penalty vs. runtime overlap routing | unit + unit | existing (scheduling.test.ts:689 + scheduler-loop.test.ts:1143) + new `reservation overlap is penalty, not block` | ✓ partial — Plan 04-02 adds the "not block" test |
| SC-5 | Feature-dep merged-gate on downstream dispatch | unit | same as REQ-EXEC-06 above | ❌ Plan 04-03 |
| Perf | p95 tick latency < 100ms at ~50 × ~20 | smoke | `LOAD_TEST=1 npm run test:integration -- test/integration/scheduler-perf-smoke.test.ts` | ❌ Plan 04-03 |

### Sampling Rate
- **Per task commit:** `npm run test:unit -- <changed-file>` (<10s)
- **Per wave merge:** `npm run test` (full unit + integration)
- **Phase gate:** `npm run verify` (format + lint + typecheck + test + ESLint CI) green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `test/helpers/scheduler-fixtures.ts` — canonical DAG fixture helper (plan 04-02)
- [ ] `test/integration/scheduler-boundary.test.ts` — AST + runtime-guard boundary test (plan 04-01)
- [ ] `test/integration/scheduler-boundary-allowlist.json` — companion data file (plan 04-01)
- [ ] `test/integration/scheduler-perf-smoke.test.ts` — LOAD_TEST-gated p95 assertion (plan 04-03)

## Security Domain

Phase 4 is an internal orchestrator layer with no new external attack surface. ASVS categories:

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A — internal boundary |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A |
| V5 Input Validation | partial | `SchedulerEvent` union is TS-typed; IPC-origin events are already validated at the frame-schema boundary (Phase 3). No new validation needed inside the orchestrator (gray area B). |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for orchestrator scheduler

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Concurrent graph mutation race | Tampering | Serial event queue + boundary test (this phase's primary contribution) |
| Runaway retry / silent token burn | DoS | Retry policy with `retryCap` + inbox escalation (landed in Phase 3); scheduler-layer concern is recomputing eligibility statelessly (gray area H) |
| Graph-corrupt write outside tick | Tampering | Runtime `__enterTick`/`__leaveTick` guard (plan 04-01) |

## Plan Breakdown Suggestions

### Plan 04-01: Serial event queue consolidation + tick-loop audit + SchedulerEvent schema + boundary-test infrastructure

**Maps to criterion:** 1 (primary) + infrastructure for 3 and 5

**Candidate files to modify:**
- `src/orchestrator/scheduler/index.ts` — (a) add `this.wakeSleep?.()` to `enqueue()`; (b) wrap `tick()` body in `graph.__enterTick()` / `graph.__leaveTick()`; (c) optionally relocate `SchedulerEvent` union to `events.ts` per gray area B (doc-only move).
- `src/orchestrator/scheduler/events.ts` — (a) add exhaustiveness assertion `const _exhaustive: never = event` at bottom of `handleSchedulerEvent`; (b) handle `shutdown` or remove from union.
- `src/core/graph/index.ts` — add `__enterTick/__leaveTick` methods + dev-gated `_assertInTick()` invoked from each mutation method. Guarded by `process.env.GVC_ASSERT_TICK_BOUNDARY` so prod has zero cost.
- `src/compose.ts` — route TUI `toggleMilestoneQueue` and `cancelFeatureRunWork` through `scheduler.enqueue()` (NEW event types like `{ type: 'ui_action', kind: 'toggle_milestone_queue', milestoneId }`) OR allowlist them. Preference: allowlist (keeps the queue focused on execution events; TUI ops are intrinsically synchronous and short).

**Candidate new test files:**
- `test/integration/scheduler-boundary.test.ts` — AST walker (see § Code Examples)
- `test/integration/scheduler-boundary-allowlist.json` — companion data file
- `test/integration/scheduler-tick-guard.test.ts` — runtime guard test (set env, direct mutation throws, in-tick mutation succeeds)
- `test/unit/orchestrator/scheduler-loop.test.ts` — new `describe('enqueue wake semantics')`: enqueue during sleep wakes loop immediately (assert with fake timers)

**Candidate verification:**
- `npm run test:integration -- scheduler-boundary` passes (no unallowed mutations).
- `npm run test` full suite passes.
- Pre-existing 5203 LOC of scheduler-loop tests still pass — no regressions.

### Plan 04-02: Combined-graph metrics audit + 7-key priority sort test matrix + reservation-overlap penalty test + docs reconciliation

**Maps to criteria:** 2, 3, 4

**Candidate files to modify:**
- `ROADMAP.md` — line 87: rewrite criterion 3 to match CONTEXT gray area E ("Priority sort obeys the documented key order (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age + stable ID tiebreaker)").
- `docs/architecture/graph-operations.md:207–216` — add row 8 for ID tiebreaker to the priority table; add brief note on sort stability.
- No production code changes expected here (sort is correct; metrics are correct; penalty is correct).

**Candidate new test files:**
- `test/helpers/scheduler-fixtures.ts` — `diamond`, `linearChain`, `parallelSiblings`, `deepNested`, `mixedFeatureTask`, `prePostMixed` fixtures with expected `maxDepth` / `distance` maps.
- `test/unit/core/scheduling.test.ts` — new `describe('canonical DAG fixtures')` exercising each fixture's expected metrics.
- `test/unit/core/scheduling.test.ts` — new `describe('priority key order — canonical 7+1 fixture')` with the 9-unit ordered-list assertion.
- `test/unit/core/scheduling.test.ts` — new `describe('reservation overlap is penalty, not block')`: overlapping task still dispatches when capacity allows.

**Candidate verification:**
- All new tests green.
- ROADMAP diff is visible in PR review (doc-only change).

### Plan 04-03: Feature-dep enforcement + dispatcher integration with WorkerPool + perf smoke + retry-eligibility audit

**Maps to criteria:** 5 (primary) + REQ-EXEC-05 confirmation + REQ-EXEC-06 closure + perf-adjacent (criterion 2)

**Candidate files to modify:**
- `src/core/graph/queries.ts` — add upstream feature-merged gate to `readyTasks()` (see § Code Examples).
- `src/orchestrator/scheduler/dispatch.ts` — add `hasUnmergedFeatureDep` defensive check + log-and-skip in the dispatch loop.
- Possibly tweak sort key 6 comment to document the `task.status` proxy (Pitfall 6).

**Candidate new test files:**
- `test/unit/core/scheduling.test.ts` — new `describe('feature-dep merged gate — tasks')`:
  - Two-feature chain; upstream at each of {branch_open, merge_queued, integrating, rebased, conflict, cancelled}; downstream tasks NOT ready.
  - Flip upstream to `work_complete + merged`; downstream tasks ready on next call.
- `test/unit/orchestrator/scheduler-loop.test.ts` — `describe('feature-dep dispatch-time guard')`: direct-inject a blocked unit into dispatcher; asserts log + skip (does not crash).
- `test/integration/scheduler-perf-smoke.test.ts` — LOAD_TEST-gated test:
  - Generate 50 features × 20 tasks with mixed feature-deps.
  - Run 100 ticks; measure `performance.now()` around each `tick()`.
  - Assert `p95 < 100ms`.
  - `describe.skipIf(process.env.LOAD_TEST !== '1')`.

**Candidate verification:**
- Default `npm run test` skips perf smoke; full suite still green.
- `LOAD_TEST=1 npm run test:integration -- scheduler-perf-smoke` passes.
- `npm run verify` green.

## Open Questions

1. **Should TUI callbacks (`toggleMilestoneQueue`, `cancelFeatureRunWork`) enqueue events or stay outside-tick?**
   - What we know: They're short + synchronous today; PITFALLS.md flags "outside the queue" as the highest architectural regression risk.
   - What's unclear: Is "user-triggered inline graph edit" a legitimate exception, or does it need to route through `enqueue()`? The latter changes TUI semantics (action → event → next tick → ui.refresh()).
   - Recommendation: Plan 04-01 picks ONE approach and documents it. Preference: allowlist these specific call sites with a clear comment, and add a `{ type: 'ui_graph_action' }` event type as a Phase 7/8 future path.

2. **Should `agents/runtime.ts` mutations during phase-agent `await` go through the event queue?**
   - What we know: They run inside the tick body but not through the queue (opaque async call).
   - What's unclear: Semantically, is this a "bypass"? PITFALLS.md's "inline graph mutations outside the event queue" phrasing is ambiguous.
   - Recommendation: Plan 04-01 allowlists `agents/runtime.ts` call sites with a documented rationale (inside-tick, through-async-await, from-agent-tool-result). Flag as a Phase 5 topic when the feature-phase planner agent's full mutation pattern is shipped.

3. **Sort key 6 retry-eligibility proxy — correct or drift?**
   - What we know: Sort uses `task.status ∈ {stuck, failed}`; CONTEXT gray area H defines it via AgentRun.
   - What's unclear: Does the lifecycle coordinator guarantee `task.status = stuck/failed` iff the AgentRun is `retry_await`?
   - Recommendation: Plan 04-03 adds an invariant test asserting this coupling. If the test passes, comment the proxy and close. If it fails, remediate in a follow-up.

4. **Does `shutdown` event need a handler?**
   - What we know: Declared but unwired; tests enqueue it harmlessly.
   - Recommendation: Plan 04-01 removes it from the union OR wires it to `this.running = false`. Either works; exhaustiveness assertion forces a decision.

5. **Cancelled upstream feature = deadlocked downstream?**
   - What we know: Gray area G literally says "only 'merged' unblocks"; a cancelled upstream means downstream never unblocks.
   - Recommendation: Out of scope for Phase 4. Document in § Pitfall notes + defer to Phase 7 (cancellation cascade) or Phase 10 (re-plan flows).

## Pitfalls + Landmines (Phase-4-specific, new vs. research/PITFALLS.md)

1. **Existing `autoExecutionEnabled` defaults to `true`.** Boundary test and perf smoke fixtures MUST set it explicitly. (See Pitfall 3 above.)
2. **`SchedulerEvent` is currently declared in `index.ts` not `events.ts`.** CONTEXT gray area B names `events.ts` as the home. Either move it (low risk, doc-only) or update the decision rationale. Recommend move + re-export for backward compat.
3. **The 1102 + 5203 LOC of existing tests must all pass unchanged.** CONTEXT L says "keep and tighten, not rewrite." Plans MUST NOT break existing tests. If a plan needs to change a signature, there's probably a better refactor.
4. **The 72 mutation call sites in `src/` are real.** The allowlist will be chunky. Make the allowlist's format something a human can maintain — JSON with file→functions mapping, not an opaque hash.
5. **`readyTasks()` change is in `src/core/graph/*` — under the boundary rule.** Keep the change pure (no new imports from outside `@core/*`). Verified that `FeatureWorkControl` / `FeatureCollabControl` are already types used here.
6. **The `_assertInTick()` guard must be free in prod.** Use `process.env.GVC_ASSERT_TICK_BOUNDARY` to gate. Measure that the `if (env) return` branch doesn't regress the perf smoke.
7. **AST walker is a test-time cost.** If walking 300+ .ts files per test run adds seconds, gate it behind `test:boundary` scripts or mark as `.concurrent`. Measure.
8. **ROADMAP edit is a doc commit.** Plan 04-02 final step edits ROADMAP.md — make sure the plan explicitly calls this out so the planner / verify-work knows the contract "6-key" phrase is being replaced.
9. **`overlaps.ts` + `claim-lock-handler.ts` double-coordination.** Same overlap pair could be triggered from both paths in the same tick. Check `ConflictCoordinator.handleSame/CrossFeatureOverlap` for idempotency. Add a note in plan 04-02's test design.
10. **Retry `retry.baseBackoffMs` ≠ real field name.** CONTEXT§H and "Specific Ideas" reference `baseBackoffMs/maxBackoffMs/maxAttempts`; actual fields are `retry.baseDelayMs`, `retry.maxDelayMs`, top-level `retryCap`. Plan 04-03 must use the real names.
11. **`dispatch.ts:473` rebuilds combined graph every dispatchReadyWork call — but the tick also calls ports-side coordinators that don't need the graph.** Fine as-is, but note: if a future refactor moves `buildCombinedGraph` earlier in the tick (e.g., for warnings), don't rebuild twice.
12. **`vi.useFakeTimers` + `wakeSleep`.** `wakeSleep` is set inside `sleep(ms)`. With fake timers, the Promise resolution model changes. New test asserting "enqueue wakes the sleep" must carefully interleave `await loop.run()` (starts the async loop) → `loop.enqueue(...)` (triggers wakeSleep) → `await Promise.resolve()` (flush microtask) → `expect(loop.handledEvents).toContain(event)`. Reference scheduler-loop.test.ts:557 for the fake-timers pattern.

## Sources

### Primary (HIGH confidence)
- `src/orchestrator/scheduler/*.ts` (1607 LOC, 8 files) — read in full
- `src/core/scheduling/index.ts` (636 LOC) — read in full
- `src/core/graph/{index,queries,types}.ts` — mutation surface + query filters
- `src/runtime/{contracts,worker-pool,retry-policy}.ts` — port shape + retry semantics
- `src/compose.ts` (430 LOC) — boot wiring, scheduler construction, TUI callback inventory
- `src/config/schema.ts:121–172` — retry config field names
- `test/unit/core/{boundary,scheduling}.test.ts` — boundary pattern + existing sort/metrics coverage
- `test/unit/orchestrator/scheduler-loop.test.ts` — 5203 LOC baseline
- `docs/architecture/graph-operations.md` — authoritative priority tier + sort order + scheduler pseudocode
- `.planning/phases/04-scheduler-tick-event-queue/04-CONTEXT.md` — locked decisions + auto-answered gray areas
- `.planning/research/ARCHITECTURE.md` §"Serial event queue" — event-queue contract
- `.planning/research/PITFALLS.md` §"Inline graph mutations outside the event queue" + §"Rebuild combined graph on every mutation"

### Secondary (MEDIUM confidence)
- `.planning/research/SUMMARY.md` §"Phase 4 delivers" — scope confirmation
- `specs/test_scheduler_frontier_priority.md` — behavioral spec (scenarios, not executable)
- `docs/operations/conflict-coordination.md` — reservation vs. runtime invariant

### Tertiary (LOW confidence — cross-verify at plan time)
- Pitfall 5 assumption that `src/agents/runtime.ts` mutations are inside the tick body — inferred from call chain, not confirmed with runtime guard
- Pitfall 6 retry eligibility proxy — plausibly correct, needs invariant test to confirm
- Perf smoke target (< 100ms at 50 × 20) — CONTEXT gray area D states the target but actual behavior depends on measurement

## Metadata

**Confidence breakdown:**
- Standard stack (existing code): HIGH — every file read, mutations enumerated, call sites counted.
- Criterion 1 (boundary test): HIGH — template exists at `test/unit/core/boundary.test.ts`; AST walker is mechanical.
- Criterion 2 (metrics): HIGH — existing tests prove correctness; need only fixture reorg + more fixtures.
- Criterion 3 (priority sort): HIGH — implementation matches CONTEXT spec exactly; need full-order test + doc edit.
- Criterion 4 (overlap): HIGH — two paths exist; need one "penalty not block" integration test.
- Criterion 5 (feature-dep): HIGH — gap is narrow and verified by reading queries.ts.
- Pitfalls (new ones from audit): MEDIUM — 12 listed; some (e.g., A1 `agents/runtime.ts`) depend on runtime observation not done in this session.
- Perf smoke feasibility: MEDIUM — target plausible but unverified; LOAD_TEST fallback documented.

**Research date:** 2026-04-24
**Valid until:** 2026-05-08 (2 weeks — scheduler domain is stable; research stays valid unless Phase 5 lands early and changes the dispatch paths)

## RESEARCH COMPLETE
