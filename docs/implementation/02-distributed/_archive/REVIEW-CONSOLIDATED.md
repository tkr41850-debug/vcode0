# Consolidated Review — 02-distributed plan

Synthesized from 7 reviewer outputs: `opus` (holistic), `haiku-1` (non-negotiable compliance), `haiku-2` (citation accuracy), `haiku-3` (schema/persistence), `haiku-4` (IPC frame/transport), `haiku-5` (phase ordering/shippability), `plan-relevance` (existing partial plan).

## TL;DR

The plan's overall shape (registry → single remote task → multi-worker → feature-phase migration → leases/recovery) is correct and well-de-risked. But the five phases were drafted in parallel and three deep contradictions need to be resolved before any phase 2+ implementation begins: (1) **session-storage authority** flip-flops between centralized (phase 2) and worker-local (phase 3/4/5), changing recovery semantics; (2) **migration numbering** is unanchored to the actual repo (`max=009`) and three phases claim overlapping IDs; (3) **fence-token plumbing is incomplete** — phase 5 requires a fence on the `run` frame but no step actually adds it, and phase-4 proposal frames are not in the fenced set. Recommendation: **fix critical+significant issues, then ship phase by phase.** Phase 1 can land mostly as-is; phases 2–5 need a coordinated revision pass.

## Critical issues (must fix before landing)

1. **Session-storage authority contradiction across phases 2 → 3 → 4 → 5.**
   - Phase 2 step 2.3 explicitly settles centralized orchestrator-side sessions via `RemoteSessionStore` IPC proxy, justified as "phase 5's lease/takeover work needs this." Phase 3 step 3.4 then introduces a per-run worker-side `FileSessionStore` rooted at `<workerScratch>/sessions/<agentRunId>/`. Phase 3 step 3.5's sticky-resume fallback assumes "the session lives on the dead worker." Phase 4 known-gaps says "keeps disk-backed `FileSessionStore`." Phase 5 step 5.4 reopens the question with `isResumableForWorker(sessionId, workerId)` having two branches.
   - **Affected phases:** 2, 3, 4, 5 (every phase touches session storage).
   - **Found by:** opus, haiku-1, haiku-2, haiku-3, haiku-5 (5 of 7).
   - **Suggested fix:** normalize to phase-2's centralized decision. Delete worker-side `FileSessionStore` parameterization from phase 3 step 3.4 (cache only, non-authoritative). Rewrite phase 3 step 3.5 so `unknown_worker` falls through to *another worker with the same `sessionId`*, not `mode: 'start'`. Drop the worker-authoritative branch from `isResumableForWorker` in phase 5 step 5.4 (centralized → trivial true is the only branch). Update phase 4 known-gaps text accordingly.

2. **Migration numbering is unanchored and self-conflicting.**
   - Repo baseline `max(migration) = 009_agent_run_harness_metadata.ts`. Phase 1 step 1.3 claims `012_workers`. Phase 3 step 3.1 claims `010_agent_run_owner_worker`. Phase 3 step 3.6 claims `011_agent_run_owner_index`. Phase 5 step 5.1 and 5.9 are still placeholders `0NN_*`. Phase 1 cites baseline reservations of `010`/`011` that are not in the tree.
   - **Affected phases:** 1, 3, 5 (and implicitly 02-distributed README which claims "01-baseline has merged").
   - **Found by:** opus, haiku-2, haiku-3, haiku-5 (4 of 7).
   - **Suggested fix:** pin a contiguous sequence now. Recommended chain: `010 workers` (phase 1), `011 agent_run_owner_columns` (phase 3.1), `012 agent_run_owner_index` (phase 3.6), `013 run_leases + fence_token` (phase 5.1), `014 drop_worker_pid_columns` (phase 5.9). Update each phase doc's filename, DB-registration line, and rollback note. Drop the "renumber later" hand-wave in phase 3 step 3.1.

3. **Phase 5 never adds `fence` to the `run` frame, but every fence-bearing path requires it.**
   - Phase 5 step 5.3 says the worker pulls the fence from the `run` frame it received. Phase 5 step 5.4 takeover dispatches a resumed run "with the new fence in the run frame." Phase 5 step 5.5 requires workers to attach the current fence to mutating frames and `--push-option fence=<n>`. No step extends `OrchestratorToWorkerMessage.run` schema with `fence`.
   - **Affected phases:** 5 (all of fence/lease enforcement).
   - **Found by:** opus, haiku-4, haiku-5 (3 of 7).
   - **Suggested fix:** add `fence: number` to the `run` payload in `src/runtime/contracts.ts` and the TypeBox mirror as part of phase 5 step 5.2 (or a new substep). Pin the dispatch ordering: read+increment `agent_runs.fence_token` *before* dispatch, send fence in the `run` frame, then call `harness.start`, then `grantLease`. Currently step 5.2 grants the lease *after* `harness.start` returns, leaving the worker with a run but no fence.

4. **Phase 5 fencing is incomplete — phase-4 proposal frames mutate persisted state but are not fenced.**
   - Phase 4 step 4.5 introduces `proposal_op`, `proposal_submitted` (which writes `agent_runs.payload_json` and drives approval), `proposal_phase_ended` (advances orchestrator-visible proposal lifecycle). Phase 5 step 5.5 fences `result`, `error`, `claim_lock`, `request_help`, `request_approval`. It does not fence proposal frames. Phase 5 step 5.5 also classifies `progress` as advisory, but `progress` mutates `agent_runs.run_status` and persists token-usage rollups (per `budget_usage_rollup_architecture` memory). `session_op` (mutates orchestrator session store) is also unfenced.
   - **Affected phases:** 5 (and indirectly 4, since proposal protocol is incomplete without fence).
   - **Found by:** opus, haiku-3, haiku-4, haiku-5 (4 of 7).
   - **Suggested fix:** classify per-frame in phase 5 step 5.5: every frame that touches `agent_runs` or downstream rollup/payload tables → fenced. That includes `proposal_op`, `proposal_submitted`, `proposal_phase_ended`, `progress`, `session_op`, `confirm`. Only purely transient TUI streams (`assistant_output` text deltas) stay unfenced. Add `proposal_*` frames to step 5.5's review-prompt fenced-frames list.

5. **Phase 3 vs Phase 5 — run ownership has two sources of truth (`owner_worker_id` column and `run_leases` table) and no phase retires either.**
   - Phase 3 step 3.1 adds `agent_runs.owner_worker_id` and `owner_assigned_at`, explicitly *rejecting* a `run_assignments` table. Phase 5 step 5.1 introduces `run_leases` (1:1 by `agent_run_id PRIMARY KEY`) — exactly the rejected design. Phase 5 step 5.9's column-drop migration retires `worker_pid`/`worker_boot_epoch` but leaves `owner_worker_id` orphaned. Baseline also has `tasks.worker_id` (from `001_init.ts`) which no phase mentions.
   - **Affected phases:** 3, 5 (schema split-brain).
   - **Found by:** opus, haiku-1, haiku-3 (3 of 7).
   - **Suggested fix:** phase 5 step 5.9 should explicitly drop `agent_runs.owner_worker_id` and `owner_assigned_at` along with the legacy pid columns (replaced entirely by `run_leases`). Alternatively, push back to phase 3 and have it persist ownership through an interim table that becomes `run_leases`. State the fate of `tasks.worker_id` explicitly (likely retire it in the same step). Enumerate the post-phase-5 `agent_runs` column set in the doc.

6. **Phase 1 vs Phase 5 — heartbeat/renewal frame family is conflated; two different heartbeats exist and phase 5 extends the wrong one.**
   - Phase 1 distributed defines `register`/`heartbeat`/`heartbeat_ack` as separate `RegistryFrame` family on the WebSocket transport. Baseline phase 1 has `health_ping`/`health_pong` on the local stdio `NdjsonStdioTransport`. Phase 5 step 5.3 says "the phase-1 `health_pong` grows a `leases` field" and points file edits at `src/runtime/harness/index.ts` and `src/runtime/worker/index.ts` (the stdio child path, not the network registry path).
   - **Affected phases:** 1, 5 (renewal carrier).
   - **Found by:** opus, haiku-1, haiku-2, haiku-4, haiku-5 (5 of 7).
   - **Suggested fix:** lease renewal rides the registry-plane `heartbeat`/`heartbeat_ack` (worker-scoped, network transport). Rewrite phase 5 step 5.3 to extend `heartbeat` (or `heartbeat_ack`), not `health_pong`. Retarget the file edits to `src/runtime/registry/*`. Keep `health_pong` as the local-process liveness it already is. Add a one-table glossary in the README distinguishing the two heartbeat planes.

7. **Phase 5 step 5.7 reattach hand-waves a "phase-1 reconnect handshake" that phase 1 does not define.**
   - Phase 5 step 5.7 scenario 1 (orchestrator restart with non-expired leases) says runs "reattach via phase-1 reconnect... lease row not deleted, fence not bumped." Phase 1 step 1.4 only defines pre-register state until a `register` frame arrives; runs are dropped. The worker has no protocol to volunteer "I currently hold run X with fence F" on reconnect.
   - **Affected phases:** 1, 5.
   - **Found by:** opus.
   - **Suggested fix:** phase 1 step 1.2 should add a `reconnect` frame variant carrying `bootEpoch` + held `agentRunId`s + fences. Or phase 5 step 5.3 should make the first post-restart heartbeat carry full reattach info and define reattach semantics explicitly. Without this, scenario 1 is untestable.

8. **Phase 4 dispatch never filters by `scopeKinds`, so a task-only worker can silently receive feature-phase dispatch.**
   - Phase 1 step 1.1 declares `WorkerCapabilities = { scopeKinds, harnessKinds }`. Phase 2 step 2.5's `MultiHarnessPool` routes by `harnessKinds` only (local-spawn vs remote). Phase 4 needs feature-phase routing but no step adds `scopeKinds.includes(scope.kind)` filtering. Phase 4 also references `verification` capability in prose but never lands the registry/picker side that enforces it.
   - **Affected phases:** 1, 3 (picker), 4.
   - **Found by:** opus, haiku-5 (2 of 7, but blast radius is large).
   - **Suggested fix:** phase 3 step 3.3 picker filters by both `scopeKinds.includes(scope.kind)` AND `harnessKinds.includes(harnessKind)`. Phase 4 step 4.4 lands the verification capability advertisement on the registry schema. Add a test that a task-only worker rejects feature-phase dispatch.

9. **README/phase docs say "no agents on the orchestrator" everywhere, but phases 1–3 explicitly keep them in-process; the non-negotiable is misstated.**
   - README line 13 says the orchestrator hosts no agents in every phase. Phase 2 step 2.4 keeps planner/replanner/verifier/summarizer/researcher/discusser local. Phase 3 step 3.1 reaffirms "feature-phase agents continue to run locally on the orchestrator." Only phase 4.8 actually retires them. Even after phase 4, local-spawn task workers exist (host-level reading of "no agents" remains false).
   - **Affected phases:** 1–4 (and the README invariant).
   - **Found by:** haiku-1, haiku-5 (2 of 7).
   - **Suggested fix:** restate README line 13 as a phase-4-end invariant. Carve out the temporary exception for phases 1–3 explicitly. Pick whether "on the orchestrator" means process-level (achievable end of phase 4) or host-level (not achievable while local-spawn is supported), and commit. The cleanest framing: process-level for feature-phase agents, host-level allowed for explicit local-spawn task workers.

10. **`RuntimePort` and `Store` grow distributed-system concepts in violation of README non-negotiable.**
    - README line 16 says `RuntimePort`, IPC frame contracts, and `Store` "should not grow distributed-system concepts; those live behind concrete transport / registry / lease implementations." Phase 3 step 3.2 adds `targetWorkerId`, `policyHint`, `listWorkers(): WorkerCapacityView[]`, `not_dispatchable` to `RuntimePort`. Phase 5 step 5.1 adds `grantLease`/`getLease`/`renewLease`/`expireLease`/`listExpiredLeases` and `expectedFence` precondition to `Store.updateAgentRun`. Phase 5 step 5.4 leaks worker identity into `SessionStore` via `isResumableForWorker(sessionId, workerId)`.
    - **Affected phases:** 3, 5.
    - **Found by:** opus, haiku-1 (2 of 7, but identified as top non-negotiable violation).
    - **Suggested fix:** introduce a separate `WorkerDirectoryPort`/`PlacementPort` for worker inventory and selection; pass an opaque placement claim into `dispatchRun`, not raw `workerId`. Introduce a dedicated `RunLeaseStore`/`LeaseRepository` port for lease lifecycle. Keep fence checking inside the concrete persistence layer or behind a dedicated repository helper, not on generic `Store.updateAgentRun`. Resumability is a property of the session record, not a worker-specific `SessionStore` method.

11. **Phase 4 step 4.8 deletes `VerificationService.verifyFeature` but `IntegrationCoordinator` still calls it.**
    - The plan claims `IntegrationCoordinator` does not call `VerificationService` directly. Actual code at `src/orchestrator/integration/index.ts:128-129` calls `this.deps.ports.verification.verifyFeature(feature)`. If an implementer follows the plan literally, the merge/integration flow breaks. Step 4.8 says "confirm via grep before deletion" — fragile.
    - **Affected phases:** 4.
    - **Found by:** opus, haiku-2 (2 of 7; haiku-2 verified the citation directly).
    - **Suggested fix:** before step 4.8 lands, add an explicit pre-step that traces every call site of `verifyFeature` and retargets each to consume a remote-produced `VerificationSummary` or routes through the feature-phase dispatch plane. Don't delete based on grep; delete based on tracing audit.

12. **Phase 2's network dispatch plane is assumed but never actually landed.**
    - Phase 1 step 1.4 says non-registry run frames are "logged and dropped." Phase 1 step 1.5 only registers and heartbeats. Phase 2 step 2.4 assumes a live addressable worker connection / `WorkerLease` / network `SessionHarness` substrate exists. No phase-2 step updates the phase-1 server to route `run`/`abort`/`manual_input`/result frames to a specific registered worker. Phase 2 step 2.7 can pass with an in-process fake remote while the real registry/server path is still incomplete.
    - **Affected phases:** 1, 2.
    - **Found by:** haiku-4, haiku-5 (2 of 7, with clear evidence).
    - **Suggested fix:** add an explicit phase-2 step (between 2.3 and 2.4, or inside 2.4) titled "make live worker connections dispatchable": extend the phase-1 registry server to maintain `connection ↔ workerId` map and route run-plane frames. Define one canonical transport seam (see cross-cutting theme below).

## Significant issues (worth fixing)

1. **Phase 2 `RemoteSshHarness` is misnamed — the IPC plane is WebSocket, not SSH.** SSH is the git transport. Rename to `RemoteHarness` or `RemoteWsHarness`. Found by: opus, haiku-4 (2 of 7).

2. **Transport seam is described three different ways across the track.** Phase 1 D4 promises generic `WebSocket*Transport` implementing `IpcTransport`. Phase 1 steps 1.4–1.5 deliver `WorkerRegistryServer`/`WorkerRegistryClient` in `src/runtime/registry/*`. Phase 4 step 4.3 references `WorkerNetworkTransport.dispatchRun` without provenance. Pick one canonical layer and use it everywhere. Found by: haiku-4.

3. **Phase 2 step 2.5's `MultiHarnessPool` quietly does capacity-aware routing.** Phase 2 says `RuntimePort` surface is unchanged but the dispatcher routes by `worker.capability`. Phase 2 should pin a degenerate single-worker policy explicitly and the test in step 2.7 should only register one remote worker. Push capacity-aware routing fully into phase 3. Found by: opus.

4. **Phase 3 step 3.2 breaks `RuntimePort` non-negotiable** (covered in critical #10). Add as significant in case the redesign lands incrementally: extend the picker via composition (constructor capture), not method args. Found by: opus, haiku-1.

5. **Phase 4 step 4.7 default-flag flip silently retroactively changes phase 1's "not yet dispatchable" promise for feature-phase scopes.** A user upgrading commit-by-commit sees remote dispatch suddenly default-on. Decouple "wire path works" (early commit) from "default is on" (separate gated flip). Add upgrade note to phase 4 exit criteria. Found by: opus.

6. **Phase 5 step 5.3 heartbeat-driven renewal does not specify worker process model.** A worker may host multiple concurrent runs (phase 3.4); the registry client and run executor may be different processes. TOCTOU race between query and pong. Specify they're the same process or share an atomic `Set<{agentRunId, fence}>`. Found by: opus.

7. **Phase 5 step 5.4 sweep-on-boot ordering not enforced architecturally.** Step 5.7 review prompt requires sweep-before-first-tick for the double-crash scenario. Step 5.4 only says "start the sweeper interval inside `scheduler.run()`." Make the first invocation synchronous: `await sweeper.sweep(now); scheduler.tick(); setInterval(...)`. Found by: opus, haiku-5 (2 of 7).

8. **Phase 5 `liveRuns` fence cache has TOCTOU window.** Cache is keyed at dispatch time but invalidated via a separate scheduler event. Drop the cache; `updateAgentRunTxn`'s `expectedFence` reads from source of truth on every mutating frame. Found by: opus.

9. **Phase 2 step 2.1 push-option `agent_run_id` authorization is forgeable.** Push options are client-controlled. Pre-receive hook should look up the lease for the branch and reject pushes whose `agent_run_id` doesn't match the lease holder *and* whose fence isn't current. Mark this as "weak authorization until phase 5; document residual risk in `docs/concerns/`." Found by: opus, haiku-1.

10. **Phase 4 step 4.9 lint enforcement is too narrow.** Scoped to `src/orchestrator/**` and `src/agents/runtime.ts`. Should also cover `src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, all `src/agents/**`. Invert the rule: allow runtime `pi-agent-core` imports only in worker-side modules. Found by: haiku-1.

11. **Phase 4 step 4.4 verification capability gating described in prose but never implemented.** No step extends registry schema, capability matching, or phase-3 picker to require `verification` capability before enabling remote verify/ci_check. Add a substep. Found by: haiku-5.

12. **Phase 4 step 4.8 leaves a dead pid/proc liveness path for feature-phase runs after migration.** After phase 4 there is no orchestrator-side pid for a remote run. Set `worker_pid` NULL on dispatch for feature-phase runs in step 4.8. Found by: opus.

13. **Phase 4 step 4.5 proposal-op stream has no monotonic sequence number; reconnect can drop frames silently.** Add per-run `seq` to `proposal_op` and `proposal_submitted`. Combine with critical #4 (fence on these frames). Found by: opus.

14. **Phase 4 step 4.6 bootstrap-planner identity allocation is hand-waved.** Spell out placeholder feature lifecycle: name, behavior on bootstrap abort, TUI visibility, rename interaction with `agent_runs.feature_id` FK. Found by: opus.

15. **Phase 2 step 2.4 `onExit`-on-transport-close conflicts with phase 5's network-partition design.** Phase 5 expects the worker to keep running and the lease to expire; phase 2 marks the run terminated on transport close. Phase 5 must explicitly retract phase 2's `onExit` semantics or phase 2 should fire `onExit` only on clean closes. Found by: opus.

16. **Phase 4 step 4.5 result-frame shape is internally inconsistent.** Step 4.2 expects `result.output.kind: 'text_phase'`, step 4.4 `'verification' | 'ci_check'`, step 4.5 `'proposal'`. No step rewrites the `result` union and validator to a scope-aware `PhaseOutput`. Schema contract hole. Found by: haiku-4.

17. **Phase 4 changes `agent_runs.payload_json` semantics without defining the persisted JSON envelope.** Recovery/approval code already depends on exact JSON shape. Define the envelope (raw `GraphProposal`? `proposal + details + submissionIndex`? new wrapper?) and state it is byte-compatible with the current local/recovery envelope. Found by: haiku-3.

18. **`Store.updateAgentRun` evolves implicitly to take `expectedFence` but no phase actually changes the port.** Either add `options?: { expectedFence?: number }` explicitly in phase 5, or route fence-checked writes through dedicated lease-aware helpers. Found by: haiku-3.

19. **Run-frame routing keys are under-specified for multiplexed concurrent runs.** Phase 3 allows one worker to host multiple runs; new phase-2 (`session_op`, bootstrap) and phase-4 frames don't always carry `agentRunId`/`sessionId`/`scopeRef`. Add a routing-key table to the README. Found by: haiku-4.

20. **Existing manual-wait frames (`request_help`/`help_response`/`request_approval`/`approval_decision`/`manual_input`/`claim_lock`/`claim_decision`) are not explicitly regression-tested over the network path.** Add at least one integration test exercising a human-in-the-loop wait over the remote transport. Found by: haiku-4.

21. **`tasks.worker_id` (baseline column) is left hanging.** No distributed phase says whether it stays authoritative, mirrors run ownership, is legacy, or should be retired. Phase 3 should state its relationship to `agent_runs.owner_worker_id`. If obsolete, retire in phase 5.9. Found by: haiku-3.

22. **Phase 5 step 5.1 rollback note is incorrect.** Says rollback is `DROP TABLE`. The migration also adds `agent_runs.fence_token`. Document the actual SQLite rebuild needed, or explicitly state rollback is out of scope. Found by: haiku-3, haiku-5 (2 of 7).

23. **Phase 5 step 5.9 column-drop rebuild does not enumerate the final kept column set.** Given phase 3 adds owner columns and phase 5 adds `fence_token`, the absence of an explicit final schema is risky. Enumerate kept/dropped/introduced columns. Found by: opus, haiku-3 (2 of 7).

24. **Cited rebuild-pattern example (`006_rename_feature_ci_to_ci_check.ts`) does not show a `CREATE TABLE … AS SELECT` rebuild.** It's a data rewrite. Update phase 5's reference to a real example or acknowledge it's the first table-rebuild migration. Found by: haiku-3.

25. **`run_leases` indexes don't match the sweep predicate.** Step 5.1 indexes `expires_at` and `worker_id` but the hot query is "active leases whose `expires_at + grace` is before now." Use a partial index on active leases or a composite `(state, expires_at)` index. Found by: haiku-3.

26. **`heartbeat_ack` is invented in phase 1 step 1.2 then effectively disappears.** Either delete it or use it as the natural place for lease renewal metadata (better than overloading `health_pong`). Found by: haiku-4.

27. **`worker_ready`/`worker_init_ack` frames are unvalidated and direction-ambiguous.** First place the track adds a third frame family without a common validation story. Add validators analogous to `validateRegistryFrame`. State directionality. Found by: haiku-4.

28. **Phase 2 step 2.6 `result.branchHeadSha` extension is missing schema mirror.** Add the TypeBox schema update in lockstep. Found by: haiku-4.

29. **Phase 3 step 3.4 `concurrentRuns` observability addition has no concrete frame.** "Whatever observability frame phase 1 defined" — phase 1 didn't define one for this purpose. Pin to `heartbeat` or add a `worker_status` frame. Found by: haiku-4.

30. **Phase 4 flag lifecycle is incomplete.** Step 4.6/4.7 flips `remoteFeaturePhases.*` to `true`; step 4.8 deletes the local backend, making flags dead. No step removes them or documents them as no-ops. Found by: haiku-5.

31. **Phase 4 uses two different env-var names for the enforcement override.** `GVC_FORCE_REMOTE_AGENTS` (design) vs `GVC_ALLOW_LOCAL_FEATURE_PHASE_BACKEND` (step 4.9). Pick one. Found by: haiku-1, haiku-5 (2 of 7).

32. **Phase 1 vs Phase 5 — `bootEpoch` semantics.** Phase 1 uses `bootEpoch` as a cache-invalidation token. Phase 5 doesn't mention it. Does a worker restarting reclaim its old leases? Phase 5 step 5.9 should drop `boot_epoch` from `workers` or explicitly state why it stays. Found by: opus.

33. **Phase 2 vs Phase 4 — bare-repo branch namespace authorization.** Phase 2 hook only authorizes task-branch pushes. Phase 4 introduces remote feature-phase agents that may push (planner mutates feature graph proposal; verification is read-only). Phase 4 should explicitly state which feature-phase scopes push and extend the hook authorization. Found by: opus.

34. **Step 5.9 deliberately irreversible but sits inside the normal phase flow.** Treat as its own release boundary with explicit compatibility window and backup requirement. Found by: haiku-5.

35. **Worker-kind/harness-kind/transport-kind vocabulary is not stable.** Phase 1 uses `harnessKinds` aligned with existing `HarnessKind = 'pi-sdk' | 'claude-code'`. Phase 2 selection examples use `local-spawn` vs `remote-ssh`. Phase 3 uses `WorkerCapacityView.kind: 'local-spawn' | 'remote'`. These are different axes. Pin one vocabulary; affects registry schema, scheduler filters, persistence. Found by: haiku-5.

36. **Later phases keep patching `LocalWorkerPool` even though `MultiHarnessPool` is the distributed runtime.** Phase 3 steps 3.2/3.3/3.5/3.6 and phase 5 steps 5.2/5.5 thread changes through `src/runtime/worker-pool.ts` only. `MultiHarnessPool` disappears after phase 2. Risk: ownership/capacity/lease/fence logic lands on the inactive code path. Found by: haiku-5.

37. **Phase 2 prerequisite "agent_runs carries worker_id (or equivalent)" conflicts with phase 3 actually adding it.** Sequence prose dependency is ahead of schema dependency. Rewrite phase 2 prereq or move `owner_worker_id` to phase 1 or 2. Found by: opus, haiku-3, haiku-4, haiku-5 (4 of 7).

## Minor / nits

- README cross-reference to `01-baseline` is stale (haiku-2, opus).
- Phase 1 step 1.5 TUI panel path is hand-waved ("verify path during implementation"). Find it now (opus).
- Phase 2 step 2.3 correlation ids are random + per-run scope; not bounded against collision. Make monotonic per-run (opus).
- Phase 1 step 1.5 `WorkerRegistryClient` placement (`src/runtime/registry/`) — orchestrator code shouldn't import worker code. Add comment forbidding orchestrator imports, or move to shared subdirectory after phase 2 (opus).
- Phase 4 step 4.2 leaves a design choice (run extension vs separate `run_feature_phase` variant) for later review. Make the call now (opus, haiku-4).
- Phase 5 step 5.5 push-option fence enforcement requires signed push options; document trust model (opus, haiku-1).
- Phase 4 step 4.4 `VerificationLayerConfig` ships once per dispatch; mid-feature config edits are stale. Probably acceptable, state explicitly (opus).
- Phase 5 step 5.2 review prompt — define "worker ack" precisely (receipt of `run` frame? first heartbeat? `worker_init_ack`?) (opus).
- Phase 5 step 5.9 places bare-repo cleanup helper under `src/runtime/worktree/index.ts`; helper actually manipulates bare refs. Rename or move to orchestrator git module (haiku-1).
- Phase 5 background understates what phase 3 already persisted (says ownership is "implicit" but phase 3.1 persists `owner_worker_id`). Update background (haiku-1, haiku-2).
- Phase 1 stale line anchors in `src/compose.ts` (claim `:193-205`, actual `:211-223`; claim `:237-244`, actual `:255`) (haiku-2).
- Phase 1 step 1.6 cites `src/architecture/worker-model.md`; actual is `docs/architecture/worker-model.md` (haiku-2).
- Phase 2 stale anchors: `DiscussFeaturePhaseBackend` is at `:75` not `:62`; `FeaturePhaseOrchestrator` at `:177` not `:68` (haiku-2).
- Phase 2 cites `src/orchestrator/scheduler/dispatch.ts:164-186` for pid/proc recovery; actual is `src/orchestrator/services/recovery-service.ts:809-844` (haiku-2).
- Phase 5 cites `src/runtime/git/bare-repo-hooks.ts` (phantom path); phase 2 introduced bare-repo orchestration under `src/orchestrator/git/`. Align (haiku-2).
- Phase 4 stale anchors: `src/compose.ts:171` vs actual `:189-209`; `src/compose.ts:180-190` `proposalOpSink` vs actual `:198-208`; `src/tui/app.ts:71` vs `TuiApp.onProposalOp` at `:355-376` (haiku-2).
- Phase 3 background and step text drift on the Store query surface (`listWorkerLoad` vs `listRunsByOwner`). Pick one (haiku-3).
- `owner_assigned_at` is write-heavy and query-light; no later phase indexes or queries it. Either justify keeping as audit, or drop (haiku-3).
- No FK on `agent_runs.owner_worker_id` or `run_leases.worker_id`. Add a one-sentence justification (synthetic local IDs, or leases outliving worker rows) (haiku-3).
- "ALTER TABLE ADD COLUMN is idempotent" wording is imprecise; safety comes from `schema_migrations` (haiku-3).
- Phase 5 step 5.1 still has literal `0NN_*` placeholders (opus, haiku-3, haiku-5).
- Phase 1 `idx_workers_last_seen_at DESC` — state intended query pattern (haiku-3).
- Phase 4 step 4.3 test claim about `payload_json` parity for text phases is suspicious; text phases don't have stable `payload_json` semantics today (haiku-3).
- Phase 1 step 1.5 makes compose unit test optional; default-off behavior deserves required coverage (haiku-5).
- Phase 2 step 2.6 `branchHeadSha` optional indefinitely silently skips the safety check (haiku-5).
- Phase 4 says "9 commits" and "effective total 11 commits" — count mismatch (haiku-5).
- Phase 4 step 4.6 is one numbered step but three commits, breaking README's "one step = one commit" claim (haiku-5).
- Four nearby heartbeat names (`heartbeat`, `heartbeat_ack`, `health_ping`, `health_pong`) are easy to conflate; add glossary (haiku-4).
- `session_op` write-only / load split request-response — state asymmetry intentionally (haiku-4).
- Phase 4 splits `run`-frame change across steps 4.1 and 4.2 — should land together (haiku-4).
- Registry/routing terminology overloaded (`workerId`, `bootEpoch`, `ownerWorkerId`, `fence`); add glossary table (haiku-4).
- `proposal_phase_ended` vs terminal `result` ordering is unspecified (haiku-4).

## Cross-cutting themes

### Theme A — Session-storage authority drift
**Description:** the single most-flagged contradiction. Phase 2 commits centralized; phases 3, 4, 5 each in their own way reopen worker-local. Everything downstream (sticky resume, takeover, recovery) depends on this choice.

**Rolls up:** critical #1; significant cross-phase items.

**Resolution:** treat phase 2's centralized decision as the canonical answer. Phases 3/4/5 must be rewritten to the centralized model. Worker-local `FileSessionStore` may exist as a non-authoritative cache; mark explicitly. Sticky resume becomes a locality optimization, not a correctness requirement. `isResumableForWorker` collapses to a property of the session record + run state.

### Theme B — Migration numbering and Store-port evolution
**Description:** schema sequence is unanchored against the actual repo; the `Store` port grows distributed semantics implicitly without touching its definition file.

**Rolls up:** critical #2, #5; significant #18; haiku-3's whole schema timeline.

**Resolution:** pin the migration chain (`010 workers`, `011 owner cols`, `012 owner index`, `013 leases+fence`, `014 drop legacy cols`). Decide whether owner columns survive `014` or are dropped in favor of `run_leases`. Update `src/orchestrator/ports/index.ts` explicitly when fence/lease semantics enter the Store API, OR introduce `RunLeaseStore` and keep `Store` clean.

### Theme C — Fence-token plumbing is incomplete
**Description:** phase 5 has the fence concept but the wire-level details are not all there: `run` frame doesn't carry it, proposal frames don't enforce it, `progress`/`session_op` don't enforce it.

**Rolls up:** critical #3, #4; significant #13.

**Resolution:** (1) add `fence` to `OrchestratorToWorkerMessage.run` schema as part of phase 5 step 5.2. (2) Reorder phase 5 step 5.2 so the orchestrator increments fence *before* dispatch, sends in `run`, then `harness.start`, then `grantLease`. (3) Per-frame classification: every frame that mutates `agent_runs` or downstream tables → fenced. Move `proposal_op`, `proposal_submitted`, `proposal_phase_ended`, `progress`, `session_op`, `confirm` into the fenced set. (4) Add monotonic `seq` to `proposal_op` for ordering across reconnect.

### Theme D — Heartbeat/transport plane confusion
**Description:** the track has two heartbeats (registry-plane network `heartbeat` and run-plane stdio `health_pong`); phase 5 conflates them. The transport seam itself has three names (`IpcTransport`/`WebSocket*Transport`, `WorkerRegistryServer`/`WorkerRegistryClient`, `WorkerNetworkTransport`).

**Rolls up:** critical #6, #7; significant #2, #6, #26.

**Resolution:** pick one renewal carrier (registry-plane `heartbeat` is the right answer, since leases are worker-scoped). Pick one canonical transport seam (`IpcTransport` with concrete `WebSocketServerTransport`/`WebSocketClientTransport` impls in `src/runtime/ipc/`, registry server/client builds on top). Add a "wire planes" section to the README listing: worker-scoped connection frames, run-scoped runtime frames, session RPC frames, proposal mirror frames.

### Theme E — Ownership model split-brain (column vs lease vs `tasks.worker_id`)
**Description:** three places persist who owns a run; no phase declares the canonical source.

**Rolls up:** critical #5; significant #21, #23.

**Resolution:** declare `run_leases` as authoritative once phase 5 lands. Drop `owner_worker_id`/`owner_assigned_at` and `tasks.worker_id` in step 5.9. Update phase 5 step 5.9 column-drop rebuild to explicitly enumerate the post-phase-5 `agent_runs` schema.

### Theme F — Capability vocabulary and routing axes
**Description:** `harnessKinds` (pi-sdk vs claude-code, baseline meaning) vs new transport-kind (local-spawn vs remote) vs `scopeKinds` (task vs feature_phase) vs `verification` capability — multiple orthogonal axes named loosely. The picker doesn't filter by all of them.

**Rolls up:** critical #8; significant #11, #35.

**Resolution:** name the three axes distinctly: `harnessKinds` keeps existing baseline semantics (pi-sdk/claude-code). Introduce a new `transportKind` axis (local-spawn vs remote-ws). Confirm `scopeKinds` covers task/feature_phase. Phase 3 step 3.3 picker filters across all three. Phase 4 step 4.4 lands `verification` capability advertisement and enforcement.

### Theme G — Distributed concepts polluting transport-agnostic ports
**Description:** README non-negotiable says `RuntimePort`/IPC contracts/`Store` stay clean. Phases 3 and 5 grow them with worker IDs, lease tokens, fence preconditions.

**Rolls up:** critical #10; significant #4.

**Resolution:** introduce `WorkerDirectoryPort`/`PlacementPort`, `RunLeaseStore`. Pass opaque placement claims through `dispatchRun`. Keep IPC frames focused on run semantics; carry lease/fence in transport envelopes (or per-connection attachments) where the lease layer can enforce them, not as bare optional fields on every variant.

### Theme H — README invariants overstated relative to phase reality
**Description:** "no agents on orchestrator" / "ports stay clean" / "one step = one commit" all read as global invariants but become true only at phase 4.8 (or never, if local-spawn task workers persist).

**Rolls up:** critical #9; significant #3, #4, #10; haiku-1's compliance core.

**Resolution:** rewrite README "non-negotiables" as **phase-end invariants** (which phase achieves each), or as **target-end-state invariants** with the temporary exceptions explicitly carved out. Pick process-level vs host-level scope for "no agents on orchestrator."

### Theme I — Migration safety and reversibility
**Description:** phase 5 step 5.9 is irreversible (table rebuild) but sits inside the normal phase flow.

**Rolls up:** significant #22, #34.

**Resolution:** treat 5.9 as a separate release milestone with explicit backup-required note. Document rollback strategy: if rollback is out of scope post-5.9, say so plainly in the phase exit criteria.

### Theme J — Implementation drift between phases (forward references that don't land)
**Description:** phase 2 assumes a dispatchable network plane phase 1 didn't deliver; phase 3 evolves `LocalWorkerPool` instead of `MultiHarnessPool`; phase 4 references `WorkerNetworkTransport` and `verification` capability without provenance.

**Rolls up:** critical #12; significant #11, #36.

**Resolution:** in each phase doc's prerequisites section, list every cross-phase symbol it consumes and the exact prior step that lands it. Where a forward reference exists with no landing step, add the missing step.

## Per-phase punch list

### Phase 1 — protocol & registry
- **Pin migration number** to `010_workers` (assuming 01-baseline has merged; if not, restate the README assumption). Drop the "renumber later" hand-wave [opus, haiku-2, haiku-3, haiku-5].
- **Decide and document the canonical transport seam.** Choose `IpcTransport` with `WebSocketServerTransport`/`WebSocketClientTransport` (per design D4) and have the registry server/client build on top. Move file edits in step 1.4/1.5 into `src/runtime/ipc/` plus thin `src/runtime/registry/` adapters [haiku-4].
- **Define a `reconnect` frame variant** carrying `bootEpoch` + held `agentRunId`s + fences, OR explicitly defer reconnect to phase 5 with a note that scenario 1 of step 5.7 depends on this [opus].
- **Resolve `heartbeat_ack`**: either delete it or use it as the lease-renewal carrier in phase 5 [haiku-4].
- **Update stale anchors** in `src/compose.ts` (`:211-223` not `:193-205`; `:255` not `:237-244`); update doc path to `docs/architecture/worker-model.md` [haiku-2].
- **Make compose unit test required, not optional** in step 1.5 [haiku-5].
- **Note the `harnessKinds` union is open** (claude-code from squid track will extend it later) — one-line callout [plan-relevance].
- **State `idx_workers_last_seen_at DESC` intended query pattern** [haiku-3].
- **Pin TUI panel path** in step 1.5 [opus].

### Phase 2 — remote task execution
- **Add an explicit step "make live worker connections dispatchable"** between 2.3 and 2.4 (or inside 2.4): extend the phase-1 registry server to maintain `connection ↔ workerId` map and route run-plane frames [haiku-4, haiku-5].
- **Rename `RemoteSshHarness` → `RemoteHarness` (or `RemoteWsHarness`).** SSH is git transport; the IPC plane is WebSocket [opus, haiku-4].
- **Settle session storage to centralized** as the canonical answer; remove forward references that allow a worker-authoritative branch [opus, haiku-1, haiku-2, haiku-3, haiku-5].
- **Pin a degenerate single-worker policy** in step 2.5's `MultiHarnessPool`. Push capacity-aware routing fully into phase 3. Step 2.7 test registers exactly one remote worker [opus].
- **Document `distributed.enabled` default and preflight.** State that flipping it without a seeded bare repo is rejected [haiku-5].
- **Document push-option authorization weakness** in `docs/concerns/`. Mark as "weak authorization until phase 5" [opus, haiku-1].
- **Update stale anchors** for `DiscussFeaturePhaseBackend` (`:75`), `FeaturePhaseOrchestrator` (`:177`), pid/proc recovery (`src/orchestrator/services/recovery-service.ts:809-844`) [haiku-2].
- **Add schema mirror for `result.branchHeadSha`** in step 2.6 [haiku-4].
- **Make `branchHeadSha` non-optional** in the long run, or pin a deadline [haiku-5].
- **State `worker_ready`/`worker_init_ack` directionality and add validators** [haiku-4].
- **Reconcile phase 2 prereq about `agent_runs.worker_id`** with phase 3 actually adding it [opus, haiku-3, haiku-4, haiku-5].
- **Document phase 2 `onExit`-on-transport-close vs phase 5 partition design.** Likely fix: only fire `onExit` on clean closes [opus].
- **Cite squid Phase A streaming `SessionHandle` design as prior art** for the `FeaturePhaseBackend` contract being harness-agnostic — one sentence [plan-relevance].
- **Make session-frame routing keys explicit** (every `session_op`/`session_load_*` frame carries `agentRunId`/`sessionId`/`scopeRef`) [haiku-4].

### Phase 3 — multi-worker scheduling
- **Pin migration numbers**: `011_agent_run_owner_columns`, `012_agent_run_owner_index` [opus, haiku-2, haiku-3, haiku-5].
- **Move worker selection out of `RuntimePort`.** Introduce `WorkerDirectoryPort`/`PlacementPort`. Picker filters by `scopeKinds.includes(scope.kind)` AND `harnessKinds.includes(harnessKind)` AND `transportKind` [opus, haiku-1].
- **Drop worker-side `FileSessionStore` parameterization in step 3.4** (cache only, non-authoritative). Rewrite step 3.5 sticky-resume so `unknown_worker` falls through to *another worker with same `sessionId`*, not `mode: 'start'` [opus, haiku-1, haiku-2, haiku-3, haiku-5].
- **Patch `MultiHarnessPool`, not `LocalWorkerPool`,** in steps 3.2/3.3/3.5/3.6. Verify the change lands on the active distributed code path [haiku-5].
- **Pin `concurrentRuns` observability** to a concrete frame (likely `heartbeat`) with schema mirror [haiku-4].
- **Resolve `tasks.worker_id` semantics** explicitly (mirror, retire, or keep) [haiku-3].
- **Document FK absence on `owner_worker_id`** [haiku-3].
- **Settle `Store` query surface naming** (`listRunsByOwner` vs `listWorkerLoad`) [haiku-3].
- **Justify or drop `owner_assigned_at`** based on whether anything queries/displays it [haiku-3].

### Phase 4 — remote feature phases
- **Trace every `VerificationService.verifyFeature` call site** before step 4.8 deletion. Specifically `src/orchestrator/integration/index.ts:128-129` calls it directly today. Retarget each call to consume a remote-produced `VerificationSummary` [opus, haiku-2].
- **Add a substep that lands `verification` capability** on registry schema and picker enforcement [haiku-5].
- **Decide and commit run-frame design** (extend `run` vs new `run_feature_phase` variant) [opus, haiku-4].
- **Define `result` union as scope-aware `PhaseOutput`** with all branches (`text_phase`/`verification`/`ci_check`/`proposal`) and update validator [haiku-4].
- **Define the `agent_runs.payload_json` envelope** for remote proposal submit (state byte-compatibility with current local/recovery envelope) [haiku-3].
- **Add `seq` to `proposal_op` and `proposal_submitted`** for ordering across reconnect [opus].
- **Set `worker_pid` NULL on dispatch for feature-phase runs** in step 4.8 (no orchestrator-side pid for remote) [opus].
- **Specify bootstrap-feature lifecycle in step 4.6**: name, abort behavior, TUI visibility, rename interaction with `agent_runs.feature_id` FK [opus].
- **Decouple "wire path works" from "default is on"** in step 4.7. Add upgrade note to phase exit criteria [opus].
- **Authorize feature-phase-agent pushes** in the bare-repo hook (currently only task-branch authorized). State which scopes push [opus].
- **Pick one env-var name** (`GVC_FORCE_REMOTE_AGENTS` vs `GVC_ALLOW_LOCAL_FEATURE_PHASE_BACKEND`) and use it consistently [haiku-1, haiku-5].
- **Plan dead-flag cleanup** post-step-4.8 [haiku-5].
- **Renumber step 4.6 into 4.6/4.7/4.8** if the "one step = one commit" rule matters; otherwise exempt explicitly [haiku-5].
- **Invert lint enforcement scope** in step 4.9: allowlist worker-side modules; scan everything else (`src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, all `src/agents/**`) [haiku-1].
- **Update stale anchors**: `src/compose.ts:189-209` for orchestrator instantiation; `src/compose.ts:198-208` for `proposalOpSink`; `src/tui/app.ts:355-376` for `TuiApp.onProposalOp` [haiku-2].
- **Specify `proposal_phase_ended` ordering vs `result`** [haiku-4].
- **State `VerificationLayerConfig` mid-feature staleness** is acceptable [opus].
- **Cite squid D.11 as prior art** for `FeaturePhaseBackend` being harness-agnostic [plan-relevance].

### Phase 5 — leases and recovery
- **Pin migration numbers**: `013_run_leases_fence_token`, `014_drop_worker_pid_columns` [opus, haiku-2, haiku-3, haiku-5].
- **Add `fence` to `OrchestratorToWorkerMessage.run` schema** as part of step 5.2. Reorder dispatch: increment fence → send in `run` → `harness.start` → `grantLease` [opus, haiku-4, haiku-5].
- **Add `proposal_op`/`proposal_submitted`/`proposal_phase_ended`/`progress`/`session_op`/`confirm` to the fenced frames list** in step 5.5 [opus, haiku-3, haiku-4, haiku-5].
- **Switch lease renewal to the registry-plane `heartbeat`** (worker-scoped network frame), not stdio `health_pong`. Retarget file edits to `src/runtime/registry/*` [opus, haiku-1, haiku-2, haiku-4, haiku-5].
- **Drop `liveRuns` fence cache.** Rely on `updateAgentRunTxn`'s source-of-truth `expectedFence` check [opus].
- **Define reconnect handshake** explicitly: phase 1 adds a `reconnect` frame variant, OR phase 5 step 5.3 makes the first post-restart heartbeat carry full reattach info [opus].
- **Specify worker process model** for lease renewal: registry client and run executor are the same process, OR share an atomic `Set<{agentRunId, fence}>` [opus].
- **Make sweep-on-boot synchronous** in step 5.4: `await sweeper.sweep(now); scheduler.tick(); setInterval(...)` [opus, haiku-5].
- **Decide fate of `agent_runs.owner_worker_id`/`owner_assigned_at`/`tasks.worker_id`** in step 5.9. Recommended: drop all in favor of `run_leases` [opus, haiku-1, haiku-3].
- **Enumerate the post-phase-5 `agent_runs` column set** in step 5.9 [opus, haiku-3].
- **Update the rebuild-pattern reference** to a real example, or acknowledge it's the first table-rebuild migration [haiku-3].
- **Fix step 5.1 rollback note** (the migration also adds `fence_token`; not just `DROP TABLE`) [haiku-3, haiku-5].
- **Tune `run_leases` indexes** for the sweep predicate (partial index on active leases or composite `(state, expires_at)`) [haiku-3].
- **Treat step 5.9 as a separate release milestone** with backup requirement; out-of-band from normal phase flow [haiku-5].
- **Drop `boot_epoch` from `workers` in step 5.9** or state why it stays [opus].
- **Either delete `getLease` or document a consumer** [haiku-3].
- **Drop `isResumableForWorker(sessionId, workerId)`** — collapse to a session-record property since centralized sessions are settled [haiku-1].
- **Override phase 2's `onExit`-on-transport-close** explicitly: dirty close → wait for lease expiry → takeover [opus].
- **Update bare-repo hook path** to phase 2's location (`src/orchestrator/git/`), not `src/runtime/git/bare-repo-hooks.ts` [haiku-2].
- **Move bare-repo cleanup helper** out of `src/runtime/worktree/index.ts` [haiku-1].
- **Update phase 5 background** to acknowledge phase 3 already persisted owner identity [haiku-1, haiku-2].
- **Update `Store.updateAgentRun` port definition explicitly** if `expectedFence` lands there, OR route through dedicated lease-aware helpers [haiku-3].
- **Document push-option fence trust model** [opus, haiku-1].
- **Define "worker ack"** in step 5.2 review prompt [opus].

## Disagreements between reviewers

1. **Should the `Store` port grow lease/fence semantics?**
   - **Claim A (haiku-1):** No. `Store` is a transport-agnostic seam; introduce a separate `RunLeaseStore`/`LeaseRepository` port. `expectedFence` does not belong on generic `updateAgentRun`.
   - **Claim B (haiku-3):** Acknowledges the `Store` port already plausibly extends to lease methods; main complaint is that `expectedFence` is added implicitly without updating the port file. Either add it explicitly OR route through dedicated helpers.
   - **Picked side:** haiku-1 is more rigorous against the README non-negotiable. Adopt: introduce `RunLeaseStore`. Keep `Store` clean. This lines up with critical #10 and theme G.

2. **Does phase 2's `onExit`-on-transport-close conflict with phase 5's partition design?**
   - **Claim A (opus):** Yes — phase 5 needs the run to survive transport drop while the lease expires; phase 2's `onExit` marks it terminated.
   - **Claim B (none, only opus raised this):** N/A — single reviewer.
   - **Picked side:** opus's reasoning is sound. Phase 5 must explicitly retract phase 2's `onExit` semantics for dirty closes.

3. **Does centralized session storage handle takeover, or does phase 5 still need worker-authoritative branches?**
   - **Claim A (opus, haiku-1, haiku-2, haiku-3, haiku-5):** Centralized is settled in phase 2 and resolves takeover trivially; later worker-local mentions are drift.
   - **Claim B (phase 5 step 5.4 itself):** Both branches must be supported via `isResumableForWorker`.
   - **Picked side:** five reviewers vs the doc itself. Adopt centralized-only. Drop `isResumableForWorker` worker-authoritative branch. (This is critical #1.)

4. **Should phase 4 step 4.6 be one step or three?**
   - **Claim A (haiku-5):** One step = one commit is the README rule; rename 4.6 into 4.6/4.7/4.8.
   - **Claim B (phase 4 itself):** Acknowledges the split, treats it as fine.
   - **Picked side:** doc-process issue, low impact. Either renumber OR exempt the step explicitly in the README (haiku-5's fallback).

5. **Is "no agents on the orchestrator" a process-level or host-level claim?**
   - **Claim A (haiku-5):** ambiguous; under host-level reading, phase 4 doesn't satisfy it because local-spawn task workers persist.
   - **Claim B (haiku-1, README):** treat as the destination invariant; phases 1–3 are temporary exceptions.
   - **Picked side:** haiku-5's narrower reading is more rigorous. Adopt: process-level for feature-phase agents (achievable end of phase 4); host-level for in-orchestrator-process agents (achievable now); local-spawn task workers are explicitly permitted as a separate worker kind.

6. **Are phase 1's stale line anchors a critical issue?**
   - **Claim A (opus):** flagged as nit ("phase 1 step 1.5 hand-waved").
   - **Claim B (haiku-2):** verified citations, called out as significant for implementation accuracy.
   - **Picked side:** haiku-2 is the citation-accuracy specialist; their weighting is correct. Promote to "significant" for implementer ergonomics.

7. **Is the `RuntimePort` extension in phase 3 step 3.2 a violation?**
   - **Claim A (opus, haiku-1):** Yes — `targetWorkerId`, `policyHint`, `listWorkers()`, `not_dispatchable` all distributed concepts.
   - **Claim B (none explicit):** phase 3 itself defends it as "scheduler asks the registry."
   - **Picked side:** README non-negotiable is explicit (line 16). Two reviewers concur. Adopt the fix: `WorkerDirectoryPort`/`PlacementPort`, composition over method args.

8. **Should fence-checking happen at `Store.updateAgentRun` level or via dedicated helpers?**
   - **Claim A (haiku-1):** Dedicated helpers; keep generic `Store` clean.
   - **Claim B (haiku-3):** Either is fine but it has to be documented either way.
   - **Picked side:** haiku-1's design is stronger. Dedicated helpers in `RunLeaseStore` (or fence-aware methods on it). Generic `Store.updateAgentRun` stays as-is.

## What the plan gets right

- **Bare-repo as the canonical worktree-sync layer** is the right shape: co-locates ref state with orchestrator SQLite, avoids GitHub rate limits, gives the merge train a single authoritative source [opus, haiku-1].
- **Single orchestrator authority** is set as a non-negotiable up front; no leader election, no multi-orchestrator HA explosion [opus, haiku-1].
- **Phase 1's "visible but not dispatchable" property** is a thoughtful seam — registry observability before dispatch wiring [opus, haiku-5].
- **Phase 4's per-scope flag rollout** with read-only first, verify next, replanner before planner, bootstrap last reflects real risk ordering [opus, haiku-5].
- **Phase 4 step 4.9's audit guard** (lint + at-rest scan + runtime assertion) is the right paranoia level [opus, haiku-1].
- **Phase 5's crash matrix** enumerates every interesting failure and points at recovery test [opus, haiku-5].
- **Migration retirement of legacy fields with the rebuild pattern** is correct SQLite hygiene [opus, haiku-3].
- **Phase 1 keeps registry frames separate from run frames** to protect `RuntimePort` from registry concerns [haiku-1, haiku-4].
- **Phase 2 enforces no-shared-FS** via bare repo + worker worktrees + pull-back-before-merge [haiku-1].
- **Phase 2 settles on centralized session storage** (the cleanest answer to takeover and no-shared-disk) [haiku-1, haiku-3].
- **Phase 4's main migration direction is correct**: proposal host on worker, verification on worker, step 4.8 deletes `FeaturePhaseOrchestrator`/`DiscussFeaturePhaseBackend` [haiku-1, haiku-4].
- **Phase 5 does not smuggle a compensating in-process agent back onto the orchestrator** [haiku-1].
- **Worker sync stays first-party and downstream-only** (orchestrator-hosted bare repo, GitHub is not operational sync) [haiku-1].
- **`fence_token INTEGER NOT NULL DEFAULT 0`** is a good additive column shape [haiku-3].
- **Phase 3 partial owner index** (`WHERE owner_worker_id IS NOT NULL`) is good design [haiku-3].
- **Distributed run high-level phase ordering is correct** (registry → single remote task → multi-worker → feature-phase → leases) [haiku-5].
- **Most destructive changes are deferred** until phase 5 [haiku-5].
- **Phase 4 rollout shape is strong**: infra → read-only scopes → verify → proposal → defaults → deletion → guards [haiku-5].
- **Branch-as-sync model in phase 2** avoids shared filesystem assumptions and gives recovery a clear unit [haiku-5].
- **Proposal-host mirror design** is the right latency/safety tradeoff (worker-local synchronous, streaming checkpoints) [haiku-4, haiku-5].
- **Plan is aware of ordering/race hazards** in proposal mirror; review prompts call out the right invariants [haiku-4, haiku-5].
- **`proposal_*` frames carry `agentRunId` + `scopeRef`** — correct routing-key pattern [haiku-4].
- **Prompt-digest move in phase 4** is transport-friendly (worker gets plain JSON instead of reaching back into orchestrator state) [haiku-4].
- **`run_leases` separated from `agent_runs`** correctly avoids hot-row churn [haiku-3].
- **Most cited file anchors are correct** for core runtime seams (`RuntimePort`, `LocalWorkerPool`, `dispatchReadyWork`, `recovery-service`, `GraphProposalToolHost`, `VerificationService.verifyFeature`) [haiku-2].

## Existing-plan (structured-growing-squid) verdict

Squid Phases A and B are already merged and silently underpin 02-distributed (the unified `RuntimePort.dispatchRun`, `RunScope`, `scopeRef`, harness-aware config, `harness_kind`/`worker_pid`/`worker_boot_epoch` columns). Nothing to lift; the dependency is implicit. Squid Phases C/D/E (MCP HTTP server, `ClaudeCodeHarness`, hooks/stream-json) address a different problem (multiple harnesses on one machine) and should not be folded in. The only edits worth making to the 02-distributed track are two one-line callouts: (1) phase 1 step 1.1 should note the `harnessKinds` union is open and a future `claude-code` harness will extend it; (2) phase 2 step 2.4 / phase 4 README should cite squid Phase A's streaming `SessionHandle` design as prior art for the harness-agnostic `FeaturePhaseBackend` contract. If squid C/D/E is later picked up, the MCP server must bind to a network-reachable host (not `127.0.0.1`) and the `claude-code` harness must assume nothing about shared filesystem with the orchestrator — those constraints flow naturally from 02-distributed's non-negotiables.

## Final recommendation

**Fix critical and significant issues, then ship phase by phase.** Phase 1 can land mostly as-is (pin migration number, decide canonical transport seam, define reconnect or defer it explicitly, fix stale anchors). Phases 2–5 need a coordinated revision pass to resolve the three deepest contradictions — session-storage authority (centralized everywhere), migration numbering (010→014 chain), and fence-token plumbing (add to `run` frame, fence proposal/progress/session_op) — plus the ownership split-brain (drop owner columns in step 5.9 in favor of `run_leases`) and the heartbeat plane choice (registry-plane, not stdio `health_pong`). The plan's overall architecture is sound; the issues are integration seams between independently-drafted phase docs, not redesigns. Estimated revision cost: one to two days of doc work before any phase 2+ implementation begins.
