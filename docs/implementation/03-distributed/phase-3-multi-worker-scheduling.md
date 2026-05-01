# Phase 3 — Multi-worker scheduling

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-0-migration-consolidation (pins migration ids 003 and 004 for this track), phase-1-protocol-and-registry (worker registry, capability advertisement, and health views), phase-2-remote-task-execution (remote worker runtime, `RemoteSessionStore`, and worker-side worktree provisioning)
- Default verify: npm run check:fix && npm run check
- Phase exit: npm run verify; boot a real second worker process; submit a three-feature graph; observe via the worker panel from step 3.6 that runs distribute across both workers and ownership clears on completion.
- Doc-sweep deferred: `docs/architecture/worker-model.md` (single-worker scheduler narrative), `docs/architecture/persistence.md` (recovery-metadata schema; `owner_worker_id` / `owner_assigned_at` columns and index). Reconcile in one doc-only commit at phase exit.

Ships as 7 commits, in order.

## Contract

- Goal: replace the single-integer capacity model with worker-aware capacity plus ownership: per-worker concurrency tracking, a capacity-weighted picker, persisted `ownerWorkerId`, sticky resume, and a small operator query surface.
- Scope:
  - In:
    - `agent_runs.owner_worker_id` and `owner_assigned_at` columns, plus the supporting `owner_worker_id` partial index.
    - Capacity-aware `RuntimePort` surface: `listWorkers()` and `dispatchRun(..., { targetWorkerId, policyHint })`.
    - Worker-aware scheduling that filters on `capabilities.{scopeKinds, harnessKinds, transportKind}` and breaks ties by `(inFlight / maxConcurrent, lastAssignedAt)`.
    - Worker-side concurrent-run isolation: per-run worktree / scratch / log roots keyed on `agentRunId`, plus a defensive `worker_full` rejection when registry state lags.
    - Sticky resume that prefers the previous owner when a run resumes, with bounded fallback.
    - Minimal operator visibility joining worker capacity with owned runs, including the three-tier worker-panel rendering that `phase-5-leases-and-recovery` later enriches.
    - End-to-end integration coverage proving the multi-worker outcome.
  - Out:
    - Lease-based recovery, network-liveness reclamation, and takeover semantics (`phase-5-leases-and-recovery`).
    - Remote feature-phase agent distribution; `discuss`, `verify`, and related feature-phase scopes still run on the orchestrator (`phase-4-remote-feature-phases`).
    - Cross-worker session migration; when a sticky target disappears, pre-lease fallback is a fresh start rather than session transfer (no owner phase in this track).
    - Per-run CPU, memory, or network enforcement (hardening outside this track).
    - Worker auto-scaling or a broader observability product surface beyond the minimal worker query / panel seam (no owner phase in this track).
- Exit criteria:
  - `npm run verify` passes on the final commit.
  - The integration test from step 3.7 passes deterministically across at least 20 consecutive runs.
  - Ownership is persisted, queryable, and cleared at the right transitions: dispatch sets `owner_worker_id` / `owner_assigned_at`, the operator surface exposes them, and terminal completion nulls both fields.
  - The picker distributes ready work across healthy workers by declared capacity without regressing the single-worker path.
  - Sticky resume prefers the previous owner when available, and its fallback remains intentionally conservative: no resume on a different worker with a stale session id, and no implicit lease semantics before `phase-5-leases-and-recovery`.

## Plan

- Background: on the verified state, capacity, worker selection, ownership persistence, sticky routing, and operator query are all absent. Scheduler dispatch in `src/orchestrator/scheduler/dispatch.ts:782-842` still gates ready work through a single `idleWorkerCount()` integer. `RuntimePort` does not yet expose per-worker capacity views or a targetable dispatch seam. `BaseAgentRun`, `AgentRunQuery`, and `agent_runs` do not persist or query `ownerWorkerId` / `ownerAssignedAt`. Remote-worker execution from `phase-2-remote-task-execution` proved one worker can run one task end to end, but it did not establish concurrent isolation on the worker or a policy for picking among heterogeneous workers. Operator surfaces also cannot answer “what is each worker doing right now?” or render joined worker load plus owned-run state. This phase lifts the single-remote-worker restriction from `phase-2-remote-task-execution` while explicitly leaving recovery to `phase-5-leases-and-recovery`.

- Notes:
  - Transport-port purity deviation: this phase intentionally grows `RuntimePort` with `listWorkers()` and optional `targetWorkerId` / `policyHint` instead of introducing a dedicated `WorkerDirectoryPort` or `PlacementPort`. Keep that surface bounded to placement and operator-query callers; do not widen it further here.
  - `Store.listRunsByOwner(workerId)` is the matching small query seam for the operator surface. It is accepted debt for this track, not a license to push more placement policy into `Store`.
  - Session authority stays on the orchestrator side, per `phase-2-remote-task-execution`. Worker-side concurrency isolation must not reintroduce worker-local session ownership.
  - The worker panel’s three-tier rendering is intentionally forward-shaped for `phase-5-leases-and-recovery`: render the `runStatus` tier now, then enrich it with lease freshness / recovery state when that phase lands.

## Steps

### 3.1 Persist run ownership [risk: med, size: M]

What: add `owner_worker_id` and `owner_assigned_at` columns to `agent_runs` and surface them on `BaseAgentRun`. Migration is `003_agent_run_owner_columns.ts`; numbering is pinned by `phase-0-migration-consolidation`, with `002_workers.ts` as the predecessor. New columns default `NULL`; set them on dispatch and clear them on terminal completion. Keep them as direct columns, not a join table, because ownership is 1:1 with the run.

Files:
  - `src/persistence/migrations/003_agent_run_owner_columns.ts` — new TS migration. `ALTER TABLE agent_runs ADD COLUMN owner_worker_id TEXT` and `ADD COLUMN owner_assigned_at INTEGER`. No backfill; `NULL` is the correct value for historic rows. Rollback is two `ALTER TABLE ... DROP COLUMN` statements (SQLite >=3.35) or the rebuild pattern later reused by `phase-5-leases-and-recovery` step 5.9 if the local SQLite predates that.
  - `src/persistence/db.ts` — register `Migration003AgentRunOwnerColumns` in the imports and `migrations` array alongside `Migration002Workers`.
  - `src/persistence/sqlite-store.ts` — extend `AGENT_RUN_COLUMNS` (`:25-26`), `AgentRunInsertParams` and `AgentRunUpdateParams` (`:33-79`), and the prepared insert / update statements (`:107-134`) to include both columns. Update `agentRunToRow` and `rowToAgentRun` codecs.
  - `src/core/types/runs.ts` — add `ownerWorkerId?: string` and `ownerAssignedAt?: number` to `BaseAgentRun`.
  - `src/orchestrator/ports/index.ts` — update `AgentRunQuery` to allow `ownerWorkerId?: string`. `AgentRunPatch` extends automatically through the existing `Omit`.

Tests:
  - `test/unit/persistence/sqlite-store.test.ts` — extend with insert, update, and query round-trip coverage for `ownerWorkerId` / `ownerAssignedAt`. Confirm a `NULL` ownership row reads back as `undefined` for both fields.
  - `test/unit/persistence/migrations.test.ts` — assert applying `003_agent_run_owner_columns` to a DB with a populated `agent_runs` row leaves the row valid with `owner_worker_id IS NULL`.

Review goals (cap 200 words):
  1. Confirm `AGENT_RUN_COLUMNS`, insert / update prepared statements, and the codec all list the two new columns in matching order; column-order mismatch silently writes the wrong field.
  2. Confirm the migration leaves historic rows valid with `NULL` ownership and does not require backfill.

Commit: feat(persistence): add owner_worker_id to agent_runs
Rollback: `git revert` removes the code; on already-migrated dev DBs the columns persist (additive `ALTER TABLE`) — drop them via the table-rebuild fallback already called out above, or wipe the DB file before re-running migrations.

### 3.2 Add the capacity-aware `RuntimePort` seam [risk: med, size: M]

What: replace the single `idleWorkerCount(): number` scheduling seam with a richer surface the picker can consume, while keeping local-spawn behavior intact. This is the explicit transport-port-purity deviation for the phase.

Specifically:
  - Add `listWorkers(): readonly WorkerCapacityView[]` to `RuntimePort`. Each `WorkerCapacityView` carries `{ workerId, kind: 'local-spawn' | 'remote', capabilities: WorkerCapabilities, maxConcurrent, inFlight, healthy }`. `capabilities` is the `phase-1-protocol-and-registry` `WorkerCapabilities` type — the picker in step 3.3 filters on `capabilities.{scopeKinds, harnessKinds, transportKind}`, so the view must surface it.
  - Keep `idleWorkerCount()` for back-compat. `phase-1-protocol-and-registry` / `phase-2-remote-task-execution` callers and the scheduler tick still use it as a cheap “is anyone free?” gate; remove it only in a later cleanup after `phase-5-leases-and-recovery`.
  - Extend `dispatchRun` with an optional fourth arg: `options?: { targetWorkerId?: string; policyHint?: 'sticky' | 'capacity' }`. When `targetWorkerId` is set, the pool routes to that worker or returns a `not_dispatchable` result the scheduler can re-queue.
  - Add a matching `not_dispatchable` variant to `DispatchRunResult`: `{ kind: 'not_dispatchable'; agentRunId: string; reason: 'unknown_worker' | 'worker_full' | 'worker_unhealthy' }`. Existing call sites switch through this case explicitly.
  - `phase-1-protocol-and-registry`’s `WorkerRegistry` gains a `register(view)` / `update(view)` surface and the pool reads from it. `LocalWorkerPool` keeps working with a default self-registration policy.

Files:
  - `src/runtime/contracts.ts` — define `WorkerCapacityView`, extend `DispatchRunResult` with `not_dispatchable`, extend `RuntimePort` with `listWorkers()` and the optional `options` arg on `dispatchRun`.
  - `src/runtime/worker-pool.ts` — implement `listWorkers()`. Track `inFlight` from `liveRuns.size + featurePhaseLiveSessions.size`. When the `phase-1-protocol-and-registry` registry exists, merge its views into the result; until then, return `[{ workerId: 'local', kind: 'local-spawn', maxConcurrent: this.maxConcurrency, inFlight, healthy: true }]`. Honor `options.targetWorkerId === 'local'` (or `undefined`) by dispatching as today; reject other targets with `not_dispatchable` because there is only one worker until step 3.3 wires the registry in.
  - `src/runtime/registry/index.ts` — extend with `setLoad(workerId, inFlight)` so the pool can keep load fresh as runs start and finish. If the registry module uses a different name, follow that naming.
  - `src/orchestrator/ports/index.ts` — re-export `WorkerCapacityView` for orchestrator-side consumers.

Tests:
  - `test/unit/runtime/worker-pool.test.ts` — `listWorkers()` returns one local view in the default config; `inFlight` increments after a dispatch and decrements after `result`. With `targetWorkerId: 'unknown'`, dispatch returns `not_dispatchable`.
  - `test/unit/runtime/contracts.test.ts` — TypeScript exhaustiveness around `DispatchRunResult` switches compiles after adding `not_dispatchable`; fix every affected switch in this step, not in step 3.3.

Review goals (cap 250 words):
  1. Verify every existing `switch` on `DispatchRunResult.kind` now handles `not_dispatchable`; no implicit fall-through.
  2. Verify `idleWorkerCount` semantics are unchanged.
  3. Verify `targetWorkerId === undefined` is a no-op default.

Commit: feat(runtime): capacity-aware dispatch seam with worker views

### 3.3 Add the worker-aware picker in scheduler dispatch [risk: high, size: L]

What: rewrite `dispatchReadyWork` in `src/orchestrator/scheduler/dispatch.ts:782-842` to drive the dispatch loop from per-worker capacity instead of a single integer.

For each ready unit:
  1. Read `WorkerCapacityView[]` via `runtime.listWorkers()`.
  2. Filter by capability: only candidates whose `capabilities.scopeKinds` includes the unit’s `scope.kind`, whose `capabilities.harnessKinds` includes the run’s required `harnessKind`, and whose `capabilities.transportKind` matches the dispatch path. A task-only worker (no `feature_phase` in `scopeKinds`) must reject feature-phase dispatch outright. `phase-4-remote-feature-phases` step 4.4 lands `verification` capability advertisement; the picker filter compounds with that.
  3. Filter to `healthy && inFlight < maxConcurrent`.
  4. Pick using a deterministic capacity-weighted round-robin: order candidates by `(inFlight / maxConcurrent, lastAssignedAt)` ascending so the most-empty worker, relative to declared capacity, wins ties. Persist `lastAssignedAt` per worker in scheduler state; it survives the loop body but does not need disk persistence.
  5. Call `dispatchRun(scope, dispatch, payload, { targetWorkerId })`. On `not_dispatchable` with `reason: 'worker_full'` or `'worker_unhealthy'`, drop that candidate from the loop’s local view and retry the same unit against another worker. On `'unknown_worker'` (registry race), skip the unit for this tick, log it, and let the next tick retry.
  6. On successful dispatch, persist `owner_worker_id = workerId` and `owner_assigned_at = now` via the existing `runningRunPatch` (`:160-190`). Clear both columns on terminal completion in `events.ts` — whichever worker-message handler processes terminal `result` / `error` is the place that must null them.

The local-spawn back-compat case stays identical to today: `listWorkers()` returns one view, the picker picks it, and `targetWorkerId === 'local'`.

Files:
  - `src/orchestrator/scheduler/dispatch.ts` — replace the `idleWorkers` integer (`:797`) and the `dispatched < idleWorkers` loop break (`:813-816`) with a `pickWorker(views, lastAssignedAt)` helper plus a `not_dispatchable` retry inner loop. Pass `targetWorkerId` through to `dispatchTaskRun` / `dispatchFeaturePhaseRun`. Extend `runningRunPatch` (`:160-190`) and the corresponding feature-phase patches (`:192-224`) to set `ownerWorkerId` and `ownerAssignedAt` from a new arg.
  - `src/orchestrator/scheduler/events.ts` — in the worker-message handler that processes terminal `result` / `error`, patch `ownerWorkerId: undefined` and `ownerAssignedAt: undefined` alongside the terminal run-status update.
  - `src/orchestrator/scheduler/index.ts` — `SchedulerLoop` constructor stashes a per-worker `lastAssignedAt: Map<string, number>` and passes it into `dispatchReadyWork`.

Tests:
  - `test/unit/orchestrator/scheduler/dispatch-multi-worker.test.ts` — new. Two ready units and two workers with `maxConcurrent: 1` each should distribute one unit per worker. One full worker plus one empty worker should route all dispatchable units to the empty one. Three units plus one worker with `maxConcurrent: 1` should leave two units ready this tick. Capability filter regression: a feature-phase ready unit plus a worker advertising `scopeKinds: ['task']` only must stay unscheduled.
  - Extend `test/unit/orchestrator/scheduler-loop.test.ts` if it asserts dispatch counts against `idleWorkerCount`; the single-worker happy path must remain identical.
  - existing `test/unit/orchestrator/dispatch-guard.test.ts` keeps passing; the unmerged-dependency guard is orthogonal to the picker.

Review goals (cap 250 words):
  1. Verify the inner `not_dispatchable` retry loop terminates by shrinking the candidate set every iteration.
  2. Verify `ownerWorkerId` is set on every successful dispatch.
  3. Verify `ownerWorkerId` and `ownerAssignedAt` are cleared on every terminal completion path, including error paths that do not look like the happy-path `result` flow.

Commit: feat(scheduler/dispatch): capacity-aware worker picker
Migration ordering: step 3.2 must merge before this step because the picker depends on `listWorkers()`, `targetWorkerId`, and the `not_dispatchable` result kind.

### 3.4 Isolate concurrent runs on the worker side [risk: high, size: L]

What: a worker hosting `N` concurrent runs must isolate them. Reuse the worker-side worktree provisioning from `phase-2-remote-task-execution`: each run creates its own worktree under the worker root. Session state is not worker-local; `phase-2-remote-task-execution` made the orchestrator authoritative for session storage, so the worker proxies session ops through `RemoteSessionStore` on the IPC channel. State the constraint explicitly in code: a worker may run `M` runs in parallel where `M <= maxConcurrent`, and any per-run filesystem state on the worker (`worktree`, scratch, logs) lives under a directory derived from `agentRunId`, never shared.

Concretely:
  - The remote worker’s `start(scope, payload, agentRunId)` entry point, introduced on the worker side by `phase-2-remote-task-execution`, takes a process-level concurrency lock that checks `currentLoad < maxConcurrent` and rejects with a structured `worker_full` error otherwise. This is defensive: the orchestrator picker should stay within capacity, but a registry-state race or heartbeat skew must not corrupt the worker.
  - Each accepted run gets `worktreeRoot = <workerScratch>/<agentRunId>/`. Worktree provisioning calls `WorktreeProvisioner.ensureFeatureWorktree` and `ensureTaskWorktree` with this root. The existing `GitWorktreeProvisioner` in `src/runtime/worktree/index.ts:12` should accept an explicit project root; if it does not, parameterize it instead of redesigning the provisioner.
  - Each accepted run uses one `RemoteSessionStore` instance keyed on `agentRunId`. There is no per-worker `FileSessionStore`; sessions live on the orchestrator. This is what makes later takeover work without a session-migration protocol: a new worker can stream the same session ops the old one used.
  - Resource caps per run remain out of scope for this phase even if worker config exposes them.

This step does not change the orchestrator side except to add `concurrentRuns` to whatever observability frame `phase-1-protocol-and-registry` defined. The orchestrator already counts in-flight work via `listWorkers()`.

Files:
  - `src/runtime/worker/index.ts` — add the per-run scratch-root logic. The exact entry point depends on the worker-side shape from `phase-2-remote-task-execution`; this plan assumes a `WorkerNode.handleStart(scope, payload, agentRunId)` method exists. Inside it, derive `runScratchRoot` and pass it into worktree provisioning. Construct the session store as a `RemoteSessionStore` keyed on `agentRunId`.
  - `src/runtime/worktree/index.ts` — verify `GitWorktreeProvisioner` accepts an explicit project root; if not, parameterize it.
  - The remote worker service module from `phase-2-remote-task-execution` (for example `src/runtime/worker-service/index.ts`) — add the concurrency gate.

Tests:
  - `test/unit/runtime/worker/concurrent-run-isolation.test.ts` — new. Drive two concurrent `handleStart` calls with distinct `agentRunId` values; assert the resulting worktree roots do not overlap and each run’s `RemoteSessionStore` proxy uses a distinct correlation scope. Drive a third call when `maxConcurrent === 2`; assert the structured `worker_full` rejection.
  - `test/integration/worker-side-concurrency.test.ts` — boot a faux remote worker with `maxConcurrent: 2`, submit three runs, assert two land and one bounces back as `not_dispatchable` for the picker to handle.

Review goals:
  1. Verify every per-run filesystem path — worktree, scratch, and logs — is keyed on `agentRunId`, never on `taskId` alone. Two retries of the same task have different `agentRunId`s and must not collide.
  2. Verify the `worker_full` rejection path is fast-fail: provisioning happens after the gate, with no partial worktree creation followed by rollback.
  3. Verify abort / cleanup tears down per-run scratch fully, including dangling git refs from a partially created worktree.
  4. Verify no worker-side `FileSessionStore` is constructed; sessions go through `RemoteSessionStore` and the orchestrator remains authoritative.
  5. Verify the gate is per-process, not per-machine; two worker processes on the same VM each keep their own counter.

Commit: feat(runtime/worker): per-run scratch isolation under concurrency
Smoke: boot one worker with `maxConcurrent: 2`; start two runs and confirm distinct scratch roots, then start a third and confirm the worker rejects it before provisioning.
Crash matrix:
  - reject before admission: no scratch directory, worktree, or session proxy should be created.
  - fail during provisioning: cleanup must remove partial worktree state and per-run scratch keyed on `agentRunId`.
  - worker crash mid-run: no worker-local session authority exists to migrate; later recovery logic can rely on the orchestrator-owned session seam already in place.

### 3.5 Add sticky-resume policy [risk: med, size: M]

What: prefer the previous owner of a run when it resumes. When the picker sees a non-empty `ownerWorkerId` on the run’s `agent_runs` row and the unit is being dispatched in resume mode, it sets `targetWorkerId = previousOwnerId`. If that worker is `unknown_worker` or `unhealthy` and returns `not_dispatchable`, the picker falls back to capacity-weighted selection across the remaining healthy workers.

Crucially, this step does not perform recovery reassignment. A run whose previous worker is unreachable but still heartbeat-healthy stays out of scope until `phase-5-leases-and-recovery` introduces leases. What this step does handle is the orchestrator-restart case: after restart, every `running` run still has `ownerWorkerId` persisted from before; `recovery-service.ts` should prefer that owner when it redispatches. If the worker is back, the resume lands there and benefits from affinity. If the worker is gone, the pre-lease fallback stays conservative: restart in `mode: 'start'` instead of attempting a cross-worker resume with the old session id.

Implement the policy as a thin layer in front of the step-3.3 picker, not as a second picker. Keeping sticky and non-sticky dispatch in one code path avoids fairness drift and duplicated guards.

Files:
  - `src/orchestrator/scheduler/dispatch.ts` — in `dispatchTaskUnit` and `dispatchFeaturePhaseUnit`, read `run.ownerWorkerId` before picking. If the run is in resume mode (`run.sessionId !== undefined`) and the column is set, pass `policyHint: 'sticky'` and `targetWorkerId: run.ownerWorkerId` into `dispatchRun`. On `not_dispatchable` with reason `'unknown_worker'`, retry the dispatch as `mode: 'start'`; do not resume on a different worker with the old session id.
  - `src/orchestrator/services/recovery-service.ts` — apply the same owner preference when redispatching `running` runs after orchestrator restart. The existing stale-worker kill check still runs first; the sticky preference matters only once the referenced worker is back.
  - `src/runtime/worker-pool.ts` — verify the result-kind switch composes `not_resumable` and `not_dispatchable` correctly. The existing `not_resumable` retry lives in dispatch, not here; the point is to keep both result kinds handled coherently.

Tests:
  - `test/unit/orchestrator/scheduler/sticky-resume.test.ts` — new. (a) `ownerWorkerId: 'A'` plus a healthy worker A with capacity resumes on A. (b) Same run with worker A full falls through to B. (c) Same run with worker A unknown falls back to `mode: 'start'`, with ownership cleared. (d) Run with no prior `ownerWorkerId` uses the normal capacity picker.
  - `test/integration/orchestrator-restart-sticky.test.ts` — start a run on worker A, kill the orchestrator, restart it, and assert the recovery path routes the resume back to A.

Review goals (cap 250 words):
  1. Verify sticky preference only applies when dispatch is in resume mode; a fresh start must never bias toward a stale `ownerWorkerId`.
  2. Verify the fallback from `not_dispatchable: 'unknown_worker'` is `mode: 'start'`, not resume on a different worker with the old session id.
  3. Verify the fallback path clears `sessionId` and `ownerWorkerId` so the next persist reflects the new owner.
  4. Verify `recovery-service` uses the same logic as the live picker rather than copying sticky policy into a second code path.
  5. Verify `ownerWorkerId` pointing at a registered but `unhealthy` worker is treated as `not_dispatchable` rather than a hard failure.

Commit: feat(scheduler): sticky-resume policy with capacity fallback

### 3.6 Add the operator visibility surface [risk: med, size: M]

What: expose three queries:
  - `Store.listRunsByOwner(workerId): AgentRun[]` — what is each worker doing right now? Drive it from the new `owner_worker_id` index.
  - `RuntimePort.listWorkers(): WorkerCapacityView[]` — current declared capacity, in-flight count, and health. This already exists from step 3.2.
  - One minimal CLI or TUI surface, whichever fits the repo’s existing operator tooling, that joins the two: per worker, show kind, health, `inFlight / maxConcurrent`, and the `agentRunId`s it owns.

The “who owns run X?” question is answered by reading `agent_runs.owner_worker_id` through `Store.getAgentRun(id)`. No extra API is needed.

Keep the UI surface intentionally small. This phase needs enough operator visibility to debug capacity decisions, but the long-term observability product is out of scope per `03-distributed/README.md`.

Files:
  - `src/persistence/migrations/004_agent_run_owner_index.ts` — new TS migration adding `CREATE INDEX idx_agent_runs_owner_worker ON agent_runs(owner_worker_id) WHERE owner_worker_id IS NOT NULL`. The migration id is pinned by `phase-0-migration-consolidation`. The partial index keeps the structure small because most historic rows have `NULL` ownership. `phase-5-leases-and-recovery` step 5.9 drops this index if it later drops the column.
  - `src/persistence/db.ts` — register `Migration004AgentRunOwnerIndex` in the imports and `migrations` array.
  - `src/orchestrator/ports/index.ts` — add `Store.listRunsByOwner(workerId: string): AgentRun[]`.
  - `src/persistence/sqlite-store.ts` — implement the query with a prepared statement.
  - `src/tui/...` or `src/cli/...`, whichever already hosts operator tooling — add the worker panel / debug surface. For any worker hosting a `runStatus === 'running'` run, keep the three-tier rendering forward-shaped even though lease state does not land until `phase-5-leases-and-recovery`: lease `active` plus heartbeat fresh → `active`; lease `active` plus heartbeat in the grace window → `delayed`; lease `expired` / `released` → `in recovery`. That includes the stranded case where `owner_worker_id` points at a worker absent from `listWorkers()`. Until `phase-5-leases-and-recovery` step 5.1 lands, render the `runStatus` tier only and leave the lease side stubbed.

Tests:
  - `test/unit/persistence/sqlite-store.test.ts` — extend with `listRunsByOwner` round-trip coverage and confirm `NULL`-owner rows do not appear.
  - `test/unit/tui/...` or `test/unit/cli/...` — snapshot or text-render test of the worker surface given a fixture with two workers and three runs.

Review goals (cap 200 words):
  1. Verify the partial index uses `WHERE owner_worker_id IS NOT NULL` and that `listRunsByOwner` is an exact-match query.
  2. Verify the operator surface tolerates stranded ownership — absent from `listWorkers()`, present in `listRunsByOwner` — and renders a stranded / recovery hint instead of hiding it.

Commit: feat(persistence,tui): operator visibility for worker ownership
Rollback: `git revert` removes the migration import + index code; on already-migrated dev DBs run `DROP INDEX idx_agent_runs_owner_worker;` manually before re-running migrations against the same file.

### 3.7 Add the multi-worker integration test [risk: low, size: M]

What: add the end-to-end test that proves the phase outcome. Stand up two registered workers — one local-spawn and one remote faux worker — plus three feature-with-task graphs. Assert that all three tasks progress under the multi-worker scheduler, with one task per worker on the more capacious side and the third waiting in queue until a slot frees.

Reuse the `test/integration/harness/` fixtures and the `fauxModel` pattern from `CLAUDE.md`’s integration-test guidance. The remote worker should be a second-process boot of the worker runtime, speaking to the orchestrator over the `phase-1-protocol-and-registry` transport. If that phase already has a reusable remote-worker fixture, extend it instead of duplicating it.

This is the stop-energy gate: if it passes, the phase outcome holds. If it fails, the picker, ownership persistence, or worker-side isolation are the likely suspects in that order.

Files:
  - `test/integration/multi-worker-scheduling.test.ts` — new. Use the existing scheduler harness; register two workers, one with `maxConcurrent: 2` and one with `maxConcurrent: 1`; enqueue three ready tasks; assert (a) both workers receive a dispatch within the same tick, (b) `agent_runs.owner_worker_id` is set correctly per dispatch, (c) the third task waits until a slot frees and inherits ownership from whichever worker frees first, and (d) on simulated orchestrator restart mid-flow, resumed runs route back to their original owners per step 3.5.
  - `test/integration/harness/multi-worker.ts` — new helper for booting two workers and tearing them down deterministically.

Tests:
  - `npm run test:integration -- multi-worker-scheduling` in addition to the phase default verify.

Review goals (cap 200 words):
  1. Verify determinism. If tie-breaking depends on `Date.now()` or `Math.random()`, inject a clock and seed instead of asserting on accidental timing.
  2. Verify event-order assertions, not just final state, and keep cleanup deterministic.

Commit: test(orchestrator): multi-worker scheduling integration

---
Shipped in <SHA1>..<SHA7> on <YYYY-MM-DD>
