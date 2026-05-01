# Phase 4 — Remote feature-phase agents

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-0-migration-consolidation (migration numbering pinned for any schema work landed here), phase-1-protocol-and-registry (worker registry, capability advertisement, fence-field convention), phase-2-remote-task-execution (network IPC transport, bare-repo sync, `RemoteSessionStore` seam, faux remote-worker harness), phase-3-multi-worker-scheduling (capacity-aware picker, `WorkerCapacityView`, capability filter that this phase extends with `verification`)
- Default verify: npm run check:fix && npm run check
- Phase exit: npm run verify; boot a real remote worker; submit a fresh project; observe bootstrap-plan, discuss, research, plan, verify, and ci_check all execute on the worker with the orchestrator instantiating zero pi-sdk `Agent` instances; confirm the TUI live-planner mirror renders proposal ops in real time as they stream from the worker.
- Doc-sweep deferred: docs/architecture/worker-model.md (where-do-agents-run section flips at step 4.7), docs/architecture/planner.md (line 16 host-location note), docs/operations/recovery.md (disconnect-handling gap until phase-5-leases-and-recovery lands)

Ships as 12 commits, in order, plus an optional smoke (4.10). Steps 4.6 and 4.7 each split into substeps that share their X.Y prefix: 4.6.a / 4.6.b / 4.6.c stage the planner-scope flag flips; 4.7.a is the `verifyFeature` retarget that lands between 4.7's flag flip and 4.8's deletion. Each commit stands on its own and the suite stays green between commits. The first three steps are infra (no functional change). Steps 4.4–4.7 migrate one scope at a time behind a per-scope flag. Step 4.9 enforces the non-negotiable.

## Contract

- Goal: move every remaining pi-sdk `Agent` invocation off the orchestrator (planner, replanner, verifier, summarizer, researcher, discusser, and the bootstrap planner that creates a feature graph from a fresh project), so that after this phase the orchestrator process hosts zero agent loops and makes zero model calls — purely a scheduler / state machine / git-coordination service — while verification shell commands execute on the worker VM against the worker's worktree and return JSON-shaped results over the same network plane that delivers task results.
- Scope:
  - In:
    - `FeaturePhaseRunPayload` extension carrying every input the worker needs to render its own prompt (`featureSnapshot`, `tasks`, `eventDigest: FeaturePhasePromptDigest`, `replanReason`).
    - Worker-side `FeaturePhaseWorkerRuntime` peer to `WorkerRuntime`, dispatching by `scopeRef.kind === 'feature_phase'`.
    - `RemoteFeaturePhaseBackend implements FeaturePhaseBackend` for `discuss` / `research` / `summarize` text phases, behind per-scope flag map `config.distributed.remoteFeaturePhases.*`.
    - Remote `verify` and `ci_check` execution including the `verification` worker capability advertisement chain (worker → registry → picker filter compounding with phase-3-multi-worker-scheduling step 3.3 capability filter).
    - Worker-side `GraphProposalToolHost` with live-mirror IPC: new `proposal_op`, `proposal_submitted`, `proposal_phase_ended` `WorkerToOrchestratorMessage` variants, each carrying `seq` (per `agentRunId`) and `fence` (declared at frame introduction per the cross-cutting fence-token concern; phase-5-leases-and-recovery step 5.5 flips enforcement on).
    - Staged migration of `replan` → `plan` → bootstrap planner with per-scope flags flipped to `true` one commit at a time.
    - Retirement of `FeaturePhaseOrchestrator` (`src/agents/runtime.ts:177`), `DiscussFeaturePhaseBackend` (`src/runtime/harness/feature-phase/index.ts:75`), and the local body of `VerificationService.verifyFeature` (`src/orchestrator/services/verification-service.ts:25`).
    - ESLint rule with inverted-scope allowlist + runtime startup assertion in `compose.ts` enforcing zero in-orchestrator-process `Agent` construction; `GVC_FORCE_REMOTE_AGENTS` env override (default on; `=0` for dev-only opt-out).
    - Optional end-to-end integration smoke driving bootstrap-plan → discuss → research → plan → execute → verify → integrate against a faux remote worker.
  - Out:
    - Lease-based recovery for feature-phase runs; orphan recovery still uses pid/proc liveness for feature-phase runs after this phase (phase-5-leases-and-recovery).
    - Disconnect handling for in-flight planner runs — today's behaviour is "the run hangs until orchestrator restart" (phase-5-leases-and-recovery lease takeover).
    - Heartbeat-driven `health_timeout` semantic disambiguation (worker network failure vs worker process failure) (phase-5-leases-and-recovery).
    - Feature-phase observability beyond the existing `agent_runs` row + proposal-op stream (no owner phase in this track).
    - Per-phase resource caps on worker side (no owner phase in this track).
    - `squid-track` / `claude-code` harness kind (separate track).
- Exit criteria:
  - All commits land in order (4.1, 4.2, 4.3, 4.4, 4.5, 4.6.a, 4.6.b, 4.6.c, 4.7, 4.7.a, 4.8, 4.9; 4.10 smoke is optional).
  - `npm run verify` passes on the final commit with default config (no flag overrides).
  - Orchestrator process instantiates zero pi-sdk `Agent` instances end-to-end (audit-guard test at-rest; optional smoke in motion).
  - `grep -RIn 'new Agent(' src/orchestrator src/agents/runtime.ts` returns zero hits after step 4.8.
  - TUI live-planner mirror renders proposal ops in real time (manual sanity check; tests cover programmatic ordering).
  - Final review across 4.1–4.9 confirms no path silently falls back to in-process.

## Plan

- Background: other phases in this track left one durable in-process agent surface — `FeaturePhaseOrchestrator` (`src/agents/runtime.ts:177`), instantiated in `src/compose.ts:189-209` and dispatched via `DiscussFeaturePhaseBackend` (`src/runtime/harness/feature-phase/index.ts:75`). `LocalWorkerPool.dispatchRun` already routes by scope, so the seam is in place — only the backend implementation needs to change. This phase is the seam where the proposal graph + approval flow traverse the network without losing live-mirror semantics, and where verification's authoritative JSON arrives from a remote machine. Confirmed call sites for `VerificationService.verifyFeature` today: `src/orchestrator/integration/index.ts:128-129` (`IntegrationCoordinator` direct caller during the merge train), and the `ci_check` feature-phase backend at `src/runtime/harness/feature-phase/index.ts:204-210` (in-process `DiscussFeaturePhaseBackend`). The TUI manual flow at `src/tui/proposal-controller.ts:268` already dispatches bootstrap planning through the same `dispatchRun({ scope: { kind: 'feature_phase', featureId, phase: 'plan' } })` plane as every other planner run, so aligning the bootstrap path is code-path consolidation rather than new design. Existing prompt rendering lives at `src/agents/runtime.ts:394-447` (`renderPrompt`); existing run-frame shape at `src/runtime/contracts.ts:339-350`; existing `FeaturePhaseRunPayload` at `src/runtime/contracts.ts:18-21`; existing `PhaseOutput` discriminator with `verification` and `ci_check` variants at `src/runtime/contracts.ts:64-65`; existing proposal-op sink wiring at `src/compose.ts:180-190`; existing `ProposalPhaseSessionImpl` at `src/agents/runtime.ts:113-175`; existing worker-pool live-session entry handling at `src/runtime/worker-pool.ts:617`; existing live-handle helper at `src/runtime/harness/feature-phase/index.ts:304`. Decisions settled in this phase, with rationale:
  - **Top-level planner bootstrap.** Dispatched through the same `feature_phase` plane as every other planner run; orchestrator-assigned `agent_run_id`; no "bootstrap worker" role. A special role doubles surface area, and the bootstrap planner is the same pi-sdk agent with the same toolset; only the feature row already exists (the scheduler creates the placeholder feature when the user kicks off a project, then dispatches `plan` against it).
  - **Proposal-host network seam.** `GraphProposalToolHost` lives **on the worker**, alongside the planner agent that drives it. Each tool call mutates the worker's `InMemoryFeatureGraph` draft synchronously, with no network round-trip per call. The host's `subscribe(...)` listener becomes a worker-side adapter that converts each `op_recorded` and `submitted` event into new `WorkerToOrchestratorMessage` variants; the orchestrator side replays them into the existing `proposalOpSink` and into `agent_runs.payload_json` on submit. Justification: planner/replanner can issue dozens of tool calls per turn; a per-call round-trip ties planner latency to network latency and shifts every cycle of the agent loop into the orchestrator's serialization path, which is precisely the seam this track is trying to remove. Reusing the existing `subscribe + checkpoint-style submit` shape from baseline (`bd2fb83`) keeps the wire protocol thin: stream ops as they happen, persist on submit. Authoritative graph mutation still happens orchestrator-side after operator approval — the worker only ships the `GraphProposal` object, never directly mutates the orchestrator's `FeatureGraph`.
  - **Verification on remote.** Shell-command runner moves to the worker. A new `verification` worker capability advertises which command set the worker can run. The orchestrator continues to own the `VerificationLayerConfig` and ships it inside the feature-phase payload; the worker executes commands against its locally-cloned worktree (already the wire model from phase-2-remote-task-execution's bare-repo sync) and sends back a `VerificationSummary` JSON value via `WorkerToOrchestratorMessage.result` with `output.kind: 'verification' | 'ci_check'`. Stdout/stderr are truncated and bundled into `VerificationSummary.summary` exactly as the local runner does today (`src/orchestrator/services/verification-shell.ts`). The orchestrator does not stream raw stdout — keeping the wire shape JSON-shaped preserves the property the merge queue relies on (`feature_verification_contract`).
  - **TUI live-planner mirror.** `UiPort.onProposalOp` keeps its current signature. The wire path is `worker → orchestrator → ui.onProposalOp`. The orchestrator-side adapter (introduced in step 4.5) translates incoming `proposal_op` / `proposal_submitted` IPC frames into the existing sink calls. TUI code does not change; it sees the same callbacks at the same scope granularity, only sourced from the network.
  - **Feature-phase scope routing.** `RunScope.feature_phase` already carries `featureId` and `phase`. Extend `FeaturePhaseRunPayload` with the planner-baked context fields the worker now needs to assemble its own prompt (feature snapshot, summary context, replan reason already there). Routing decisions stay where they are: phase-3-multi-worker-scheduling's capacity scheduler picks the worker; this phase only changes which payload shape it ships.
  - **Migration ordering.** Read-only scopes lift first (discuss / research / summarize). Verification next (owns the merge-queue JSON contract). Replanner before planner (planner has the bootstrap seam). Top-level planner last. Each step is one feature-flagged scope so we can revert one at a time.
- Notes:
  - Audit & enforcement details land in step 4.9. Wire-frame schemas land in steps 4.1 and 4.5; the terminal `result` frame is unchanged in shape (only its source moves) and `VerificationSummary` round-trips through the existing discriminated payload.
  - `proposal_op` and `proposal_submitted` carry `seq: number`, a monotonically-increasing sequence id scoped to `(agentRunId)`. The orchestrator-side adapter records last-seen `seq`; on a worker reconnect mid-stream (per the `reconnect` frame from phase-1-protocol-and-registry), the orchestrator can ask the worker to replay from the last-seen `seq` to avoid lost ops without rerunning the planner from scratch. (`proposal_phase_ended` is one-shot terminal and does not need `seq`.)
  - Open: alternative for step 4.2 schema change is a second `run_feature_phase` frame variant rather than making `task` / `payload` optional on the existing `run` frame. Doc assumes the smaller schema change (optional fields keyed on `scopeRef.kind`); revisit at IPC-schema review time if discriminator clarity wins.
  - Watch: `ProposalPhaseSessionImpl` (`src/agents/runtime.ts:113`) stays as the session-handle abstraction across the cutover. `bindAgent` becomes `bindRemoteRun`, wrapping `SessionHandle` instead of an in-process `Agent`. Pre-bind queueing semantics at `src/agents/runtime.ts:121-175` must survive the wrapper change; step 4.8 review goal #3 is the gate.
  - Watch: gaps left for phase-5-leases-and-recovery — recovery still uses pid/proc liveness for feature-phase runs (phase-1-protocol-and-registry heartbeat covers liveness while running, but the orphan-recovery path on orchestrator restart still grep's `/proc/<pid>/environ`); leave a `// TODO(phase-5-leases-and-recovery)` marker in `RecoveryService` (`src/orchestrator/services/recovery-service.ts`) at every site where the pid check still applies to feature-phase runs. Disconnect handling: if a worker disconnects mid-planner-run, today's behaviour is "the run hangs until orchestrator restart"; heartbeat-driven `health_timeout` from phase-1-protocol-and-registry classifies the run as `retry_await`, which is not quite right semantically (the worker hasn't necessarily failed, only its network has) — phase-5-leases-and-recovery disambiguates.

## Steps

### 4.1 Feature-phase run payload + worker-side context [risk: med, size: M]

What: extend `FeaturePhaseRunPayload` to carry every input the worker needs to render its own prompt, so the worker no longer has to reach back into the orchestrator's `FeatureGraph` and event store. This is the prerequisite for any remote feature-phase agent: the worker must be self-sufficient between dispatch and submit. Pure additive — nothing dispatches with the new fields yet.

Files:
  - `src/runtime/contracts.ts` — extend `FeaturePhaseRunPayload` (currently `src/runtime/contracts.ts:18-21`) with `featureSnapshot: Feature`, `tasks: Task[]`, `eventDigest: FeaturePhasePromptDigest`, optional `replanReason: string` (existing). Define `FeaturePhasePromptDigest` mirroring the fields rendered today in `runtime.ts:renderPrompt` (discussion summary, research summary, plan summary, success criteria, constraints, etc.).
  - `src/agents/runtime.ts` — extract the body of `renderPrompt` (`src/agents/runtime.ts:394-447`) into a standalone `buildFeaturePhasePromptDigest(feature, run, store, graph, phase, reason?)` helper exported from a new file `src/agents/context/digest.ts`. Keep `renderPrompt` a thin wrapper for the in-process path that still exists during migration.
  - `src/agents/context/digest.ts` — new module re-exporting the helper plus `FeaturePhasePromptDigest` type used by both runtime.ts and the worker.
  - `src/runtime/ipc/frame-schema.ts` — extend the run-frame schema branch to allow the new payload shape (TypeBox additions; mirrors `src/runtime/contracts.ts`).

Tests:
  - `test/unit/agents/context/digest.test.ts` — assert the digest captures every field the existing `renderPrompt` consumes for each phase (discuss/research/plan/verify/summarize/replan). Use the same fixture style as `test/unit/agents/runtime.test.ts`.

Review goals (cap 250 words):
  1. Every prompt-template variable in `src/agents/prompts/*.ts` is sourced from the digest.
  2. The digest is plain-data JSON-serializable.
  3. `renderPrompt` produces byte-identical output before/after.
  4. Flag any field still read from `this.deps.store` or `this.deps.graph` inside the helper.

Commit: refactor(agents/runtime): extract feature-phase prompt digest

### 4.2 Worker-side feature-phase runtime skeleton [risk: med, size: M]

What: add a `FeaturePhaseWorkerRuntime` peer to `WorkerRuntime` (`src/runtime/worker/index.ts:61`) on the worker side. Same shape — accepts the IPC transport, owns one pi-sdk `Agent`, runs to completion — but takes a `FeaturePhaseRunPayload` instead of a `TaskRunPayload`. This step lands the class with **only the text-phase code path wired** (`discuss` / `research` / `summarize`), leaves proposal and verify code paths as `throw new Error('not yet wired')`, and is not yet reachable through dispatch (no `compose.ts` change). Pure additive scaffolding so the diff in step 4.3 is small.

Files:
  - `src/runtime/worker/feature-phase-runtime.ts` — new. `class FeaturePhaseWorkerRuntime` with `run(scope: FeaturePhaseScope, payload: FeaturePhaseRunPayload, dispatch: RuntimeDispatch): Promise<void>`. Implementation: build prompt from `payload.eventDigest`, instantiate `FeaturePhaseToolHost` (text-phase tools only — reuse `buildFeaturePhaseAgentToolset` from `src/agents/tools/agent-toolset.ts`), construct pi-sdk `Agent`, run, send terminal `result` frame with `output.kind: 'text_phase'`. Persist messages via `SessionStore.saveCheckpoint` exactly as `WorkerRuntime` does (`src/runtime/worker/index.ts:169-174`).
  - `src/runtime/worker/entry.ts` — register the new runtime alongside the existing task runtime; dispatch by inspecting incoming `run` frame's `scopeRef` (`src/runtime/contracts.ts:339-350`). When `scopeRef.kind === 'feature_phase'`, route to the feature-phase runtime; otherwise to the task runtime. Existing task path unchanged.
  - `src/runtime/contracts.ts` — extend the `run` frame variant so feature-phase dispatches can carry the feature-phase payload. Today the `run` frame has `task: Task` and `payload: TaskPayload` (lines 341-350); add an optional `featurePhasePayload: FeaturePhaseRunPayload` and make `task`/`payload` optional when `scopeRef.kind === 'feature_phase'`. (Alternative: add a second `run_feature_phase` frame variant. Pick whichever the IPC schema review prefers; the doc assumes the first since it's a smaller schema change.)
  - `src/runtime/ipc/frame-schema.ts` — mirror the schema change.

Tests:
  - `test/unit/runtime/worker/feature-phase-runtime.test.ts` — happy path for `discuss` end-to-end with a faux pi-sdk agent (use the same scripted `FauxResponse` pattern as task tests under `test/integration/harness/`). Assert the worker emits a `result` frame with `output.kind: 'text_phase'` and `phase: 'discuss'`.
  - `test/unit/runtime/ipc-frame-schema.test.ts` — extend with the new run-frame shape (already added by step 4.1's schema work; this step proves it parses).

Review goals (cap 250 words):
  1. The worker-side feature-phase runtime builds prompts from `payload.eventDigest` only — never reaches into orchestrator state.
  2. It terminates the agent on every code path, including thrown errors and aborts (`src/runtime/worker/index.ts:175-201` is the reference pattern).
  3. Flag any path that swallows an error without sending a terminal frame.

Commit: feat(runtime/worker): feature-phase runtime skeleton (text phases)

### 4.3 Remote feature-phase backend (text phases) [risk: high, size: L]

What: introduce `RemoteFeaturePhaseBackend implements FeaturePhaseBackend` that dispatches feature-phase scopes through the same network transport phase-2-remote-task-execution introduced for tasks, instead of through `FeaturePhaseOrchestrator`. Behind a per-scope feature flag (`config.distributed.remoteFeaturePhases.discuss/research/summarize/...`), default off. Wires `discuss`, `research`, `summarize` only — proposal and verify still go through the in-process backend.

Files:
  - `src/runtime/harness/feature-phase/remote-backend.ts` — new. `class RemoteFeaturePhaseBackend implements FeaturePhaseBackend`. `start(scope, payload, agentRunId)` builds a `FeaturePhaseRunPayload` from the orchestrator's view of the feature (using the digest helper from step 4.1), calls `WorkerNetworkTransport.dispatchRun` with `scopeRef: scope`, and returns a `FeaturePhaseSessionHandle` whose `awaitOutcome()` resolves when the worker sends the terminal `result` frame. Reuse `createFeaturePhaseHandle` (`src/runtime/harness/feature-phase/index.ts:304`) — only the source of `outcome` changes.
  - `src/runtime/harness/feature-phase/index.ts` — export a small dispatcher that consults `config.distributed.remoteFeaturePhases.<phase>` and routes to either `RemoteFeaturePhaseBackend` or the existing `DiscussFeaturePhaseBackend`.
  - `src/compose.ts` — instantiate `RemoteFeaturePhaseBackend` with the registry/transport from phase-1-protocol-and-registry / phase-2-remote-task-execution and the per-phase flag map from config; pass the dispatcher to `LocalWorkerPool` (`src/compose.ts:203`) instead of the bare `DiscussFeaturePhaseBackend`. (`LocalWorkerPool` keeps its existing `featurePhaseBackend?` slot — no signature change.)
  - `src/config.ts` — add `distributed.remoteFeaturePhases: { discuss?: boolean; research?: boolean; summarize?: boolean; verify?: boolean; replan?: boolean; plan?: boolean }`. All default `false`.

Tests:
  - `test/integration/distributed/remote-feature-phase-text.test.ts` — wire a faux remote worker (the harness from phase-2-remote-task-execution) and dispatch a `discuss` run. Assert (a) the orchestrator emits one outbound `run` frame with `scopeRef.kind === 'feature_phase'` and the payload's digest is populated; (b) the `result` frame's `output.kind === 'text_phase'`; (c) `agent_runs.payload_json` is updated identically to the in-process path.
  - Update `test/unit/runtime/worker-pool-feature-phase-live.test.ts` to add a flag-on case asserting the dispatcher selects the remote backend.

Review goals (cap 250 words):
  1. `agent_runs.payload_json` is written orchestrator-side after the worker submits — worker is not authoritative for orchestrator state.
  2. Error frames from the worker translate to a `kind: 'error'` outcome on the existing handle plumbing without bypassing `onTaskComplete`.
  3. The digest is built once per dispatch, not on every retry.
  4. Flag any silent fallback that hides a missing remote worker.

Commit: feat(runtime): remote feature-phase backend for text phases

Rollback: revert lands the code, but `config.distributed.remoteFeaturePhases.*` defaults stay `false` even after revert (no production deployments at flag-on for these phases yet); no operator action needed beyond the revert itself.

### 4.4 Remote verification [risk: high, size: L]

What: lift `VerificationService.verifyFeature` (`src/orchestrator/services/verification-service.ts:25`) onto the worker for both the LLM `verify` phase and the headless `ci_check` phase. The worker holds the worktree (already the wire model from phase-2-remote-task-execution), so it runs the shell commands locally; the orchestrator ships `VerificationLayerConfig` in the payload and consumes the JSON result. Behind `config.distributed.remoteFeaturePhases.verify` (gates LLM verify) and a separate `config.distributed.remoteCiCheck` (gates ci_check, which has no LLM).

Files:
  - `src/orchestrator/ports/worker-registry.ts` — extend `WorkerCapabilities` with the optional `verification?: { commandSets: readonly string[] }` field reserved by phase-1-protocol-and-registry step 1.1. Workers that can run a given command set (e.g., `'ci_check'`, `'verify'`) advertise it; workers without the toolchain leave it absent.
  - `src/runtime/registry/frames.ts` — extend the `register` frame's TypeBox capability schema with the same field; add a unit-test assertion that a worker missing `verification` is rejected from `verify` / `ci_check` dispatch by the phase-3-multi-worker-scheduling picker (the picker filter compounds: `verification` capability advertised AND command set is in the advertised list).
  - `src/runtime/worker/index.ts` — when the worker boots, populate `capabilities.verification.commandSets` from its own `VerificationLayerConfig` (which command sets it has commands for).
  - `src/orchestrator/scheduler/dispatch.ts` — extend the picker filter from phase-3-multi-worker-scheduling step 3.3 with: when `scope.kind === 'feature_phase'` and the dispatch is `verify` or `ci_check`, require `capabilities.verification?.commandSets.includes(commandSetName)`.
  - `src/runtime/contracts.ts` — extend `FeaturePhaseRunPayload` with `verification?: { layerConfig: VerificationLayerConfig }`. Extend `PhaseOutput` discriminator so the existing `verification` and `ci_check` variants (`src/runtime/contracts.ts:64-65`) survive unchanged — only their producer changes.
  - `src/runtime/worker/feature-phase-runtime.ts` — add the verify code path: instantiate the LLM `Agent` exactly like the text phases, plus build a `WorkerVerificationRunner` (new tiny class wrapping `runShell` from `src/orchestrator/services/verification-shell.ts`) that the verify toolset calls to actually execute checks on the worker's worktree. For `ci_check` (no LLM), the runtime skips the agent entirely and just runs the shell commands, posting back a `result` frame with `output.kind: 'ci_check'`.
  - `src/runtime/worker/verification-runner.ts` — new. Re-export `runShell`, `formatVerificationResult`, `truncateSummary` from `src/orchestrator/services/verification-shell.ts` for worker-side use.
  - `src/orchestrator/services/verification-service.ts` — gate the `verifyFeature` body on the same flag: when remote verification is enabled, throw if called (the `ci_check` feature-phase backend should be the only path that ever invokes it on the orchestrator side, and that path is now also remote). Add a doc comment stating this is a transitional shim — step 4.9 of this phase deletes the body via step 4.8.
  - `src/runtime/harness/feature-phase/remote-backend.ts` — extend to handle `verify` and `ci_check`. For `ci_check`, no LLM agent on the worker, but the dispatch shape stays uniform.

Tests:
  - `test/integration/distributed/remote-verification.test.ts` — drive a `ci_check` feature-phase scope through the faux remote worker; assert (a) the worker received the `VerificationLayerConfig`; (b) the resulting `VerificationSummary` round-trips intact; (c) `IntegrationCoordinator` still gates on the JSON `ok: false` result identically (`src/orchestrator/integration/index.ts` consumes `VerificationSummary`).
  - `test/unit/runtime/worker/verification-runner.test.ts` — round-trip a faux command set; assert truncation behaviour matches `verification-shell.ts`.

Review goals (cap 300 words):
  1. `VerificationLayerConfig` ships in the payload — not pulled from worker-local config.
  2. `VerificationSummary` JSON shape is byte-identical between local and remote producers (merge-queue contract from `feature_verification_contract`).
  3. On remote-`ci_check`, no LLM agent is constructed.
  4. Shell-command stdout truncation matches `truncateSummary` exactly.
  5. Flag any orchestrator-side fallback that silently runs the local runner.

Commit: feat(verification): execute verify and ci_check on remote workers

### 4.5 Worker-side proposal host + live-mirror IPC [risk: high, size: L]

What: lift `GraphProposalToolHost` onto the worker for planner/replanner runs. The host's `subscribe` listener on the worker side translates each `op_recorded` and `submitted` event into new IPC frames `proposal_op` and `proposal_submitted`. The orchestrator side replays them into `proposalOpSink` (i.e. `UiPort.onProposalOp`) and into `agent_runs.payload_json` on submit. This is the single highest-stakes step of the phase. It is still gated behind the `replan` and `plan` flags from step 4.3's flag map; no scope flips on yet.

Files:
  - `src/runtime/contracts.ts` — add `WorkerToOrchestratorMessage` variants. Each carries `fence: number` per the cross-cutting "Fence tokens" decision: phase-5-leases-and-recovery step 5.5 enforces, this step declares the field at frame introduction so phase-5-leases-and-recovery only flips enforcement on. Pre-phase-5 the orchestrator-side adapter accepts any fence (workers stamp `0`); after phase-5-leases-and-recovery, mismatched fences are dropped.

    `proposal_op` and `proposal_submitted` additionally carry `seq: number`, a monotonically-increasing sequence id scoped to the `(agentRunId)` pair. The orchestrator-side adapter records last-seen `seq`; on a worker reconnect mid-stream (per phase-1-protocol-and-registry `reconnect` frame), the orchestrator can ask the worker to replay from the last-seen `seq` to avoid lost ops without rerunning the planner from scratch. (`proposal_phase_ended` is a one-shot terminal frame and does not need `seq`.)
    - `{ type: 'proposal_op'; agentRunId; scopeRef; op: GraphProposalOp; draftSnapshot: GraphSnapshot; seq: number; fence: number }`
    - `{ type: 'proposal_submitted'; agentRunId; scopeRef; details: ProposalPhaseDetails; proposal: GraphProposal; submissionIndex: number; seq: number; fence: number }`
    - `{ type: 'proposal_phase_ended'; agentRunId; scopeRef; outcome: 'completed' | 'failed'; fence: number }`
  - `src/runtime/ipc/frame-schema.ts` — mirror.
  - `src/runtime/worker/feature-phase-runtime.ts` — wire the proposal-host code path. Build host with `createProposalToolHost(...)`, attach a subscriber that emits the three new frame variants over `transport.send`, then run the planner/replanner agent. On agent settle, call `host.buildProposal()` / `host.getProposalDetails()` and bundle into the existing `result` frame with `output.kind: 'proposal'` (which the orchestrator already consumes from `DispatchRunResult.kind: 'awaiting_approval'`, `src/runtime/contracts.ts:117`).
  - `src/runtime/harness/feature-phase/remote-backend.ts` — register a worker-message handler that translates the three new frames into calls on the existing `proposalOpSink` (today wired in `compose.ts:180-190`). The signal sink is passed to the backend at construction so it stays the same callback chain that `UiPort.onProposalOp` is already wired to.
  - `src/agents/runtime.ts` — leave the in-process planner/replanner code path intact for now; this step only adds the remote alternative. The two paths must produce structurally-equivalent `proposalOpSink` event streams.
  - `src/runtime/worker-pool.ts` — extend `registerWorkerHandler` (`src/runtime/worker-pool.ts:617`) to dispatch proposal frames. They are not terminal frames — must not delete the live session entry. Existing `result`/`error` paths are unchanged.

Tests:
  - `test/integration/distributed/remote-planner-mirror.test.ts` — drive a planner run through the faux remote worker; the worker's faux model issues `addFeature`, `addTask`, `addDependency`, `submit`. Assert that `UiPort.onProposalOp` is called once per op with `draftSnapshot` matching the worker's draft state at that point, and `UiPort.onProposalSubmitted` is called once with the proposal payload that matches `host.buildProposal()` on the worker. The streams must be ordered (subscribe semantics from `bd2fb83`) — assert ordering.
  - `test/unit/runtime/ipc-frame-schema.test.ts` — extend with the three new variants.
  - `test/unit/runtime/worker-pool.test.ts` — assert proposal frames don't terminate the live session.

Review goals (cap 350 words):
  1. The worker's `GraphProposalToolHost` is the only one constructed for the run (no orchestrator-side double-mirror).
  2. Every `op_recorded` becomes exactly one `proposal_op` frame, in order.
  3. `ProposalPhaseSessionImpl` semantics (sendUserMessage / abort / awaitOutcome from `src/agents/runtime.ts:113-175`) survive the network seam.
  4. Flag any path where a worker `proposal_op` could arrive after `proposal_phase_ended`.

Commit: feat(runtime): worker-side proposal host with live-mirror IPC

### 4.6 Migrate replan, then plan, then bootstrap planner [risk: high, size: L]

What: flip the per-scope flags one at a time, in order: `replan` → `plan` → bootstrap. Three commits — wire path landed in step 4.5; each is a config flip + one test so a regression isolates to one scope. Bootstrap is the same code path as `plan` but with empty prior-event digest; confirm digest is usable and add the bootstrap fixture if not covered.

Files:
  - `src/config.ts` — flip `distributed.remoteFeaturePhases.replan` default to `true` (commit 4.6.a), then `plan` (commit 4.6.b), then add a `distributed.remoteBootstrapPlanner` flag and flip it on (commit 4.6.c). The bootstrap flag is separate so we can roll it back without disabling regular `plan` runs.

Tests:
  - `test/integration/distributed/remote-replanner.test.ts` (commit 4.6.a) — drive a replan with a non-trivial feature graph; assert `proposalOpSink` events match an in-process baseline.
  - `test/integration/distributed/remote-planner.test.ts` (commit 4.6.b) — drive a plan from an existing feature with prior discuss/research events; same assertion.
  - `test/integration/distributed/remote-bootstrap-planner.test.ts` (commit 4.6.c) — empty graph, bootstrap user request, assert the resulting feature graph round-trips through approval and matches the worker-side `host.buildProposal()`.

Review goals (cap 350 words; run once after all three commits land):
  1. All three planner scopes (`replan`, `plan`, bootstrap-`plan`) succeed end-to-end with no orchestrator-side `new Agent(` hits.
  2. Approve / reject / rerun flows from `src/tui/proposal-controller.ts:307-339` still drive the same state transitions (the TUI's local `GraphProposalToolHost` for manual draft authoring stays local).
  3. `agent_runs.payload_json` after submit contains the same `GraphProposal` shape regardless of source.
  4. Abort-before-first-op terminates the worker via `LocalWorkerPool.abortRun` and produces `proposal_phase_ended` with `outcome: 'failed'`.

Commit subjects (in order):
  - 4.6.a: feat(distributed): default replanner to remote
  - 4.6.b: feat(distributed): default planner to remote
  - 4.6.c: feat(distributed): default bootstrap planner to remote

Rollback: each sub-commit is one config-flag default flip; reverting the sub-commit returns the default to `false` and disables the remote path for that scope. Operators who explicitly set `distributed.remoteFeaturePhases.<phase>: true` in their config retain the behaviour through revert; operators relying on the default must also redeploy the reverted build.

Migration ordering: 4.6.a → 4.6.b → 4.6.c is required. Bootstrap planner shares the `plan` wire path; if bootstrap (4.6.c) flips before `plan` (4.6.b), an empty-graph bootstrap dispatch lands on a code path whose default still routes locally for a non-empty `plan` run, leaving the per-scope flag set inconsistent with operator expectations. Replan (4.6.a) ships first because its smaller event-digest surface area shakes out digest bugs before they hit the planner's broader fixture.

### 4.7 Default remote text phases + verification on [risk: med, size: M]

What: flip the remaining flag defaults to `true`: `discuss`, `research`, `summarize`, `verify`, `ci_check`, `remoteCiCheck`. The wire paths landed in 4.3 and 4.4; this step is the cutover.

Files:
  - `src/config.ts` — flip the six flag defaults.
  - `docs/architecture/worker-model.md` — update the "where do agents run" section to reflect that all feature-phase agents now run on workers.
  - `docs/architecture/planner.md` — update line 16 ("The host is instantiated by the planner/replanner runtime in `src/agents/runtime.ts`...") to note the host now lives on the worker; the orchestrator-side adapter relays events to `UiPort`.

Tests: existing integration suite covers all six scopes once the flags flip; the per-scope tests from steps 4.3, 4.4, 4.6 now run with default config, no flag override.

Review goals (cap 200 words):
  1. Every `config.distributed.remoteFeaturePhases.*` default is `true`.
  2. Doc updates have no stale in-process references.
  3. `npm run test` passes with no flag overrides.
  4. The suite fails loudly (not skips) if remote workers are unavailable.

Commit: feat(distributed): default all feature-phase agents to remote

Rollback: revert flips the six defaults back to `false`. Operators who already shipped this build but want to fall back without redeploying can set the six keys to `false` in config; documentation must call out this escape hatch in the doc-sweep at phase exit.

### 4.7.a Pre-retire trace: `verifyFeature` call sites [risk: med, size: M]

What: before deleting `VerificationService.verifyFeature` in step 4.8, trace every call site and retarget it. Greppping for `verifyFeature(` and naive deletion miss the orchestrator-side direct caller; this step makes the rewiring explicit so the deletion is mechanical.

Confirmed call sites today:
  - `src/orchestrator/integration/index.ts:128-129` — `IntegrationCoordinator` calls `verificationService.verifyFeature(...)` directly during the merge train. After step 4.4 verification is dispatched as a feature-phase scope; this site must be retargeted to read the latest `VerificationSummary` from `agent_runs.payload_json` (whichever run produced it on the worker) instead of re-running the local shell.
  - The `ci_check` feature-phase backend (`src/runtime/harness/feature-phase/index.ts:204-210`) used to invoke `verifyFeature` inside the in-process `DiscussFeaturePhaseBackend`. After step 4.4 this path executes on the worker; the in-process call site goes away with the backend itself in step 4.8.

Files:
  - `src/orchestrator/integration/index.ts:128-129` — replace the direct `verifyFeature` call with a read against the latest `verification`-output `agent_runs` row for the feature, produced by the remote `verify` / `ci_check` scope. The merge-queue contract from `feature_verification_contract` already requires `VerificationSummary` JSON; this just sources it from the remote-produced row.
  - `src/runtime/harness/feature-phase/index.ts` — confirm via grep that no remaining call sites import `verifyFeature` outside `VerificationService` itself.

Tests:
  - Extend `test/integration/orchestrator/integration-verification-source.test.ts` (new or extend existing integration coordinator test) to assert that `IntegrationCoordinator.runIntegration` consumes a remote-produced `VerificationSummary` and never invokes `VerificationService.verifyFeature` after this step.

Review goals (cap 250 words):
  1. Every call site of `VerificationService.verifyFeature` outside the service itself is gone.
  2. The merge-queue contract `{ ok, summary, failedChecks? }` is byte-identical pre/post.
  3. The test asserts the source of the `VerificationSummary`, not just its shape.

Commit: refactor(orchestrator/integration): consume remote verification rows

### 4.8 Retire the in-process FeaturePhaseOrchestrator [risk: high, size: L]

What: delete `FeaturePhaseOrchestrator` (`src/agents/runtime.ts:177`), `DiscussFeaturePhaseBackend` (`src/runtime/harness/feature-phase/index.ts:75`), and the local body of `VerificationService.verifyFeature` (`src/orchestrator/services/verification-service.ts:25`). Step 4.7.a already retargeted every external `verifyFeature` caller; this step is mechanical deletion to make the non-negotiable structural.

`ProposalPhaseSessionImpl` (`src/agents/runtime.ts:113`) stays as the session-handle abstraction. Repurpose `bindAgent` → `bindRemoteRun`, wrapping `SessionHandle` instead of an in-process `Agent`. `persistPhaseOutputToFeature` (`src/agents/runtime.ts:528`) also stays — it is not an agent loop.

Files:
  - `src/agents/runtime.ts` — delete `FeaturePhaseOrchestrator` and helpers below it that only `FeaturePhaseOrchestrator` consumed (`createAgent`, `executeAgent`, `loadMessages`, `persistMessages`, `phaseToTemplateName`, `phaseRoutingTier`). Keep `ProposalPhaseSessionImpl`, `persistPhaseOutputToFeature`, `findLatestPlanEvent` (consumed by orchestrator-side digest building from step 4.1). Refactor `ProposalPhaseSessionImpl` to wrap `SessionHandle` not `Agent`.
  - `src/agents/index.ts` — drop the `FeaturePhaseOrchestrator` export. Keep `ProposalPhaseSessionImpl` and `persistPhaseOutputToFeature`.
  - `src/runtime/harness/feature-phase/index.ts` — delete `DiscussFeaturePhaseBackend` and `ProposalPhaseAgent` interface; keep the `FeaturePhaseBackend` interface and the synthetic-handle helpers (still used by tests).
  - `src/orchestrator/services/verification-service.ts` — delete `verifyFeature` body; keep the class as a thin shim that throws "verification runs on workers; orchestrator-side runner removed in this phase". The merge queue's `IntegrationCoordinator` (`src/orchestrator/integration/index.ts:54`) does not call `VerificationService` directly — it consumes the `VerificationSummary` returned by the feature-phase scope, which now arrives over the wire. Confirm via grep before deletion.
  - `src/compose.ts` — remove `new FeaturePhaseOrchestrator(...)` (`src/compose.ts:189-209`) and `new DiscussFeaturePhaseBackend(...)`. The `RemoteFeaturePhaseBackend` from step 4.3 is the only backend.
  - Dispatch path for feature-phase runs sets `worker_pid` to NULL on the orchestrator-side `runningRunPatch` (no orchestrator-side pid for a remote agent). The legacy column persists until phase-5-leases-and-recovery step 5.9 drops it; setting it NULL avoids a confusing pid that points at the orchestrator process for a run that lives on a worker VM.

Tests:
  - `test/unit/agents/runtime.test.ts` — drop the `FeaturePhaseOrchestrator` cases; keep `ProposalPhaseSessionImpl` semantics tests with a faux `SessionHandle`.
  - `test/unit/runtime/worker-pool-feature-phase-live.test.ts` — drop the in-process backend branches; keep the remote backend coverage.
  - `test/unit/orchestrator/services/verification-service.test.ts` (if present) — delete or re-target at the worker-side runner.

Review goals (cap 300 words):
  1. `grep 'new Agent(' src/orchestrator/** src/agents/**` (excluding worker subtree) — zero hits.
  2. `FeaturePhaseOrchestrator` and `DiscussFeaturePhaseBackend` have no remaining importers.
  3. `ProposalPhaseSessionImpl` pre-bind queueing semantics (`src/agents/runtime.ts:121-175`) are preserved against `SessionHandle`.
  4. `persistPhaseOutputToFeature` is still called from the orchestrator-side approval path.

Commit: refactor(agents): retire in-process FeaturePhaseOrchestrator

### 4.9 Audit guard: lint rule + runtime assertion [risk: high, size: M]

What: prevent regression of the non-negotiable. ESLint rule scope is **inverted** — allowlist worker-side modules (`src/runtime/worker/**`, `src/agents/tools/**`) and scan everything else, since the regression vector is any `Agent` construction outside the worker process. Runtime assertion in `compose.ts` throws on startup if any non-remote feature-phase backend is registered. Env override `GVC_FORCE_REMOTE_AGENTS` (default on; `=0` opts into dev-only local agents).

Files:
  - `eslint.config.js` (or `.eslintrc.cjs` per repo convention — verify before edit) — add `no-restricted-imports` rule with **inverted scope**: target everything under `src/**`, allow imports of `@mariozechner/pi-agent-core` only from `src/runtime/worker/**` and `src/agents/tools/**` (where the real agent code lives) plus type-only imports anywhere. The rule fires on `src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, all `src/agents/**` outside the worker subtree, and `src/orchestrator/**`. This catches the wider regression surface than scoping to `src/orchestrator/**` alone.
  - `src/compose.ts` — add a startup check: if `featurePhaseBackend` is anything other than `RemoteFeaturePhaseBackend` (or its dispatcher wrapper), and `process.env.GVC_FORCE_REMOTE_AGENTS` is not `'0'`, throw `Error('orchestrator must use remote feature-phase backend; set GVC_FORCE_REMOTE_AGENTS=0 for dev-only override')`.
  - `docs/implementation/03-distributed/README.md` — append a "phase-4-remote-feature-phases enforcement" note pointing at the lint rule and the `GVC_FORCE_REMOTE_AGENTS` override, so a future reader knows where the guard lives.

Tests:
  - `test/unit/runtime/audit-no-local-agents.test.ts` — at-rest scan of `src/` asserting zero matches for `new Agent(` under `src/orchestrator/**` and `src/agents/runtime.ts`. Lints alone catch new imports; this catches dynamic patterns the linter misses (e.g. `Reflect.construct(Agent, ...)`).
  - `eslint` runs as part of `npm run lint:ci` — confirm coverage by adding a small fixture that imports `Agent` directly and asserting the rule fires (use `eslint --rulesdir` or a scoped fixture under `test/fixtures/eslint/`).

Verification: `npm run check:fix && npm run check && npm run lint:ci`.

Review goals (cap 250 words):
  1. `allowTypeImports` is enabled so IPC-contract type-only imports of `Agent` still work.
  2. The runtime assertion uses `GVC_FORCE_REMOTE_AGENTS` correctly (default on; `=0` is the dev override).
  3. The at-rest scan test catches obvious bypasses (`Reflect.construct(Agent, ...)`, dynamic `import()` of pi-agent-core).
  4. `npm run lint:ci` actually invokes the new rule.
  5. Flag any orchestrator-side path that legitimately needs `pi-agent-core` at runtime — that's a design bug, not an allowlist case.

Commit: feat(audit): forbid in-process agent loops on the orchestrator

Rollback: `GVC_FORCE_REMOTE_AGENTS=0` is the documented dev-only escape hatch. Reverting the commit removes both the lint rule and the runtime assertion; operators relying on the env override should remove `GVC_FORCE_REMOTE_AGENTS=0` from any deploy environments after revert because the variable becomes a no-op.

### 4.10 End-to-end integration smoke (optional) [risk: low, size: M]

What: one integration test drives a fresh project from empty graph all the way through bootstrap-plan → discuss → research → plan → execute → verify → integrate, with every agent loop on a faux remote worker. This is the proof the non-negotiable holds in a non-trivial flow, not just per-scope unit tests. Optional because the per-scope tests from steps 4.3–4.6 cover the same wire seam; the smoke is here so a future regression that only manifests across multiple scopes (e.g. a context digest field that's fine for `discuss` but breaks `verify`) is caught.

Files:
  - `test/integration/distributed/phase-4-end-to-end.test.ts` — new. Use the faux remote harness from phase-2-remote-task-execution plus the `fauxModel` pattern from `test/integration/harness/`. Script the worker with FauxResponse sequences for each phase. Assertions: (a) the orchestrator process instantiates zero pi-sdk `Agent` instances (use a `vi.spyOn` or module-level counter); (b) the `agent_runs` row sequence matches the expected phase progression; (c) the final feature reaches `merged` after `IntegrationCoordinator.runIntegration` consumes a remote-produced `VerificationSummary`; (d) `UiPort.onProposalOp` was called for every planner op the faux model issued.

Tests: the file is itself the test.

Review goals (cap 250 words):
  1. The `new Agent(...)` counter covers reflective construction paths.
  2. The faux transport is topologically identical to the network path (same frame validation, same ordering).
  3. `UiPort.onProposalOp` ordering assertions are strict.
  4. The test asserts the merge queue actually consumed the remote `VerificationSummary`.

Commit: test(distributed): end-to-end smoke for fully-remote feature graph

---
Shipped in <SHA1>..<SHA9> on <YYYY-MM-DD>
