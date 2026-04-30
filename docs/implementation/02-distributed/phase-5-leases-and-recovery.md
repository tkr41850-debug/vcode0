# Phase 5 — Ownership leases & remote recovery

## Goal

Replace the local-machine pid/proc liveness model with **ownership leases** as
the authoritative record of "which worker owns which run". Heartbeats from
phase 1 renew leases; expired leases are reclaimed and the run is rerouted to
another worker via the phase-3 scheduler. After this phase the system is fully
distributed: no `worker_pid` column, no `/proc/<pid>/environ` probe, no
`process.kill` from the orchestrator. Network liveness is the source of truth.

This is the **last** phase of the distributed track. After it merges, baseline
pid/proc liveness is gone for good and the data model carries fence tokens for
any worker-attributable state mutation.

## Background

### Phases 1–4 prerequisites (assumed)

- **Phase 1** — worker registry on its own *registry* plane,
  `heartbeat` frame as canonical lease carrier, capacity reporting,
  `reconnect` / `worker_shutdown` registry frames. Baseline
  `health_ping`/`health_pong` (`01-baseline/phase-1-safety.md` step
  1.4) stays local-stdio liveness only and carries **no** lease
  semantics (D6 reversal).
- **Phase 2** — task execution on remote workers; git sync via a bare repo on
  the orchestrator host. Whichever session-storage shape phase 2 landed on
  (centralized vs. worker-authoritative) is opaque to the lease layer.
- **Phase 3** — multi-worker scheduling. Ownership is queryable but implicit
  (in-memory map + legacy `worker_pid` column). Phase 5 promotes it to a
  first-class persisted record.
- **Phase 4** — every feature-phase agent on remote workers. Both
  `agent_runs.scopeType` values now run on workers; the lease layer covers
  them uniformly.

### Verified gaps on `main`

Legacy liveness concentrates in three places:

- `src/orchestrator/services/recovery-service.ts:809-844`
  (`killStaleWorkerIfNeeded`) reads `worker_pid` + `worker_boot_epoch`, probes
  `/proc/<pid>/environ` via `readProcEnvironmentMarkers` (`:847-856`), then
  `process.kill(pid, 'SIGKILL')`. Called from `recoverTaskRun` (`:102`) and
  `recoverFeaturePhaseRun` (`:218`).
- `src/orchestrator/services/recovery-service.ts:788-807`
  (`rebaseTaskWorktree`) writes a `RECOVERY_REBASE` marker into a local
  worktree path. After phase 2, worktrees do not live on the orchestrator
  host, so the marker has nowhere to land.
- The phase-0 consolidated `001_init.ts` carries the `worker_pid` and
  `worker_boot_epoch` columns (originally added by the pre-consolidation
  `009_agent_run_harness_metadata.ts:14-19`). Threaded through
  `src/persistence/sqlite-store.ts:43-44, 69-70, 110, 124-125, 190-191`,
  `src/persistence/codecs.ts:281-282, 307-308`,
  `src/persistence/queries/index.ts:111-112`, `src/core/types/runs.ts:38-39`,
  `src/runtime/contracts.ts:95-96`,
  `src/runtime/harness/index.ts:25-26, 116-117, 163-164, 234-235, 257-261`,
  `src/runtime/harness/feature-phase/index.ts:308-309, 344-346, 387-388,
  425-427`, `src/runtime/worker-pool.ts:41-55, 264-284`, and
  `src/orchestrator/scheduler/dispatch.ts:160-262`.

### Design decisions

- **Lease record shape.** New `run_leases` table, *not* extra columns on
  `agent_runs`. Leases churn on every heartbeat; `agent_runs` is already wide
  and hot. A separate table keeps takeover history auditable and lets
  `agent_runs.fence_token` be the only new column on the run row — bumped on
  every takeover so older leases are invalidated atomically.
- **Renewal model.** Heartbeat-driven on the *registry plane*. The
  phase-1 `RegistryFrame.heartbeat` grows a `leases: { agentRunId,
  fence }[]` field; each entry extends `expires_at` to `now + ttlMs`.
  Per D6 reversal, `health_ping` / `health_pong` (baseline phase 1
  step 1.4) is local-stdio only and carries **no** lease semantics.
  A separate `lease_renew` RPC is rejected — it doubles network
  chatter and creates two paths to keep in sync.
- **Expiry policy.** Static TTL plus configurable grace: `leaseTtlMs`
  (default `30_000`), `leaseGraceMs` (default `15_000` per phase-1
  open-question confirmation). Lease is renewable until `expiresAt`,
  takeover-eligible only after `expiresAt + leaseGraceMs` (absorbs
  single missed heartbeats). Operator tuning lives under a new
  `config.workerLeases` block.
- **Lease states.** Three terminal-ish values: `active` (held by a
  live worker), `expired` (heartbeat timeout — passes through grace
  before takeover), `released` (voluntary release via
  `worker_shutdown` D15 frame or clean local-spawn `child.on('exit')`
  — **skips grace**, takeover fires on next tick).
- **`bootEpoch` semantics (D7).** Each worker process picks a fresh
  `bootEpoch` on start; same `workerId` across reboots is the
  identity, `bootEpoch` distinguishes incarnations. On reconnect: same
  `bootEpoch` = reattach (no fence rotation, leases keep ticking);
  different `bootEpoch` = treated as new identity (prior leases for
  that `workerId` are expired, fences bumped, runs rerouted). Phase-1
  registry server holds `connection ↔ (workerId, bootEpoch)` and
  drives this branch.
- **Takeover protocol.** Sweep at `leaseTtlMs / 4`. For each lease past
  `expiresAt + leaseGraceMs`:
  1. Mark lease `state = 'expired'` and bump `agent_runs.fence_token` in
     one transaction.
  2. Decide resumability: (a) session storage from phase 2 reports the
     session as recoverable for a *different* worker, (b) `runStatus` is
     `running` / `await_response` / `await_approval`, (c) the proposal-host
     model from phase 4 says no in-flight proposal is mid-apply. If any
     fails, the run goes to `replanning` (existing `replan_needed`
     vocabulary; memory: `feature_verification_contract`).
  3. Pick a new worker via the phase-3 scheduler's `selectWorker`. If none
     available, leave `ready` for the next tick.
  4. Worker pulls latest state from the bare repo
     (`git fetch origin <feature-branch>`); old worker's local worktree is
     forfeit.
  5. Dispatch via `RuntimePort.dispatchRun(...)` with `mode: 'resume'`,
     `sessionId`, **and the new fence in the run frame**.
- **Fencing.** Every state-mutating worker frame carries
  `(workerId, agentRunId, fence)`. Stale fences are dropped. Enforcement:
  - IPC frame validator (baseline phase-1 step 1.1) — `fence` becomes
    required on mutating variants only.
  - Bare-repo pre-receive hook (phase 2,
    `src/orchestrator/git/bare-repo-hooks.ts`) reads `run_leases` +
    `agent_runs.fence_token` for the pushed branch's owning run and
    rejects pushes whose `--push-option fence=<n>` is below current.
  - Per D10 narrow carve-out: a new
    `RunLeaseStore.updateRunWithFence(runId, expectedFence, patch)`
    wraps the existing `updateAgentRunTxn` body. Worker-attributable
    update sites threaded through `dispatchMetadata`
    (`src/runtime/worker-pool.ts:40-56`) call this; everything else
    keeps the unchecked `Store.updateAgentRun` path.
- **Crash matrix.**

  | Crash | Detection / Recovery | Test |
  |---|---|---|
  | Orchestrator mid-run | Reboot finds `running` runs with live leases. Live → reattach via phase-1 reconnect. Expired → takeover. | 5.7 |
  | Worker mid-run | Heartbeats stop; lease passes grace. Sweep → bump fence → reroute → resume from `sessionId`. | 5.6 |
  | Network partition | Orchestrator-side: as worker crash. Worker-side: phase-1 watchdog fires; worker drops work. On reconnect, stale fence → `abort`. | 5.8 |
  | Worker ↔ bare repo | `git push` fails → worker reports `error: git_unreachable`. Phase-1 retry classifies transient; lease is *not* expired unless heartbeats also stop. | within 5.6 |
  | Both simultaneously | Stateless reboot; lease rows on disk are expired. Reconciler sweeps on boot *before* scheduler runs; reroute on first tick. | 5.7 (case 2) |

- **Retirement of pid/proc liveness.** Sites and disposition:
  - `recovery-service.ts:809-844` (`killStaleWorkerIfNeeded`) — **deleted**;
    replaced by the lease-expiry sweep (step 5.4).
  - `recovery-service.ts:847-879` (`readProcEnvironmentMarkers`,
    `parseProcEnvironment`) — **deleted**, no replacement.
  - `recovery-service.ts:788-807` (`rebaseTaskWorktree` / `RECOVERY_REBASE`)
    — **deleted**. Worktree state lives on the worker; recovery hands the
    resumed worker the feature-branch ref via the dispatch payload.
  - `harness/index.ts:25-26, 116-117, 163-164, 234-235, 257-261` and
    `harness/feature-phase/index.ts:308-309, 344-346, 387-388, 425-427` —
    drop `workerPid` / `workerBootEpoch` from `SessionHandle` and the
    factories; replace with `workerId` (string, assigned by phase 1).
  - `worker-pool.ts:40-56, 264-284` and
    `scheduler/dispatch.ts:160-262` — `dispatchMetadata`,
    `runningRunPatch`, and `proposalAwaitingApprovalPatch` drop pid/boot,
    gain `workerId` + `fence`.
  - Phase-0 consolidated `001_init.ts` — columns dropped in a new
    migration (step 5.9, `014_drop_legacy_run_columns.ts`) using the
    `CREATE TABLE … AS SELECT` rebuild pattern (SQLite `DROP COLUMN`
    is unreliable on the Alpine 3.34.x builds we target). Five
    columns drop in this migration: `agent_runs.{worker_pid,
    worker_boot_epoch, owner_worker_id, owner_assigned_at}` and
    `tasks.worker_id`. The `idx_agent_runs_owner_worker` index is
    also dropped. All other field references in "Verified gaps" are
    updated.
  - **Downgrade is out of scope.** Rollback to a pre-phase-5 binary
    requires restoring from a SQLite backup taken before step 5.9.
- **Orphaned branches.** A dead worker may leave a feature/task branch on
  the bare repo with no live owner. Branches are **lease-tied**: each branch
  ref is owned by whichever run currently holds the lease for that scope.
  Cleanup runs only after a takeover *or* an explicit cancel — never on
  mere lease expiry, because the takeover may itself fail and the branch
  must remain available for retry. When a feature moves to `cancelled` or a
  task run is rerouted *and* the new worker has acked its first heartbeat
  with the new fence, the cleanup step in `WorktreeProvisioner` runs
  `git update-ref -d` against any task branch whose owning run is
  `cancelled` / `completed` and which no live worker reports holding open.
  Hooks into the disposal logic from `01-baseline/phase-4-recovery.md`
  step 4.1 and respects the same idempotency contract. Phase 5 does *not*
  introduce a generic branch GC.

## Steps

The phase ships as **9 commits**. Each stands alone; the test suite stays
green between commits. Step ordering follows the lease lifecycle:
schema → grant → renew → expire → take over → tests for each crash class →
finally retire the legacy columns and add orphan cleanup.

---

### Step 5.1 — `run_leases` table + `fence_token` column + Store API

**What:** durable lease store. Schema only — no behavior change.
Producer/consumer wiring lands in steps 5.2 and 5.4. Rollback is
`DROP TABLE run_leases` *plus* `ALTER TABLE agent_runs DROP COLUMN
fence_token` (this migration adds both).

**Files:**

- `src/persistence/migrations/013_run_leases_fence_token.ts` — new TS
  migration. Pinned id `013` per phase-0 consolidation chain (phase 1 =
  `010_workers.ts`, phase 3 = `011_agent_run_owner_columns.ts` /
  `012_agent_run_owner_index.ts`, phase 5 step 5.1 = `013`, step 5.9 =
  `014`). Register `Migration013RunLeasesFenceToken`. Creates:

  ```sql
  CREATE TABLE run_leases (
    agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
    worker_id    TEXT NOT NULL,
    fence_token  INTEGER NOT NULL,
    granted_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('active','expired','released'))
  );
  CREATE INDEX idx_run_leases_expires ON run_leases(expires_at);
  CREATE INDEX idx_run_leases_worker ON run_leases(worker_id);
  ALTER TABLE agent_runs ADD COLUMN fence_token INTEGER NOT NULL DEFAULT 0;
  ```

- `src/persistence/db.ts` — register in the `migrations` array (same
  wiring as the 010 entry from phase 1 step 1.3).
- `src/orchestrator/ports/index.ts` — extend `Store` with `grantLease`,
  `getLease`, `renewLease` (fence-checked, refuses on stale fence),
  `expireLease` (transactional: lease mutation + fence bump in one tx),
  `releaseLease` (voluntary, marks `state='released'`, **skips grace**;
  used by `worker_shutdown` from phase 1 step 1.2 and by clean
  local-spawn `child.on('exit')`), and
  `listExpiredLeases(now, graceMs)`.
- `src/persistence/sqlite-store.ts` — implement. `expireLease` and
  `releaseLease` each wrap in `db.transaction(...)`.
- `src/core/types/runs.ts` — add `RunLease` (with `state: 'active' |
  'expired' | 'released'`); add `fenceToken: number` to `AgentRun`
  (default 0 for pre-migration rows).

**Tests:** `test/unit/persistence/sqlite-store.test.ts` — extend with
grant + renew + expire + listExpired round-trip. Cover fence-monotonic
guarantee (two consecutive `expireLease` calls bump by exactly 1 each).
Cover renewal-with-stale-fence rejection.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the new `run_leases` migration: (1) idempotent (`CREATE TABLE
> IF NOT EXISTS`, no destructive `DROP` on pre-existing data); (2)
> migration id pinned to `013_run_leases_fence_token.ts` per phase-0
> chain; (3) the `fence_token` ADD COLUMN has `NOT NULL DEFAULT 0` so
> existing rows survive migration; (4) `Store` API additions are
> type-safe and include `releaseLease` for the `'released'` state path;
> (5) `expireLease` runs the lease-row update and fence bump in one
> transaction; (6) `releaseLease` skips the fence bump (clean release,
> no fence rotation needed) but still wraps in a transaction; (7) no
> consumer wired yet. Flag any FK omission, missing index, or interface
> drift. Under 350 words.

**Commit:** `feat(persistence): add run_leases table and fence_token column`

---

### Step 5.2 — Lease grant on dispatch

**What:** every successful `dispatchRun` (started or resumed) creates an
`active` lease owned by the assigned worker, with
`expires_at = now + leaseTtlMs` and `fence_token = agent_runs.fence_token`.
If the grant fails, the dispatch is rolled back — no lease, no run.

**Dispatch ordering (pinned).** The fence must travel in the `run`
frame so the worker can stamp every subsequent state-mutating frame
with it. Order:

1. Read-and-increment `agent_runs.fence_token` in one transaction;
   capture the new value `fence`.
2. Send `run` frame to the picked worker with `fence` in the payload.
3. `await harness.start(...)` — this only succeeds once the worker
   acks the run.
4. `await store.grantLease({ ..., fence, state: 'active' })`.
5. Persist `runStatus = 'running'` via the existing dispatch patches.

If step 4 fails, close the handle, send `abort` to the worker, and
reject the dispatch — the run does not advance. Step 1 already bumped
the fence, so a retry naturally picks a fresh fence and any frame
emitted by the aborted worker is rejected by step 5.5 enforcement.

**Files:**

- `src/runtime/contracts.ts` — confirm `OrchestratorToWorkerMessage.run`
  carries `fence: number` (added at frame introduction in phase 1 step
  1.2's `RegistryFrame` neighbour schemas; this step verifies the
  TypeBox mirror in `frame-schema.ts` is in sync). Extend
  `DispatchRunResult` `started` / `resumed` variants with `workerId:
  string` and `fence: number`. Legacy `workerPid` / `workerBootEpoch`
  stay until step 5.9.
- `src/runtime/worker-pool.ts:78+` — implement the ordering above. Read
  + bump fence via a new `Store.bumpAndReadFence(agentRunId)`
  transaction (added to step 5.1 review). After `harness.start` resolves,
  call `store.grantLease({ agentRunId, workerId, fence, grantedAt: now,
  expiresAt: now + ttl, state: 'active' })`. On grant failure, close the
  handle and rethrow.
- `src/orchestrator/scheduler/dispatch.ts:160-262` — extend
  `runningRunPatch` and `proposalAwaitingApprovalPatch` to persist
  `fenceToken` from the dispatch result.
- `src/config.ts` — add `workerLeases: { ttlMs: 30_000, graceMs: 15_000,
  sweepIntervalMs: 7_500 }`. `graceMs` default 15s per phase-1 design
  decision.

**Tests:**

- `test/unit/runtime/worker-pool-lease-grant.test.ts` — fake harness +
  in-memory store: assert `dispatchRun` produces a `run_leases` row with
  the right shape; assert that if `grantLease` throws, the handle is
  closed and `dispatchRun` rejects.
- `test/unit/orchestrator/scheduler/dispatch-fence-persistence.test.ts` —
  assert `runningRunPatch` writes `fenceToken` from the dispatch result.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the dispatch lease grant: (1) every code path producing a
> `started` or `resumed` `DispatchRunResult` calls `grantLease` exactly
> once per dispatch (grep `kind: 'started'` and `kind: 'resumed'` in
> `worker-pool.ts`); (2) the pinned ordering holds — bump fence → send
> `run` frame with fence → `harness.start` → `grantLease` → persist
> `runStatus='running'`. The fence travels in the `run` frame so the
> worker can stamp later frames; the lease is granted only after the
> worker has acked, so an immediate rejection does not leave an orphan
> lease; (3) failure to grant rejects the dispatch and tears down the
> handle (`abort` + close) — the run does not advance to `running`. The
> already-bumped fence guarantees any straggler frame from the aborted
> worker is rejected by step 5.5 enforcement; (4) `Store.bumpAndReadFence`
> is the only path that increments `agent_runs.fence_token` outside of
> takeover — flag any other writer. Under 350 words.

**Commit:** `feat(runtime): grant ownership lease on dispatch`

---

### Step 5.3 — Heartbeat-driven lease renewal (registry plane)

**What:** extend the phase-1 `heartbeat` *registry-plane* frame
(`RegistryFrame` introduced in phase 1 step 1.2) to carry the worker's
held `agentRunId`s with their fences. The orchestrator handler renews
each lease via `store.renewLease`. Stale-fence heartbeats are dropped
(worker is stale; takeover already happened) and trigger an `abort` on
the run plane.

**Per D6 reversal**: `heartbeat` is the *canonical lease carrier*.
`health_ping` / `health_pong` from baseline phase 1 step 1.4 stays
local-stdio liveness only and carries **no leases**. Run-plane
multiplexing means lease renewal piggybacks on the same registry
WebSocket the worker uses for `register` / `reconnect` /
`worker_shutdown`.

**Files:**

- `src/runtime/contracts.ts` — `RegistryFrame.heartbeat` (added in
  phase 1 step 1.2) gains `leases: Array<{ agentRunId: string; fence:
  number }>`. `health_pong` schema is **untouched** — it stays
  lease-free local liveness.
- `src/runtime/ipc/frame-schema.ts` (baseline phase-1 step 1.1) — add
  `leases` to the registry-plane TypeBox branch only.
- `src/runtime/registry/server.ts` (phase 1 step 1.4) — heartbeat
  handler iterates `leases[]` and calls `store.renewLease` per entry.
  On renew rejection (stale fence), logs and dispatches `abort` over
  the run plane (registry server holds the `connection ↔ workerId`
  map; the run-plane router from phase 2 step 2.3.5 has the
  `(workerId, agentRunId) → connection` mapping).
- `src/runtime/registry/client.ts` (phase 1 step 1.4) — registry
  client and run executor share an in-process atomic
  `Map<agentRunId, fence>` (one-process-per-worker constraint makes
  this safe). On every `run` frame received, set the entry; on every
  heartbeat tick, snapshot the map into the outgoing `leases[]`.
- `src/orchestrator/scheduler/lease-keeper.ts` — **new** (or fold
  into registry server's `onHeartbeat`). Subscribes to heartbeat
  events; calls `store.renewLease` per entry.

**Tests:** `test/integration/distributed/lease-renewal.test.ts` — faux
worker scripted to send registry-plane heartbeats; assert `expires_at`
advances by roughly `ttlMs` per heartbeat; assert that a tampered
heartbeat with a stale fence does not extend the lease and triggers an
`abort` on the run plane.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify lease renewal: (1) lease renewal lives on the *registry*-plane
> `heartbeat` frame, not on `health_pong` (D6 reversal — `health_pong`
> stays a local-stdio liveness probe with no lease semantics); (2)
> every heartbeat with a non-empty `leases` array renews exactly those
> leases — no implicit renewal of leases the worker did not list; (3)
> renewal is idempotent over a single tick (a worker that heartbeats
> twice in the same tick does not get double credit); (4) stale-fence
> heartbeats do not advance `expires_at` and *do* trigger the abort
> path on the run plane; (5) renewal is threaded through
> `Store.renewLease` (no direct SQL writes) so the fence-check
> transaction added in step 5.1 actually runs; (6) registry client and
> run executor share an in-process `Map<agentRunId, fence>` — confirm
> single-process-per-worker assumption is documented. Under 400 words.

**Commit:** `feat(runtime): renew leases via heartbeat pong`

---

### Step 5.4 — Lease-expiry sweep + reroute

**What:** periodic sweep replaces `killStaleWorkerIfNeeded`. Every
`config.workerLeases.sweepIntervalMs`, the scheduler queries
`store.listExpiredLeases(now, graceMs)`. For each expired lease: bump
fence via `store.expireLease`, decide resumability, reroute via the
phase-3 scheduler. **Sweep-on-boot is synchronous before the first
scheduler tick** — `await sweeper.sweep(now); scheduler.tick();
setInterval(...)`. Without this, a reattaching worker can race a
stale lease.

Voluntary release paths bypass the periodic sweep entirely: the
`worker_shutdown` registry frame (phase 1 step 1.2) and clean
local-spawn `child.on('exit')` both call `store.releaseLease(...)`
which marks lease `state='released'` and **skips the grace period**.
The next scheduler tick sees no live lease and reroutes immediately.
Crash-style local-spawn `child.on('exit')` (non-zero exit, signal,
or unexpected termination) calls `store.expireLease` directly — also
skipping the TTL wait, since orchestrator and worker are co-located
and crash detection is synchronous.

**Takeover events log.** Every transition out of `active` (whether
expiry or voluntary release) writes a row to a new
`run_lease_events` audit table: `agent_run_id`, `prior_state`,
`new_state` (`expired` | `released`), `prior_worker_id`,
`new_worker_id` (NULL until reroute lands), `prior_fence`,
`new_fence`, `reason` (`heartbeat_timeout` | `worker_shutdown` |
`local_child_exit_clean` | `local_child_exit_crash` |
`forced_takeover`), `at`. This is the forensic gap left by dropping
`owner_worker_id` in step 5.9.

**Files:**

- `src/persistence/migrations/013_run_leases_fence_token.ts` (extend
  step 5.1) — add the `run_lease_events` table to the same migration:
  ```sql
  CREATE TABLE run_lease_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
    prior_state TEXT NOT NULL,
    new_state   TEXT NOT NULL,
    prior_worker_id TEXT,
    new_worker_id   TEXT,
    prior_fence INTEGER NOT NULL,
    new_fence   INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX idx_run_lease_events_run ON run_lease_events(agent_run_id);
  ```
- `src/orchestrator/scheduler/lease-sweeper.ts` — new pure module taking
  `(now, store, scheduler, runtime, sessionStore, config)`; emits per
  expired lease either `lease_expired_resume` (reroutes via
  `runtime.dispatchRun(..., { mode: 'resume', sessionId })`) or
  `lease_expired_replan` (transitions to `replanning` via existing
  `replan_needed` vocabulary; memory: `feature_verification_contract`,
  `merge_train_executor_design`). Writes `run_lease_events` row in the
  same transaction as `expireLease`.
- `src/orchestrator/scheduler/events.ts` — handle the two new events.
  Each reuses the existing dispatch path. After a successful reroute,
  back-fills the `new_worker_id` on the matching `run_lease_events`
  row.
- `src/orchestrator/scheduler/index.ts` — `scheduler.run()` does
  `await sweeper.sweep(now); scheduler.tick();
  setInterval(sweeper.sweep, config.workerLeases.sweepIntervalMs);`
  in that order. `scheduler.stop()` clears the interval.
- `src/runtime/sessions/index.ts` — extend `SessionStore` (the
  centralized `RemoteSessionStore` from phase 2) with
  `isResumableForWorker(sessionId, workerId): Promise<boolean>`. Per
  phase 2 centralization, this is an orchestrator-side lookup against
  the canonical session row.

**Tests:**

- `test/unit/orchestrator/scheduler/lease-sweeper.test.ts` — fake clock
  + in-memory store: lease expired → fence bumped → reroute event;
  lease in grace → no event; lease expired but session not resumable →
  replan event.
- `test/integration/distributed/lease-expiry-reroute.test.ts` — two
  faux workers; first goes silent; assert the run is taken over by the
  second after `ttl + grace + sweepInterval` and resumes from the
  persisted `sessionId`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the sweep: (1) `expireLease`, the fence bump, and the
> `run_lease_events` insert all happen in one transaction so partial
> takeover is impossible and forensic state is never lost; (2)
> sweep-on-boot is synchronous and runs *before* the first scheduler
> tick (`await sweeper.sweep(now); scheduler.tick();
> setInterval(...)`); a reattaching worker cannot race a stale lease;
> (3) the resumability decision consults *all three* signals (session
> storage, runStatus, proposal-host state) — skipping any of them
> risks double-applying a proposal or resurrecting a cancelled run;
> (4) the reroute uses the phase-3 scheduler's `selectWorker` rather
> than picking arbitrarily; (5) the sweeper interval is started exactly
> once per orchestrator boot in `scheduler.run()` and stopped on
> shutdown — no leaked interval; (6) voluntary `releaseLease` paths
> (`worker_shutdown`, clean local-spawn exit) skip grace and write a
> `run_lease_events` row with the right `reason`; (7) crash-style
> local-spawn exit calls `expireLease` directly — no TTL wait. Under
> 450 words.

**Commit:** `feat(orchestrator): expire stale leases and reroute runs`

---

### Step 5.5 — Fence-token enforcement on worker→orchestrator frames

**What:** every state-mutating worker frame carries a `fence` field; the
orchestrator validates against `agent_runs.fence_token` and drops on
mismatch. Same enforcement on the bare-repo pre-receive hook and on
`Store.updateAgentRun`.

**Files:**

- `src/runtime/contracts.ts` — turn on `fence: number` enforcement for every state-mutating worker→orch frame. The field itself is added at each frame's introduction (phase 1 task frames + registry-plane `worker_shutdown` / `reconnect`, phase 2 `session_op`, phase 4 `proposal_op` / `proposal_submitted` / `proposal_phase_ended`); this step only flips the validator from "optional" to "required + checked". The full enforced list:
  - **Run-state**: `result`, `error`, `claim_lock`, `request_help`, `request_approval`, `confirm` (introduced earlier).
  - **Session**: `session_op` (introduced phase 2 step 2.3) — checked because session writes after takeover would corrupt the resume point.
  - **Proposal**: `proposal_op`, `proposal_submitted`, `proposal_phase_ended` (introduced phase 4 step 4.5) — checked because a stale planner could otherwise re-submit or re-emit ops to a run that has been taken over. (`progress` is a per-frame counter on these frames for reconnect ordering — not a fence.)
  - **Registry plane (D7 / D15)**: `reconnect` and `worker_shutdown` carry `leases: Array<{ agentRunId, fence }>` and per-lease fences are checked on receipt. A reconnecting worker presenting a stale fence has its claim refused (run already taken over); a shutting-down worker presenting a stale fence has its `releaseLease` rejected (lease already expired).
  - **Advisory frames stay un-fenced**: `progress` (the run-plane progress frame, separate from proposal-frame `seq`), `assistant_output`. Over-fencing them would drop legitimate trailing UX after a takeover for no integrity benefit.
- `src/runtime/ipc/frame-schema.ts` — extend the matching TypeBox
  branches; the validator from baseline phase 1 step 1.1 picks them up.
- `src/runtime/worker-pool.ts` — IPC handler reads
  `agent_runs.fence_token` (cached per dispatch in `liveRuns`); on
  mismatch, drops the frame, logs, and sends `abort`. Cache
  invalidation: every `expireLease` updates the cache via the
  scheduler event from step 5.4.
- `src/orchestrator/git/bare-repo-hooks.ts` (phase 2) — pre-receive
  hook reads the pushed branch's owning `agent_run_id`, looks up
  `run_leases` and `agent_runs.fence_token`, and rejects pushes whose
  `--push-option fence=<n>` is below current. Workers pass fence as a
  push option. (Path lives under `src/orchestrator/git/...` per phase
  2 — bare repo and hooks are orchestrator-host concerns.)
- **Per D10 — narrow carve-out, not broad refactor.** Reject extending
  `Store.updateAgentRun(..., expectedFence)`. Instead, introduce a
  scoped `RunLeaseStore.updateRunWithFence(runId, expectedFence,
  patch)` (or free function in `sqlite-store.ts`) that wraps the
  existing `updateAgentRunTxn` body. Only worker-attributable update
  sites (threaded through `dispatchMetadata`) call this; everything
  else keeps the unchecked path. This avoids retrofitting fence
  semantics onto every existing `updateAgentRun` caller.

**Tests:**

- `test/unit/runtime/ipc-fence-enforcement.test.ts` — fake transport;
  send `result` with fence one below current; assert run state unchanged
  and `abort` sent.
- `test/integration/distributed/git-push-fence-rejection.test.ts` — bare
  repo with the pre-receive hook; push with stale fence; assert the
  push is rejected and the working ref is unchanged.
- `test/unit/persistence/sqlite-store-fence.test.ts` —
  `RunLeaseStore.updateRunWithFence` with stale `expectedFence` is a
  no-op and surfaces a typed error; the unchecked
  `Store.updateAgentRun` path is unaffected.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify fencing: (1) every state-mutating frame variant carries
> `fence`; non-mutating variants (`progress`, `assistant_output`) do
> not; the registry-plane `reconnect` and `worker_shutdown` frames
> carry per-lease fences for the leases they reference; (2) the cached
> fence in `worker-pool.ts` is invalidated on every takeover (no path
> where a stale cache survives); (3) the bare-repo hook lives at
> `src/orchestrator/git/bare-repo-hooks.ts` (phase 2 location), reads
> `run_leases` + `agent_runs.fence_token` (not the lease alone — the
> fence is on the run, the lease is the attribution); (4) the carve-
> out `RunLeaseStore.updateRunWithFence` is wired at every worker-
> attributable call site (grep `dispatchMetadata`), and the existing
> unchecked `Store.updateAgentRun` is *not* extended — D10 narrow
> carve-out, not broad refactor; (5) failure modes are observable —
> drops are logged with enough detail to attribute them. Under 450
> words.

**Commit:** `feat(runtime): enforce fence tokens on worker frames and pushes`

---

### Step 5.6 — Worker-crash takeover integration test

**What:** end-to-end. Faux worker A dispatches a task, runs one turn,
exits without clean shutdown. Heartbeat timeout → lease expires →
worker B takes over → resumes from `sessionId` → completes the task.

**Files:**

- `test/integration/distributed/worker-crash-takeover.test.ts` — new.
  Two faux workers behind a controllable transport:
  1. Dispatch to worker A.
  2. A emits one `progress`, then exits.
  3. Wait `ttl + grace + sweepInterval` on fake clock.
  4. Assert: lease `expired`, `fence_token` bumped by 1, run `running`
     on B, B received the same `sessionId` in its `run` frame.
  5. B emits `result`; task completes.

  Also asserts the worker-↔-bare-repo partition fragment from the crash
  matrix: a transient `git_unreachable` does *not* expire the lease
  while heartbeats continue.
- `test/integration/distributed/harness/two-worker-fixture.ts` — new
  fixture for steps 5.6–5.8; reuses the faux-model harness style from
  `test/integration/harness/`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the crash-takeover test: (1) assertions pin every observable
> state (lease row, fence value, run status, new worker id), not just
> "task eventually completes"; (2) the test uses fake time for the
> sweep, never a real sleep; (3) the post-takeover worker actually
> receives the new fence in its `run` frame; (4) the old worker's
> stale `result` frame, if it manages to send one post-takeover, is
> rejected by step 5.5's enforcement and the test proves it. Under
> 350 words.

**Commit:** `test(runtime): worker-crash lease takeover and resume`

---

### Step 5.7 — Orchestrator-crash recovery integration test

**What:** orchestrator dies mid-run; comes back; finds active leases
and reattaches to live workers. Variant: both crash; reboot sweep
expires leases and reroutes.

**Files:**

- `test/integration/distributed/orchestrator-crash-recovery.test.ts` —
  new. Covers the D7 reconnect matrix and D15 shutdown/limbo matrix.
  Scenarios (each a test case with assertions on lease row, fence,
  run status, audit row):
  1. **Orchestrator-only crash, lease in-grace.** Boot, dispatch,
     observe lease + heartbeats. Kill orchestrator without graceful
     shutdown. Worker keeps running. Boot fresh orchestrator reusing
     the SQLite db. Worker reconnects (D7 same `bootEpoch`) → reattach
     handshake. Assert: lease row not deleted, fence not bumped, no
     `run_lease_events` row written.
  2. **Orchestrator crash, lease expired before reconnect.** Crash
     orchestrator. Wait `ttl + grace`. Boot orchestrator. Sweep on
     boot expires the lease. Worker reconnects → fence stale →
     reconnect refused → worker drops the run. Reroute fires on next
     tick.
  3. **Worker reboot mid-run (different `bootEpoch`).** Worker process
     restarts. New process registers with fresh `bootEpoch` and same
     `workerId`. Per D7 reconcile: orchestrator treats as new identity;
     prior leases for that `workerId` are `expired`; rerouted.
  4. **Double crash, sweep-on-boot.** Both dead. Boot fresh
     orchestrator with no live workers. Sweep runs on boot *before*
     scheduler tick. Assert: previously-active leases all end up
     `expired`, fences bumped, `run_lease_events` rows written, runs
     marked for reroute. When a worker registers, the reroute fires.
  5. **Voluntary `worker_shutdown` (D15).** Worker sends
     `worker_shutdown` frame with current leases + fences. Orchestrator
     calls `releaseLease` per entry. Lease state → `released`. Audit
     row reason = `worker_shutdown`. Reroute fires on next tick *with
     no grace wait*.
  6. **Bare close (D15 dirty).** Worker socket closes without
     `worker_shutdown`. No `onExit`, runStatus stays `running`. Lease
     waits the full `ttl + grace` before sweeper expires it. Audit
     row reason = `heartbeat_timeout`.
  7. **Reconnect after `worker_shutdown` (D15 limbo).** Worker sends
     `worker_shutdown` then immediately reconnects. Orchestrator: the
     released lease is gone; reconnect must not resurrect it. Worker
     sees no leases assigned to it; no work resumed.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the orchestrator-crash test: (1) the reattach scenario
> (case 1) does *not* bump the fence — that would invalidate the live
> worker's ongoing IPC frames and silently lose work; (2) the double-
> crash scenario (case 4) runs the sweep *before* the scheduler tick
> on boot, so a reattaching worker cannot win a race against takeover;
> (3) the SQLite db is reused across the simulated reboot; (4) the
> test does not depend on the orchestrator's in-memory worker registry
> surviving the crash — phase 1's registry rebuilds from worker
> reconnects, not from disk; (5) all six D7 reconnect scenarios and
> all six D15 shutdown/limbo scenarios are exercised — same-bootEpoch
> reattach, different-bootEpoch reboot, stale-fence reconnect refused,
> voluntary `worker_shutdown` (clean release, no grace), bare close
> (dirty, full grace wait), shutdown-then-reconnect limbo; (6) every
> case asserts the matching `run_lease_events` audit row (or its
> absence in the reattach case). Under 500 words.

**Commit:** `test(orchestrator): orchestrator-crash lease recovery`

---

### Step 5.8 — Network-partition takeover integration test

**What:** worker alive, link severed. Orchestrator-side: lease expires,
takeover fires. Worker-side: phase-1 watchdog fires; worker drops work
and attempts reconnect. On reconnect, presents stale fence → `abort`.

**Files:**

- `test/integration/distributed/network-partition-takeover.test.ts` —
  new. Single worker A + worker B registered for takeover.
  Controllable transport with `partition()` that drops frames both
  directions:
  1. Dispatch, observe steady-state heartbeats.
  2. `partition()`. Wait `ttl + grace + sweepInterval`.
  3. Assert: orchestrator-side lease expired, run rerouted to B.
     A's watchdog fired (faux worker observable: stopped emitting).
  4. Heal partition. Assert: A's reconnect met with `abort` because
     its fence is stale; A's follow-up `result` (if scripted) is
     rejected.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the partition test: (1) both sides of the partition are
> exercised — orchestrator-side takeover *and* worker-side
> self-eviction; (2) the heal step proves the abort path: a healed
> first worker that tries to keep working is told to stop, so the
> system cannot end up with two live workers thinking they own the
> same run; (3) the takeover worker actually receives the new fence
> and does not inherit the old one. Under 350 words.

**Commit:** `test(runtime): network partition lease takeover`

---

### Step 5.9 — Retire `worker_pid` / `/proc` / `RECOVERY_REBASE`

**What:** delete the legacy liveness model. After this commit no code
path reads `worker_pid`, `worker_boot_epoch`, `owner_worker_id`,
`owner_assigned_at`, `tasks.worker_id`, `/proc/<pid>/environ`, or the
`RECOVERY_REBASE` marker. Migration drops the five columns and the
matching `idx_agent_runs_owner_worker` index. Adds the lease-tied
orphan-branch cleanup hook per the Background policy.

**Files:**

- `src/orchestrator/services/recovery-service.ts` — delete
  `killStaleWorkerIfNeeded` (`:809-844`), `readProcEnvironmentMarkers`
  (`:847-856`), `parseProcEnvironment` (`:858-879`),
  `rebaseTaskWorktree` (`:788-807`), call sites (`:102, :218`), and the
  `readProcEnvironment` constructor field (`:74`). The `RECOVERY_REBASE`
  marker write is gone — the resumed worker pulls feature-branch HEAD
  via the bare repo.
- `src/runtime/harness/index.ts:25-26, 116-117, 163-164, 234-235,
  257-261` and `src/runtime/harness/feature-phase/index.ts:308-309,
  344-346, 387-388, 425-427` — drop `workerPid` / `workerBootEpoch` from
  `SessionHandle`, `createSessionHandle`, and the feature-phase
  factories. `CURRENT_ORCHESTRATOR_BOOT_EPOCH` (harness/index.ts:64) is
  unused; also delete.
- `src/runtime/contracts.ts:95-96` — remove `workerPid` /
  `workerBootEpoch` from `DispatchHarnessMetadata`.
- `src/runtime/worker-pool.ts:41-55, 264-284` and
  `src/orchestrator/scheduler/dispatch.ts:160-262` — `dispatchMetadata`,
  `runningRunPatch`, `proposalAwaitingApprovalPatch` drop legacy fields.
  `liveRuns` keys on `workerId`.
- `src/core/types/runs.ts:38-39`,
  `src/persistence/sqlite-store.ts:43-44, 69-70, 110, 124-125, 190-191`,
  `src/persistence/codecs.ts:281-282, 307-308`,
  `src/persistence/queries/index.ts:111-112` — drop columns from the
  type and SQL surfaces.
- `src/persistence/migrations/014_drop_legacy_run_columns.ts` — new
  migration. Pinned id `014` per phase-0 chain. **First table-rebuild
  migration post-consolidation** (the consolidated `001_init.ts` from
  phase 0 absorbed the old `006_rename_feature_ci_to_ci_check.ts`
  rebuild precedent, so cite the pattern abstractly rather than
  pointing at a now-collapsed migration). Use `CREATE TABLE … AS
  SELECT` to rebuild `agent_runs` without `worker_pid`,
  `worker_boot_epoch`, `owner_worker_id`, `owner_assigned_at`; rebuild
  `tasks` without `worker_id`; drop `idx_agent_runs_owner_worker`.
  Migration docstring enumerates the post-rebuild `agent_runs` schema
  verbatim so future readers can audit. Downgrade out of scope.
- `src/persistence/db.ts` — register the new migration.
- `src/runtime/worktree/index.ts` — add the lease-tied orphan-branch
  cleanup helper from the Background section. Hooks from the
  baseline phase-4 disposal sites
  (`01-baseline/phase-4-recovery.md` step 4.1) plus the takeover path
  in step 5.4.
- `test/unit/orchestrator/recovery.test.ts:1145` — delete the
  `RECOVERY_REBASE` assertion; update the surrounding test to assert
  resumed worker pulls feature-branch HEAD via the dispatch payload.
  Replace `killStaleWorkerIfNeeded` cases with lease-based equivalents
  (substantive coverage already comes from steps 5.4–5.8).

**Tests:** behavioral coverage already exists from earlier steps.
Step-local addition: `test/unit/runtime/worktree/orphan-cleanup.test.ts`
— assert lease-tied cleanup runs only after takeover *and* the new
worker's first heartbeat acks the new fence; never on mere lease
expiry.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the retirement: (1) zero references remain to `worker_pid`,
> `workerPid`, `worker_boot_epoch`, `workerBootEpoch`,
> `owner_worker_id`, `ownerWorkerId`, `owner_assigned_at`,
> `ownerAssignedAt`, `tasks.worker_id`, `idx_agent_runs_owner_worker`,
> `/proc/`, `process.kill` (orchestrator-side), or `RECOVERY_REBASE` —
> grep the whole tree, including tests; (2) `run.ownerWorkerId` reads
> are forbidden post-phase-5 — flag any survivor; (3) the column-drop
> migration uses the `CREATE TABLE … AS SELECT` rebuild pattern, not
> `ALTER TABLE … DROP COLUMN`, since SQLite `DROP COLUMN` is unreliable
> on the Alpine builds we target; (4) the migration is additive on top
> of the lease migration from step 5.1 — i.e. it assumes step 5.1
> already applied; (5) the migration's docstring lists the post-
> rebuild `agent_runs` schema verbatim; (6) every `agent_runs` insert /
> update site no longer attempts to set the dropped columns; (7)
> orphan cleanup never runs on mere lease expiry — only after a
> confirmed takeover or explicit cancel; (8) test changes do not
> regress coverage. Under 500 words.

**Commit:** `refactor(runtime): retire pid/proc liveness in favor of leases`

---

## Phase exit criteria

- All nine commits land in order on a feature branch.
- `npm run verify` passes on the final commit.
- The phase-level integration suite (`test/integration/distributed/`)
  exercises: lease grant on dispatch, registry-plane heartbeat-driven
  renewal, single missed heartbeat absorbed by grace, expired lease
  reroute, fence-token rejection on stale frames, fence rejection on
  stale push, worker-crash takeover, orchestrator-crash reattach
  (same `bootEpoch`), worker reboot mid-run (different `bootEpoch`),
  double-crash sweep-on-boot, voluntary `worker_shutdown` clean release
  (skips grace), shutdown-then-reconnect limbo, network-partition
  takeover, orphan branch cleanup after takeover.
- A final review subagent reads all nine commits and confirms: every
  failure mode in the crash matrix and every D7 reconnect / D15
  shutdown scenario has a test; the fence-token model is enforced at
  IPC, store (via `RunLeaseStore.updateRunWithFence`), and git-push
  layers without gap; no code path retains `worker_pid`,
  `worker_boot_epoch`, `owner_worker_id`, `owner_assigned_at`,
  `tasks.worker_id`, `/proc/`, or `RECOVERY_REBASE`; the orphan-
  branch cleanup is lease-tied (does not run on mere lease expiry);
  every transition out of `active` writes a `run_lease_events` row.
- After this phase, the local-machine baseline pid/proc liveness is
  gone. The system is fully distributed; the only worker identity that
  crosses any boundary is the phase-1 `workerId`, and the only
  authority a worker carries is its current `(workerId, fence)` pair.
