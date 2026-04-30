# Phase 3 — Multi-worker scheduling

## Goal

Replace the single-integer capacity model with worker-aware capacity + ownership: per-worker concurrency tracking, capacity-weighted picker, persisted `ownerWorkerId`, sticky resume, and a small ops query surface.

This phase **lifts** the single-remote-worker restriction from phase 2 and does not touch recovery (phase 5).

## Background

Capacity, worker selection, ownership persistence, sticky routing, and operator query are all absent on `main`; each step below cites the file/line being changed.

## Steps

The phase ships as **7 commits**. Steps stand on their own; the test suite stays green between commits.

---

### Step 3.1 — Persist run ownership

**What:** add `owner_worker_id` and `owner_assigned_at` columns to `agent_runs` and surface them on `BaseAgentRun`. Migration is `011_agent_run_owner_columns.ts` (pinned numbering from [phase 0](./phase-0-migration-consolidation.md); `010_workers.ts` is the predecessor). New columns default `NULL`; set on dispatch, cleared on terminal completion. Single columns, not a join table — 1:1 with the run.

**Files:**

- `src/persistence/migrations/011_agent_run_owner_columns.ts` — new TS migration. `ALTER TABLE agent_runs ADD COLUMN owner_worker_id TEXT` and `ADD COLUMN owner_assigned_at INTEGER`. No backfill (NULL is the correct value for historic rows). Rollback is two `ALTER TABLE … DROP COLUMN` statements (SQLite ≥3.35) or the rebuild pattern from phase 5 step 5.9 if the local SQLite predates that.
- `src/persistence/db.ts` — register `Migration011AgentRunOwnerColumns` in the imports + `migrations` array literal alongside `Migration010Workers` from phase 1.
- `src/persistence/sqlite-store.ts` — extend `AGENT_RUN_COLUMNS` (`:25-26`), `AgentRunInsertParams` and `AgentRunUpdateParams` (`:33-79`), and the prepared insert/update statements (`:107-134`) to include both columns. Update `agentRunToRow` / `rowToAgentRun` codecs.
- `src/core/types/runs.ts` — add `ownerWorkerId?: string` and `ownerAssignedAt?: number` to `BaseAgentRun`.
- `src/orchestrator/ports/index.ts` — extend `AgentRunPatch` automatically through the `Omit` (no manual change), and update `AgentRunQuery` to allow `ownerWorkerId?: string`.
- (No graph or scheduler changes yet — that arrives in step 3.3.)

**Tests:**

- `test/unit/persistence/sqlite-store.test.ts` — extend with insert + update + query round-trip for `ownerWorkerId` / `ownerAssignedAt`. Confirm a NULL ownership row reads back as `undefined` for both fields.
- `test/unit/persistence/migrations.test.ts` (or wherever the migration smoke test lives) — assert applying `011_agent_run_owner_columns` to a DB with a populated `agent_runs` row leaves the row valid with `owner_worker_id IS NULL`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the step body; additionally confirm `AGENT_RUN_COLUMNS`, insert/update prepared statements, and codec all list the two new columns in matching order (column-order mismatch silently writes the wrong field). Under 200 words.

**Commit:** `feat(persistence): add owner_worker_id to agent_runs`

---

### Step 3.2 — Capacity-aware `RuntimePort` seam

**What:** replace `idleWorkerCount(): number` on `RuntimePort` with a richer surface that the new picker can consume, and extend `dispatchRun` with an optional `targetWorkerId`. Both changes are additive to the seam — `LocalWorkerPool` keeps working with a default policy.

Specifically:

- Add `listWorkers(): readonly WorkerCapacityView[]` to `RuntimePort`. Each `WorkerCapacityView` carries `{ workerId, kind: 'local-spawn' | 'remote', capabilities: WorkerCapabilities, maxConcurrent, inFlight, healthy }`. `capabilities` is the phase-1 `WorkerCapabilities` type — the picker (step 3.3) filters on `capabilities.{scopeKinds, harnessKinds, transportKind}`, so the view must surface it.
- Keep `idleWorkerCount()` for back-compat (phase-1/2 callers and the scheduler tick still use it as a cheap "is anyone free?" gate); deprecate in a follow-up after phase 5.
- Extend `dispatchRun` with an optional fourth arg: `options?: { targetWorkerId?: string; policyHint?: 'sticky' | 'capacity' }`. When `targetWorkerId` is set, the pool routes to that worker or returns a `not_dispatchable` result the scheduler can re-queue.
- Add a corresponding `not_dispatchable` variant to `DispatchRunResult` (`{ kind: 'not_dispatchable'; agentRunId: string; reason: 'unknown_worker' | 'worker_full' | 'worker_unhealthy' }`). Existing call sites switch through this case explicitly.

Phase 1's `WorkerRegistry` gains a `register(view)` / `update(view)` surface; the pool reads from it. (`LocalWorkerPool`'s self-registration as `workerId = 'local'` is described in Files below.)

**Files:**

- `src/runtime/contracts.ts` — define `WorkerCapacityView`, extend `DispatchRunResult` with `not_dispatchable`, extend `RuntimePort` with `listWorkers()` and the optional `options` arg on `dispatchRun`.
- `src/runtime/worker-pool.ts` — implement `listWorkers()`. Track `inFlight` from `liveRuns.size + featurePhaseLiveSessions.size`. When phase 1/2 added a `WorkerRegistry`, merge its views into the result; until that exists, return `[{ workerId: 'local', kind: 'local-spawn', maxConcurrent: this.maxConcurrency, inFlight, healthy: true }]`. Honor `options.targetWorkerId === 'local'` (or undefined) by dispatching as today; reject other targets with `not_dispatchable` because there is only one worker until step 3.3 wires the registry in.
- `src/runtime/registry/index.ts` (assumed introduced in phase 1) — extend with `setLoad(workerId, inFlight)` so the pool can keep load fresh as runs start/finish. If phase 1 used a different name, follow that naming.
- `src/orchestrator/ports/index.ts` — re-export `WorkerCapacityView` for orchestrator-side consumers.
- (No store, no migration changes.)

**Tests:**

- `test/unit/runtime/worker-pool.test.ts` — new or extended file: `listWorkers()` returns one local view in default config; `inFlight` increments after a dispatch and decrements after `result`. With `targetWorkerId: 'unknown'`, dispatch returns `not_dispatchable`.
- `test/unit/runtime/contracts.test.ts` — exhaustiveness check on `DispatchRunResult` switches across the codebase compiles after adding `not_dispatchable` (TypeScript will fail any non-exhaustive `switch` — fix call sites here, not in 3.3).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify every existing `switch` on `DispatchRunResult.kind` now handles `not_dispatchable` (no implicit fall-through). Verify `idleWorkerCount` semantics are unchanged and `targetWorkerId === undefined` is a no-op default. Under 250 words.

**Commit:** `feat(runtime): capacity-aware dispatch seam with worker views`

---

### Step 3.3 — Worker-aware picker in scheduler dispatch

**What:** rewrite `dispatchReadyWork` (`src/orchestrator/scheduler/dispatch.ts:782-842`) to drive the dispatch loop from per-worker capacity instead of a single integer. For each ready unit:

1. Read `WorkerCapacityView[]` via `runtime.listWorkers()`.
2. **Filter by capability**: only candidates whose `capabilities.scopeKinds` includes the unit's `scope.kind` AND whose `capabilities.harnessKinds` includes the run's required `harnessKind` AND whose `capabilities.transportKind` matches the dispatch path. A task-only worker (no `feature_phase` in `scopeKinds`) must reject feature-phase dispatch outright. Phase 4 step 4.4 lands `verification` capability advertisement; the picker filter compounds with that.
3. Filter to `healthy && inFlight < maxConcurrent`.
4. Pick using a deterministic capacity-weighted round-robin: order candidates by `(inFlight / maxConcurrent, lastAssignedAt)` ascending so the most-empty worker (relative to its declared capacity) wins ties. Persist `lastAssignedAt` per worker in scheduler state — it survives the loop body but does not need disk persistence.
5. Call `dispatchRun(scope, dispatch, payload, { targetWorkerId })`. On `not_dispatchable` with `reason: 'worker_full'` / `'worker_unhealthy'`, drop the candidate from the loop's local view and retry the same unit against another worker. On `'unknown_worker'` (registry race) skip the unit this tick — log and let the next tick retry.
6. On a successful dispatch, persist `owner_worker_id = workerId` and `owner_assigned_at = now` via the existing `runningRunPatch` (`:160-190`). Wire ownership clear-out on terminal completion in `events.ts` (or wherever the `result`/`error` worker message handler runs) — null both columns.

The local-spawn back-compat case is identical to today: `listWorkers()` returns one view, the picker picks it, `targetWorkerId === 'local'`. No regression on a single-worker config.

**Files:**

- `src/orchestrator/scheduler/dispatch.ts` — replace the `idleWorkers` integer (`:797`) and the `dispatched < idleWorkers` loop break (`:813-816`) with a `pickWorker(views, lastAssignedAt)` helper plus a `not_dispatchable` retry inner loop. Pass `targetWorkerId` through to `dispatchTaskRun` / `dispatchFeaturePhaseRun`. Extend `runningRunPatch` (`:160-190`) and the corresponding feature-phase patches (`:192-224`) to set `ownerWorkerId` and `ownerAssignedAt` from a new arg.
- `src/orchestrator/scheduler/events.ts` — at the worker-message handler that processes terminal `result`/`error` (look for the existing call into `updateAgentRun`; the `runStatus = 'completed'` path is where ownership clears), patch `ownerWorkerId: undefined, ownerAssignedAt: undefined`.
- `src/orchestrator/scheduler/index.ts` — `SchedulerLoop` constructor stashes a per-worker `lastAssignedAt: Map<string, number>` and passes it into `dispatchReadyWork`.
- (No store changes — column already exists from 3.1.)

**Tests:**

- `test/unit/orchestrator/scheduler/dispatch-multi-worker.test.ts` — new. Two ready units, two workers each with `maxConcurrent: 1`; assert one unit goes to each worker (no head-of-line blocking). One full worker + one empty worker; assert all units route to the empty one. Three units, one worker with `maxConcurrent: 1`; assert two units stay in the ready set this tick. **Capability filter**: a feature-phase ready unit + one worker advertising `scopeKinds: ['task']` only → unit stays unscheduled (no fallback to a task-only worker).
- Extend `test/unit/orchestrator/scheduler-loop.test.ts` if it asserts dispatch counts against `idleWorkerCount`. The single-worker happy path must remain identical.
- `test/unit/orchestrator/dispatch-guard.test.ts` (from 01-baseline phase 3.2) keeps passing — the unmerged-dep guard is orthogonal to the picker.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the inner `not_dispatchable` retry loop terminates (must shrink the candidate set every iteration). Verify `ownerWorkerId` is set on every successful dispatch and cleared on every terminal completion (look for error paths that bypass the `updateAgentRun` clear — those leak ownership). Under 250 words.

**Commit:** `feat(scheduler/dispatch): capacity-aware worker picker`

---

### Step 3.4 — Worker-side concurrent-run isolation

**What:** a worker hosting N concurrent runs must isolate them. Reuse phase 2's worker-side worktree provisioning — each run must create its own worktree under the worker's root. Session state is **not** worker-local: phase 2 made the orchestrator authoritative for session storage (see the README "Session persistence" cross-cutting decision); the worker proxies session ops through `RemoteSessionStore` on the IPC channel. State the constraint explicitly in code: a worker may run M runs in parallel where M ≤ its declared `maxConcurrent`, and any per-run filesystem state on the worker (worktree, scratch, logs) lives under a directory derived from `agentRunId`, never shared.

Concretely:

- The remote worker's `start(scope, payload, agentRunId)` (introduced in phase 2 on the worker side; see whatever `WorkerNode` / `WorkerService` class the phase landed) takes a process-level concurrency lock that checks `currentLoad < maxConcurrent` and rejects with a structured `worker_full` error otherwise. This is defensive — the orchestrator picker should not exceed capacity, but a registry-state race (heartbeat skew) must not corrupt the worker.
- Each accepted run gets its own `worktreeRoot = <workerScratch>/<agentRunId>/`. Worktree provisioning calls `WorktreeProvisioner.ensureFeatureWorktree` and `ensureTaskWorktree` with this root; the existing `GitWorktreeProvisioner` (`src/runtime/worktree/index.ts:12`) already takes a project root, so the change is a constructor arg, not a redesign.
- Each accepted run uses one `RemoteSessionStore` instance (from phase 2 step 2.3) keyed on `agentRunId`. There is no per-worker `FileSessionStore` — session data lives on the orchestrator. This is what makes lease takeover (phase 5) work without a session-migration protocol: the new worker streams the same session ops as the old one.
- Resource caps per run (memory, CPU): out of scope for this phase; the worker config exposes them but enforcement is a separate hardening item.

This step does not change the orchestrator side except to add `concurrentRuns` to whatever observability frame phase 1 defined. The orchestrator already counts in-flight via `listWorkers()`.

**Files:**

- `src/runtime/worker/index.ts` (the worker-side runtime, distinct from the orchestrator-side `LocalWorkerPool`) — add the per-run scratch-root logic. The exact entry point depends on phase 2's worker-side shape; this step assumes a `WorkerNode.handleStart(scope, payload, agentRunId)` method exists. Inside, derive `runScratchRoot` and pass it into worktree provisioning. The session store is constructed as a `RemoteSessionStore` (already wired by phase 2 step 2.3) keyed on `agentRunId`.
- `src/runtime/worktree/index.ts` — verify `GitWorktreeProvisioner` accepts an explicit project root; if not, parameterize. Currently `:12` shows the provisioner; check whether the constructor takes a root or hard-codes `process.cwd()`.
- The remote worker service module (named in phase 2; e.g. `src/runtime/worker-service/index.ts`) — concurrency gate.

**Tests:**

- `test/unit/runtime/worker/concurrent-run-isolation.test.ts` — new. Drive two concurrent `handleStart` calls with distinct `agentRunId` values; assert the resulting worktree roots do not overlap, and each run's `RemoteSessionStore` proxy uses a distinct correlation scope. Drive a third call when `maxConcurrent === 2`; assert the structured `worker_full` rejection.
- `test/integration/worker-side-concurrency.test.ts` — boot a faux remote worker with `maxConcurrent: 2`, submit three runs, assert two land and one bounces back as `not_dispatchable` (which the picker handles).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify worker-side isolation: (1) every per-run filesystem path (worktree, scratch, log) is keyed on `agentRunId`, never on `taskId` alone — two retries of the same task have different `agentRunId`s and must not collide; (2) the `worker_full` rejection path is fast-fail (no partial worktree creation followed by rollback) — provisioning happens after the gate; (3) abort/cleanup tears down per-run scratch fully, including dangling git refs from a partially-created worktree; (4) **no worker-side `FileSessionStore` is constructed** — sessions go through `RemoteSessionStore` per phase 2 step 2.3; the orchestrator stays authoritative; (5) the gate is per-process, not per-machine — two worker processes on the same VM each have their own counter. Under 450 words.

**Commit:** `feat(runtime/worker): per-run scratch isolation under concurrency`

---

### Step 3.5 — Sticky-resume policy

**What:** prefer the previous owner of a run when it resumes. The picker, when it sees a non-empty `ownerWorkerId` on the run's `agent_runs` row and the unit is being dispatched in `resume` mode, sets `targetWorkerId = previousOwnerId`. If that worker is `unknown_worker` or `unhealthy` (returned `not_dispatchable`), the picker falls back to capacity-weighted selection across the remaining healthy workers.

Crucially: **this step does not perform recovery reassignment.** A run whose previous worker is unreachable but healthy according to heartbeat (e.g. a partition) stays parked until phase 5 introduces leases. What this step *does* handle is the orchestrator-restart case: after restart, every `running` run has an `ownerWorkerId` from before; recovery (`recovery-service.ts`) calls `dispatchRun` with `targetWorkerId = previousOwnerId`. If the worker is back, the resume lands there and benefits from cache locality plus the worker-hosted session. If the worker is gone, the picker reroutes — and the only correct behavior pre-phase-5 is to start fresh (`mode: 'start'`) since the worker-hosted session is also gone. That fallback already exists in `dispatchTaskRun` (`:311-320`) for the `not_resumable` case; extend it to also fire on a `not_dispatchable` from the sticky target with reason `'unknown_worker'`.

The policy is implemented as a thin layer in front of the 3.3 picker — *not* as a separate code path. Rationale: keeping picker logic in one place avoids the divergence trap where sticky and non-sticky paths drift apart on fairness or guards.

**Files:**

- `src/orchestrator/scheduler/dispatch.ts` — in `dispatchTaskUnit` and `dispatchFeaturePhaseUnit`, before calling the picker, read `run.ownerWorkerId`. If the run is in resume mode (`run.sessionId !== undefined`) and the column is set, pass `policyHint: 'sticky'` and `targetWorkerId: run.ownerWorkerId` into `dispatchRun`. On `not_dispatchable` with reason `'unknown_worker'`, retry the dispatch as `mode: 'start'` (which clears `sessionId` on the next persist) — *not* against a different worker with the old session id, since the session lives on the dead worker.
- `src/orchestrator/services/recovery-service.ts` — same change in the recovery path: when redispatching a `running` run from before restart, prefer its persisted `ownerWorkerId`. The killStaleWorkerIfNeeded check in the existing recovery still runs first; the sticky preference only matters once the worker the run pointed at is back.
- `src/runtime/worker-pool.ts` — the existing `not_resumable` retry (`worker-pool.ts` does not currently have one — that lives in `dispatchTaskRun` in `dispatch.ts`) needs to compose with `not_dispatchable` correctly. Verify the result-kind switch covers both.

**Tests:**

- `test/unit/orchestrator/scheduler/sticky-resume.test.ts` — new. (a) Run with `ownerWorkerId: 'A'` resuming, worker A healthy and has capacity → goes to A. (b) Same run, worker A full → goes to B (capacity-weighted). (c) Same run, worker A is unknown → fallback to `mode: 'start'`, ownership cleared. (d) Run with no prior `ownerWorkerId` (fresh dispatch) → normal capacity-weighted selection.
- `test/integration/orchestrator-restart-sticky.test.ts` — start a run on worker A, kill the orchestrator, restart it, assert the recovery call routes the resume to A.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify sticky resume: (1) the sticky preference is only applied when the dispatch is in `resume` mode — a fresh start should never bias toward a stale `ownerWorkerId`; (2) the fallback from `not_dispatchable: 'unknown_worker'` is to `mode: 'start'`, *not* to a different worker with the old session id (the session is gone with the worker); (3) the fallback path correctly clears `sessionId` and `ownerWorkerId` so the next persist reflects the new owner; (4) recovery-service uses the same logic as the live picker — no second copy of the sticky decision; (5) the case where `ownerWorkerId` points at a worker that is registered but `unhealthy` is treated as `not_dispatchable` rather than as a hard failure (the worker may come back, but pre-phase-5 we cannot wait — fall through to capacity selection). Under 450 words.

**Commit:** `feat(scheduler): sticky-resume policy with capacity fallback`

---

### Step 3.6 — Operator visibility surface

**What:** expose three queries:

- `Store.listRunsByOwner(workerId): AgentRun[]` — what is each worker doing right now? Driven by the new `owner_worker_id` index.
- `RuntimePort.listWorkers(): WorkerCapacityView[]` (already added in 3.2) — current declared capacity, in-flight count, health.
- A small CLI or debug surface (TUI panel or `--list-workers` flag, whichever fits the repo) that joins the two: per worker, show kind, health, `inFlight / maxConcurrent`, and the agentRunIds it owns.

The "who owns run X?" question is answered by reading `agent_runs.owner_worker_id` directly via `Store.getAgentRun(id)`. No new API for that; it falls out of step 3.1.

The CLI / TUI piece is intentionally minimal — phase 3 needs operator visibility to debug capacity decisions, but the long-term observability surface is out of scope (per `02-distributed/README.md` "Out of scope" §). Wire the data, add one panel or one flag, stop.

**Files:**

- `src/persistence/migrations/012_agent_run_owner_index.ts` — new TS migration adding `CREATE INDEX idx_agent_runs_owner_worker ON agent_runs(owner_worker_id) WHERE owner_worker_id IS NOT NULL`. Pinned id from [phase 0](./phase-0-migration-consolidation.md). Partial index keeps the index small since most historic rows have NULL ownership. (Phase 5 step 5.9 drops this index when it drops the column.)
- `src/persistence/db.ts` — register `Migration012AgentRunOwnerIndex` in the imports + `migrations` array literal.
- `src/orchestrator/ports/index.ts` — add `Store.listRunsByOwner(workerId: string): AgentRun[]`.
- `src/persistence/sqlite-store.ts` — implement using a prepared statement.
- `src/tui/...` (or `src/cli/...`, whichever the repo currently houses operator tooling under) — add a worker panel that prints the joined view. **Three-tier rendering** for any worker hosting a `runStatus === 'running'` run, with the lease side stubbed pre-phase-5 (panel renders the `runStatus` tier only until phase 5 step 5.1 lands, then enriches): lease `active` + heartbeat fresh → "active"; lease `active` + heartbeat in the grace window → "delayed"; lease `expired`/`released` → "in recovery" (includes the stranded case where `owner_worker_id` points at a worker absent from `listWorkers()`).
- (No core or scheduler changes.)

**Tests:**

- `test/unit/persistence/sqlite-store.test.ts` — extend with `listRunsByOwner` round-trip; check that NULL-owner rows do not appear.
- `test/unit/tui/...` (or CLI) — snapshot or text-render test of the worker panel given a fixture of two workers and three runs.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the partial index (`WHERE owner_worker_id IS NOT NULL`) and `listRunsByOwner` exact-match. Confirm the surface tolerates a stranded-ownership worker (absent from `listWorkers()`, present in `listRunsByOwner`) and renders it with a "stranded" hint rather than hiding it. Under 200 words.

**Commit:** `feat(persistence,tui): operator visibility for worker ownership`

---

### Step 3.7 — Multi-worker integration test

**What:** end-to-end test that proves the phase outcome: two registered workers (one local-spawn, one remote-faux), three feature-with-task graphs, all three tasks run concurrently with one task per worker on the more capacious side and the third bouncing into a queued state until a slot frees.

Reuse `test/integration/harness/` fixtures and the `fauxModel` pattern described in `CLAUDE.md` §Integration Tests. The remote worker is a second process boot of the worker runtime, talking to the orchestrator over the phase-1 transport. If phase 1's tests already stand up a remote worker fixture, extend it rather than duplicate.

The test is a stop-energy gate: if it passes, the phase outcome holds. If it fails, the picker, ownership persistence, or worker-side isolation are the suspects in that order.

**Files:**

- `test/integration/multi-worker-scheduling.test.ts` — new. Use existing scheduler harness; register two workers (one with `maxConcurrent: 2`, one with `maxConcurrent: 1`); enqueue three ready tasks; assert (a) both workers receive a dispatch within the same tick, (b) `agent_runs.owner_worker_id` is set correctly per dispatch, (c) the third task waits until a slot frees and inherits ownership from whichever worker frees first, (d) on simulated orchestrator restart mid-flow, the resumed runs route back to their original owners (sticky resume from 3.5).
- `test/integration/harness/multi-worker.ts` (new helper) — boot two workers and tear them down deterministically.

**Tests:** the file above is the test.

**Verification:** `npm run check:fix && npm run check && npm run test:integration -- multi-worker-scheduling`.

**Review subagent:**

> Verify determinism (inject a clock + seed if the tiebreaker depends on `Date.now()` / `Math.random()`) and event-order assertions (not just final state). Standard integration hygiene applies for cleanup. Under 200 words.

**Commit:** `test(orchestrator): multi-worker scheduling integration`

---

## Phase exit criteria

- All seven commits land in order on the phase branch.
- `npm run verify` passes on the final commit.
- The multi-worker integration test from 3.7 passes deterministically across at least 20 consecutive runs (catch any picker non-determinism or worker-startup race).
- Manual smoke: boot a real second worker process; submit a three-feature graph; observe via the 3.6 operator surface that runs distribute across both workers and that ownership clears on completion.
- A final review subagent confirms: ownership is persisted, set, and cleared at every transition; sticky resume falls through to fresh start when the previous worker is gone (*not* to a different worker with a stale session id); the picker's fairness behavior holds under heterogeneous capacity.

## Out of scope

Deferred to later phases per the README phase table: lease-based recovery and network-liveness reclamation (phase 5), feature-phase agent distribution (phase 4), cross-worker session migration, and per-task resource caps.
