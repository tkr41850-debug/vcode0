# Phase 4: Scheduler Tick + Event Queue — CONTEXT

**Gathered:** 2026-04-24
**Status:** Ready for planning
**Mode:** `--auto` (recommended options selected without interactive prompts; rationale logged inline)

## Source
- Phase definition: `ROADMAP.md` § Phase 4
- Requirements: `REQ-EXEC-05` (scheduler side — worker-count cap governs concurrency), `REQ-EXEC-06` (feature deps enforce "wait for merge to main")
- Depends on: Phase 1 (FSM + scheduling rules + graph invariants), Phase 2 (Store port + typed config), Phase 3 (WorkerPool + runtime dispatch surface)

## Goal (verbatim)
Wire the serial event queue + scheduler that orchestrates the Phase 3 worker pool: combined-graph metrics, priority sort, reservation overlap penalty, dispatch.

## Success Criteria
1. All graph mutations flow through the single serial event queue — boundary test fails if any mutation bypasses it.
2. Combined-graph critical-path metrics (maxDepth, distance) match expected values on canonical test DAGs.
3. Priority sort obeys the documented key order (milestone → work-type tier → critical-path → partial-failed → overlap → retry → age + stable ID tiebreaker).
4. Reservation overlap applies scheduling penalty but does not block; runtime overlap (write pre-hook) routes to coordination.
5. Feature deps enforce "wait for merge to main" — downstream feature dispatches only after upstream's `collab=merged`.

## Locked Decisions (from prior phases / PROJECT.md / research)

- **Serial event queue is the canonical mutation surface**: every graph mutation — from worker messages, planner/verifier results, TUI user actions, feature-phase completion — enters a single FIFO queue. Handlers run to completion synchronously on the tick. Research (`SUMMARY.md`, `PITFALLS.md` § Pitfall "Inline graph mutations outside the event queue") flags bypasses as the single highest-risk architectural regression.
- **Combined virtual graph**: pre-execution features appear as single weighted nodes; executing features expand to tasks; inter-feature edges route through upstream terminal tasks into downstream root tasks. Already implemented in `src/core/scheduling/index.ts` (`buildCombinedGraph`, `computeGraphMetrics`).
- **Work-type tier order**: `verify > execute > plan > summarize` — the scheduler prefers completing features over starting new ones.
- **Milestones are steering buckets, not dependencies**: milestone `steeringQueuePosition` is the outermost priority key.
- **Reservation overlap is a *penalty*, not a block**: overlapping units are demoted in priority but still eligible. The *block* comes from runtime overlap via the write pre-hook `claim_lock` round-trip (Phase 3 delivered this mechanism).
- **Feature deps use the collab-control axis**: downstream features wait on the upstream's `collabControl === 'merged'`, not `workControl === 'done'`. This is what "wait for merge to main" means mechanically.
- **Worker-count cap governs concurrency** (REQ-EXEC-05): scheduler respects `ports.runtime.idleWorkerCount()`; cap lives in typed config.
- **Core boundary** (Biome `noRestrictedImports`): `src/core/scheduling/*` must not import from `@runtime/*`, `@persistence/*`, `@tui/*` — scheduling rules are pure. Orchestrator glues core rules to ports.

## Gray Areas — Auto-Answered (skip_discuss=true)

### A. Event queue physical shape
**Decision**: Keep a single in-memory `SchedulerEvent[]` FIFO inside `SchedulerLoop` (already present at `src/orchestrator/scheduler/index.ts:84`). Drain-to-empty per tick. No cross-process queue; no SQLite-backed queue (persistence is for state, not the queue).
**Why**: Research `ARCHITECTURE.md` §"Serial event queue" validates the in-memory shape. SQLite-backed queue would re-introduce fsync into the hot path — defeating the architecture. Events are idempotent replays of persisted state on crash recovery (Phase 9), so the queue itself doesn't need durability.

### B. Event type schema location + framing
**Decision**: `SchedulerEvent` discriminated union lives in `src/orchestrator/scheduler/events.ts` as the single TypeScript source; no runtime validation (typebox/Zod) — events originate inside trusted code, not at the IPC boundary. Adding every enqueue-point is covered by the boundary test from criterion 1.
**Why**: Runtime validation inside the orchestrator is overhead without a threat model. The IPC boundary (worker→orchestrator) already has typebox validation from Phase 3; those frames get translated to `SchedulerEvent` inside the handler. Scheduler-internal events (retry timer, TUI action, planner result) are typechecked at compile time.

### C. Boundary-test enforcement for criterion 1 (no graph mutation bypasses the queue)
**Decision**: Add a `FeatureGraph` facade-test that wraps graph methods with a "must be inside tick" guard (`graph.__enterTick()` / `__leaveTick()`), and add a dedicated integration test that exhaustively scans `src/orchestrator/` and `src/runtime/` for direct mutation calls outside the scheduler tick body. Static test runs in `test/integration/scheduler-boundary.test.ts` and uses an AST walk (ts-morph or the repo's existing AST helpers if any) to assert mutation call sites.
**Why**: Runtime guard catches dynamic bypass; AST walk catches statically-written bypass. Both together are cheaper than a full effect-system refactor and give a loud failure signal.

### D. Combined-graph rebuild cadence
**Decision**: v1 rebuilds the combined graph on every tick (fresh `buildCombinedGraph(graph)` call). No incremental invalidation. PITFALLS.md marks the ≥~200-node threshold as the trigger for incremental — we're below that for v1 and a Phase 4 clean rebuild is simpler to reason about.
**Why**: Critical-path correctness is more important than tick latency at this scale. Incremental invalidation is logged as a deferred optimization (`docs/optimization-candidates/`). Phase 4 adds a perf smoke test (~50 features × ~20 tasks) asserting tick stays < 100ms.

### E. Priority sort key count reconciliation
**Decision**: Canonical spec is **7 ordered keys + 1 stable tiebreaker**:
1. milestone steering queue position (lower first, unqueued last)
2. work-type tier (verify > execute > plan > summarize)
3. critical-path maxDepth (higher first)
4. partially-failed deprioritization (any failures → lower)
5. reservation-overlap penalty (overlapping → lower)
6. retry-eligible before fresh-pending
7. readiness age (older first)
8. [stable tiebreaker] entity ID (alphabetical) — deterministic test order, not a semantic key

ROADMAP's "6-key order" is a shorthand miscount (the parenthetical actually enumerates 7 items). Plan 04-02 updates the ROADMAP bullet to match and adds a test that asserts this exact order against a canonical fixture.
**Why**: Existing `src/core/scheduling/index.ts:511` already implements 8 keys (7 + ID tiebreaker) correctly. Rather than remove keys to match a miscount in the ROADMAP, reconcile the docs to the implementation and lock it with a test.

### F. Reservation-overlap penalty shape
**Decision**: Binary penalty (`overlapping → 1, else → 0`) at key 5 — matches existing implementation. No multi-tier penalty by overlap count; no path-weight-based scaling. Penalty only applies to `kind === 'task'` units (feature-phase units don't reserve task paths).
**Why**: The stated goal is "penalty but does not block" — a binary signal achieves this with the least tuning surface. Multi-tier or proportional penalties create debug/explain ambiguity (which factor demoted this unit?). If v2 needs finer granularity, add then; don't speculate now.

### G. Feature-dep enforcement mechanism
**Decision**: Enforce in two layers:
1. **Readiness filter** (primary): `prioritizeReadyWork` in `src/core/scheduling/index.ts` filters out feature-phase and task units whose feature has any upstream `dependsOn` dependency where upstream `collabControl !== 'merged'`. Filter runs before sorting, so blocked work never enters the ready list.
2. **Dispatch-time guard** (defensive): `dispatchReadyWork` re-asserts the invariant before calling `runtime.submit` — fast-failing if a blocked unit somehow made it through. The guard logs and no-ops rather than throwing, so a single stale tick doesn't crash the loop.

Layer 1 is the functional mechanism; layer 2 is the belt-and-suspenders invariant.
**Why**: Filtering in the readiness stage is where the criterion is most naturally expressed — "feature deps gate dispatch" — and keeps the priority sort pure (it doesn't need to understand collab state). Defensive guard makes regressions loud.

### H. Retry-eligible-before-fresh mechanics
**Decision**: A unit is retry-eligible when its most-recent `AgentRun` is in a terminal-error state AND `now >= lastFailedAt + retryBackoffMs` AND attempts-so-far < cap. Scheduler does not track backoff timers as separate events — freshness is recomputed every tick from persisted run rows. Backoff formula: `retryBackoffMs = min(config.retry.baseBackoffMs * 2^attempts, config.retry.maxBackoffMs)`.
**Why**: Stateless recomputation keeps the event queue free of retry-specific event types. Exponential with cap is the standard shape and matches Phase 3's retry-policy research notes.

### I. Dispatch fairness across idle workers
**Decision**: Dispatch iterates the sorted `ready` list and submits up to `idleWorkerCount` units in sort order. No per-feature round-robin layer; no "one-per-feature-first" rule. If the sort already captures the right preference (verify of feature-A before execute of feature-B), no extra fairness layer is needed.
**Why**: PROJECT.md states "max parallelism at every level" — fairness as a cap would fight that. Starvation concerns are already mitigated by key 7 (readiness age) and key 4 (partial-failure demote). If a real starvation case emerges, add an aging bonus in a later iteration.

### J. Tick cadence + wakeup
**Decision**: v1 keeps the current 1000ms poll (`setTimeout` in `loop()` at `src/orchestrator/scheduler/index.ts:155`) **plus** an event-driven wake via `wakeSleep()` on enqueue. Any `enqueue()` call triggers the wake so events don't wait up to 1s to be processed. Periodic timer is the fallback for clock-driven work (readiness age rollovers, retry backoff expiry).
**Why**: Pure event-driven misses time-based transitions (a task becomes retry-eligible at `t0 + backoff`, but no message fires at that instant). Pure polling adds up-to-1s latency. Both together handle both cases with minimal code.

### K. Reservation overlap computation location
**Decision**: Overlap sets are computed inside `prioritizeReadyWork` per tick from the graph's `task.reservations` fields (already present — see `src/core/scheduling/index.ts:478`). No caching. No dedicated orchestrator data structure.
**Why**: The combined-graph rebuild already costs more; overlap set computation is O(tasks × reservations) ≈ negligible compared to graph walks. Caching adds invalidation complexity for no observable benefit.

### L. Existing scheduler code — keep or rewrite?
**Decision**: Keep and tighten. `src/orchestrator/scheduler/*.ts` (2107 LOC total) and `src/core/scheduling/index.ts` (636 LOC) substantially implement the Phase 4 contract. Phase 4's job is: (a) close the gap on success criteria 1 (boundary test), 3 (key-order test), 5 (feature-dep gate), (b) write the unit-test matrix the ROADMAP promises, (c) reconcile the 6→7 key shorthand in docs. No ground-up rewrite.
**Why**: User memory `project_code_churn_allowed.md` says "existing code is not precious" BUT research `SUMMARY.md` says "bias toward clarifying and completing". The Phase 4 implementation is already directionally correct — the test backbone and docs/code reconciliation are the real gaps.

### M. Feature-phase dispatch vs task dispatch split
**Decision**: Keep existing split — `SchedulableUnit` discriminates `kind: 'task'` from `kind: 'feature_phase'`; dispatcher has two paths (`dispatchTaskUnit`, `dispatchFeaturePhaseUnit`). No unification. Feature-phase work (planner, verifier, summarizer) uses a different port (`runtime.runFeaturePhase`) than task work (`runtime.submit`), so unifying adds indirection without simplification.
**Why**: Phase 5 will build heavily on the feature-phase dispatch path (feature-level planner, verify agent). Phase 4 shouldn't churn that surface.

## Scope Fences
- **Out of scope**: feature-level planner agent (Phase 5), verify agent (Phase 5), merge-train queue + rebase (Phase 6), inbox routing (Phase 7), TUI scheduler view (Phase 8), full crash-recovery event replay (Phase 9), re-plan additive diff (Phase 10).
- **In scope**: serial event queue + wake semantics, event type schema, combined-graph metrics (audit + tests), priority sort (audit + test + doc reconciliation), reservation-overlap penalty (audit + test), feature-dep enforcement (add + test), boundary test for criterion 1, dispatcher integration with Phase 3 `WorkerPool`, perf smoke.

## Expected Plans (3)

- **04-01**: Serial event queue consolidation + tick loop audit + `SchedulerEvent` schema + boundary-test infrastructure (criterion 1). Includes the AST walker + runtime `__enterTick` guard.
- **04-02**: Combined virtual graph metrics audit + 7-key priority sort test matrix + reservation-overlap penalty test + docs reconciliation (criteria 2, 3, 4). Includes canonical DAG fixtures.
- **04-03**: Feature-dep enforcement (readiness filter + defensive dispatch guard) + dispatcher integration with Phase 3 `WorkerPool` surface + perf smoke test + retry-eligibility recomputation tests (criterion 5 + REQ-EXEC-05/06 closure).

## Cross-Phase Notes
- Phase 5 feature-level planner agent emits graph mutations through the event queue — 04-01's schema must accept `feature_plan_tool_call` event shape.
- Phase 6 merge-train flips upstream `collabControl → 'merged'` — 04-03's feature-dep gate will fire downstream dispatches on the next tick.
- Phase 7 inbox + pause/resume introduces `paused` + `awaiting_response` states — 04-01's event schema should leave room (discriminated union + exhaustiveness-check assertion) for later additions without a breaking change.
- Phase 9 crash recovery replays persisted events — 04-01's `enqueue()` must be safe to call during boot rehydration (idempotent on duplicate events, which Phase 2 already handles at the Store layer).

## Canonical References

**Downstream agents MUST read these before planning or implementing Phase 4.**

### Project-level
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`
- `.planning/research/SUMMARY.md` §"Phase 4 delivers" + §"Six canonical patterns"
- `.planning/research/ARCHITECTURE.md` §"Serial event queue + async feature-phase agents" + §"Combined virtual graph critical path" + §"Work-type priority tiers"
- `.planning/research/PITFALLS.md` § "Inline graph mutations outside the event queue" + § "Rebuild combined graph on every mutation"

### Prior phase artifacts
- `.planning/phases/01-foundations-clarity/01-CONTEXT.md` — FSM axes, boundary rule, decision tables
- `.planning/phases/02-persistence-port-contracts/02-CONTEXT.md` — Store port shape, rehydration invariant
- `.planning/phases/03-worker-execution-loop/03-CONTEXT.md` — worker pool + IPC schema + `claim_lock` runtime-overlap path

### In-tree architecture docs
- `docs/architecture/graph-operations.md` — DAG mutations + scheduler pseudocode + priority tiers (Phase 4's authoritative behavior doc)
- `docs/architecture/worker-model.md` — worker pool + IPC shape (Phase 4 consumes `runtime.submit` / `runtime.idleWorkerCount`)
- `docs/architecture/data-model.md` — composite-state matrix (feature-dep gate reads `collabControl`)
- `docs/operations/conflict-coordination.md` — runtime-overlap routing (confirms reservation-overlap is *penalty*, not *block*)

### Existing code touched in this phase
- `src/orchestrator/scheduler/index.ts` — `SchedulerLoop` class, event queue, tick
- `src/orchestrator/scheduler/events.ts` — `SchedulerEvent` discriminated union + handlers
- `src/orchestrator/scheduler/dispatch.ts` — `dispatchReadyWork`, task + feature-phase dispatch paths
- `src/orchestrator/scheduler/overlaps.ts` — same-feature + cross-feature runtime overlap coordination
- `src/orchestrator/scheduler/active-locks.ts`, `claim-lock-handler.ts` — runtime-overlap write-prehook coordination (Phase 3 wiring)
- `src/core/scheduling/index.ts` — `buildCombinedGraph`, `computeGraphMetrics`, `CriticalPathScheduler`, `prioritizeReadyWork`
- `src/core/graph/*` — graph mutations the scheduler orchestrates
- `src/core/fsm/*` — composite guards (Phase 1 baseline)
- `src/runtime/pool/*`, `src/runtime/contracts.ts` — worker-pool surface the dispatcher submits to
- `src/config/schema.ts` — `workers.cap`, `retry.{baseBackoffMs,maxBackoffMs,maxAttempts}` knobs

### Specs that bound Phase 4 contracts
- `specs/test_scheduler_frontier_priority.md` — priority-sort semantics
- `specs/test_graph_contracts.md` — graph operation contracts
- `specs/test_graph_invariants.md` — DAG invariants the scheduler cannot violate
- `specs/test_agent_run_wait_states.md` — retry-eligibility + wait-state semantics

## Specific Ideas
- **Boundary-test message**: when the AST walker finds a direct graph mutation outside a scheduler tick, the error should say "graph mutation at <file>:<line> bypasses the event queue — route through SchedulerLoop.enqueue() or add to the approved call-site allowlist". Name the allowlist file so the fix path is obvious.
- **Canonical DAG fixtures**: place in `test/helpers/scheduler-fixtures.ts`. Include at minimum: diamond, linear-chain, parallel-siblings, deep-nested, mixed feature+task graph. These are reused by Phase 5 verify-agent tests and Phase 9 crash-recovery tests.
- **Perf smoke gate**: assert p95 tick latency < 100ms for 50 features × 20 tasks. If it fails on CI, degrade to `LOAD_TEST=1` gating like Phase 2's load test.
- **Feature-dep readiness filter**: should short-circuit on *any* upstream `collabControl !== 'merged'` (not just `= 'rebased'` or `= 'integrating'`) — the only "dispatch-unblocking" collab state is `merged`.

## Deferred Ideas
- Incremental combined-graph rebuild (triggered at ≥~200 node threshold per PITFALLS.md).
- Multi-tier or proportional reservation-overlap penalty.
- Aging-bonus / anti-starvation layer in the priority sort.
- Cross-milestone preemption (when a higher-priority milestone arrives mid-execution).
- Per-feature round-robin dispatch fairness cap.

## Blockers / Concerns
- **Existing 8-key sort vs ROADMAP's 6-key shorthand**: resolution in gray-area E — plan 04-02 updates ROADMAP + adds test locking the 7-key + tiebreaker contract.
- **AST-walker dependency**: if no existing AST helper in the repo, plan 04-01 must add `ts-morph` (dev-only). Verify at research time.
- **Feature-phase dispatch (Phase 5 consumer)**: the `dispatchFeaturePhaseUnit` path already calls `ports.runtime.runFeaturePhase` — Phase 5 will materialize this. Phase 4 must not churn the signature.

---

*Phase: 04-scheduler-tick-event-queue*
*Context gathered: 2026-04-24 (auto-mode)*
