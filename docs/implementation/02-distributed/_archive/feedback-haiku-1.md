# Phase Review — Haiku 1, non-negotiable compliance

## Critical issues (block landing)

- Phase 3, step 3.2 (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-3-multi-worker-scheduling.md:67-84`)
  - Wording: "replace `idleWorkerCount(): number` on `RuntimePort` with a richer surface"; "`Add listWorkers(): readonly WorkerCapacityView[]`"; "`options?: { targetWorkerId?: string; policyHint?: 'sticky' | 'capacity' }`".
  - Assessment: Real violation.
  - Why this blocks: the README says `RuntimePort` must not grow distributed-system concepts (`/home/alpine/vcode0/docs/implementation/02-distributed/README.md:13-16`). `workerId`, per-worker capacity, health, and placement policy are exactly the lease/registry/transport concerns that were supposed to stay behind concrete implementations.
  - Consequence: once `RuntimePort` exposes worker identity and health, the scheduler and any caller become coupled to distributed placement semantics. That is the opposite of a transport-agnostic runtime seam.
  - Fix: keep `RuntimePort` scope/payload/control-only. Move worker inventory + placement into a separate orchestrator-side port/service (for example `WorkerDirectoryPort` / `PlacementPort`) and let the runtime consume an opaque placement claim, not raw `workerId` and health metadata.

- Phase 5, step 5.1 and step 5.5 (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:183-188`, `391-395`)
  - Wording: "extend `Store` with `grantLease`, `getLease`, `renewLease`, `expireLease`, and `listExpiredLeases(now, graceMs)`"; "`Store.updateAgentRun` calls ... gain an `expectedFence`".
  - Assessment: Real violation.
  - Why this blocks: the README explicitly calls out the `Store` port as a seam that must not absorb distributed-system concepts (`/home/alpine/vcode0/docs/implementation/02-distributed/README.md:16`). Lease lifecycle, grace windows, and fence preconditions are distributed coordination concerns.
  - Consequence: the generic persistence port stops being a persistence port and becomes the lease coordinator API. That couples every store implementation to one recovery protocol.
  - Fix: introduce a dedicated `RunLeaseStore` / `LeaseRepository` port. Keep fence checking inside the concrete lease/persistence layer or behind a dedicated internal repository API; do not thread `expectedFence` through the generic `Store` contract.

- Phase 5, steps 5.2, 5.3, and 5.5 (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:225-236`, `275-286`, `374-390`)
  - Wording: "extend `DispatchRunResult` `started` / `resumed` variants with `workerId: string` and `fence: number`"; "`health_pong` schema gains `leases: Array<{ agentRunId: string; fence: number }>`"; "add `fence: number` to `WorkerToOrchestratorMessage` variants `result`, `error`, `claim_lock`, `request_help`, `request_approval`".
  - Assessment: Real violation.
  - Why this blocks: the README says the IPC frame contracts should not grow lease tokens, fence IDs, or related distributed metadata (`/home/alpine/vcode0/docs/implementation/02-distributed/README.md:16`). This step does exactly that, repeatedly.
  - Consequence: the public run protocol now bakes in one specific distributed coordination scheme. That makes the contracts less reusable for local transport, alternate registries, or non-leased implementations.
  - Fix: carry lease/fence metadata in a concrete transport envelope or connection-scoped attachment owned by the runtime/lease implementation. Keep the typed run-frame unions focused on run semantics, not network-ownership state.

## Significant issues (worth addressing)

- README vs phases 2–3 on "no agents run on the orchestrator" (`/home/alpine/vcode0/docs/implementation/02-distributed/README.md:13`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-2-remote-task-execution.md:42-50`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-3-multi-worker-scheduling.md:12`)
  - Wording: README says "Every pi-sdk `Agent` invocation ... runs on a worker process on a worker VM" and that this holds for "every phase"; phase 2 says planner/replanner/verifier/summarizer/researcher/discusser "keep running locally"; phase 3 repeats that feature-phase agents "continue to run locally on the orchestrator".
  - Assessment: Real plan-level contradiction, but mostly a wording/contract bug rather than an implementation regression.
  - Why it matters: this is the top-level non-negotiable the review is supposed to enforce. As written, the README claims a property the phase docs knowingly do not satisfy until phase 4.
  - Fix: either (a) restate README line 13 as a phase-4 exit invariant / track-end invariant, or (b) explicitly carve out the temporary exception for phases 1–3 while keeping the destination non-negotiable.

- Phase 4, step 4.9 enforcement is too narrow (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-4-remote-feature-phases.md:272-285`)
  - Wording: lint rule is scoped to `src/orchestrator/**` and `src/agents/runtime.ts`; the at-rest scan also checks only `src/orchestrator/**` and `src/agents/runtime.ts`.
  - Assessment: Real missing enforcement.
  - Why it matters: the non-negotiable is broader than those paths. Orchestrator-resident runtime code also lives in `src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, and potentially other `src/agents/**` modules. A future `new Agent(...)` in one of those files would bypass the guard.
  - Fix: invert the rule. Allow runtime `pi-agent-core` imports only in worker-side modules (`src/runtime/worker/**` and any explicitly worker-only support directories). Scan all other `src/**` paths, especially `src/compose.ts` and `src/runtime/**` outside the worker subtree.

- Phase 2 settles centralized sessions, but phases 3–5 reopen worker-local / ambiguous session authority (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-2-remote-task-execution.md:240-257`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-3-multi-worker-scheduling.md:142-147`, `154-156`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-4-remote-feature-phases.md:327-329`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:22-25`, `331-334`)
  - Wording: phase 2 explicitly decides "centralize sessions on the orchestrator" and says "Worker filesystems are treated as scratch. Nothing on the worker is authoritative." Phase 3 step 3.4 reintroduces a per-run worker `FileSessionStore`; phase 4 known gaps says the phase "keeps disk-backed `FileSessionStore`"; phase 5 says the lease layer is opaque to whether phase 2 chose centralized vs worker-authoritative storage.
  - Assessment: Real inconsistency, not just imprecise wording.
  - Why it matters: recovery, takeover, and resumability semantics depend directly on where the authoritative session lives. Later phases cannot branch on a choice phase 2 already made.
  - Fix: normalize phases 3–5 to the phase-2 decision. Worker-local session paths may exist as caches/scratch, but the docs must say they are non-authoritative; remove the worker-authoritative branches and the hedging text.

- Phase 5, step 5.4 leaks worker identity into `SessionStore` (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:330-334`)
  - Wording: "extend `SessionStore` with `isResumableForWorker(sessionId, workerId): Promise<boolean>`; centralized → no-op true; worker-authoritative → RPC the new worker."
  - Assessment: Real abstraction drift.
  - Why it matters: even though the README only names `RuntimePort`, IPC, and `Store`, this change still pushes worker-placement knowledge into a storage seam. It also bakes in the already-rejected worker-authoritative branch.
  - Fix: if centralized session storage is the settled direction, resumability should be a property of the session record plus run state, not a worker-specific `SessionStore` method. Put any worker-specific viability check in the lease/placement layer.

- Phase 5 heartbeat/renewal text does not line up with phase 1’s registry protocol (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-1-protocol-and-registry.md:132-139`, `183-191`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:64-67`, `268-286`)
  - Wording: phase 1 creates separate `RegistryFrame` variants `register` / `heartbeat` / `heartbeat_ack` and says run frames are distinct; phase 5 says "the phase-1 `health_pong` grows a `leases` field" and that `lease-keeper` subscribes to "pong events from the phase-1 registry".
  - Assessment: Imprecise wording today; it becomes a real design bug if implemented literally.
  - Why it matters: the plan currently conflates the registry heartbeat plane with the run IPC health-pong plane. That is exactly how duplicate liveness sources creep in.
  - Fix: pick one renewal carrier and rename the text to match it. Either lease renewal rides registry `heartbeat` frames, or it rides per-run `health_pong`; the doc should not imply both.

## Minor / nits

- Phase 4, step 4.9 uses two different env-var stories (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-4-remote-feature-phases.md:274-280`)
  - Wording: the step text references `GVC_FORCE_REMOTE_AGENTS`; the actual startup check uses `GVC_ALLOW_LOCAL_FEATURE_PHASE_BACKEND`.
  - Assessment: Imprecise wording.
  - Why it matters: this is the enforcement escape hatch. Two names make the rollback/debug path harder to reason about.
  - Fix: choose one variable family and use it consistently in prose, code, and tests.

- Phase 2 background overstates the seam moved in phase 2 (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-2-remote-task-execution.md:22-25`, `42-45`)
  - Wording: "A new `RemoteSshHarness` implements the existing `SessionHarness` / `FeaturePhaseBackend` seams" while the out-of-scope list immediately says feature-phase agents stay local until phase 4.
  - Assessment: Imprecise wording.
  - Why it matters: it makes phase 2 sound broader than it is and muddies the no-local-agents trajectory.
  - Fix: say `RemoteSshHarness` lands for `SessionHarness` / task execution only in phase 2; feature-phase backend migration is phase 4.

- Phase 5 background understates what phase 3 already persisted (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-3-multi-worker-scheduling.md:36-49`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:25-27`)
  - Wording: phase 5 says ownership is still "implicit (in-memory map + legacy `worker_pid` column)" and that phase 5 promotes it to a first-class persisted record.
  - Assessment: Imprecise wording / plan drift.
  - Why it matters: phase 3 step 3.1 already persists `owner_worker_id` and `owner_assigned_at`. Phase 5 should build on that fact, not overwrite the mental model.
  - Fix: update phase 5 background to say phase 3 persisted owner identity, while phase 5 adds lease/fence authority on top.

- Phase 5, step 5.9 places bare-repo branch cleanup under a generic worktree module (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:584-588`)
  - Wording: "`src/runtime/worktree/index.ts` — add the lease-tied orphan-branch cleanup helper" even though the cleanup deletes refs from the orchestrator-hosted bare repo.
  - Assessment: Mostly layering nit.
  - Why it matters: the noun "worktree" reads like local-path manipulation, while the operation is actually bare-ref cleanup on the orchestrator.
  - Fix: prefer an orchestrator git/bare-repo module for the cleanup helper, or explicitly say the helper only manipulates bare refs and never touches a local worktree path.

## Cross-phase inconsistencies

- README top-level invariant vs the actual cutover schedule
  - Compare `/home/alpine/vcode0/docs/implementation/02-distributed/README.md:13` with `/home/alpine/vcode0/docs/implementation/02-distributed/README.md:27-28`, plus phase 2 and phase 3 exclusions (`phase-2-remote-task-execution.md:42-50`, `phase-3-multi-worker-scheduling.md:12`).
  - Inconsistency: line 13 says the orchestrator hosts no agents in every phase; the phase table and the phase docs say that only becomes true after phase 4.
  - Fix: make the README’s statement track the actual migration schedule.

- Phase 2 centralized-session decision vs later worker-local session language
  - Compare `phase-2-remote-task-execution.md:240-257` with `phase-3-multi-worker-scheduling.md:142-147`, `154-156`, `phase-4-remote-feature-phases.md:327-329`, and `phase-5-leases-and-recovery.md:22-25`, `331-334`.
  - Inconsistency: phase 2 closes the decision; phases 3–5 treat it as still open or partially reversed.
  - Fix: carry the phase-2 decision forward explicitly and remove the alternate branch from later phases.

- Phase 1 “registry heartbeat” plane vs phase 5 “health_pong renewal” plane
  - Compare `phase-1-protocol-and-registry.md:132-139`, `183-191` with `phase-5-leases-and-recovery.md:64-67`, `268-286`.
  - Inconsistency: phase 1 isolates registry frames from run frames; phase 5 blurs registry pongs and run-health pongs into one renewal channel.
  - Fix: unify the terminology and choose exactly one source-of-truth heartbeat surface.

- README “transport-agnostic ports stay transport-agnostic” vs phase 3/5 contract changes
  - Compare `/home/alpine/vcode0/docs/implementation/02-distributed/README.md:16` with `phase-3-multi-worker-scheduling.md:67-84` and `phase-5-leases-and-recovery.md:183-188`, `225-236`, `275-286`, `374-395`.
  - Inconsistency: the README says not to put worker IDs, lease/fence state, or network coordination into `RuntimePort`, IPC contracts, or `Store`; the implementation plan repeatedly does exactly that.
  - Fix: refactor the plan so distributed coordination lives in dedicated registry/lease/transport layers, not in the shared runtime/store contracts.

## What the plan gets right

- Phase 1 is careful about not polluting the existing run protocol (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-1-protocol-and-registry.md:132-139`)
  - Good wording: registry frames are "deliberately NOT added" to `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage`.
  - Why it matters: this is exactly the transport-agnostic discipline the README asks for.

- Phase 2 strongly enforces "no shared filesystem assumption" on the git/worktree path (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-2-remote-task-execution.md:20-22`, `175-188`, `469-476`)
  - Good wording: workers fetch/push against an orchestrator-hosted bare repo, create worktrees on their own VM, and the orchestrator fetches the branch back before merge.
  - Why it matters: worktree state crosses the boundary by git refs, not by mounted paths.

- Phase 2 also gets the worker/filesystem authority story right for sessions (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-2-remote-task-execution.md:240-257`)
  - Good wording: "centralize sessions on the orchestrator" and "Worker filesystems are treated as scratch. Nothing on the worker is authoritative."
  - Why it matters: this is the cleanest answer to both takeover and no-shared-disk concerns.

- Phase 4’s main migration direction is correct (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-4-remote-feature-phases.md:27-31`, `155-167`, `239-253`)
  - Good wording: proposal host lives on the worker, verification runs on the worker, and step 4.8 deletes `FeaturePhaseOrchestrator` / `DiscussFeaturePhaseBackend`.
  - Why it matters: once that lands, there is no feature-phase excuse left for orchestrator-side `Agent` instantiation.

- Phase 5 does not appear to smuggle a compensating in-process agent back onto the orchestrator (`/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:73-89`, `110-130`, `545-583`)
  - Good wording: takeover is framed as lease/session/git-state coordination, and retirement explicitly deletes pid/proc recovery and `RECOVERY_REBASE`.
  - Why it matters: the recovery plan changes liveness and ownership, but it does not imply a "small local agent" fallback.

- The plan stays disciplined about single orchestrator authority (`/home/alpine/vcode0/docs/implementation/02-distributed/README.md:14`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-5-leases-and-recovery.md:467-490`)
  - Good wording: no leader election, no multi-orchestrator coordination, and crash recovery is a fresh boot of the same authority against the existing SQLite/bare-repo state.
  - Why it matters: that keeps the distributed-runtime scope bounded instead of quietly expanding into HA design.

- The worker sync path stays first-party and downstream-only (`/home/alpine/vcode0/docs/implementation/02-distributed/README.md:34-35`, `/home/alpine/vcode0/docs/implementation/02-distributed/phase-2-remote-task-execution.md:103-109`)
  - Good wording: git sync is against the orchestrator-hosted bare repo; GitHub is not the operational sync layer.
  - Why it matters: this cleanly satisfies the "workers reach the orchestrator over the network" requirement without introducing third-party operational dependencies.
