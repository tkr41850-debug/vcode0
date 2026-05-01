# Phase 1 — Worker protocol and registry

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-0-migration-consolidation (pins migration id 010 for this track and the consolidated `001_init.ts` baseline)
- Default verify: npm run check:fix && npm run check
- Phase exit: npm run verify; with `workerProtocol.enabled: true`, run the end-to-end test from step 1.5: a `WorkerRegistryClient` connects, sends `register`, receives `register_ack`, heartbeats, then is observed transitioning `live → stale → lost` via injected clock.
- Doc-sweep deferred: docs/architecture/distributed-worker-protocol.md, docs/architecture/worker-model.md, docs/architecture/README.md, docs/implementation/03-distributed/README.md (phase row outcome flip)

Ships as 6 commits, in order.

## Contract

- Goal: introduce a network worker protocol and an orchestrator-side registry. Workers can connect over the network, register an identity, declare capacity and capabilities, and heartbeat. The orchestrator persists registered workers and exposes them as a queryable seam, but does not yet dispatch any work to them — local-spawn `LocalWorkerPool` (`src/runtime/worker-pool.ts:62`) remains the only path that actually runs tasks.
- Scope:
  - In:
    - WebSocket transport scaffolding (server + client classes, no business logic).
    - The `RegistryFrame` union — `register` / `register_ack` / `register_reject`, `heartbeat` / `heartbeat_ack`, `reconnect` / `reconnect_ack`, `worker_shutdown` / `worker_shutdown_ack` — with TypeBox validation.
    - `workers` table (migration `010`) plus `WorkerRegistryPort` and a SQLite-backed implementation.
    - Status derivation (`live` / `stale` / `lost`) computed from `last_seen_at`, never stored.
    - `workerProtocol.enabled` config flag (default off) plus shared-bearer-token auth.
    - A worker-side `WorkerRegistryClient` that registers and heartbeats but receives no dispatch.
    - TUI `registered: N (remote, not yet dispatchable)` indicator that does not feed any capacity rollup.
  - Out:
    - Dispatching any work to a remote worker (phase-2-remote-task-execution wires `dispatchRun` over the wire).
    - Lease semantics — frames carry no lease state and acks are no-ops (phase-5-leases-and-recovery).
    - TLS termination (operator-managed reverse proxy; tracked outside this track).
    - Authentication beyond a shared token (auth/mTLS hardening tracks separately, see 03-distributed/README.md "Out of scope").
    - Multi-worker scheduling and capacity-aware picker (phase-3-multi-worker-scheduling).
    - Operator-driven worker eviction (phase-5-leases-and-recovery).
    - Routing run-plane frames to a registered worker (phase-2-remote-task-execution).
- Exit criteria:
  - All six commits land in order; `npm run verify` passes on the final commit.
  - With `workerProtocol.enabled: false` (default), behaviour is byte-identical to baseline: no port bound, no rows written, no extra log lines.
  - With `workerProtocol.enabled: true`, the end-to-end test from step 1.5 demonstrates connect → register → heartbeat → stale → lost.
  - A registered remote worker never receives a `dispatchRun` call in this phase (phase-2-remote-task-execution wires that).
  - Cross-cutting review confirms: `RegistryFrame` unions stay isolated from `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage` (no shared `type` discriminators); the `workers` table carries no FK to `agent_runs` (and vice versa); every new public symbol is reachable from a barrel or contracts re-export; `import 'ws'` appears only inside `src/runtime/registry/transport/`.

## Plan

- Background: on the verified state, `main` has no worker identity on the wire — `LocalWorkerPool` (`src/runtime/worker-pool.ts:62`) is the only path that runs tasks, IPC is single-child stdio (`src/runtime/ipc/index.ts:9-19`), and `Store` (`src/orchestrator/ports/index.ts:43-58`) has no worker rows. The phase-0-migration-consolidation slot `010_workers.ts` is free for this track. The shape `harness_kind` / `worker_pid` / `worker_boot_epoch` already exists on `agent_runs` (`src/persistence/migrations/009_agent_run_harness_metadata.ts:1-30`) and is the closest analogue to the `(workerId, bootEpoch)` pair this phase introduces. The registry is purely additive on top of these surfaces; default config keeps the system byte-identical to baseline.

- Notes:
  - Identity model (D1): the orchestrator must recognise a worker across restarts (so a flapping worker doesn't fork into N orphan rows) and detect that a worker has restarted (so stale capacity claims are invalidated). `workerId` is stable, generated once per worker, persisted in `<workerDataDir>/worker-id`, opaque to the orchestrator. `bootEpoch` is a monotonic per-worker counter, incremented every start. The registry table keys on `worker_id`; `boot_epoch` is a column, not part of the key — re-registration with a higher `boot_epoch` updates the existing row and resets `last_seen_at`. The orchestrator keys all future worker addressing on `workerId`; `bootEpoch` is the cache-invalidation token.
  - Handshake (D2): one frame, worker → orchestrator, on connect, of type `register` carrying `workerId`, `bootEpoch`, `protocolVersion: 1`, `capabilities: { scopeKinds: ['task', 'feature_phase']; harnessKinds: ['pi-sdk']; transportKind: 'local-spawn' | 'remote-ws' }`, `capacity: { maxConcurrentRuns: number }` (soft cap; this phase only records it), and `agent: { name; version }`. Local-spawn workers join the registry in-process with `workerId='local'`. `harnessKinds` is an open union — squid-track adds `'claude-code'` later. Orchestrator replies `register_ack` (accept) or `register_reject` (protocol mismatch, banned, etc.); `protocolVersion` is integer-versioned; mismatches reject rather than negotiate.
  - Heartbeat + stale detection (D3): worker sends `heartbeat` on the same connection every `heartbeatIntervalMs` (default `5000`); each heartbeat updates `workers.last_seen_at` to `Date.now()`. A worker with `last_seen_at` older than `staleAfterMs` (default `15_000`, three missed beats) is reported `status: 'stale'`; older than `evictAfterMs` (default `300_000`) it is reported `lost` and stops appearing in capacity rollups. Stale/lost workers are not deleted: rows persist so a recovered worker reconnecting with the same `workerId` keeps continuity. Operator-driven eviction is deferred to phase-5-leases-and-recovery. The clock is the orchestrator's `Date.now()` only — workers never push their own timestamps. This prevents skew from leaking into liveness logic.
  - Transport (D4): WebSocket via `ws` (pure JS) — bidirectional JSON frames map 1:1 onto existing NDJSON shapes; `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage` ride unchanged. Encapsulated in `WebSocketServerTransport` / `WebSocketClientTransport` implementing `IpcTransport` (`src/runtime/ipc/index.ts:9-19`). `src/runtime/contracts.ts` does not change. Registry frames live in a separate `RegistryFrame` union multiplexed on the same socket but typed separately so `RuntimePort` and dispatch frames stay transport-agnostic (step 1.2). The transport listens on a config-driven `host` + `port`. Authentication ships as a shared bearer token in config (env-overridable); mTLS/auth hardening is out of scope per the README.
  - Visibility, not dispatchability (D5): at phase exit, registered remote workers appear in the `workers` table, surface through `WorkerRegistryPort.listWorkers()`, and render in the TUI as `registered: N (remote, not yet dispatchable)`. They do not appear in `LocalWorkerPool.idleWorkerCount()` and do not receive any `dispatchRun` call.
  - Wire-plane reference (see 03-distributed/README.md "Wire planes" table): this phase introduces the registry plane — `register` / `register_ack` / `register_reject` (one-shot per connection); `heartbeat` / `heartbeat_ack` (recurring; phase-5-leases-and-recovery layers leases onto the heartbeat as the canonical lease carrier); `reconnect` / `reconnect_ack` (worker volunteers held `(agentRunId, fence)` after a transport drop; the body is a no-op shell here, filled by phase-5-leases-and-recovery step 5.4); `worker_shutdown` / `worker_shutdown_ack` (voluntary release; ack-only here, fence-and-release semantics in phase-5-leases-and-recovery). The `health_ping` / `health_pong` pair is the run-plane local-stdio liveness watchdog from baseline phase 1; network workers do not use it — they renew via `heartbeat`.
  - Forward-phase semantics (preview, not implemented this phase): phase-5-leases-and-recovery extends `heartbeat` with `leases: Array<{ agentRunId, fence }>` so the recurring frame becomes the canonical lease carrier (no separate lease-renew RPC). On `reconnect`, same-`bootEpoch` reattaches by `(agentRunId, fence)` without rotating the fence; a different `bootEpoch` drops every prior lease regardless of TTL. `worker_shutdown` moves the listed leases to `state='released'`, bumps the fence, and triggers immediate reroute — grace timers are skipped because the worker has volunteered. The shapes ship with their `heldLeases` / `inFlightLeases` payload slots in this phase so phase-5-leases-and-recovery only needs to flip enforcement on.
  - Transport-port purity (deviation): this phase keeps `RuntimePort` and the IPC frame contracts untouched; the registry is a new port (`WorkerRegistryPort`) and a new frame union (`RegistryFrame`). The phase-3-multi-worker-scheduling picker filters on `capabilities.transportKind`, which is why `transportKind` is part of capabilities here, not a separate worker-identity field.

## Steps

### 1.1 WorkerRegistryPort types and in-memory implementation [risk: med, size: M]

What: introduce the registry port shape. Pure types plus an in-memory implementation suitable for unit tests and as the dependency target for steps 1.2–1.5. No persistence yet, no transport yet.

Files:
  - `src/orchestrator/ports/worker-registry.ts` — new. Define:
    - `WorkerIdentity = { workerId: string; bootEpoch: number }`.
    - `WorkerCapabilities = { scopeKinds: readonly RunScope['kind'][]; harnessKinds: readonly HarnessKind[]; transportKind: 'local-spawn' | 'remote-ws' }`. `transportKind` is part of capabilities (not worker identity) so the phase-3-multi-worker-scheduling picker can filter on it. phase-4-remote-feature-phases step 4.4 extends the type with an optional `verification?: { commandSets: readonly string[] }` field.
    - `WorkerCapacity = { maxConcurrentRuns: number }`.
    - `WorkerStatus = 'live' | 'stale' | 'lost'`.
    - `RegisteredWorker = WorkerIdentity & { capabilities; capacity; agent: { name; version }; lastSeenAt: number; status: WorkerStatus; firstSeenAt: number }`.
    - `WorkerRegistryPort` interface: `register(input)`, `heartbeat(workerId, bootEpoch, now)`, `listWorkers(filter?)`, `getWorker(workerId)`, `markEvicted(workerId)`, `subscribe(listener)` returning unsubscribe.
  - `src/orchestrator/ports/index.ts` — extend `OrchestratorPorts` with `workerRegistry: WorkerRegistryPort`. Keep the field optional in this step; flip to required in step 1.5 once compose wires it.
  - `src/runtime/registry/in-memory.ts` — new. `InMemoryWorkerRegistry` implementing the port; backs the unit tests and the integration tests that don't need SQLite. Includes a `now: () => number` injection for deterministic tests.
  - `src/runtime/index.ts` — re-export the new public types.

Tests:
  - `test/unit/runtime/worker-registry-in-memory.test.ts` — register; re-register with bumped `bootEpoch` updates the row; heartbeat updates `lastSeenAt` only when worker exists; `listWorkers` filters by status; `subscribe` fires on register / heartbeat / transition; clock injection makes status transitions deterministic.

Review goals (cap 200 words):
  1. Verify the step body — port surface matches the type list above.
  2. Flag fields added to `RegisteredWorker` with no producer or no consumer.
  3. Flag any path where one throwing `subscribe` listener stops other listeners from being notified.

Commit: feat(orchestrator/ports): worker registry port and in-memory impl

### 1.2 Registry frame schemas (transport-agnostic) [risk: med, size: M]

What: define the wire shapes for the registry plane as a separate `RegistryFrame` union, with TypeBox validation that mirrors the validator added in 01-baseline phase-1-safety step 1.1. The new frames are deliberately NOT added to `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage` — those unions remain about runs. The worker connection multiplexes the two frame families on one socket, distinguished by their `type` discriminator.

The full registry-plane variant set (cross-reference 03-distributed/README.md "Wire planes" table):
  - `register` / `register_ack` / `register_reject` — handshake.
  - `heartbeat` / `heartbeat_ack` — recurring liveness.
  - `reconnect` / `reconnect_ack` — worker volunteers held `(agentRunId, fence)` after a transport drop.
  - `worker_shutdown` / `worker_shutdown_ack` — voluntary release.

Schemas land here; behaviour is no-op acks (phase-5-leases-and-recovery fills in lease semantics).

The `reconnect` shape:

```
{
  type: 'reconnect',
  workerId: string,
  bootEpoch: number,
  heldLeases: Array<{ agentRunId: string; fence: number }>
}
```

`reconnect_ack` carries `{ confirmedLeases: Array<{ agentRunId: string }> }` — same shape as the `confirmedLeases` field on `heartbeat_ack`.

The `worker_shutdown` shape:

```
{
  type: 'worker_shutdown',
  workerId: string,
  bootEpoch: number,
  reason: 'graceful' | 'config_reload' | 'operator_drain',
  inFlightLeases: Array<{ agentRunId: string; fence: number }>
}
```

`worker_shutdown_ack` carries no payload beyond the discriminator.

Files:
  - `src/runtime/registry/frames.ts` — new. Export `WorkerToRegistryFrame` (`register`, `heartbeat`, `reconnect`, `worker_shutdown`) and `RegistryToWorkerFrame` (`register_ack`, `register_reject`, `heartbeat_ack`, `reconnect_ack`, `worker_shutdown_ack`) discriminated unions, plus `validateRegistryFrame(value): { ok: true; frame } | { ok: false; error }` using TypeBox. Reuse the same TypeBox patterns as `src/runtime/ipc/frame-schema.ts` (introduced in 01-baseline phase-1-safety step 1.1).
  - `src/runtime/registry/protocol.ts` — new. Exports `PROTOCOL_VERSION = 1` plus a small `RegistryRejectReason` union (`protocol_mismatch`, `unauthenticated`, `banned`).

Tests:
  - `test/unit/runtime/registry-frames.test.ts` — happy-path round-trip per variant; missing required field rejected; wrong-type field rejected; unknown `type` rejected; `protocolVersion: 0` still parses (so we can return `register_reject` instead of dropping the connection).

Review goals (cap 300 words):
  1. Verify every variant in the unions has a TypeBox branch and a happy-path test.
  2. Verify the registry frame discriminator does not collide with any `type` already used in `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage` (`src/runtime/contracts.ts:339-467`).
  3. Verify `validateRegistryFrame` never throws.
  4. Verify reject reasons are a closed string-literal union, not free-form.

Commit: feat(runtime/registry): typebox-validated registry frame schemas

### 1.3 workers table and Store-backed registry [risk: high, size: L]

What: persistent backing for the registry. Migration `010_workers.ts` adds the table (id pinned by phase-0-migration-consolidation); `SqliteWorkerRegistry` is an in-memory cache fronted by SQL — heartbeats coalesce to avoid per-beat SQLite writes.

Files:
  - `src/persistence/migrations/010_workers.ts` — new. Create `workers(worker_id PRIMARY KEY, boot_epoch INTEGER NOT NULL, capabilities_json TEXT NOT NULL, capacity_max_concurrent INTEGER NOT NULL, agent_name TEXT NOT NULL, agent_version TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)` with `CREATE INDEX idx_workers_last_seen_at ON workers(last_seen_at DESC)`. Idempotent (`CREATE TABLE IF NOT EXISTS`). Status (`live` / `stale` / `lost`) is derived from `last_seen_at + now()` — not stored — so status thresholds can be retuned without a migration. Rollback is a `DROP TABLE workers` (no inbound FKs in this phase).
  - `src/persistence/db.ts` — register `Migration010Workers` in the imports and `migrations` array, same pattern as the consolidated `Migration001Init` wire-up from phase-0-migration-consolidation.
  - `src/persistence/codecs.ts` — add `workerRowToRegistered` / `registeredToWorkerRow` near the existing `agentRunToRow` family.
  - `src/persistence/queries/index.ts` — add the `WorkerRow` type alongside `AgentRunRow`.
  - `src/runtime/registry/sqlite.ts` — new. `SqliteWorkerRegistry implements WorkerRegistryPort`. Holds an in-memory `Map<string, RegisteredWorker>` populated from the table at construction; `register` writes through synchronously (rare event); `heartbeat` updates the cache synchronously and the row through a coalesced flush every `flushIntervalMs` (default `1000`) — write loss on crash is acceptable because the next heartbeat replaces it. `listWorkers` reads from the cache. Status is computed at read time from `lastSeenAt`.
  - `src/runtime/registry/index.ts` — barrel that re-exports both impls.

Tests:
  - `test/unit/persistence/sqlite-store.test.ts` — extend with worker insert/update/list ordered by `last_seen_at DESC`. (No new test file — the existing one is the convention for SQLite codec round-trips.)
  - `test/unit/runtime/sqlite-worker-registry.test.ts` — new. Construct against `:memory:`; assert load-on-construct, write-through on register, coalesced heartbeat flush, status derivation across the `staleAfterMs` boundary.

Review goals (cap 200 words):
  1. Flag any place the in-memory cache and the table can disagree without a path back to convergence.
  2. Verify the cache is populated from disk at construction (not lazily).
  3. Verify heartbeat flushes are bounded under burst (no unbounded write queue).

Commit: feat(persistence): workers table and sqlite-backed worker registry
Rollback: `git revert` removes the migration import + registry impl, but on already-migrated local dev DBs the `workers` table persists. Drop manually (`DROP TABLE workers;`) before re-running migrations against the same file.
Migration ordering: this step must merge before step 1.4, which feeds the registry from the network transport.

### 1.4 Network transport — server side [risk: high, size: L]

What: a `WorkerRegistryServer` that listens on a TCP port, accepts WebSocket connections, demultiplexes registry frames from run frames, and feeds the registry. Run frames are not yet routed anywhere — the server logs them at debug level and drops them. Connections are strictly worker-initiated.

Files:
  - `src/runtime/registry/server.ts` — new. `class WorkerRegistryServer { constructor(deps: { registry: WorkerRegistryPort; auth: AuthPolicy; now: () => number; log: Logger }, opts: { host; port; heartbeatIntervalMs; staleAfterMs; evictAfterMs }) }`. Uses the `ws` library. Per-connection state: `workerId | null` until `register`. Maintains a `connection ↔ workerId` map so phase-2-remote-task-execution can route run-plane frames (`run`, `abort`, `manual_input`, results, etc.) to the registered worker. Frame routing:
    - `validateRegistryFrame` first; on `ok: false`, send `register_reject` if pre-registration, else log and close with code 1003.
    - `register`: auth check → `registry.register(...)` → `register_ack`. Stash `workerId` on the connection.
    - `heartbeat`: must be post-register; updates `registry.heartbeat(...)` (`lastSeenAt` only this phase).
    - `reconnect`: must be post-register; pre-phase-5-leases-and-recovery the algorithm is a no-op shell — log the intent and ack empty (phase-5-leases-and-recovery step 5.4 fills the reconcile body).
    - `worker_shutdown`: must be post-register; log and ack immediately (phase-5-leases-and-recovery fills release semantics).
    - any other frame: log at debug, drop. (phase-2-remote-task-execution routes them.)
  - `src/runtime/registry/auth.ts` — new. `AuthPolicy` interface with `verify(headers, register): { ok: true } | { ok: false; reason: RegistryRejectReason }`. Ship a `SharedSecretAuthPolicy` that compares the `Authorization: Bearer <token>` header against a config value.
  - `src/runtime/registry/staleness.ts` — new. A `StalenessSweeper` that periodically (every 1s) walks `registry.listWorkers()` and lets the registry recompute `status`. Pure for testability.
  - Add `ws` to `dependencies` in `package.json` (and `@types/ws` to `devDependencies`).

Tests:
  - `test/unit/runtime/registry-staleness.test.ts` — sweeper transitions live → stale → lost across injected `now()` ticks.
  - `test/integration/runtime/worker-registry-server.test.ts` — boot a server on port `0`; connect a `ws` client; send `register`; expect `register_ack`; send heartbeats; assert registry rows; let the connection time out; assert status transitions to `stale`. Use the harness scaffolds under `test/integration/harness/` for lifecycle parity. Skip the test if `ws` import fails (so CI without optional native deps still passes — `ws` is pure JS, but the guard is cheap).

Review goals (cap 400 words):
  1. Verify every code path that closes a WS connection has a matching teardown — no socket leak on auth failure, frame validation failure, or normal disconnect.
  2. Verify one bad connection cannot block the accept loop or mutate another worker's row.
  3. Verify authentication runs before `registry.register` (otherwise a wrong-token register pollutes the table).
  4. Verify heartbeats from a `workerId` that was never `register`-ed are rejected, not silently treated as registration.
  5. Flag any path where a frame can mutate registry state without a prior valid `register`.

Commit: feat(runtime/registry): websocket server with auth and staleness sweeper
Rollback: `git revert` undoes the code, but reverting also removes `ws` from `dependencies` — run `npm install` after revert so `node_modules/ws` is also pruned.
Migration ordering: depends on step 1.3 (registry must persist) and step 1.2 (frames must validate). Must merge before step 1.5, which composes the server into the app lifecycle.

### 1.5 Composition wiring, config, worker-side client (off by default) [risk: high, size: L]

What: boot the registry server alongside `LocalWorkerPool` when config opts in; expose the registry via `OrchestratorPorts.workerRegistry`; add a small worker-side `WorkerRegistryClient` so end-to-end test coverage can drive a real worker against a real server. Default config keeps the server disabled so existing test suites and existing deployments are byte-identical to today.

Files:
  - `src/config.ts` — add `workerProtocol?: { enabled: boolean; host: string; port: number; sharedSecret?: string; heartbeatIntervalMs?: number; staleAfterMs?: number; evictAfterMs?: number }` to `GvcConfig`. Default `enabled: false`. Document precedence: `GVC_WORKER_PROTOCOL_TOKEN` env overrides `sharedSecret` if set. (`src/config.ts:62-68` is the existing `DEFAULT_CONFIG` site; the new block goes there.)
  - `src/compose.ts:211-223` — after constructing `LocalWorkerPool`, conditionally construct `SqliteWorkerRegistry`, `WorkerRegistryServer`, and `StalenessSweeper`. Add `workerRegistry` to `ports`. Wire shutdown into the existing `app.stop` lifecycle (`src/compose.ts:255`) so the server closes before `db.close()`. When `enabled === false`, install a no-op `NullWorkerRegistry` so the port is always present and consumers don't need null checks.
  - `src/runtime/registry/null.ts` — new. `NullWorkerRegistry` returns empty lists / no-ops. Keeps the port shape uniform.
  - `src/runtime/registry/client.ts` — new. `WorkerRegistryClient` for use in tests and as the worker-side reference impl: dial server, send `register`, await `register_ack`, start heartbeat interval, expose `close()`. Pure: no spawn, no agent loop. phase-2-remote-task-execution wraps this in a real worker daemon.
  - `src/orchestrator/ports/index.ts` — flip `workerRegistry` from optional (step 1.1) to required.
  - `src/tui/worker-counts.ts` — read `workerRegistry.listWorkers()` and render `registered: N` next to the existing `running/idle/total`. Mark them visually as remote. Do not include them in any "available capacity" rollup.
  - `src/runtime/index.ts` — re-export `WorkerRegistryClient` and `NullWorkerRegistry`.

Tests:
  - `test/integration/runtime/worker-registry-end-to-end.test.ts` — new. Boot `composeApplication`-equivalent wiring with `workerProtocol.enabled: true` against a temp dir; spin up a `WorkerRegistryClient` in-process pointing at the listen port; assert `ports.workerRegistry.listWorkers()` reflects the client's identity and capacity; kill the client; assert status transitions to `stale` then `lost` via injected clock.
  - `test/unit/compose.test.ts` (or extend an existing compose test if one exists; otherwise this step omits the unit test and relies on the integration test) — assert default config produces `NullWorkerRegistry`.

Review goals (cap 250 words):
  1. Verify default-config byte-identity: no port bound, no rows written, no extra log lines.
  2. Confirm `WorkerRegistryClient` imports nothing from `@runtime/harness`.
  3. Flag any path that already routes a run through the network in this phase.

Commit: feat(runtime/registry): compose wiring, config gate, and worker client
Smoke: with `workerProtocol.enabled: true`, run the end-to-end test from `test/integration/runtime/worker-registry-end-to-end.test.ts` and confirm connect → register → heartbeat → stale → lost on the injected clock.
Migration ordering: depends on steps 1.1–1.4. Flipping `workerRegistry` from optional to required happens here because compose now provides the implementation.

### 1.6 Documentation — distributed worker model addendum [risk: low, size: S]

What: record the protocol, identity model, heartbeat semantics, and the deliberate "visible but not dispatchable" property as architecture documentation. This is the cross-reference that phase-2-remote-task-execution will build on; without it phase-2-remote-task-execution has to relitigate the design.

Files:
  - `docs/architecture/distributed-worker-protocol.md` — new. Sections: Identity (`workerId` + `bootEpoch`), Handshake (frame shapes, version negotiation, rejection reasons), Heartbeat (cadence, stale/lost thresholds, clock policy), Transport (WebSocket choice plus alternatives considered plus how to swap), Persistence (`workers` table, status-derived-not-stored), Visibility-but-not-dispatchability boundary, Out of scope for this phase (forward links to the rest of the track). Cite real file paths with `:line` for every claim.
  - `docs/architecture/worker-model.md` — add a "Distributed extension" section near the bottom (after the existing "Crash Recovery" section, `docs/architecture/worker-model.md:439-461`) with a short pointer to the new doc.
  - `docs/implementation/03-distributed/README.md` — flip the `phase-1-protocol-and-registry` row's "Outcome" to past tense once this step lands; add a one-line "What phase-2-remote-task-execution inherits from this phase" pointer.
  - `docs/architecture/README.md` — add the new doc to the topic list.

Tests: none — documentation-only.

Review goals (cap 200 words):
  1. Verify the doc matches the code (frame shapes, persistence schema).
  2. Flag any sentence that overstates the current state.

Commit: docs(architecture): distributed worker protocol and registry

---
Shipped in <SHA1>..<SHA6> on <YYYY-MM-DD>
