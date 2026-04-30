# 02-distributed — Distributed worker runtime

Implementation track to lift the runtime from local-machine (process-per-task children of the orchestrator) to a fleet of remote workers reachable over the network. Motivated by deployment on many weak VMs where horizontal scale is the only path to useful parallelism.

This track assumes [01-baseline](../01-baseline/README.md) has merged. It is intentionally separate: the changes cut across spawn model, filesystem model, scheduling, and recovery, which would blur the local-MVP plan if folded in as more "phases".

The open design questions are catalogued in [`docs/feature-candidates/runtime/distributed-runtime.md`](../../feature-candidates/runtime/distributed-runtime.md). This track answers them and then lands code.

## Architectural non-negotiables

These are the **end-state** invariants — the system after the whole track lands. Phases 1–3 are temporary exceptions where called out below; phase 4 is the cutover.

- **No feature-phase agents run on the orchestrator process.** *End-state, phase-4-end invariant, achieved at phase 4 step 4.8.* Every pi-sdk `Agent` invocation that hosts a feature-phase scope — planning, replanning, verification, summarization, research, discussion, including the top-level planner that bootstraps a feature graph — runs on a worker process on a worker VM after phase 4. **Phases 1–3 are explicit temporary exceptions:** `FeaturePhaseOrchestrator` keeps running in-process until phase 4 cuts it over. The non-negotiable is **process-level**: explicit local-spawn task workers (a separate worker kind in the registry, dispatched through `RuntimePort` like any other worker) are permitted on the same host, because they are not in-orchestrator-process agents. After phase 4, lint and runtime guards (step 4.9) enforce the in-orchestrator-process zero-agent property.
- **Single orchestrator authority.** Multi-orchestrator HA is out of scope for this track; it stays a separate candidate.
- **Workers reach the orchestrator over the network.** No shared filesystem assumption between orchestrator and worker, and no shared filesystem assumption between two workers. Anything currently keyed on a local path (worktrees, session files, pid markers) must be reconsidered. Holds from phase 2 onward.
- **Transport-agnostic ports stay transport-agnostic — partial compliance, with documented deviation.** The intent is that `RuntimePort`, the IPC frame contracts, and the `Store` port do not grow distributed-system concepts. Worker selection, lease lifecycle, and fence enforcement should ideally live behind dedicated ports (`WorkerDirectoryPort` / `PlacementPort` for placement, `RunLeaseStore` for lease lifecycle, fence checks inside lease-aware persistence helpers — never on generic `Store.updateAgentRun`).

  **Note on transport-port purity (deviation).** Phases 3 and 5 observe the non-negotiable only **partially**. Specifically, `RuntimePort` grows `listWorkers()` and an optional `targetWorkerId` arg on `dispatchRun` (phase 3 step 3.2), and `Store` grows lease lifecycle methods — `grantLease` / `renewLease` / `expireLease` / `listExpiredLeases` / `getLease` / `listRunsByOwner` (phase 5 step 5.1). These are accepted debt: the distributed concepts they introduce are bounded, used by a small set of callers, and refactorable to dedicated ports (`WorkerDirectoryPort`, `PlacementPort`, `RunLeaseStore`) in 2–4 days of focused work. The refactor is not part of this track.

  **One specific extension is not deferred:** `Store.updateAgentRun(..., { expectedFence?: number })` is rejected outright. Worker-attributable writes that need fence checking instead go through a dedicated `RunLeaseStore.updateRunWithFence(runId, expectedFence, patch)` helper (or equivalent free function in `sqlite-store.ts`), introduced in phase 5 step 5.5 alongside the IPC frame fence enforcement. This avoids the silent-omission hazard of an optional fence parameter on a generic write method.

## Wire planes

The track distinguishes three multiplexed frame families on the worker↔orchestrator network connection. Each plane is typed separately so the existing run-frame unions stay transport-agnostic.

| Frame pair | Plane | Purpose |
|---|---|---|
| `register` / `register_ack` / `register_reject` | Registry (setup) | One-shot per connection. Authenticates worker, declares capabilities + capacity, accepts or rejects on protocol mismatch. |
| `heartbeat` / `heartbeat_ack` | Registry (liveness, lease carrier) | Recurring; worker-scoped (network workers only). After phase 5 the heartbeat carries `leases: Array<{agentRunId, fence}>` and is the canonical lease-renewal channel. |
| `health_ping` / `health_pong` | Run-plane (local stdio liveness, **no leases**) | Baseline phase 1 frames; orchestrator↔local-spawn-child only. Pure liveness watchdog with no lease semantics. Network workers do not use them — they renew leases via `heartbeat`. |
| `reconnect` / `reconnect_ack` | Registry (lease lifecycle) | Worker volunteers held `(agentRunId, fence)` after a transport drop; orchestrator either reattaches or sends `abort` per the algorithm in [`_archive/INVESTIGATION-architectural.md`](./_archive/INVESTIGATION-architectural.md) §D7. |
| `worker_shutdown` / `worker_shutdown_ack` | Registry (lease lifecycle) | Voluntary release. Lease moves to `released` (skip grace period); takeover may dispatch immediately. Fire-and-forget; lost frame falls back to TTL expiry. |

## Scope

Seven phases. Phase 0 is a track-level pre-phase that clears migration-numbering anxiety; phases 1–6 stand on their own and ship in order; later phases assume earlier ones merged.

| Phase | Theme | Outcome | Risk |
|-------|-------|---------|------|
| [Phase 0](./phase-0-migration-consolidation.md) | Migration consolidation | Existing `001_init.ts` … `009_agent_run_harness_metadata.ts` collapse into a single `001_init.ts` carrying the union shape. Distributed-track migrations extend it directly without numbering negotiation. | Low — fresh-db schema is byte-identical to pre-phase; no production deployments at 0.0.0 |
| [Phase 1](./phase-1-protocol-and-registry.md) | Worker protocol & registry | Workers register, heartbeat, and report capacity to the orchestrator; orchestrator still spawns local children for actual work. Pure additive seam. | Medium — new transport surface, but no behavior change yet |
| [Phase 2](./phase-2-remote-task-execution.md) | Remote task execution | A registered remote worker can run one task end-to-end: network IPC, worker-side worktree, branch synced back to the orchestrator. Local spawn becomes one transport among others. | High — touches the worker hot path and the git sync model |
| [Phase 3](./phase-3-multi-worker-scheduling.md) | Multi-worker scheduling | Many workers concurrently; capacity-aware dispatch; ownership of a run is explicit and queryable. | High — scheduler model change |
| [Phase 4](./phase-4-remote-feature-phases.md) | Remote feature-phase agents | Planner, replanner, verifier, summarizer, researcher, discusser dispatch to remote workers via the same plane as task execution. After this phase, the orchestrator process hosts zero agent loops. | High — surfaces every place a feature-phase agent currently runs in-process |
| [Phase 5](./phase-5-leases-and-recovery.md) | Ownership leases & remote recovery | Leases, takeover on worker death, stale-lease reclamation, reroute on disconnect. Replaces pid/proc liveness with network liveness. | High — recovery semantics change |
| [Phase 6](./phase-6-deployment-packaging.md) | Deployment packaging | `npm run worker` is a real deployment surface: SIGTERM drains cleanly via `worker_shutdown`, transient transport drops absorbed by an in-process reconnect loop, env validated fail-fast, structured logs, canonical systemd unit + env template under `deploy/`. | Low — packaging on top of the now-feature-complete worker runtime |

## Cross-cutting concerns

These concerns are touched by multiple phases. They are noted here so each phase doc can reference back rather than redefine them.

- **Session persistence — orchestrator is authoritative.** Session storage backs pi-sdk `Agent` checkpoint persistence keyed on `agent_run_id`. With multi-worker scheduling and lease takeover (phases 3 + 5), runs are not pinned to a worker — a resumed run may land on a different worker than originally executed it. Sessions therefore live on the orchestrator side. Workers proxy session reads/writes through `RuntimePort` over the IPC transport; takeover requires no session migration because the new worker streams the same session ops as the old one. Phase 2 introduces the `RemoteSessionStore` IPC seam; phases 3, 4, 5 build on it and never reopen "worker-local sessions" as an option. Implementation tracking: [`docs/feature-candidates/runtime/centralized-conversation-persistence.md`](../../feature-candidates/runtime/centralized-conversation-persistence.md).
- **Fence tokens.** Every run carries a monotonically-increasing `fence_token`. Phase 5 grants leases stamped with the current fence; lease expiry bumps the fence in the same transaction. Every state-mutating operation attributable to a run — IPC frames that change orchestrator state, worker-attributable `Store` writes, bare-repo pushes — carries the fence and is rejected if it is below the run's current fence. This prevents a returning-from-partition zombie worker from corrupting state after takeover. Phase 5 step 5.5 enumerates enforcement points exhaustively; phases 1, 2, 4 add the `fence: number` field to every new state-mutating frame they introduce so phase 5 only needs to flip enforcement on, not retrofit schemas.
- **Git as the worktree sync protocol.** Branches are the natural unit of orchestrator↔worker filesystem exchange. The orchestrator hosts a bare repo (over ssh, `git daemon`, or `http-backend`) and workers `git fetch` / `git push` against it. GitHub or any other remote is treated as an optional downstream publication target, never as the operational sync layer — the goal is LAN-speed exchange with no third-party rate limits, no external dep, and a single authoritative ref store co-located with the orchestrator's SQLite state. Phases 2–5 build on this assumption.
- **Liveness model.** Phase 1 establishes heartbeat as the source of truth. Phases 4 and 5 retire the `worker_pid` / `/proc/<pid>/environ` liveness checks left over from the local model.
- **Identity and addressing.** Run identity (`agent_run_id`, `session_id`) stays orchestrator-assigned. Worker identity is new and is introduced in phase 1.

## Working agreement

Same as [01-baseline](../01-baseline/README.md#working-agreement): each phase doc breaks into numbered steps; per step, implement, run `npm run check:fix` then `npm run check`, run a review subagent, address findings, commit with the conventional-commit subject given in the step.

Phases that fit one logical change ship as one commit. Phases with several independent steps ship as multiple commits, one per step. No squashing across phases.

## Cross-phase conventions

- New persistence work uses the existing TS migration system (`src/persistence/migrations/NNN_*.ts`), continuing the numbering used by 01-baseline.
- New IPC frame variants extend the schemas added in 01-baseline phase 1; the validation gate from that phase covers them automatically.
- New ports (worker registry, lease store, remote git) extend `src/orchestrator/ports/index.ts` first, then concrete implementations.
- Architecture boundary still holds: `core/` does not import `runtime/` or `persistence/`. The new transport, registry, and lease code lives in `runtime/` and `persistence/`.

## Out of scope

- Multi-orchestrator HA, leader election, or orchestrator failover.
- Cross-region or trust-boundary deployments (auth/mTLS hardening tracks separately if needed).
- Worker-to-worker direct communication; all coordination flows through the orchestrator.
- Replacing pi-sdk `Agent` or the harness contract — distribution happens beneath those, not by rewriting them.
- TUI / observability changes beyond what is required to render distributed state correctly.

## Related

- [`docs/feature-candidates/runtime/distributed-runtime.md`](../../feature-candidates/runtime/distributed-runtime.md) — open design questions this track answers.
- [`docs/feature-candidates/runtime/centralized-conversation-persistence.md`](../../feature-candidates/runtime/centralized-conversation-persistence.md) — likely dependency of phase 2.
- [`docs/feature-candidates/runtime/advanced-ipc-guarantees.md`](../../feature-candidates/runtime/advanced-ipc-guarantees.md) — stronger transport semantics; orthogonal but adjacent.
- [`docs/architecture/worker-model.md`](../../architecture/worker-model.md) — the local baseline this track evolves.
