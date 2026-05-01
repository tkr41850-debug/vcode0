# Phase 5 — Leases and recovery

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-0-migration-consolidation (pins migration ids `005` and `006` for this track), phase-1-protocol-and-registry (registry plane, `heartbeat` / `reconnect` / `worker_shutdown` frame surface, `bootEpoch` semantics), phase-2-remote-task-execution (`RemoteSessionStore`, bare-repo and pre-receive hook plumbing), phase-3-multi-worker-scheduling (`selectWorker` and the worker-panel three-tier rendering this phase enriches), phase-4-remote-feature-phases (proposal-host model that takeover resumability consults)
- Default verify: npm run check:fix && npm run check
- Phase exit: npm run verify; boot two workers; dispatch a task to worker A; kill worker A without graceful shutdown; observe the lease pass grace, fence bump, and run resume on worker B from the persisted `sessionId` to completion.
- Doc-sweep deferred: `docs/architecture/worker-model.md` (pid/proc liveness, `RECOVERY_REBASE` marker, `FileSessionStore`-as-sole-persistence narrative), `docs/architecture/persistence.md` (`worker_pid` / `worker_boot_epoch` / `owner_worker_id` / `owner_assigned_at` references; recovery-metadata schema; new `run_leases` / `run_lease_events` / `fence_token` surfaces), `docs/operations/verification-and-recovery.md` (lease-based reclamation and crash-matrix copy). Reconcile in one doc-only commit at phase exit.

Ships as 9 commits, in order.

## Contract

- Goal: replace local-machine pid/proc liveness with persisted ownership leases as the authoritative record of "which worker owns which run"; heartbeats from the registry plane renew leases, expired leases are reclaimed and rerouted via the phase-3-multi-worker-scheduling picker, and every state-mutating worker frame is fenced.
- Scope:
  - In:
    - New `run_leases` and `run_lease_events` tables, `agent_runs.fence_token` column (migration `005`), with Store API: `grantLease`, `getLease`, `renewLease`, `expireLease`, `releaseLease`, `listExpiredLeases`, `bumpAndReadFence`, `RunLeaseStore.updateRunWithFence`.
    - Lease grant on dispatch with pinned ordering (bump fence → send `run` frame with fence → `harness.start` → `grantLease` → persist `running`); rollback closes handle and aborts on grant failure.
    - Heartbeat-driven lease renewal as the canonical lease carrier; `health_pong` stays local-stdio liveness with no lease semantics (D6 reversal).
    - Voluntary release on `worker_shutdown` D15 frame and clean local-spawn `child.on('exit')` (skips grace).
    - Lease-expiry sweep with reroute or replan, sweep-on-boot synchronous before first scheduler tick.
    - Fence-token enforcement at IPC, `RunLeaseStore.updateRunWithFence`, and bare-repo `git push` layers.
    - Integration tests for the worker-crash, orchestrator-crash (seven D7 / D15 cases), and network-partition crash matrix.
    - Retirement of `worker_pid`, `worker_boot_epoch`, `owner_worker_id`, `owner_assigned_at`, `tasks.worker_id`, `idx_agent_runs_owner_worker`, `/proc/<pid>/environ` probes, orchestrator-side `process.kill`, and `RECOVERY_REBASE` markers (migration `006` table-rebuild).
    - Lease-tied orphan-branch cleanup helper that runs only after takeover or explicit cancel.
  - Out:
    - Multi-orchestrator leadership / split-brain protection (single-orchestrator authority is a 03-distributed track non-negotiable; no owner phase in this track).
    - Automatic lease re-grant on transient flap shorter than grace (handled by `reconnect` reattach within the grace window; flap longer than grace expires the lease).
    - Per-run quotas or backoff on chronic takeover (no owner phase in this track).
    - Cross-worker session migration mid-run; the new worker streams from `RemoteSessionStore` rather than from prior worker memory (per phase-2-remote-task-execution centralization).
    - UI surface for lease state beyond the worker-panel three-tier enrichment introduced by phase-3-multi-worker-scheduling step 3.6.
- Exit criteria:
  - All nine commits land in order on a feature branch; `npm run verify` passes on the final commit.
  - Phase-level integration suite covers the crash matrix end-to-end (steps 5.6–5.8 plus the seven D7 / D15 cases in step 5.7).
  - Final review across all nine commits confirms: every crash-matrix and D7 / D15 scenario has a test; fence enforcement holds at IPC, `RunLeaseStore.updateRunWithFence`, and git-push layers; zero residual references to the legacy columns / `worker_pid` / `RECOVERY_REBASE`; orphan cleanup is lease-tied; every transition out of `active` (to `expired` or `released`) writes a `run_lease_events` row.
  - After this phase, the local-machine baseline pid/proc liveness is gone. The only worker identity that crosses any boundary is the phase-1-protocol-and-registry `workerId`, and the only authority a worker carries is its current `(workerId, fence)` pair.

## Plan

- Background: the cumulative state shipped by other phases in this track already delivers the registry plane (heartbeat is the canonical lease carrier per D6 reversal; `health_pong` stays local-stdio with no lease semantics), remote task and feature-phase execution, bare-repo git sync, and multi-worker scheduling with implicit ownership. This phase promotes ownership to a first-class persisted record covering both `agent_runs.scopeType` values uniformly. Legacy liveness concentrates in `src/orchestrator/services/recovery-service.ts` (`killStaleWorkerIfNeeded` at `:809-844`, `readProcEnvironmentMarkers` at `:847-856`, `parseProcEnvironment` at `:858-879`, `process.kill` call sites at `:102` and `:218`; `rebaseTaskWorktree` at `:788-807` writes a `RECOVERY_REBASE` marker into a local worktree path that no longer exists post-phase-2-remote-task-execution), and in the `worker_pid` / `worker_boot_epoch` columns threaded through persistence (`src/persistence/sqlite-store.ts:43-44, 69-70, 110, 124-125, 190-191`; `src/persistence/codecs.ts:281-282, 307-308`; `src/persistence/queries/index.ts:111-112`; `src/core/types/runs.ts:38-39`), runtime contracts (`src/runtime/contracts.ts:95-96`), harness (`src/runtime/harness/index.ts:25-26, 116-117, 163-164, 234-235, 257-261`; `src/runtime/harness/feature-phase/index.ts:308-309, 344-346, 387-388, 425-427`), worker-pool (`src/runtime/worker-pool.ts:41-55, 264-284`), and scheduler dispatch (`src/orchestrator/scheduler/dispatch.ts:160-262`). Step 5.9 enumerates exact line ranges for retirement.
- Notes:
  - **Lease record shape.** New `run_leases` table, *not* extra columns on `agent_runs`. Leases churn on every heartbeat; `agent_runs` is already wide and hot. A separate table keeps takeover history auditable and lets `agent_runs.fence_token` be the only new column on the run row — bumped on every takeover so older leases are invalidated atomically.
  - **Renewal model.** Heartbeat-driven on the registry plane. The phase-1-protocol-and-registry `RegistryFrame.heartbeat` grows a `leases: { agentRunId, fence }[]` field; each entry extends `expires_at` to `now + ttlMs`. Per D6 reversal, `health_ping` / `health_pong` (01-baseline phase-1-safety step 1.4) is local-stdio only and carries no lease semantics. A separate `lease_renew` RPC is rejected — it doubles network chatter and creates two paths to keep in sync.
  - **Expiry policy.** Static TTL plus configurable grace: `leaseTtlMs` (default `30_000`), `leaseGraceMs` (default `15_000` per phase-1-protocol-and-registry open-question confirmation). Lease is renewable until `expiresAt`, takeover-eligible only after `expiresAt + leaseGraceMs` (absorbs single missed heartbeats). Operator tuning lives under a new `config.workerLeases` block.
  - **Lease states.** Three terminal-ish values: `active` (held by a live worker), `expired` (heartbeat timeout — passes through grace before takeover), `released` (voluntary release via `worker_shutdown` D15 frame or clean local-spawn `child.on('exit')` — skips grace, takeover fires on next tick).
  - **`bootEpoch` semantics (D7).** Each worker process picks a fresh `bootEpoch` on start; same `workerId` across reboots is the identity, `bootEpoch` distinguishes incarnations. On reconnect: same `bootEpoch` = reattach (no fence rotation, leases keep ticking); different `bootEpoch` = treated as new identity (prior leases for that `workerId` are expired, fences bumped, runs rerouted). The phase-1-protocol-and-registry registry server holds `connection ↔ (workerId, bootEpoch)` and drives this branch.
  - **Takeover protocol.** Sweep at `leaseTtlMs / 4`. For each lease past `expiresAt + leaseGraceMs`: (1) mark lease `state = 'expired'` and bump `agent_runs.fence_token` in one transaction; (2) decide resumability — (a) session storage from phase-2-remote-task-execution reports the session as recoverable for a *different* worker, (b) `runStatus` is `running` / `await_response` / `await_approval`, (c) the proposal-host model from phase-4-remote-feature-phases says no in-flight proposal is mid-apply; if any fails, the run goes to `replanning` (existing `replan_needed` vocabulary; memory: `feature_verification_contract`); (3) pick a new worker via the phase-3-multi-worker-scheduling `selectWorker`; if none available, leave `ready` for the next tick; (4) worker pulls latest state from the bare repo (`git fetch origin <feature-branch>`); old worker's local worktree is forfeit; (5) dispatch via `RuntimePort.dispatchRun(...)` with `mode: 'resume'`, `sessionId`, **and the new fence in the run frame**.
  - **Fencing.** Every state-mutating worker frame carries `(workerId, agentRunId, fence)`. Stale fences are dropped. Enforcement: IPC frame validator (01-baseline phase-1-safety step 1.1) — `fence` becomes required on mutating variants only; bare-repo pre-receive hook (phase-2-remote-task-execution, `src/orchestrator/git/bare-repo-hooks.ts`) reads `run_leases` + `agent_runs.fence_token` for the pushed branch's owning run and rejects pushes whose `--push-option fence=<n>` is below current; per D10 narrow carve-out, a new `RunLeaseStore.updateRunWithFence(runId, expectedFence, patch)` wraps the existing `updateAgentRunTxn` body — worker-attributable update sites threaded through `dispatchMetadata` (`src/runtime/worker-pool.ts:40-56`) call this; everything else keeps the unchecked `Store.updateAgentRun` path.
  - **Crash matrix.**

    | Crash | Detection / Recovery | Test |
    |---|---|---|
    | Orchestrator mid-run | Reboot finds `running` runs with live leases. Live → reattach via phase-1-protocol-and-registry reconnect. Expired → takeover. | 5.7 |
    | Worker mid-run | Heartbeats stop; lease passes grace. Sweep → bump fence → reroute → resume from `sessionId`. | 5.6 |
    | Network partition | Orchestrator-side: as worker crash. Worker-side: phase-1-protocol-and-registry watchdog fires; worker drops work. On reconnect, stale fence → `abort`. | 5.8 |
    | Worker ↔ bare repo | `git push` fails → worker reports `error: git_unreachable`. Phase-1-protocol-and-registry retry classifies transient; lease is *not* expired unless heartbeats also stop. | within 5.6 |
    | Both simultaneously | Stateless reboot; lease rows on disk are expired. Reconciler sweeps on boot *before* scheduler runs; reroute on first tick. | 5.7 (case 2) |

  - **Retirement of pid/proc liveness.** Step 5.9 deletes `killStaleWorkerIfNeeded`, `readProcEnvironmentMarkers`, `parseProcEnvironment`, `rebaseTaskWorktree` / `RECOVERY_REBASE`, and the `workerPid` / `workerBootEpoch` plumbing through harness, worker-pool, and scheduler dispatch (replaced by `workerId` + `fence`). Migration `006_drop_legacy_run_columns.ts` uses `CREATE TABLE … AS SELECT` rebuild (SQLite `DROP COLUMN` unreliable on Alpine 3.34.x) to drop `agent_runs.{worker_pid, worker_boot_epoch, owner_worker_id, owner_assigned_at}`, `tasks.worker_id`, and `idx_agent_runs_owner_worker`. Downgrade requires restoring from a pre-this-phase SQLite backup.
  - **Orphaned branches.** A dead worker may leave a feature/task branch on the bare repo with no live owner. Branches are lease-tied: each branch ref is owned by whichever run currently holds the lease for that scope. Cleanup runs only after a takeover *or* an explicit cancel — never on mere lease expiry, because the takeover may itself fail and the branch must remain available for retry. When a feature moves to `cancelled` or a task run is rerouted *and* the new worker has acked its first heartbeat with the new fence, the cleanup step in `WorktreeProvisioner` runs `git update-ref -d` against any task branch whose owning run is `cancelled` / `completed` and which no live worker reports holding open. Hooks into the disposal logic from `01-baseline/phase-4-recovery.md` step 4.1 and respects the same idempotency contract. This phase does *not* introduce a generic branch GC.

## Steps

Nine commits, lease-lifecycle order: schema → grant → renew → expire → take over → crash-class tests → retire legacy columns + orphan cleanup.

### 5.1 run_leases table + fence_token column + Store API [risk: high, size: L]

What: durable lease store. Schema only. Producer/consumer wiring lands in steps 5.2 and 5.4. Migration `005_run_leases_fence_token.ts` is one transactional unit creating `run_leases`, `run_lease_events`, indexes, and adding `agent_runs.fence_token NOT NULL DEFAULT 0`. Pinned id `005` per phase-0-migration-consolidation chain (phase-1-protocol-and-registry = `002_workers.ts`, phase-3-multi-worker-scheduling = `003_agent_run_owner_columns.ts` / `004_agent_run_owner_index.ts`, this step = `005`, step 5.9 = `006`).

Files:
  - `src/persistence/migrations/005_run_leases_fence_token.ts` (new) — register `Migration005RunLeasesFenceToken`. Creates:

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
    CREATE TABLE run_lease_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_run_id    TEXT NOT NULL REFERENCES agent_runs(id),
      prior_state     TEXT NOT NULL,
      new_state       TEXT NOT NULL,
      prior_worker_id TEXT NOT NULL,
      new_worker_id   TEXT,
      fence_before    INTEGER NOT NULL,
      fence_after     INTEGER NOT NULL,
      reason          TEXT NOT NULL,
      occurred_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_run_lease_events_run ON run_lease_events(agent_run_id);
    ```

    The `run_lease_events` audit table lands here (not in step 5.4) so the migration is one transactional unit; consumers turn on in step 5.4.
  - `src/persistence/db.ts` — register in the `migrations` array (same wiring as the `002` entry from phase-1-protocol-and-registry step 1.3).
  - `src/orchestrator/ports/index.ts` — extend `Store` with `grantLease`, `getLease`, `renewLease` (fence-checked, refuses on stale fence), `expireLease` (transactional: lease mutation + fence bump in one tx), `releaseLease` (voluntary, marks `state='released'`, skips grace; used by `worker_shutdown` from phase-1-protocol-and-registry step 1.2 and by clean local-spawn `child.on('exit')`), `listExpiredLeases(now, graceMs)`, and `bumpAndReadFence(agentRunId)` (transactional: increment `agent_runs.fence_token`, return new value; called by step 5.2 dispatch path before the `run` frame is sent).
  - `src/persistence/sqlite-store.ts` — implement. `expireLease` and `releaseLease` each wrap in `db.transaction(...)`.
  - `src/core/types/runs.ts` — add `RunLease` (with `state: 'active' | 'expired' | 'released'`); add `fenceToken: number` to `AgentRun` (default 0 for pre-migration rows).

Tests: `test/unit/persistence/sqlite-store.test.ts` — extend with grant + renew + expire + listExpired round-trip. Cover fence-monotonic guarantee (two consecutive `expireLease` calls bump by exactly 1 each). Cover renewal-with-stale-fence rejection.

Review goals (cap 250 words):
  1. Migration: `fence_token` ADD COLUMN has `NOT NULL DEFAULT 0`.
  2. `expireLease` runs the lease update + fence bump in one transaction.
  3. `releaseLease` skips fence bump but still wraps in a transaction.
  4. `bumpAndReadFence` is transactional.
  5. `run_lease_events` ships in this migration alongside `run_leases` (single transactional unit).
  6. No consumer wired yet; flag any FK omission, missing index, or interface drift.

Commit: feat(persistence): add run_leases table and fence_token column
Rollback: drop the `run_leases` and `run_lease_events` tables and the `fence_token` column via a rebuild migration (additive schema cannot be undone with `git revert` alone on databases that already migrated). Downgrade requires restoring from a pre-this-phase SQLite backup.

### 5.2 Lease grant on dispatch [risk: high, size: L]

What: every successful `dispatchRun` (started or resumed) creates an `active` lease owned by the assigned worker, with `expires_at = now + leaseTtlMs` and `fence_token = agent_runs.fence_token`. If the grant fails, the dispatch is rolled back — no lease, no run.

Dispatch ordering (pinned). The fence must travel in the `run` frame so the worker can stamp every subsequent state-mutating frame with it. Order:

1. Read-and-increment `agent_runs.fence_token` in one transaction; capture the new value `fence`.
2. Send `run` frame to the picked worker with `fence` in the payload.
3. `await harness.start(...)` — this only succeeds once the worker acks the run.
4. `await store.grantLease({ ..., fence, state: 'active' })`.
5. Persist `runStatus = 'running'` via the existing dispatch patches.

If step 4 fails, close the handle, send `abort` to the worker, and reject the dispatch — the run does not advance. Step 1 already bumped the fence, so a retry naturally picks a fresh fence and any frame emitted by the aborted worker is rejected by step 5.5 enforcement.

Files:
  - `src/runtime/contracts.ts` — confirm `OrchestratorToWorkerMessage.run` carries `fence: number` (added at frame introduction in phase-1-protocol-and-registry step 1.2's `RegistryFrame` neighbour schemas; this step verifies the TypeBox mirror in `frame-schema.ts` is in sync). Extend `DispatchRunResult` `started` / `resumed` variants with `workerId: string` and `fence: number`. Legacy `workerPid` / `workerBootEpoch` stay until step 5.9.
  - `src/runtime/worker-pool.ts:78+` — implement the ordering above. Read + bump fence via `Store.bumpAndReadFence(agentRunId)` (introduced in step 5.1). After `harness.start` resolves, call `store.grantLease({ agentRunId, workerId, fence, grantedAt: now, expiresAt: now + ttl, state: 'active' })`. On grant failure, close the handle and rethrow.
  - `src/orchestrator/scheduler/dispatch.ts:160-262` — extend `runningRunPatch` and `proposalAwaitingApprovalPatch` to persist `fenceToken` from the dispatch result.
  - `src/config.ts` — add `workerLeases: { ttlMs: 30_000, graceMs: 15_000, sweepIntervalMs: 7_500 }`. `graceMs` default 15s per phase-1-protocol-and-registry design decision.

Tests:
  - `test/unit/runtime/worker-pool-lease-grant.test.ts` (new) — fake harness + in-memory store: assert `dispatchRun` produces a `run_leases` row with the right shape; assert that if `grantLease` throws, the handle is closed and `dispatchRun` rejects.
  - `test/unit/orchestrator/scheduler/dispatch-fence-persistence.test.ts` (new) — assert `runningRunPatch` writes `fenceToken` from the dispatch result.

Review goals (cap 250 words):
  1. Pinned ordering holds: bump fence → send `run` frame with fence → `harness.start` → `grantLease` → persist `runStatus='running'`.
  2. Grant failure rejects the dispatch and tears down the handle (`abort` + close).
  3. `Store.bumpAndReadFence` is the only fence-increment path outside takeover; flag any other writer.

Commit: feat(runtime): grant ownership lease on dispatch

### 5.3 Heartbeat-driven lease renewal (registry plane) [risk: med, size: M]

What: extend the phase-1-protocol-and-registry `heartbeat` registry-plane frame (`RegistryFrame` introduced in phase-1-protocol-and-registry step 1.2) to carry the worker's held `agentRunId`s with their fences. The orchestrator handler renews each lease via `store.renewLease`. Stale-fence heartbeats are dropped (worker is stale; takeover already happened) and trigger an `abort` on the run plane.

Per D6 reversal: `heartbeat` is the canonical lease carrier; `health_ping` / `health_pong` stays local-stdio liveness with no lease semantics.

Files:
  - `src/runtime/contracts.ts` — `RegistryFrame.heartbeat` (added in phase-1-protocol-and-registry step 1.2) gains `leases: Array<{ agentRunId: string; fence: number }>`. `health_pong` schema is untouched — it stays lease-free local liveness.
  - `src/runtime/ipc/frame-schema.ts` (01-baseline phase-1-safety step 1.1) — add `leases` to the registry-plane TypeBox branch only.
  - `src/runtime/registry/server.ts` (phase-1-protocol-and-registry step 1.4) — heartbeat handler iterates `leases[]` and calls `store.renewLease` per entry. On renew rejection (stale fence), logs and dispatches `abort` over the run plane (registry server holds the `connection ↔ workerId` map; the run-plane router from phase-2-remote-task-execution step 2.4 has the `(workerId, agentRunId) → connection` mapping).
  - `src/runtime/registry/client.ts` (phase-1-protocol-and-registry step 1.4) — registry client and run executor share an in-process atomic `Map<agentRunId, fence>` (one-process-per-worker constraint makes this safe). On every `run` frame received, set the entry; on every heartbeat tick, snapshot the map into the outgoing `leases[]`.
  - `src/orchestrator/scheduler/lease-keeper.ts` (new, or fold into registry server's `onHeartbeat`) — subscribes to heartbeat events; calls `store.renewLease` per entry.

Tests: `test/integration/distributed/lease-renewal.test.ts` (new) — faux worker scripted to send registry-plane heartbeats; assert `expires_at` advances by roughly `ttlMs` per heartbeat; assert that a tampered heartbeat with a stale fence does not extend the lease and triggers an `abort` on the run plane.

Review goals (cap 300 words):
  1. Renewal lives on the registry-plane `heartbeat` frame, not `health_pong` (D6 reversal).
  2. Heartbeats renew exactly the leases listed — no implicit renewal.
  3. Stale-fence heartbeats do not advance `expires_at` and trigger the run-plane abort path.
  4. Renewal threads through `Store.renewLease` (no direct SQL writes).
  5. The in-process `Map<agentRunId, fence>` between registry client and run executor is documented as single-process-per-worker.

Commit: feat(runtime): renew leases via heartbeat pong

### 5.4 Lease-expiry sweep + reroute [risk: high, size: L]

What: periodic sweep replaces `killStaleWorkerIfNeeded`. Every `config.workerLeases.sweepIntervalMs`, the scheduler queries `store.listExpiredLeases(now, graceMs)`. For each expired lease: bump fence via `store.expireLease`, decide resumability, reroute via the phase-3-multi-worker-scheduling scheduler. Sweep-on-boot is synchronous before the first scheduler tick — `await sweeper.sweep(now); scheduler.tick(); setInterval(...)`. Without this, a reattaching worker can race a stale lease.

Voluntary release (`worker_shutdown` frame, clean local `child.on('exit')`) calls `releaseLease` — skips grace, reroutes next tick. Crash-style local exit calls `expireLease` directly (synchronous co-located crash detection, no TTL wait).

Takeover events log. Every transition out of `active` (whether expiry or voluntary release) writes a row to the `run_lease_events` audit table (schema lands in step 5.1's migration). `reason` is one of `heartbeat_timeout` | `worker_shutdown` | `local_child_exit_clean` | `local_child_exit_crash` | `forced_takeover`. `new_worker_id` is NULL until reroute back-fills it. This is the forensic gap left by dropping `owner_worker_id` in step 5.9.

Files:
  - `src/orchestrator/scheduler/lease-sweeper.ts` (new) — pure module taking `(now, store, scheduler, runtime, sessionStore, config)`; emits per expired lease either `lease_expired_resume` (reroutes via `runtime.dispatchRun(..., { mode: 'resume', sessionId })`) or `lease_expired_replan` (transitions to `replanning` via existing `replan_needed` vocabulary; memory: `feature_verification_contract`, `merge_train_executor_design`). Writes `run_lease_events` row in the same transaction as `expireLease`.
  - `src/orchestrator/scheduler/events.ts` — handle the two new events. Each reuses the existing dispatch path. After a successful reroute, back-fills the `new_worker_id` on the matching `run_lease_events` row.
  - `src/orchestrator/scheduler/index.ts` — `scheduler.run()` does `await sweeper.sweep(now); scheduler.tick(); setInterval(sweeper.sweep, config.workerLeases.sweepIntervalMs);` in that order. `scheduler.stop()` clears the interval.
  - `src/runtime/sessions/index.ts` — extend `SessionStore` (the centralized `RemoteSessionStore` from phase-2-remote-task-execution) with `isResumableForWorker(sessionId, workerId): Promise<boolean>`. Per phase-2-remote-task-execution centralization, this is an orchestrator-side lookup against the canonical session row.

Tests:
  - `test/unit/orchestrator/scheduler/lease-sweeper.test.ts` (new) — fake clock + in-memory store: lease expired → fence bumped → reroute event; lease in grace → no event; lease expired but session not resumable → replan event.
  - `test/integration/distributed/lease-expiry-reroute.test.ts` (new) — two faux workers; first goes silent; assert the run is taken over by the second after `ttl + grace + sweepInterval` and resumes from the persisted `sessionId`.

Review goals (cap 300 words):
  1. `expireLease`, fence bump, and `run_lease_events` insert all happen in one transaction.
  2. Sweep-on-boot is synchronous and runs before the first scheduler tick.
  3. Resumability consults all three signals (session storage, runStatus, proposal-host state).
  4. Reroute uses phase-3-multi-worker-scheduling `selectWorker`.
  5. Voluntary `releaseLease` paths skip grace and write the right `reason`.
  6. Crash-style local exit calls `expireLease` directly.

Commit: feat(orchestrator): expire stale leases and reroute runs

### 5.5 Fence-token enforcement on worker→orchestrator frames [risk: high, size: L]

What: every state-mutating worker frame carries a `fence` field; the orchestrator validates against `agent_runs.fence_token` and drops on mismatch. Same enforcement on the bare-repo pre-receive hook and on `Store.updateAgentRun`.

Files:
  - `src/runtime/contracts.ts` — turn on `fence: number` enforcement for every state-mutating worker→orch frame. The field itself is added at each frame's introduction (phase-1-protocol-and-registry task frames + registry-plane `worker_shutdown` / `reconnect`, phase-2-remote-task-execution `session_op`, phase-4-remote-feature-phases `proposal_op` / `proposal_submitted` / `proposal_phase_ended`); this step only flips the validator from "optional" to "required + checked". The full enforced list:
    - Run-state: `result`, `error`, `claim_lock`, `request_help`, `request_approval`, `confirm` (introduced earlier).
    - Session: `session_op` (introduced phase-2-remote-task-execution step 2.3) — checked because session writes after takeover would corrupt the resume point.
    - Proposal: `proposal_op`, `proposal_submitted`, `proposal_phase_ended` (introduced phase-4-remote-feature-phases step 4.5) — checked because a stale planner could otherwise re-submit or re-emit ops to a run that has been taken over. (`progress` is a per-frame counter on these frames for reconnect ordering — not a fence.)
    - Registry plane (D7 / D15): `reconnect` and `worker_shutdown` carry `leases: Array<{ agentRunId, fence }>` and per-lease fences are checked on receipt. A reconnecting worker presenting a stale fence has its claim refused (run already taken over); a shutting-down worker presenting a stale fence has its `releaseLease` rejected (lease already expired).
    - Advisory frames stay un-fenced: `progress` (the run-plane progress frame, separate from proposal-frame `seq`), `assistant_output`. Over-fencing them would drop legitimate trailing UX after a takeover for no integrity benefit.
  - `src/runtime/ipc/frame-schema.ts` — extend the matching TypeBox branches; the validator from 01-baseline phase-1-safety step 1.1 picks them up.
  - `src/runtime/worker-pool.ts` — IPC handler reads `agent_runs.fence_token` (cached per dispatch in `liveRuns`); on mismatch, drops the frame, logs, and sends `abort`. Cache invalidation: every `expireLease` updates the cache via the scheduler event from step 5.4.
  - `src/orchestrator/git/bare-repo-hooks.ts` (phase-2-remote-task-execution) — pre-receive hook reads the pushed branch's owning `agent_run_id`, looks up `run_leases` and `agent_runs.fence_token`, and rejects pushes whose `--push-option fence=<n>` is below current. Workers pass fence as a push option. (Path lives under `src/orchestrator/git/...` per phase-2-remote-task-execution — bare repo and hooks are orchestrator-host concerns.)
  - Per D10 — narrow carve-out, not broad refactor. Reject extending `Store.updateAgentRun(..., expectedFence)`. Instead, introduce a scoped `RunLeaseStore.updateRunWithFence(runId, expectedFence, patch)` (or free function in `sqlite-store.ts`) that wraps the existing `updateAgentRunTxn` body. Only worker-attributable update sites (threaded through `dispatchMetadata`) call this; everything else keeps the unchecked path. This avoids retrofitting fence semantics onto every existing `updateAgentRun` caller.

Tests:
  - `test/unit/runtime/ipc-fence-enforcement.test.ts` (new) — fake transport; send `result` with fence one below current; assert run state unchanged and `abort` sent.
  - `test/integration/distributed/git-push-fence-rejection.test.ts` (new) — bare repo with the pre-receive hook; push with stale fence; assert the push is rejected and the working ref is unchanged.
  - `test/unit/persistence/sqlite-store-fence.test.ts` (new) — `RunLeaseStore.updateRunWithFence` with stale `expectedFence` is a no-op and surfaces a typed error; the unchecked `Store.updateAgentRun` path is unaffected.

Review goals (cap 300 words):
  1. State-mutating frames carry `fence`; advisory frames (`progress`, `assistant_output`) do not; registry-plane `reconnect` / `worker_shutdown` carry per-lease fences.
  2. Cached fence in `worker-pool.ts` is invalidated on every takeover.
  3. Bare-repo hook reads `run_leases` + `agent_runs.fence_token`.
  4. `RunLeaseStore.updateRunWithFence` wired at every `dispatchMetadata` site, unchecked `Store.updateAgentRun` not extended (D10 narrow carve-out).
  5. Drops are logged with enough detail to attribute them.

Commit: feat(runtime): enforce fence tokens on worker frames and pushes

### 5.6 Worker-crash takeover integration test [risk: low, size: M]

What: end-to-end. Faux worker A dispatches a task, runs one turn, exits without clean shutdown. Heartbeat timeout → lease expires → worker B takes over → resumes from `sessionId` → completes the task.

Files:
  - `test/integration/distributed/worker-crash-takeover.test.ts` (new). Two faux workers behind a controllable transport:
    1. Dispatch to worker A.
    2. A emits one `progress`, then exits.
    3. Wait `ttl + grace + sweepInterval` on fake clock.
    4. Assert: lease `expired`, `fence_token` bumped by 1, run `running` on B, B received the same `sessionId` in its `run` frame.
    5. B emits `result`; task completes.

    Also asserts the worker-↔-bare-repo partition fragment from the crash matrix: a transient `git_unreachable` does *not* expire the lease while heartbeats continue.
  - `test/integration/distributed/harness/two-worker-fixture.ts` (new) — fixture for steps 5.6–5.8; reuses the faux-model harness style from `test/integration/harness/`.

Tests: covered by the new files above.

Review goals (cap 250 words):
  1. Assertions pin every observable state (lease row, fence value, run status, new worker id).
  2. The test uses fake time for sweep, never real sleep.
  3. Post-takeover worker receives the new fence.
  4. Old worker's stale `result` post-takeover is rejected by step 5.5 enforcement.

Commit: test(runtime): worker-crash lease takeover and resume

### 5.7 Orchestrator-crash recovery integration test [risk: low, size: L]

What: orchestrator dies mid-run; comes back; finds active leases and reattaches to live workers. Variant: both crash; reboot sweep expires leases and reroutes.

Files:
  - `test/integration/distributed/orchestrator-crash-recovery.test.ts` (new) — covers the D7 reconnect matrix and D15 shutdown/limbo matrix. Scenarios (each a test case with assertions on lease row, fence, run status, audit row):
    1. Orchestrator-only crash, lease in-grace. Boot, dispatch, observe lease + heartbeats. Kill orchestrator without graceful shutdown. Worker keeps running. Boot fresh orchestrator reusing the SQLite db. Worker reconnects (D7 same `bootEpoch`) → reattach handshake. Assert: lease row not deleted, fence not bumped, no `run_lease_events` row written.
    2. Orchestrator crash, lease expired before reconnect. Crash orchestrator. Wait `ttl + grace`. Boot orchestrator. Sweep on boot expires the lease. Worker reconnects → fence stale → reconnect refused → worker drops the run. Reroute fires on next tick.
    3. Worker reboot mid-run (different `bootEpoch`). Worker process restarts. New process registers with fresh `bootEpoch` and same `workerId`. Per D7 reconcile: orchestrator treats as new identity; prior leases for that `workerId` are `expired`; rerouted.
    4. Double crash, sweep-on-boot. Both dead. Boot fresh orchestrator with no live workers. Sweep runs on boot *before* scheduler tick. Assert: previously-active leases all end up `expired`, fences bumped, `run_lease_events` rows written, runs marked for reroute. When a worker registers, the reroute fires.
    5. Voluntary `worker_shutdown` (D15). Worker sends `worker_shutdown` frame with current leases + fences. Orchestrator calls `releaseLease` per entry. Lease state → `released`. Audit row reason = `worker_shutdown`. Reroute fires on next tick *with no grace wait*.
    6. Bare close (D15 dirty). Worker socket closes without `worker_shutdown`. No `onExit`, runStatus stays `running`. Lease waits the full `ttl + grace` before sweeper expires it. Audit row reason = `heartbeat_timeout`.
    7. Reconnect after `worker_shutdown` (D15 limbo). Worker sends `worker_shutdown` then immediately reconnects. Orchestrator: the released lease is gone; reconnect must not resurrect it. Worker sees no leases assigned to it; no work resumed.

Tests: covered by the new file above.

Review goals (cap 350 words):
  1. Reattach (case 1) does NOT bump the fence.
  2. Double-crash (case 4) runs sweep before scheduler tick.
  3. SQLite db is reused across simulated reboot.
  4. All seven scenarios exercised — same-bootEpoch reattach, expired-before-reconnect, different-bootEpoch reboot, double-crash sweep-on-boot, voluntary `worker_shutdown`, bare close, shutdown-then-reconnect limbo.
  5. Every case asserts the matching `run_lease_events` row (or its absence in reattach).

Commit: test(orchestrator): orchestrator-crash lease recovery

### 5.8 Network-partition takeover integration test [risk: low, size: M]

What: worker alive, link severed. Orchestrator-side: lease expires, takeover fires. Worker-side: phase-1-protocol-and-registry watchdog fires; worker drops work and attempts reconnect. On reconnect, presents stale fence → `abort`.

Files:
  - `test/integration/distributed/network-partition-takeover.test.ts` (new) — single worker A + worker B registered for takeover. Controllable transport with `partition()` that drops frames both directions:
    1. Dispatch, observe steady-state heartbeats.
    2. `partition()`. Wait `ttl + grace + sweepInterval`.
    3. Assert: orchestrator-side lease expired, run rerouted to B. A's watchdog fired (faux worker observable: stopped emitting).
    4. Heal partition. Assert: A's reconnect met with `abort` because its fence is stale; A's follow-up `result` (if scripted) is rejected.

Tests: covered by the new file above.

Review goals (cap 250 words):
  1. Both sides exercised — orchestrator-side takeover and worker-side self-eviction.
  2. Heal step proves the healed worker's abort prevents two live owners.
  3. Takeover worker receives the new fence.

Commit: test(runtime): network partition lease takeover

### 5.9 Retire worker_pid / /proc / RECOVERY_REBASE [risk: high, size: L]

What: delete the legacy liveness model. After this commit no code path reads `worker_pid`, `worker_boot_epoch`, `owner_worker_id`, `owner_assigned_at`, `tasks.worker_id`, `/proc/<pid>/environ`, or the `RECOVERY_REBASE` marker. Migration drops the five columns and the matching `idx_agent_runs_owner_worker` index. Adds the lease-tied orphan-branch cleanup hook per the Plan policy.

Files:
  - `src/orchestrator/services/recovery-service.ts` — delete `killStaleWorkerIfNeeded` (`:809-844`), `readProcEnvironmentMarkers` (`:847-856`), `parseProcEnvironment` (`:858-879`), `rebaseTaskWorktree` (`:788-807`), call sites (`:102, :218`), and the `readProcEnvironment` constructor field (`:74`). The `RECOVERY_REBASE` marker write is gone — the resumed worker pulls feature-branch HEAD via the bare repo.
  - `src/runtime/harness/index.ts:25-26, 116-117, 163-164, 234-235, 257-261` and `src/runtime/harness/feature-phase/index.ts:308-309, 344-346, 387-388, 425-427` — drop `workerPid` / `workerBootEpoch` from `SessionHandle`, `createSessionHandle`, and the feature-phase factories. `CURRENT_ORCHESTRATOR_BOOT_EPOCH` (`src/runtime/harness/index.ts:64`) is unused; also delete.
  - `src/runtime/contracts.ts:95-96` — remove `workerPid` / `workerBootEpoch` from `DispatchHarnessMetadata`.
  - `src/runtime/worker-pool.ts:41-55, 264-284` and `src/orchestrator/scheduler/dispatch.ts:160-262` — `dispatchMetadata`, `runningRunPatch`, `proposalAwaitingApprovalPatch` drop legacy fields. `liveRuns` keys on `workerId`.
  - `src/core/types/runs.ts:38-39`, `src/persistence/sqlite-store.ts:43-44, 69-70, 110, 124-125, 190-191`, `src/persistence/codecs.ts:281-282, 307-308`, `src/persistence/queries/index.ts:111-112` — drop columns from the type and SQL surfaces.
  - `src/persistence/migrations/006_drop_legacy_run_columns.ts` (new) — pinned id `006` per phase-0-migration-consolidation chain. First table-rebuild migration post-consolidation (the consolidated `001_init.ts` from phase-0-migration-consolidation absorbed the old `006_rename_feature_ci_to_ci_check.ts` rebuild precedent, so cite the pattern abstractly rather than pointing at a now-collapsed migration). Use `CREATE TABLE … AS SELECT` to rebuild `agent_runs` without `worker_pid`, `worker_boot_epoch`, `owner_worker_id`, `owner_assigned_at`; rebuild `tasks` without `worker_id`; drop `idx_agent_runs_owner_worker`. Migration docstring enumerates the post-rebuild `agent_runs` schema verbatim so future readers can audit. Downgrade out of scope.
  - `src/persistence/db.ts` — register the new migration.
  - `src/runtime/worktree/index.ts` — add the lease-tied orphan-branch cleanup helper from the Plan section. Hooks from the baseline phase-4-recovery disposal sites (`docs/implementation/01-baseline/phase-4-recovery.md` step 4.1) plus the takeover path in step 5.4.
  - `test/unit/orchestrator/recovery.test.ts:1145` — delete the `RECOVERY_REBASE` assertion; update the surrounding test to assert resumed worker pulls feature-branch HEAD via the dispatch payload. Replace `killStaleWorkerIfNeeded` cases with lease-based equivalents (substantive coverage already comes from steps 5.4–5.8).

Tests: behavioral coverage already exists from earlier steps. Step-local addition: `test/unit/runtime/worktree/orphan-cleanup.test.ts` (new) — assert lease-tied cleanup runs only after takeover *and* the new worker's first heartbeat acks the new fence; never on mere lease expiry.

Review goals (cap 350 words):
  1. Grep the tree (including tests) for `worker_pid`, `workerPid`, `worker_boot_epoch`, `workerBootEpoch`, `owner_worker_id`, `ownerWorkerId`, `owner_assigned_at`, `ownerAssignedAt`, `tasks.worker_id`, `idx_agent_runs_owner_worker`, `/proc/`, orchestrator-side `process.kill`, `RECOVERY_REBASE` — zero hits.
  2. The column-drop migration uses `CREATE TABLE … AS SELECT` rebuild (not `ALTER TABLE … DROP COLUMN`).
  3. Migration docstring lists the post-rebuild `agent_runs` schema verbatim.
  4. Orphan cleanup runs only after confirmed takeover or explicit cancel — never on mere lease expiry.
  5. Test changes do not regress coverage.

Commit: refactor(runtime): retire pid/proc liveness in favor of leases
Rollback: schema rebuild is irreversible without a pre-this-phase SQLite backup; `git revert` restores code but cannot recreate the dropped columns or the `idx_agent_runs_owner_worker` index. Operator-coordinated restore from backup is required to downgrade.
Migration ordering: must land after step 5.4 (sweep replaces `killStaleWorkerIfNeeded`) and step 5.5 (fence enforcement replaces pid-based attribution). Landing this step earlier would leave the orchestrator with neither liveness model.

---
Shipped in <SHA1>..<SHA9> on <YYYY-MM-DD>
