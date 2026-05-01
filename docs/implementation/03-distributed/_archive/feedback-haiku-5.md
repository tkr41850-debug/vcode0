# Phase Review — Haiku 5, ordering & shippability

## Critical issues (block landing)

1. Phase 2 never actually lands the dispatchable network run-plane it assumes from phase 1.
   - Phase 1 step 1.4 explicitly says non-registry run frames are logged and dropped.
   - Phase 1 step 1.5 adds a `WorkerRegistryClient` that only registers and heartbeats.
   - Phase 2 step 2.4 assumes a live addressable worker connection / `WorkerLease` / network `SessionHarness` substrate already exists.
   - No phase-2 step updates the phase-1 server to route `run`, `abort`, `manual_input`, and worker result frames to a specific registered worker.
   - Result: the plan can pass step-local fake-transport tests and still fail the stated phase-end outcome, because the real phase-1 server path never becomes dispatchable.

2. The remote session-storage decision is made in phase 2, then contradicted in phase 3 and phase 4.
   - Phase 2 step 2.3 explicitly settles on centralized orchestrator-side session storage via IPC proxy.
   - Phase 3 step 3.4 reintroduces per-run worker-side `FileSessionStore` under worker scratch.
   - Phase 3 step 3.5’s sticky-resume fallback logic assumes a dead worker implies a dead session.
   - Phase 4 known gaps still say “if phase 2 already centralized session storage,” as though the decision were still open.
   - Result: resume, reroute, and crash-takeover semantics are inconsistent across phases; later steps are written for a different phase-2 outcome than the one phase 2 actually chose.

3. Later phases keep patching `LocalWorkerPool` even though phase 2 makes `MultiHarnessPool` the distributed runtime.
   - Phase 2 step 2.5 says `compose.ts` uses `MultiHarnessPool` when `config.distributed.enabled === true`.
   - Phase 3 step 3.2, 3.3, 3.5, and 3.6 all speak as though `LocalWorkerPool` remains the runtime surface that owns worker selection and fleet views.
   - Phase 5 step 5.2 and 5.5 also thread lease grant and fence enforcement through `src/runtime/worker-pool.ts` only.
   - `MultiHarnessPool` disappears from the plan after phase 2.
   - Result: ownership, capacity, lease, and fence logic risk landing on a code path that is not active in distributed mode.

4. Phase 5 never adds the current fence token to the orchestrator→worker `run` frame.
   - Step 5.3 says the worker reports held leases with fences learned from the `run` frame.
   - Step 5.4 takeover requires dispatching a resumed run with the new fence.
   - Step 5.5 requires workers to include the current fence on mutating frames and git pushes.
   - No step actually extends `OrchestratorToWorkerMessage` `type: 'run'` with `fence`.
   - Result: workers have no authoritative source for the fence they are supposed to renew, report, or attach to pushes.

5. Phase 5 fence enforcement forgets the phase-4 proposal stream.
   - Phase 4 adds `proposal_op`, `proposal_submitted`, and `proposal_phase_ended` worker→orchestrator frames.
   - Phase 5 step 5.5 fences `result`, `error`, `claim_lock`, `request_help`, and `request_approval` only.
   - `proposal_submitted` is not advisory; it updates `agent_runs.payload_json` and drives approval-visible state.
   - A stale planner worker after takeover can still emit proposal traffic unless those frames are fenced or otherwise ownership-checked.
   - Result: the lease model is incomplete for the highest-stakes feature-phase path.

6. Phase 5 is not rollback-safe end-to-end because step 5.9 is deliberately irreversible.
   - Step 5.9 rebuilds `agent_runs` to drop `worker_pid` / `worker_boot_epoch`.
   - The doc explicitly says downgrade is out of scope and rollback requires restoring a SQLite backup.
   - That is acceptable only if step 5.9 is treated as its own release boundary with an explicit compatibility window and backup requirement.
   - As written, it sits inside the normal phase flow and is described as just another commit.
   - Result: the “ships in order, stays green, safe to roll back” story breaks exactly at the point the phase declares itself complete.

7. Phase 4’s “zero agents on the orchestrator” claim is ambiguous enough to be false under the stricter reading.
   - If “on the orchestrator” means “inside the orchestrator process,” phase 4 mostly gets there by 4.8.
   - If it means “on the orchestrator host,” phase 2/3 still preserve local-spawn task workers as a valid worker kind.
   - The README and phase docs alternate between process-level and machine-level wording.
   - Because the plan explicitly preserves local-spawn as a transport, the machine-level reading is not satisfied by the end of phase 4.
   - Result: the main rollout claim for phase 4 needs narrowing or the transport matrix needs changing.

## Significant issues (worth addressing)

1. The README’s “architectural non-negotiables” read like phase-by-phase requirements, but the phase docs do not meet them.
   - “No agents run on the orchestrator” is false until phase 4.8.
   - “RuntimePort, IPC frame contracts, and Store port should not grow distributed-system concepts” is false by phase 3.2 and phase 5.5.
   - If these are target-end-state constraints, the README should say so.

2. Phase 2’s prerequisite “`agent_runs` carries `worker_id` (or equivalent)” conflicts directly with phase 3’s statement that ownership is not persisted until step 3.1.
   - Phase 1 does not add `worker_id` to `agent_runs`.
   - Phase 3 is where `owner_worker_id` is actually introduced.
   - The current wording makes phase 2 depend on a field the earlier phases never added.

3. The worker-kind / harness-kind / transport-kind vocabulary is not stable.
   - Phase 1 capabilities use `harnessKinds` aligned with existing `HarnessKind` values.
   - Phase 2 selection examples use `local-spawn` vs `remote-ssh`.
   - Phase 3 introduces `WorkerCapacityView.kind: 'local-spawn' | 'remote'`.
   - Current code’s `HarnessKind` is `'pi-sdk' | 'claude-code'`, which is a different axis entirely.
   - This is not just naming drift; it affects registry schema, scheduler filters, and persistence fields.

4. Phase 4 introduces a `verification` worker capability in prose but never lands the step that makes it real.
   - Step 4.4 says verification moves remote and workers advertise which command set they can run.
   - No step extends the registry schema, capability matching, or phase-3 picker to require that capability before enabling remote verify / ci_check.
   - The plan can therefore turn on remote verification without proving the selected worker can run the configured checks.

5. Phase 5 heartbeat naming is inconsistent with phase 1.
   - Phase 1 distributed runtime defines `heartbeat` / `heartbeat_ack` registry frames.
   - Phase 5 talks about extending `health_pong` and a “phase-1 reconnect handshake.”
   - Baseline local IPC may have `health_ping` / `health_pong`, but the distributed phase-1 doc does not.
   - The implementer needs one canonical frame family to extend.

6. Phase 5’s lease layer is not actually opaque to the phase-2 session-storage decision.
   - Cross-worker takeover requires that the new worker can resume the old session.
   - That is exactly why phase 2 centralized sessions.
   - The “whichever shape phase 2 landed on” phrasing suggests both centralized and worker-authoritative paths remain valid here, but the takeover design only really works with centralized storage.

7. The phase-2 flag story is incomplete for rollout safety.
   - Step 2.1 adds `distributed.bareRepo.enabled` and says later steps short-circuit when it is false.
   - Step 2.5 uses `config.distributed.enabled` to switch runtime implementations.
   - The default for `distributed.enabled`, the preflight that checks `repo init` has been run, and the exact flip moment are not stated.
   - This makes it too easy to enable remote dispatch against an unseeded bare repo.

8. The phase-4 flag lifecycle is incomplete.
   - Step 4.3 adds per-scope `remoteFeaturePhases.*` flags.
   - Step 4.6/4.7 flips them to `true`.
   - Step 4.8 deletes the local backend, so the flags stop being real rollout controls.
   - No later step removes them or explicitly documents them as permanent no-ops.

9. Phase 4 uses inconsistent env var names for the enforcement override.
   - Design section: `GVC_FORCE_REMOTE_AGENTS`.
   - Step 4.9: `GVC_ALLOW_LOCAL_FEATURE_PHASE_BACKEND`.
   - Rollout docs, CI, and support tooling need one name.

10. Phase 5 step 5.4 promises sweep-on-boot behavior, but the implementation step only describes starting an interval inside `scheduler.run()`.
    - Step 5.7’s double-crash scenario depends on a sweep before the next scheduler tick.
    - The startup ordering should be explicit in step 5.4, not only inferred from a later test.

11. Phase 4 violates the README’s “one step = one commit” promise.
    - Step 4.6 is one numbered step but three separate commits.
    - The phase doc acknowledges the split, so the README claim is simply not true for this track.
    - This is a documentation/working-agreement issue more than an implementation issue, but it undercuts the stated shippability model.

12. Some step-local tests are too isolated to prove the real seam.
    - Phase 2 step 2.4 can pass with a fake transport even though the actual phase-1 server still drops run frames.
    - Phase 5 step 5.2/5.3 can pass with fake stores even though no step has yet told the worker what fence to use.
    - The “stays green” claim is stronger than the current test layering actually proves.

## Minor / nits

1. Phase 3 migration numbering hand-waves around baseline ordering.
   - Step 3.1 says “if baseline 010 has not shipped, this phase claims 010 and baseline renumbers.”
   - The track README already says this implementation assumes 01-baseline has merged.
   - Pick the post-baseline migration number and remove the contingency.

2. Phase 1 step 1.5 makes the compose unit test optional.
   - Default-off behavior is a core rollout-safety claim.
   - That coverage should be mandatory, not “if one exists.”

3. Phase 2 step 2.6 makes `result.branchHeadSha` optional.
   - That is fine for incremental landing.
   - But if it stays optional indefinitely, the remote-fetch verification path can silently skip the intended safety check.

4. Phase 4 says “9 commits” and also “effective total 11 commits.”
   - The text is understandable.
   - It is still a count mismatch that future readers will trip on.

5. Commit subjects are mostly valid conventional commits and meaningfully distinct.
   - The only structural exception is step 4.6, where one step maps to three subjects.
   - A few scopes repeat (`feat(runtime/registry)`, `feat(distributed)`), but the bodies are different enough.

6. Phase 5 step 5.1 says rollback is a `DROP TABLE`.
   - That step also adds `agent_runs.fence_token`.
   - So even the schema-only step has a slightly more complex rollback story than the shorthand suggests.

## Cross-phase inconsistencies

1. README says “no agents run on the orchestrator” for every phase; phases 1–3 and most of phase 4 explicitly keep in-process feature-phase agents.

2. README says `RuntimePort`, IPC frame contracts, and `Store` should not grow distributed concepts; phase 3 and phase 5 explicitly extend all three with worker selection, leases, and fences.

3. Phase 2 assumes `agent_runs` already carries worker identity; phase 3 says ownership is not persisted until 3.1.

4. Phase 2 settles centralized sessions; phase 3 and phase 4 repeatedly talk as though worker-local sessions still exist.

5. Phase 2 makes `MultiHarnessPool` the distributed runtime; phases 3 and 5 keep evolving `LocalWorkerPool` instead.

6. Phase 1 capability schema uses `harnessKinds`; phase 2 routing talks about `remote-ssh`; phase 3 uses `local-spawn | remote`; current code’s `HarnessKind` is `pi-sdk | claude-code`.

7. Phase 5 says phase 3 ownership is still implicit in memory + legacy pid columns; phase 3 step 3.1 already persisted `owner_worker_id`.

8. Phase 5 refers to `health_pong` and reconnect handshakes not defined in the phase-1 distributed protocol doc, which talks in `heartbeat` / `heartbeat_ack` terms.

9. Phase 4 uses both `remoteFeaturePhases.ci_check` language and a separate `remoteCiCheck` flag name; the flag surface is not consistently named.

10. Phase 4 design notes say the worker-side feature-phase runtime keeps disk-backed `FileSessionStore` “if phase 2 already centralized session storage, confirm during implementation,” even though phase 2 already did centralize it by design.

11. Phase 5’s resumability decision mentions a proposal-host state query (“no in-flight proposal is mid-apply”) that phase 4 never explicitly introduces as a persisted/queryable signal.

12. Phase 5’s fencing model covers worker result/error/help/approval traffic but omits the phase-4 proposal stream, leaving the cross-phase state-mutation set incomplete.

## Phase-end state audit

### Phase 1
- What works:
  - Optional registry server boots.
  - Workers can connect, register, heartbeat, and appear in persisted worker listings.
  - Default config keeps baseline local behavior unchanged.
- What does not work yet:
  - Remote workers are visible only; they are not dispatchable.
  - Run frames are still dropped at the server.
  - No worker ownership, no lease semantics, no remote git, no remote session storage.
- Does the stated phase-end claim hold?
  - Mostly yes.
  - The “workers register but no remote dispatch; local-spawn identical to baseline” claim is met if `workerProtocol.enabled` stays false by default.
- Rollback story:
  - Good.
  - It is additive, gated, and easy to disable or revert.

### Phase 2
- What works on paper:
  - Bare-repo sync model is sensible.
  - Worker-side git, centralized session proxy, remote harness, and branch sync-back line up as the right building blocks.
  - Local spawn is intentionally preserved.
- What is missing or unclear:
  - The plan never finishes the live network dispatch plane inherited from phase 1.
  - `distributed.enabled` is referenced but not fully introduced as a rollout contract.
  - The phase-2 prerequisite `worker_id` persistence is not actually present in earlier phases.
- Does the stated phase-end claim hold?
  - Not yet.
  - As written, I do not think the phase can guarantee “one remote worker runs one task end-to-end” because the active worker connection/routing step is missing.
  - I also cannot fully verify “local spawn is still the default” because the default for `distributed.enabled` is not stated.
- Rollback story:
  - Reasonable if remote mode is still off.
  - Weaker once remote mode is enabled, because there is no explicit readiness gate that prevents partial enablement before `repo init` and transport wiring are complete.

### Phase 3
- What works on paper:
  - Ownership columns, capacity views, per-worker picker, sticky resume, and operator visibility are the right next layer.
  - Treating local-spawn as a single logical worker entry is the right compatibility model.
- What is missing or contradictory:
  - The plan updates `LocalWorkerPool` rather than the phase-2 distributed runtime wrapper.
  - Step 3.4/3.5 are written for worker-hosted sessions, not the centralized session model phase 2 selected.
  - The local-spawn-as-registry-entry behavior is specified in 3.2 but not clearly carried through the actual distributed path.
- Does the stated phase-end claim hold?
  - Only partially.
  - Ownership persistence itself is fine.
  - Multi-worker scheduling is not convincingly shippable until the runtime-object mismatch and session-model contradiction are fixed.
- Rollback story:
  - Good if limited to 3.1–3.3/3.6 additive schema and scheduler changes.
  - Still acceptable if phase 4 is held back; phase 3 does not inherently require remote feature phases.

### Phase 4
- What works on paper:
  - The migration order is sensible: digest first, worker runtime skeleton, text phases, verification, proposal mirror, then defaults, then deletion, then enforcement.
  - Keeping proposal-op streaming semantics intact is a strong design choice.
  - Deleting the in-process backend only after flag-flip soak is the right shape.
- What remains ambiguous or weak:
  - “Zero agents on the orchestrator” needs a process-vs-host clarification.
  - Verification capability gating is described but not actually landed.
  - The rollout flags become dead once the local backend is deleted.
- Does the stated phase-end claim hold?
  - If the claim means “no in-process feature-phase `Agent` construction in the orchestrator process,” then yes after 4.8/4.9.
  - If it means “no agent loops on the orchestrator machine at all,” then no, because local-spawn task workers still exist.
  - I did not find an orphaned in-process feature-phase path in the plan after 4.8, but I did find dead-flag cleanup missing.
- Rollback story:
  - Good through 4.7 because each scope flips independently.
  - Still workable after 4.8 because the phase is code-only, but the clean rollback point is 4.7, just before deletion.

### Phase 5
- What works on paper:
  - Lease grant, heartbeat renewal, expiry sweep, takeover, fencing, and crash-matrix tests are the right final shape.
  - Deferring legacy pid/proc removal to the last step is the right instinct.
- What is still broken as written:
  - Workers are never explicitly told the current fence on `run`.
  - Proposal-stream frames are not included in the fencing story.
  - Heartbeat naming / reconnect semantics are inconsistent with phase 1.
  - The phase assumes boot-time sweep ordering not yet encoded in the implementation step.
- Does the stated phase-end claim hold?
  - Not fully.
  - I do not think the plan can yet guarantee “survive worker crash without manual intervention” until fence propagation and proposal-stream ownership checks are fixed.
  - After those fixes, the overall shape is viable.
- Rollback story:
  - Steps 5.1–5.8 are mostly additive and reasonably reversible.
  - Step 5.9 is not reversible in the normal sense and should be treated as a separate, explicitly gated rollout event.

## Step ordering issues

### Phase 1 — mostly ordered correctly, but the transport promise outruns the concrete steps
- 1.1 → 1.5 is generally sensible: types, frames, persistence, server, then compose wiring.
- The main issue is conceptual, not local ordering:
  - the design section promises a generic WebSocket transport seam,
  - but the concrete steps only land registry protocol/server/client pieces.
- That omission becomes a real forward-reference bug in phase 2.
- Test coverage is mostly good.
- The only weak spot is 1.5’s optional compose unit test; default-off behavior deserves required coverage.

### Phase 2 — not ordered tightly enough to guarantee a shippable remote task path
- 2.1 is fine as groundwork.
- 2.2 is fine as worker-side git groundwork.
- 2.3 is fine and important; the centralized session decision belongs before recovery-heavy later phases.
- 2.4 forward-references missing phase-1 transport/routing behavior.
- 2.5 forward-references both a missing capability axis and an incompletely defined `distributed.enabled` flag.
- 2.6 is sensible once remote dispatch is real.
- 2.7 can go green with an in-process fake remote while the real registry/server path is still incomplete.
- Net: phase 2 needs an explicit “make live worker connections dispatchable” step before `RemoteSshHarness` or inside it.

### Phase 3 — schema and scheduler groundwork are fine; session and runtime assumptions are not
- 3.1 is ordered correctly and safely additive.
- 3.2 is locally reasonable, but it patches `LocalWorkerPool` instead of the phase-2 distributed runtime wrapper.
- 3.3 is fine if 3.2 lands on the actual active runtime path.
- 3.4 is misordered against phase 2’s already-settled centralized session model.
- 3.5 is also written for the wrong session model; its fallback rules need to be rewritten once centralized sessions are accepted as authoritative.
- 3.6 and 3.7 are reasonable after 3.1–3.5.
- Net: the biggest forward refs are not to later phases, but to an alternate phase-2 design that the plan itself rejected.

### Phase 4 — internally mostly sound, but the step/commit contract is broken and capability gating is missing
- 4.1 before 4.2 is correct; prompt/context extraction belongs first.
- 4.2 as an unreachable skeleton is acceptable because dispatch is not wired yet.
- 4.3 and 4.4 are in the right order.
- 4.4 should also add the worker capability enforcement it describes in prose; right now that is a missing sub-step.
- 4.5 before 4.6 is correct; do not flip planner/replanner defaults before the proposal-op wire exists.
- 4.6 breaks the README’s one-step/one-commit rule by design.
- 4.7 → 4.8 → 4.9 is a good soak-then-delete-then-enforce sequence.
- Net: the only structural blockers here are capability gating and dead-flag cleanup, not the migration order itself.

### Phase 5 — several steps depend on behavior that has not been introduced yet
- 5.1 is a good additive schema-first step.
- 5.2 should also add fence to the `run` frame; without that, 5.3 has no authoritative worker input.
- 5.3 depends on settled heartbeat naming and on the missing run-frame fence.
- 5.4 depends on an explicit boot-time sweep path if 5.7’s double-crash story is to hold.
- 5.5 must include phase-4 proposal frames or explicitly classify them as non-authoritative and drop them after ownership changes.
- 5.6–5.8 are strong tests, but they currently rely on semantics that earlier steps did not fully define.
- 5.9 is correctly last, but it should probably be a separate release milestone because it is not rollback-safe.

### Commit subjects — mostly good
- The subjects are almost all valid conventional-commit lines.
- They are generally differentiated by subsystem and intent.
- The main process issue is not subject quality; it is that phase 4 step 4.6 is one numbered step with three different commits.
- If the working agreement really matters, renumber 4.6 into 4.6 / 4.7 / 4.8 and shift later numbers, or explicitly exempt this phase in the README.

## What the plan gets right

1. The high-level phase ordering is correct.
   - Registry/protocol first.
   - Single remote task path second.
   - Multi-worker scheduling third.
   - Feature-phase migration fourth.
   - Lease/recovery last.

2. Most destructive changes are deferred.
   - Ownership and lease schema are additive first.
   - Legacy pid/proc retirement is held until the very end.

3. Phase 4’s rollout shape is strong.
   - Infra first, then read-only scopes, then verify, then proposal scopes, then defaults, then deletion, then guards.

4. The plan usually pairs behavior changes with targeted tests.
   - The review prompts are unusually good.
   - They call out the actual invariants that would matter in production.

5. The branch-as-sync model in phase 2 is a good seam.
   - It avoids shared filesystem assumptions.
   - It gives later recovery logic a clear unit of exchange.

6. Phase 3’s operator visibility is a good addition, not gold-plating.
   - Distributed scheduling without “who owns what?” is painful to debug.
   - The plan recognizes that early.

7. The proposal-host mirror design in phase 4 is the right performance/safety tradeoff.
   - Worker-local synchronous draft mutation keeps planner latency down.
   - Streaming checkpoints back to the orchestrator preserves the existing UI contract.

8. The phase-5 crash matrix is exactly the right kind of planning artifact.
   - It forces the plan to name worker crash, orchestrator crash, partition, and git-plane failure separately.

9. Commit subjects are, in general, usable.
   - They follow conventional-commit format.
   - They tell a reviewer what changed and why the commit exists.

10. The plan is close.
    - The main problems are not with the overall shape.
    - They are with a handful of missing glue steps and a few cross-phase contradictions that should be reconciled before implementation starts.
