# Phase Review — Haiku 4, IPC frame & transport consistency

## Critical issues (block landing)

- **Phase 5 renews the wrong heartbeat plane.**
  - Phase 1 distributed introduces worker-registry `heartbeat` / `heartbeat_ack`.
  - 01-baseline phase 1 introduces runtime `health_ping` / `health_pong` on `NdjsonStdioTransport`.
  - Phase 5 then says "the phase-1 `health_pong` grows `leases[]`" and wires renewal in `src/runtime/harness/index.ts` and `src/runtime/worker/index.ts`.
  - Those are different transports and different frame families.
  - As written, lease renewal hangs off the local child-process heartbeat path, not the distributed worker-registry socket from phase 1.
  - Pick one authoritative liveness plane and carry it through phases 1, 2, and 5.

- **Phase 4 remote feature-phase `result` framing is internally inconsistent.**
  - `src/runtime/contracts.ts` today has `WorkerToOrchestratorMessage.result` carrying `TaskResult`.
  - Phase 4 summary says the terminal `result` frame is "unchanged in shape".
  - Step 4.2 expects the worker to emit `result.output.kind: 'text_phase'`.
  - Step 4.4 expects `result.output.kind: 'verification' | 'ci_check'`.
  - Step 4.5 expects `result.output.kind: 'proposal'`.
  - No step explicitly rewrites the `result` union branch and its validator to a scope-aware `PhaseOutput` shape.
  - This is a schema contract hole, not just a test gap.

- **Phase 5 fencing misses authoritative mutations introduced earlier.**
  - Step 5.5 adds `fence` to `result`, `error`, `claim_lock`, `request_help`, and `request_approval`.
  - It does not fence `session_op`, which mutates the authoritative orchestrator-side session store from phase 2.
  - It does not fence `session_load_request` / `session_load_response`; reads are less dangerous, but pending-load correlation after takeover still needs explicit treatment.
  - It does not fence `proposal_submitted`, which updates `agent_runs.payload_json` and drives approval flow from phase 4.
  - It does not fence `proposal_phase_ended`, which advances orchestrator-visible proposal lifecycle state.
  - It also leaves `proposal_op` unfenced; UI-only would be tolerable, but the doc also replays proposal events into orchestrator state.
  - A stale worker after takeover could still write checkpoints or submit a proposal unless these frames are fenced or otherwise rejected.

- **Phase 5 requires `run.fence`, but no step actually adds it.**
  - Step 5.4 says takeover redispatch sends "the new fence in the run frame".
  - Step 5.3 says the worker heartbeat reply pulls fence from the `run` frame it received.
  - Step 5.5 never adds `fence` to `OrchestratorToWorkerMessage.run`.
  - No schema update is called out for `run.fence` either.
  - Without a fenced `run` payload, the worker cannot report or enforce the current lease generation.

- **Phase 1's transport architecture changes mid-doc and later phases depend on both versions.**
  - Design decision D4 says phase 1 introduces `WebSocketServerTransport` and `WebSocketClientTransport` implementing the same `IpcTransport` seam.
  - Step 1.4 instead introduces `WorkerRegistryServer` in `src/runtime/registry/server.ts` using `ws` directly.
  - Step 1.5 adds `WorkerRegistryClient`, not a generic `WebSocketClientTransport` under `src/runtime/ipc/`.
  - Phase 2 and phase 4 then speak about "the phase-1 network transport" as if a reusable `IpcTransport` already exists.
  - Right now the plan names two incompatible seams: a generic WebSocket transport and a registry-specific server/client pair.
  - Later phases need one stable abstraction, or they will accumulate per-feature protocol helpers around raw sockets.

- **Routing for multiplexed concurrent runs is still under-specified at the frame level.**
  - Phase 3 explicitly allows one worker to host multiple concurrent runs.
  - After that point, every worker→orchestrator frame that can arrive on a shared connection needs enough routing keys to unambiguously target one live run.
  - Existing baseline frames generally have `agentRunId` and `taskId`.
  - New phase-2 and phase-4 families do not always spell out `agentRunId`, `sessionId`, and `scopeRef` requirements in the same detail.
  - The gap is especially important for `session_op`, bootstrap frames, and any future reconnect path.

## Significant issues (worth addressing)

- **`heartbeat_ack` is invented in step 1.2, then effectively disappears.**
  - Step 1.2 defines `heartbeat_ack` as a schema variant.
  - Step 1.4's server handling lists `register` and `heartbeat`, but never says it sends `heartbeat_ack`.
  - Step 1.5's client says it sends heartbeats, but does not say it waits for or handles `heartbeat_ack`.
  - If the ack is unnecessary, delete it.
  - If it is necessary, it becomes the natural place for lease renewal metadata instead of overloading baseline `health_pong` in phase 5.

- **Phase 2 session frames are only partially specified for routing.**
  - `session_op`, `session_load_request`, and `session_load_response` are a coherent family.
  - The docs only explicitly mention a correlation id on load request/response.
  - They do not spell out whether every session frame also carries `agentRunId`, `sessionId`, and `scopeRef`.
  - That omission is survivable with one remote worker in phase 2.
  - It becomes dangerous once phase 3 allows one worker connection to host many concurrent runs.

- **`worker_ready` / `worker_init_ack` are under-specified and unvalidated.**
  - Step 2.4 adds them in `src/runtime/remote/worker-protocol.ts`.
  - Their directionality is not stated cleanly.
  - There is no validator update analogous to `validateRegistryFrame` or `frame-schema.ts`.
  - There is also no collision check against existing discriminators in registry or run-frame unions.
  - This is the first place the distributed track adds a third frame family without a common validation story.

- **Phase 2 step 2.6 adds `result.branchHeadSha` without a schema update.**
  - The step only says to extend `src/runtime/contracts.ts`.
  - The explicit TypeBox mirror from baseline phase 1 is not mentioned.
  - Because `result` is already a hot path, this is exactly the kind of drift the validation gate was meant to catch.
  - It is a small field, but it needs the same lockstep treatment as every other frame addition.

- **Phase 3 introduces transport-visible semantics without naming a concrete frame.**
  - Step 3.4 says to add `concurrentRuns` to "whatever observability frame phase 1 defined".
  - Phase 1 did not define a clearly named observability frame for this purpose.
  - The registry handshake has `capacity.maxConcurrentRuns`, and the registry heartbeat is just liveness.
  - If `concurrentRuns` belongs on heartbeats or a worker-status frame, the plan should say so and mention schema updates.
  - Leaving it unnamed will create ad hoc load reporting.

- **Existing wait/control frames are not explicitly regression-tested over the network path.**
  - Current baseline run frames include `request_help`, `help_response`, `request_approval`, `approval_decision`, `manual_input`, `claim_lock`, and `claim_decision`.
  - Phase 2's remote-harness tests only call out `run`, `abort`, `progress`, and `result`.
  - Phase 4's proposal-session review prompt covers `manual_input` for proposal flows, but not generic task help/approval/claim flows.
  - Phase 5 fences some of these worker→orch variants, which implies they matter.
  - A migration plan should explicitly prove these blocking waits survive the network transport.

- **`WorkerNetworkTransport` appears in phase 4 without being established in phases 1–2.**
  - Step 4.3 says `RemoteFeaturePhaseBackend` calls `WorkerNetworkTransport.dispatchRun`.
  - No earlier step introduces a type with that name.
  - Phase 2 instead names `RemoteSshHarness` and relies on "the phase-1 network transport".
  - This looks like seam drift rather than a settled layering.
  - Either the plan should standardize on `IpcTransport`, or it should define `WorkerNetworkTransport` before phase 4 depends on it.

- **`proposal_phase_ended` duplicates terminal semantics without an ordering contract.**
  - The proposal worker also emits a terminal `result` frame.
  - The review prompt in step 4.5 explicitly worries about `proposal_op` arriving after `proposal_phase_ended`.
  - That means ordering is already a known edge.
  - The doc should state whether `proposal_phase_ended` always precedes `result`, always follows it, or is redundant and can be derived.
  - Otherwise later fence/drop logic will be hard to reason about.

- **Directionality is missing or fuzzy for several new frames.**
  - `worker_init_ack` is not clearly directional.
  - `heartbeat_ack` is listed but not used.
  - `session_op` is effectively one-way writes plus separate request/response reads, but the doc does not say that explicitly.
  - `proposal_phase_ended` is worker→orch, but its relation to terminal `result` is unspecified.
  - Because the track relies heavily on multiplexing, these should be stated, not inferred.

- **Backwards-compatibility of baseline manual waits is hand-waved.**
  - The current codebase already depends on help/approval/manual-input flows in `src/runtime/contracts.ts` and `src/runtime/worker-pool.ts`.
  - The distributed track never has a step whose explicit goal is "prove all existing wait states work unchanged over network transport".
  - That is a migration risk, especially once feature-phase runs also join the same plane.

## Minor / nits

- **`RemoteSshHarness` is a confusing name for a WebSocket-driven control plane.**
  - SSH is the git transport in phase 2.
  - The IPC/control plane was explicitly chosen as WebSocket in phase 1.
  - The class name suggests the opposite layering.

- **The plan now has four nearby heartbeat names.**
  - `heartbeat`
  - `heartbeat_ack`
  - `health_ping`
  - `health_pong`
  - The names may be technically distinct, but they are easy to conflate in reviews and future edits.

- **`session_op` is serviceable but asymmetric.**
  - Save/checkpoint/delete are multiplexed under one frame.
  - Load is split into explicit request/response frames.
  - That is fine, but the doc should say it is intentionally one-way for writes and request/response for reads.

- **Phase 4 splits the `run`-frame change across steps 4.1 and 4.2.**
  - Step 4.1 says the schema branch changes.
  - Step 4.2 says the contracts branch changes.
  - In practice those should land together, or reviewers will chase a temporary mismatch.

- **Registry/routing terminology is slightly overloaded.**
  - `workerId` is stable identity.
  - `bootEpoch` is restart generation.
  - `ownerWorkerId` arrives in phase 3.
  - `fence` arrives in phase 5.
  - The docs are mostly clear, but a one-table glossary in the README would reduce cognitive load.

- **The README cross-phase convention says new IPC variants extend the schemas from baseline.**
  - That is good.
  - A few individual steps drift from that discipline.
  - Calling those out inline in each step would reduce implementation churn.

## Cross-phase inconsistencies

- **There are two heartbeat families, and phase 5 treats them as one.**
  - Phase 1 distributed uses registry `heartbeat` / `heartbeat_ack`.
  - Baseline safety uses `health_ping` / `health_pong` on the run transport.
  - Phase 5 extends the latter while citing the former.
  - This is the most important protocol inconsistency in the track.

- **The transport seam is described three different ways.**
  - Phase 1 D4: generic `WebSocket*Transport` implementing `IpcTransport`.
  - Phase 1 steps: `WorkerRegistryServer` / `WorkerRegistryClient` in `src/runtime/registry/*`.
  - Phase 4 step 4.3: `WorkerNetworkTransport.dispatchRun`.
  - Pick one canonical layer diagram and make every phase use the same names.

- **The plan gradually adds multiple frame families but never writes down the multiplexing model.**
  - Registry frames in phase 1.
  - Session frames and worker-bootstrap frames in phase 2.
  - Proposal frames in phase 4.
  - Lease/fence extensions in phase 5.
  - A short "wire planes" section would help: worker-scoped connection frames, run-scoped runtime frames, session RPC frames, proposal mirror frames.

- **Phase 2 assumes run↔worker identity earlier than phase 3 introduces it.**
  - Phase 2 prerequisites say `agent_runs` carries `worker_id` or equivalent.
  - Phase 3 is where `owner_worker_id` is formally introduced.
  - The docs can probably make this work, but the ownership timeline is not cleanly sequenced.

- **Schema-discipline is mostly good, but not uniformly enforced.**
  - Phase 1 step 1.2 does it for registry frames.
  - Phase 2 step 2.3 does it for session frames.
  - Phase 4 step 4.5 does it for proposal frames.
  - Phase 5 step 5.5 does it for fence-bearing run frames.
  - Step 2.4 bootstrap frames, step 2.6 `branchHeadSha`, step 3.4 `concurrentRuns`, and step 5.x `run.fence` break the pattern.

- **Routing keys are good for most run-scoped frames, but under-specified for connection-scoped ones.**
  - `agentRunId` appears on most additions.
  - `scopeRef` appears on proposal frames.
  - Registry frames are worker-scoped via `workerId`.
  - Bootstrap and session frames still need an explicit routing-key table.

- **Backwards compatibility for existing manual-wait behavior is assumed, not demonstrated.**
  - The runtime unions already support help, approval, manual input, and claim ownership.
  - The distributed track mostly focuses on happy-path dispatch and planner mirroring.
  - The migration should call out at least one integration test that exercises a human-in-the-loop wait over the remote transport.

- **Bidirectionality is not always explicit.**
  - The user-visible planner mirror needs clear worker→orch direction.
  - Session reads are request/response, but writes are one-way.
  - Bootstrap frames look like a handshake, but only one half is described well.
  - Lease renewal could be worker→orch on heartbeat or orch→worker on ping/pong; the docs currently blur them.

- **Phase 5's fence model is strong in principle but incomplete in surface area.**
  - IPC mutators are partly fenced.
  - Git push is fenced.
  - Store writes are fenced.
  - Proposal and session mutations are not yet clearly in that matrix.

## Frame inventory

Inventory below includes both brand-new discriminators and payload/field extensions that affect validation, routing, or compatibility.

Phase 3 does not add a concrete named IPC frame variant; step 3.4's `concurrentRuns` observability addition is a documentation gap and is called out above rather than listed as a concrete frame row.

| phase | step | frame name | direction | payload | validation-schema-mentioned? |
|---|---|---|---|---|---|
| 1 | 1.2 | `register` | worker→orch | `workerId`, `bootEpoch`, `protocolVersion`, `capabilities`, `capacity`, `agent` | yes |
| 1 | 1.2 | `register_ack` | orch→worker | accept/ack payload not fully spelled out | yes |
| 1 | 1.2 | `register_reject` | orch→worker | `reason: protocol_mismatch | unauthenticated | banned` | yes |
| 1 | 1.2 | `heartbeat` | worker→orch | liveness beat for registered worker; payload not fully spelled out beyond cadence | yes |
| 1 | 1.2 | `heartbeat_ack` | orch→worker | ack payload unspecified in plan | yes |
| 2 | 2.3 | `session_op` | worker→orch | save / saveCheckpoint / delete op; routing fields not fully spelled out | yes |
| 2 | 2.3 | `session_load_request` | worker→orch | load request with correlation id | yes |
| 2 | 2.3 | `session_load_response` | orch→worker | load response with correlation id and result envelope | yes |
| 2 | 2.4 | `worker_ready` | worker→orch (likely) | worker bootstrap readiness signal | no |
| 2 | 2.4 | `worker_init_ack` | unspecified in plan | bootstrap ack signal; exact sender/receiver unclear | no |
| 2 | 2.6 | `result` (extension) | worker→orch | optional `branchHeadSha` on terminal result | no |
| 4 | 4.1 / 4.2 | `run` (extension) | orch→worker | `featurePhasePayload`; `task` / `payload` optional for `scopeRef.kind === 'feature_phase'` | yes |
| 4 | 4.2 / 4.4 / 4.5 | `result` (effective extension) | worker→orch | scope-aware phase output: `text_phase` / `verification` / `ci_check` / `proposal` | no |
| 4 | 4.5 | `proposal_op` | worker→orch | `agentRunId`, `scopeRef`, `op`, `draftSnapshot` | yes |
| 4 | 4.5 | `proposal_submitted` | worker→orch | `agentRunId`, `scopeRef`, `details`, `proposal`, `submissionIndex` | yes |
| 4 | 4.5 | `proposal_phase_ended` | worker→orch | `agentRunId`, `scopeRef`, `outcome` | yes |
| 5 | 5.3 | `health_pong` (extension) | worker→orch | `leases: [{ agentRunId, fence }]` | yes |
| 5 | 5.4 / 5.5 | `run` (required but undocumented extension) | orch→worker | new `fence` on dispatch/resume so worker can renew/report current ownership | no |
| 5 | 5.5 | `result` (extension) | worker→orch | add `fence` to mutating result frames | yes |
| 5 | 5.5 | `error` (extension) | worker→orch | add `fence` | yes |
| 5 | 5.5 | `claim_lock` (extension) | worker→orch | add `fence` | yes |
| 5 | 5.5 | `request_help` (extension) | worker→orch | add `fence` | yes |
| 5 | 5.5 | `request_approval` (extension) | worker→orch | add `fence` | yes |

## Transport seam usage

### Clean / mostly clean uses of the seam

- **Phase 2 step 2.3 — `RemoteSessionStore` is conceptually clean.**
  - It treats session persistence as a small RPC layer over the transport.
  - It also explicitly mentions contract and schema updates in lockstep.

- **Phase 2 step 2.5 — `MultiHarnessPool` preserves `RuntimePort`.**
  - Dispatch remains scope-aware and transport selection stays behind the runtime port.
  - This is the right abstraction boundary.

- **Phase 4 step 4.2 — feature-phase runtime reuses the existing `run` plane.**
  - Routing by `scopeRef.kind` is exactly what the current `RunScope` abstraction wants.
  - The only caveat is the unresolved `result`-frame shape.

- **Phase 4 step 4.5 — proposal events use transport send/receive instead of bespoke side channels.**
  - `proposal_op` / `proposal_submitted` / `proposal_phase_ended` ride the same worker connection.
  - That keeps the mirror path coherent with the rest of remote execution.

- **Phase 5 step 5.5 — fence enforcement aims to span transport, store, and git.**
  - The three-layer defense is the right idea.
  - It just needs to cover every mutating frame family, not only the original run frames.

### Bypass / drift / unclear seam usage

- **Phase 1 D4 vs steps 1.4-1.5 drift away from `src/runtime/ipc/`.**
  - The design promises `WebSocket*Transport` implementing `IpcTransport`.
  - The steps instead build registry-specific socket handling in `src/runtime/registry/*`.

- **Phase 1 step 1.4 validates registry frames outside the baseline gate.**
  - That is acceptable for a separate plane.
  - But it means the repo now has at least two validators and two transport stacks.
  - The plan should say that explicitly.

- **Phase 1 step 1.4 drops run frames rather than handing them to a generic transport/router.**
  - Fine for phase 1.
  - But it shows there is not yet a reusable worker-socket abstraction for later phases to plug into.

- **Phase 2 step 2.4 adds a third mini-protocol beside registry and runtime frames.**
  - `worker_ready` / `worker_init_ack` live in `src/runtime/remote/worker-protocol.ts`.
  - No common envelope or router is described.

- **Phase 4 step 4.3 references `WorkerNetworkTransport.dispatchRun` without provenance.**
  - That suggests another wrapper may appear beside `IpcTransport` and `WorkerRegistryClient`.
  - If so, the doc should define it once and reuse the same name everywhere.

- **Phase 5 step 5.3 appears to bypass the distributed seam and reuse the local child heartbeat.**
  - The file references point at `src/runtime/harness/index.ts` and `src/runtime/worker/index.ts`.
  - Those are the stdio child-process path today.
  - In the distributed design, lease renewal should hang off the worker-registry/network channel instead.

- **No step explicitly instructs later code to avoid raw `WebSocket.send`, but the plan is trending toward bespoke socket helpers.**
  - I did not find a direct instruction like "inline `ws.send` from the backend".
  - The problem is architectural drift, not an explicit raw-send call.

- **`src/runtime/ipc/index.ts` remains a single-child stdio seam in the current codebase.**
  - The plan should say whether distributed transports will live alongside it in `src/runtime/ipc/`.
  - Right now the docs scatter transport logic across `ipc/`, `registry/`, and `remote/`.

- **The registry server/client pair is clean for phase 1 visibility, but not obviously reusable for phase 2 dispatch.**
  - That is where the docs most need a concrete handoff paragraph.
  - Without it, implementers will likely create a second network socket path for actual runs.

## What the plan gets right

- **Phase 1 correctly keeps registry frames separate from run frames.**
  - That protects `RuntimePort` from growing worker-registry concerns.
  - The explicit discriminator-collision review prompt is good.

- **The plan consistently keeps orchestrator-assigned run identity.**
  - `agentRunId` and `sessionId` remain authoritative on the orchestrator.
  - That is the right foundation for routing and takeover.

- **Most new run-scoped frames carry the right routing keys.**
  - `proposal_*` frames include both `agentRunId` and `scopeRef`.
  - That is a strong pattern and should be copied to session/bootstrap frames.

- **Phase 2's `branchHeadSha` idea is good.**
  - Verifying the fetched ref against worker-reported SHA is exactly the right protection against stale or unexpected branch state.
  - It just needs the schema mirror.

- **Phase 4's prompt-digest move is transport-friendly.**
  - The worker gets plain JSON context instead of reaching back into orchestrator state.
  - That reduces hidden dependencies in the feature-phase wire path.

- **Phase 4's worker-side proposal host is the right latency trade-off.**
  - Tool calls stay local to the worker.
  - Only proposal ops/checkpoints cross the wire.
  - That is much better than per-tool-call round trips.

- **Phase 4 explicitly preserves the TUI mirror callback shape.**
  - `UiPort.onProposalOp` stays stable.
  - That is a good compatibility target while the transport beneath it changes.

- **Phase 5's fence model is directionally strong.**
  - IPC drop rules, store `expectedFence`, and bare-repo hook fencing complement each other well.
  - Once the missing frame families are included, this becomes a robust stale-worker defense.

- **The docs repeatedly call out lockstep schema updates.**
  - Even where a few steps miss it, the intended discipline is clear.
  - That makes the remaining gaps easy to fix before implementation starts.

- **The track already separates worker-scoped and run-scoped concerns conceptually.**
  - Worker identity lives in phase 1 registry.
  - Run identity stays in runtime contracts.
  - That separation should make the final protocol easier to reason about once the frame families are normalized.

- **The plan is aware of ordering/race hazards in the proposal mirror.**
  - The step 4.5 review prompt already asks about `proposal_op` arriving after `proposal_phase_ended`.
  - That is the right instinct; the next move is to encode the ordering contract in the plan itself.

- **The README's architectural non-negotiable about transport-agnostic ports is the right north star.**
  - The implementation docs occasionally drift from it.
  - But the stated principle is solid and worth tightening the steps around.
