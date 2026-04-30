# Phase 3 — Multi-worker scheduling

## Goal

Replace the orchestrator's single-knob "idle local slots" capacity model with a worker-aware capacity and ownership model that lets many workers (local-spawn and remote alike) run concurrently. After this phase the scheduler:

- Tracks declared concurrency per registered worker (introduced in phase 1) and counts in-flight runs per worker.
- Picks a worker with spare capacity for each ready unit using a simple capacity-weighted policy that does not head-of-line block on slow VMs.
- Records on every dispatched run *which* worker is currently executing it, in a way that survives orchestrator restart.
- Prefers the previous owner on resume (sticky session), falling back to "any worker with capacity" when that worker is gone.
- Exposes a small operator query surface: "who owns run X?" and "what is each worker doing?".

This phase **lifts** the single-remote-worker restriction set in phase 2. It does **not** touch recovery semantics — phase 5 introduces leases and network-liveness reclamation. The current pid/`/proc` liveness check stays in place; reassignment of a lost run is still a phase-5 concern. Feature-phase agents continue to run locally on the orchestrator (still in `FeaturePhaseOrchestrator` / `DiscussFeaturePhaseBackend`) — phase 4 moves them onto the same plane as task runs.

## Background

Verified gaps on `main`:

- **Capacity model is a single integer.** `LocalWorkerPool` (`src/runtime/worker-pool.ts:62-76`) is constructed with a `maxConcurrency: number` and exposes capacity via `idleWorkerCount(): Math.max(0, this.maxConcurrency - this.liveRuns.size)` (`:572-574`). The scheduler reads exactly that one number at `src/orchestrator/scheduler/dispatch.ts:797` and breaks the dispatch loop once `dispatched >= idleWorkers` (`:813-816`). Nothing knows about per-worker capacity, per-worker in-flight count, or worker identity.
- **No worker-id selection.** `RuntimePort.dispatchRun(scope, dispatch, payload)` (`src/runtime/contracts.ts:239-244`) carries no worker hint. The pool always routes through the single configured `SessionHarness` and `FeaturePhaseBackend`. After phases 1 and 2 there are multiple registered workers, but the dispatch path has no way to express "send this to worker W".
- **Ownership is not persisted.** `agent_runs` columns added in `009_agent_run_harness_metadata.ts` (`harness_kind`, `worker_pid`, `worker_boot_epoch`, `harness_meta_json`) describe *what kind of process* hosted the run, not *which registered worker* did. There is no `owner_worker_id` column or `run_assignments` table. After orchestrator restart, recovery (`src/orchestrator/services/recovery-service.ts`) cannot tell which worker the run belonged to and cannot route a resume to the same worker for cache locality.
- **Sticky resume is implicit, not explicit.** `taskDispatchForRun` (`src/orchestrator/scheduler/dispatch.ts:145-158`) builds a `resume` dispatch from `run.sessionId` but says nothing about which worker hosts that session. When sessions are worker-hosted (phase 2's worker-side `FileSessionStore`), routing a resume to a different worker silently fails or hits `not_resumable`.
- **No operator visibility.** No CLI/TUI surface answers "what is worker W doing right now?" or "who owns run X?". The TUI reads only `agent_runs.run_status` and the local `liveRuns` map.

The contracts and ports already accommodate the change without breaking phases 1–2:

- `RuntimePort.dispatchRun` is the seam to extend with an optional `targetWorkerId` / policy hint.
- `Store` (`src/orchestrator/ports/index.ts:43-58`) gains `listWorkerLoad()` (or similar) that aggregates owner columns across `agent_runs`.
- `LocalWorkerPool` becomes one transport in a registry; the registry is the new capacity oracle.

## Steps

The phase ships as **7 commits**. Steps are ordered so each one stands on its own and the test suite stays green between commits. Steps 3.1 and 3.2 are persistence/contract groundwork; 3.3 rewrites the picker; 3.4 lifts worker-side concurrency; 3.5 adds sticky resume; 3.6 adds the ops query surface; 3.7 is the multi-worker integration test.

---

### Step 3.1 — Persist run ownership

**What:** add `owner_worker_id` and `owner_assigned_at` columns to `agent_runs` and surface them on `BaseAgentRun`. The migration is `011_agent_run_owner_columns.ts` per the pinned numbering from [phase 0](./phase-0-migration-consolidation.md) (phase 1's `010_workers.ts` is the predecessor). The new columns default `NULL` so historical rows remain valid; the field is set when the scheduler hands a run to a worker and cleared on terminal completion.

A separate `run_assignments` table is **rejected** for this phase: ownership is 1:1 with a run at any moment in time and the existing row already carries every other lifecycle field (`run_status`, `session_id`, harness metadata). Adding a join table buys nothing for phase 3 and complicates the recovery query in phase 5. If multi-host shadowing or per-attempt ownership history becomes a requirement later, that is the trigger to split.

Note: phase 5 step 5.9 drops these columns entirely once leases own worker attribution. This step is producer/consumer-only for phase 3's sticky-resume bookkeeping (used by step 3.5 sticky resume); after phase 5, ownership reads come from `run_leases.worker_id`. Phase 5's review prompt grep-checks for any `run.ownerWorkerId` read post-phase-5 as a forbidden access pattern.

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

> Verify the ownership persistence: (1) migration is idempotent (`ALTER TABLE` is naturally so on SQLite when the column is absent — confirm no destructive `DROP`); (2) `AGENT_RUN_COLUMNS`, the insert prepared statement, and the update prepared statement all list the two new columns in the same order the codec expects — a column-order mismatch silently writes the wrong field; (3) `BaseAgentRun` typing flows through both `TaskAgentRun` and `FeaturePhaseAgentRun`; (4) `AgentRunPatch` allows clearing the field (`ownerWorkerId: undefined`) so terminal completion can null it; (5) no consumer is wired yet — this is producer-only schema groundwork. Under 350 words.

**Commit:** `feat(persistence): add owner_worker_id to agent_runs`

---

### Step 3.2 — Capacity-aware `RuntimePort` seam

**What:** replace `idleWorkerCount(): number` on `RuntimePort` with a richer surface that the new picker can consume, and extend `dispatchRun` with an optional `targetWorkerId`. Both changes are additive to the seam — `LocalWorkerPool` keeps working with a default policy.

Specifically:

- Add `listWorkers(): readonly WorkerCapacityView[]` to `RuntimePort`. Each `WorkerCapacityView` carries `{ workerId, kind: 'local-spawn' | 'remote', maxConcurrent, inFlight, healthy }`.
- Keep `idleWorkerCount()` for back-compat (phase-1/2 callers and the scheduler tick still use it as a cheap "is anyone free?" gate); deprecate in a follow-up after phase 5.
- Extend `dispatchRun` with an optional fourth arg: `options?: { targetWorkerId?: string; policyHint?: 'sticky' | 'capacity' }`. When `targetWorkerId` is set, the pool routes to that worker or returns a `not_dispatchable` result the scheduler can re-queue.
- Add a corresponding `not_dispatchable` variant to `DispatchRunResult` (`{ kind: 'not_dispatchable'; agentRunId: string; reason: 'unknown_worker' | 'worker_full' | 'worker_unhealthy' }`). Existing call sites switch through this case explicitly.

`LocalWorkerPool` registers itself as the lone worker with `workerId = 'local'` and `maxConcurrent = this.maxConcurrency`, so phase-1/2 callers see a single-worker fleet. Phase 1's `WorkerRegistry` (the registry of remote workers) gains a `register(view)` / `update(view)` surface; the pool reads from it.

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

> Verify the runtime-port extension: (1) every existing `switch` on `DispatchRunResult.kind` (grep for `kind === 'started'` / `kind === 'resumed'` etc.) now handles `not_dispatchable` — no implicit fall-through; (2) `idleWorkerCount` semantics unchanged — the picker rewrite in 3.3 will replace its callers, this step keeps it working; (3) `targetWorkerId === undefined` is the no-op default — every existing caller compiles unchanged; (4) `LocalWorkerPool.listWorkers()` includes feature-phase live sessions in `inFlight` only if those count against the same capacity pool (they currently do, because `featurePhaseLiveSessions` and `liveRuns` share the local process budget); (5) the new `not_dispatchable` variant carries enough info (`reason`) for the picker to pick a different worker rather than crashing the run. Under 400 words.

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

Fairness is bounded by the round-robin's "most empty relative to declared capacity" tiebreaker. A weak VM with `maxConcurrent = 1` and a strong VM with `maxConcurrent = 8` both get a fair share of work — the weak VM gets one run, the strong VM gets up to eight, and the picker will not stack work onto a worker whose `inFlight / maxConcurrent` is already higher than its peers'. Head-of-line blocking on a single slow worker is impossible because the picker never blocks on a full worker — it picks a different one.

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

> Verify the picker rewrite: (1) the picker is deterministic given identical inputs (sort key `(inFlight / maxConcurrent, lastAssignedAt)` produces a stable order); (2) the inner `not_dispatchable` retry loop terminates — it must shrink the candidate set on every iteration and exit when empty, never spin; (3) `ownerWorkerId` is set on every successful dispatch (both task and feature-phase paths) and cleared on every terminal completion (look for any error path that bypasses the `updateAgentRun` clear — if so, ownership leaks); (4) the existing dispatch guard from `01-baseline/phase-3-scheduler.md` step 3.2 still runs *before* `dispatchTaskUnit` / `dispatchFeaturePhaseUnit`, not after the picker — picking a worker for an unmerged-dep task is wasted work; (5) the back-compat single-worker path produces identical commit-history to the previous integer-slot code (no surprise reorder or starvation). Under 500 words.

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
- `src/tui/...` (or `src/cli/...`, whichever the repo currently houses operator tooling under) — add a worker panel that prints the joined view. **Three-tier rendering** for any worker hosting a run with `runStatus === 'running'`, driven by joining the lease state from phase 5 step 5.1 (the worker panel renders gracefully pre-phase-5 by showing only the `runStatus` tier; phase 5 enriches it):
  - `running` × lease `active` and last heartbeat fresh → green / "active".
  - `running` × lease `active` and last heartbeat in the grace window → yellow / "delayed".
  - `running` × lease `expired` or `released` → red / "in recovery". This includes the "stranded" case (runs with `owner_worker_id` pointing at a worker absent from `listWorkers()`).
- (No core or scheduler changes.)

**Tests:**

- `test/unit/persistence/sqlite-store.test.ts` — extend with `listRunsByOwner` round-trip; check that NULL-owner rows do not appear.
- `test/unit/tui/...` (or CLI) — snapshot or text-render test of the worker panel given a fixture of two workers and three runs.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the operator surface: (1) the new index is partial (`WHERE owner_worker_id IS NOT NULL`) so it stays cheap on large `agent_runs` tables; (2) `listRunsByOwner` returns only rows with the exact `workerId` — no prefix or substring match; (3) the joined operator view does not assume ordering of runs within a worker — show whatever order is stable so successive renders are not noisy; (4) the surface tolerates a worker present in `listWorkers()` with zero owned runs (idle worker) and a worker absent from `listWorkers()` but present in `listRunsByOwner` (recently-disconnected worker with stranded ownership) — the latter is the leak phase 5 cleans up, so render it with a "stranded" hint rather than hiding it; (5) no new long-running poll loop — the panel reads on refresh, identical to existing TUI patterns. Under 400 words.

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

> Verify the multi-worker integration test: (1) determinism — two ready tasks must reproducibly land on two distinct workers; if the picker's tiebreaker depends on `Date.now()` or `Math.random()`, inject a clock and a seed; (2) the third-task-waits assertion checks the *event order*, not just the final state — a race that happens to settle correctly is not the same as fairness; (3) the orchestrator-restart leg actually exercises the recovery path (boot a fresh `SchedulerLoop` against the existing SQLite file) rather than just calling `dispatchRun` again; (4) cleanup: both workers are killed on test teardown even if assertions fail (no orphaned child processes leaking between test files); (5) the test does not depend on real network — phase 1's transport faux is sufficient. Under 500 words.

**Commit:** `test(orchestrator): multi-worker scheduling integration`

---

## Phase exit criteria

- All seven commits land in order on the phase branch.
- `npm run verify` passes on the final commit.
- The multi-worker integration test from 3.7 passes deterministically across at least 20 consecutive runs (catch any picker non-determinism or worker-startup race).
- Manual smoke: boot a real second worker process; submit a three-feature graph; observe via the 3.6 operator surface that runs distribute across both workers and that ownership clears on completion.
- Run a final review subagent across all seven commits to confirm: (a) ownership is persisted, set, and cleared at every relevant transition; (b) the picker's fairness behavior holds under heterogeneous capacity; (c) sticky resume falls through to fresh start when the previous worker is gone, *not* to a different worker with a stale session id; (d) the operator surface answers both "who owns run X?" and "what is each worker doing?"; (e) feature-phase agents are still local (phase 4 will move them); (f) recovery still uses pid/`/proc` (phase 5 will replace this). Address findings before declaring the phase complete.

## Out of scope (deferred to later phases)

- **Lease-based recovery.** A run whose owner is unreachable stays parked. Phase 5 introduces leases, takeover, and stale-lease reclamation.
- **Network-liveness for workers.** The current pid + `/proc/<pid>/environ` check still fires on local-spawn workers. Remote workers rely on phase 1's heartbeat for `healthy`, and a missed heartbeat marks the view `healthy: false` for picker purposes — but the run on that worker is not reassigned. Phase 5.
- **Feature-phase agent distribution.** Discuss/research/plan/replan/verify/summarize still execute on the orchestrator. Phase 4 moves them onto the same `dispatchRun` plane as task execution; the picker built here will then route them too with no additional scheduler change.
- **Cross-worker session migration.** A live session cannot move from worker A to worker B mid-run. The sticky-resume policy depends on this constraint; a future "live migration" feature would require a worker-to-worker session export protocol and is not motivated by current deployment shapes.
- **Per-task resource caps.** CPU/memory/network caps per run on the worker side. The phase 3.4 isolation gives a foundation (per-run scratch, per-run session) but does not enforce limits.
