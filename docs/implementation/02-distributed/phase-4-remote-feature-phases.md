# Phase 4 — Remote feature-phase agents

## Goal

Move every remaining pi-sdk `Agent` invocation off the orchestrator: planner, replanner, verifier (LLM), summarizer, researcher, discusser, and the bootstrap planner that creates a feature graph from a fresh project. After this phase, the orchestrator process hosts **zero** agent loops and makes **zero** model calls. It is purely a scheduler / state machine / git-coordination service. Verification shell commands (`npm test` etc.) execute on the worker VM against the worker's worktree, and their JSON-shaped result returns over the same network plane that delivers task results today.

## Background

Phases 1–3 left the orchestrator with one durable in-process agent surface: `FeaturePhaseOrchestrator` in `src/agents/runtime.ts:177`, instantiated once in `src/compose.ts:189-209`. It runs every feature-phase scope (`discuss`, `research`, `plan`, `verify`, `summarize`, `replan`) inline as a regular pi-sdk `Agent`, and `DiscussFeaturePhaseBackend` in `src/runtime/harness/feature-phase/index.ts:75` dispatches to it through the scope-aware `dispatchRun` seam (`RunScope: { kind: 'feature_phase', ... }` at `src/runtime/contracts.ts:33-35`). The synthetic handle returned by `createFeaturePhaseHandle` / `createProposalPhaseSessionHandle` (`src/runtime/harness/feature-phase/index.ts:304,382`) wraps an in-process `Agent` future in the same `SessionHandle` shape that real worker subprocesses use, which means the rest of the orchestrator is already scope-agnostic and ready to receive a remote backend.

Verified state on `main`:

- `FeaturePhaseOrchestrator.createAgent` (`src/agents/runtime.ts:449`) directly constructs `new Agent(...)` for every phase. The orchestrator is the only call site after phase 3.
- `GraphProposalToolHost` (`src/agents/tools/proposal-host.ts:51`) is built per planner/replanner run inside `startProposalPhase` (`src/agents/runtime.ts:288`). It also lives in the TUI at `src/tui/proposal-controller.ts:236` for manual draft authoring (no LLM there).
- `proposalOpSink` is wired from runtime to `UiPort.onProposalOp` in `src/compose.ts:198-208`. The TUI mirror (`src/tui/app.ts:355-376` — `TuiApp.onProposalOp`) consumes it directly. Phase 1's planner/replanner mirror (`9f5b73b`) is local-only because today the host runs in the orchestrator process.
- `VerificationService.verifyFeature` (`src/orchestrator/services/verification-service.ts:25`) executes shell commands on the orchestrator host against `worktreePath(feature.featureBranch)`. The same service is consumed by the `ci_check` feature-phase branch in `src/runtime/harness/feature-phase/index.ts:204-210` and by `IntegrationCoordinator` (`src/orchestrator/integration/index.ts:54`).
- `LocalWorkerPool.dispatchRun` (`src/runtime/worker-pool.ts:78`) already routes `feature_phase` scope to the configured `FeaturePhaseBackend`. The seam is in place; only the backend implementation needs to change.
- `WorkerRuntime` in `src/runtime/worker/index.ts:80` runs task agents only. It has no surface for feature-phase scopes today, no proposal tools, no verification commands.
- `RunScope` (`src/runtime/contracts.ts:33-35`) carries `featureId` and `phase` for feature-phase runs. Phases 1–3 added the network transport, registry, and capacity-aware dispatch; the dispatch payload `FeaturePhaseRunPayload` (`src/runtime/contracts.ts:18-21`) only carries `replanReason`. It will need to grow.

This phase is the seam where the highest-stakes invariant of the system — the proposal graph and its approval flow — must traverse the network without losing the live-mirror semantics. It is also the seam where verification's authoritative JSON result starts arriving from a remote machine that has never been part of the orchestrator's local filesystem assumptions.

Recovery still uses pid/proc liveness for feature-phase runs after this phase. Heartbeats from phase 1 cover liveness while the agent is running, but the orphan-recovery path on orchestrator restart still grep's `/proc/<pid>/environ`. **Phase 5** retires that and replaces it with lease-based ownership; phase 4 must not regress that gap. State it loudly in any harness/recovery comment touched here.

## Design decisions settled in this phase

- **Top-level planner bootstrap.** The bootstrap planner that creates the very first feature graph is dispatched through the same `dispatchRun({ scope: { kind: 'feature_phase', featureId, phase: 'plan' } })` plane as every other planner run. Identity is allocated by the orchestrator before dispatch (orchestrator-assigned `agent_run_id`, per cross-cutting concerns in the track README). No "bootstrap worker" role: any registered worker with capacity may take it. Justification: a special role doubles the surface area we have to keep alive, and the bootstrap planner is the same pi-sdk agent with the same toolset; the only thing different is that the feature row already exists (the scheduler creates the placeholder feature when the user kicks off a project, then dispatches `plan` against it). This is the model the TUI manual flow already uses (`src/tui/proposal-controller.ts:268`), so we are aligning code paths rather than inventing a new one.
- **Proposal-host network seam.** `GraphProposalToolHost` lives **on the worker**, alongside the planner agent that drives it. Each tool call mutates the worker's `InMemoryFeatureGraph` draft synchronously, with no network round-trip per call. The host's `subscribe(...)` listener is replaced by a worker-side adapter that converts each `op_recorded` and `submitted` event into a new `WorkerToOrchestratorMessage` variant (`proposal_op` and `proposal_submitted`). The orchestrator side replays these into the existing `proposalOpSink` and into `agent_runs.payload_json` on submit. Justification: planner/replanner can issue dozens of tool calls per turn; a per-call round-trip ties planner latency to network latency and shifts every cycle of the agent loop into the orchestrator's serialization path, which is precisely the seam this track is trying to remove. Reusing the existing `subscribe + checkpoint-style submit` shape from baseline (`bd2fb83`) keeps the wire protocol thin: stream ops as they happen, persist on submit. Authoritative graph mutation still happens orchestrator-side after operator approval — the worker only ships the `GraphProposal` object, never directly mutates the orchestrator's `FeatureGraph`.
- **Verification on remote.** The shell-command runner moves to the worker. A new `verification` worker capability advertises which command set the worker can run. The orchestrator continues to own the `VerificationLayerConfig` and ships it inside the feature-phase payload; the worker executes commands against its locally-cloned worktree (already the wire model from phase 2's bare-repo sync) and sends back a `VerificationSummary` JSON value via `WorkerToOrchestratorMessage.result` with `output.kind: 'verification' | 'ci_check'`. Stdout/stderr are truncated and bundled into `VerificationSummary.summary` exactly as the local runner does today (`src/orchestrator/services/verification-shell.ts`). The orchestrator does not stream raw stdout — keeping the wire shape JSON-shaped preserves the property the merge queue relies on (`feature_verification_contract`).
- **TUI live-planner mirror.** `UiPort.onProposalOp` keeps its current signature. The wire path is `worker → orchestrator → ui.onProposalOp`. The orchestrator-side adapter (introduced in step 4.5) translates incoming `proposal_op` / `proposal_submitted` IPC frames into the existing sink calls. TUI code does not change; it sees the same callbacks at the same scope granularity, only sourced from the network.
- **Feature-phase scope routing.** `RunScope.feature_phase` already carries `featureId` and `phase`. We extend `FeaturePhaseRunPayload` with the planner-baked context fields the worker now needs to assemble its own prompt (feature snapshot, summary context, replan reason already there). Routing decisions stay where they are: phase 3's capacity scheduler picks the worker; this phase only changes which payload shape it ships.
- **Audit & enforcement.** Two layers. (a) An ESLint boundary rule forbids importing `pi-agent-core` from any module under `src/orchestrator/**` or `src/agents/runtime.ts` outside of type-only imports. (b) A runtime assertion in `compose.ts` (toggleable via `GVC_FORCE_REMOTE_AGENTS`, default on once step 4.7 lands) wraps `FeaturePhaseOrchestrator` instantiation with a thrown error so any path that still reaches in-process construction fails loudly at startup. The legacy in-process orchestrator stays in the tree as a fallback dev shim only; production composes the remote backend.
- **Migration ordering.** Read-only scopes lift first (low risk: discuss / research → summarize). Verification next (no proposal tool, but it owns the verify-result JSON the merge queue depends on). Replanner before planner (replanner already starts from an existing feature graph; planner has the bootstrap seam). Top-level planner last. Each step is one feature-flagged scope so we can revert one at a time.

## Wire protocol additions (summary)

This phase introduces three new `WorkerToOrchestratorMessage` variants and one extension to the existing `run` frame. Schemas land in step 4.1 (payload extension) and step 4.5 (proposal frames); steps in between only consume them. The full set:

- **`run` frame** (`OrchestratorToWorkerMessage`) — extended so `task` / `payload` are optional when `scopeRef.kind === 'feature_phase'`, and a new optional `featurePhasePayload: FeaturePhaseRunPayload` field carries the digest.
- **`proposal_op`** — `{ agentRunId, scopeRef, op: GraphProposalOp, draftSnapshot: GraphSnapshot }`. Emitted by the worker's proposal-host subscriber on every recorded op. The orchestrator-side adapter calls `proposalOpSink.onOpRecorded(scope, op, draftSnapshot)`.
- **`proposal_submitted`** — `{ agentRunId, scopeRef, details: ProposalPhaseDetails, proposal: GraphProposal, submissionIndex }`. Emitted on every `submit()` call (checkpoint-style, may fire more than once per run). The adapter calls `proposalOpSink.onSubmitted(...)` and writes `agent_runs.payload_json`.
- **`proposal_phase_ended`** — `{ agentRunId, scopeRef, outcome: 'completed' | 'failed' }`. Emitted on terminal exit from the proposal phase. The adapter calls `proposalOpSink.onPhaseEnded(...)`.

The terminal `result` frame is unchanged in shape — only its source moves. For text phases, `result.output.kind === 'text_phase'`. For LLM verify, `result.output.kind === 'verification'`. For headless ci_check, `result.output.kind === 'ci_check'`. For planner/replanner, `result.output.kind === 'proposal'` (matching `DispatchRunResult.kind: 'awaiting_approval'`).

`VerificationSummary` is a JSON-shaped value — `{ ok: boolean; summary: string; failedChecks?: string[] }` — that already round-trips through the existing `result` frame's discriminated payload. No new transport plumbing is required for verification beyond extending `FeaturePhaseRunPayload` with `verification: { layerConfig: VerificationLayerConfig }`.

## Steps

The phase ships as **9 commits** (with step 4.6 split into three sub-commits, for an effective total of 11 commits on the feature branch — the underlying step-design count is 9). Each commit stands on its own and the suite stays green between commits. The first three steps are infra (no functional change). Steps 4–8 migrate one scope at a time behind a per-scope flag. Step 9 enforces the non-negotiable. An optional integration smoke test (4.10) runs every scope through one end-to-end flow.

---

### Step 4.1 — Feature-phase run payload + worker-side context

**What:** extend `FeaturePhaseRunPayload` to carry every input the worker needs to render its own prompt, so the worker no longer has to reach back into the orchestrator's `FeatureGraph` and event store. This is the prerequisite for any remote feature-phase agent: the worker must be self-sufficient between dispatch and submit. Pure additive — nothing dispatches with the new fields yet.

**Files:**

- `src/runtime/contracts.ts` — extend `FeaturePhaseRunPayload` (currently `src/runtime/contracts.ts:18-21`) with `featureSnapshot: Feature`, `tasks: Task[]`, `eventDigest: FeaturePhasePromptDigest`, optional `replanReason: string` (existing). Define `FeaturePhasePromptDigest` mirroring the fields rendered today in `runtime.ts:renderPrompt` (discussion summary, research summary, plan summary, success criteria, constraints, etc.).
- `src/agents/runtime.ts` — extract the body of `renderPrompt` (`src/agents/runtime.ts:394-447`) into a standalone `buildFeaturePhasePromptDigest(feature, run, store, graph, phase, reason?)` helper exported from a new file `src/agents/context/digest.ts`. Keep `renderPrompt` a thin wrapper for the in-process path that still exists during migration.
- `src/agents/context/digest.ts` — new module re-exporting the helper plus `FeaturePhasePromptDigest` type used by both runtime.ts and the worker.
- `src/runtime/ipc/frame-schema.ts` — extend the run-frame schema branch to allow the new payload shape (TypeBox additions; mirrors `src/runtime/contracts.ts`).

**Tests:** `test/unit/agents/context/digest.test.ts` — assert the digest captures every field the existing `renderPrompt` consumes for each phase (discuss/research/plan/verify/summarize/replan). Use the same fixture style as `test/unit/agents/runtime.test.ts`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Review the digest extraction. Verify: (1) every variable consumed by the prompt templates in `src/agents/prompts/*.ts` is sourced from the digest, not from orchestrator-only state (`store`, `graph`); (2) the digest is plain-data JSON-serializable — no class instances, no functions, no `FeatureGraph` references; (3) the in-process `renderPrompt` produces byte-identical output before and after extraction (test must assert this); (4) frame-schema branch matches the new payload shape exactly. Flag any field still read from `this.deps.store` or `this.deps.graph` inside the helper. Under 350 words.

**Commit:** `refactor(agents/runtime): extract feature-phase prompt digest`

---

### Step 4.2 — Worker-side feature-phase runtime skeleton

**What:** add a `FeaturePhaseWorkerRuntime` peer to `WorkerRuntime` (`src/runtime/worker/index.ts:61`) on the worker side. Same shape — accepts the IPC transport, owns one pi-sdk `Agent`, runs to completion — but takes a `FeaturePhaseRunPayload` instead of a `TaskRunPayload`. This step lands the class with **only the text-phase code path wired** (`discuss` / `research` / `summarize`), leaves proposal and verify code paths as `throw new Error('not yet wired')`, and is not yet reachable through dispatch (no compose.ts change). Pure additive scaffolding so the diff in step 4.3 is small.

**Files:**

- `src/runtime/worker/feature-phase-runtime.ts` — new. `class FeaturePhaseWorkerRuntime` with `run(scope: FeaturePhaseScope, payload: FeaturePhaseRunPayload, dispatch: RuntimeDispatch): Promise<void>`. Implementation: build prompt from `payload.eventDigest`, instantiate `FeaturePhaseToolHost` (text-phase tools only — reuse `buildFeaturePhaseAgentToolset` from `src/agents/tools/agent-toolset.ts`), construct pi-sdk `Agent`, run, send terminal `result` frame with `output.kind: 'text_phase'`. Persist messages via `SessionStore.saveCheckpoint` exactly as `WorkerRuntime` does (`src/runtime/worker/index.ts:169-174`).
- `src/runtime/worker/entry.ts` — register the new runtime alongside the existing task runtime; dispatch by inspecting incoming `run` frame's `scopeRef` (`src/runtime/contracts.ts:339-350`). When `scopeRef.kind === 'feature_phase'`, route to the feature-phase runtime; otherwise to the task runtime. Existing task path unchanged.
- `src/runtime/contracts.ts` — extend the `run` frame variant so feature-phase dispatches can carry the feature-phase payload. Today the `run` frame has `task: Task` and `payload: TaskPayload` (lines 341-350); add an optional `featurePhasePayload: FeaturePhaseRunPayload` and make `task`/`payload` optional when `scopeRef.kind === 'feature_phase'`. (Alternative: add a second `run_feature_phase` frame variant. Pick whichever the IPC schema review prefers; the doc assumes the first since it's a smaller schema change.)
- `src/runtime/ipc/frame-schema.ts` — mirror the schema change.

**Tests:**

- `test/unit/runtime/worker/feature-phase-runtime.test.ts` — happy path for `discuss` end-to-end with a faux pi-sdk agent (use the same scripted `FauxResponse` pattern as task tests under `test/integration/harness/`). Assert the worker emits a `result` frame with `output.kind: 'text_phase'` and `phase: 'discuss'`.
- `test/unit/runtime/ipc-frame-schema.test.ts` — extend with the new run-frame shape (already added by step 4.1's schema work; this step proves it parses).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the worker-side feature-phase runtime: (1) it builds prompts from `payload.eventDigest` only — never reaches into orchestrator state; (2) it terminates the agent (sends `result` or `error`) on every code path, including thrown errors and aborts (`src/runtime/worker/index.ts:175-201` is the reference pattern); (3) `entry.ts` correctly discriminates on `scopeRef.kind` and does not regress task dispatch; (4) message persistence uses `SessionStore.saveCheckpoint` with the same shape the task runtime writes, so resume semantics from step 4.6 work. Flag any path that swallows an error without sending a terminal frame. Under 400 words.

**Commit:** `feat(runtime/worker): feature-phase runtime skeleton (text phases)`

---

### Step 4.3 — Remote feature-phase backend (text phases)

**What:** introduce `RemoteFeaturePhaseBackend implements FeaturePhaseBackend` that dispatches feature-phase scopes through the same network transport phase 2 introduced for tasks, instead of through `FeaturePhaseOrchestrator`. Behind a per-scope feature flag (`config.distributed.remoteFeaturePhases.discuss/research/summarize/...`), default off. Wires `discuss`, `research`, `summarize` only — proposal and verify still go through the in-process backend.

**Files:**

- `src/runtime/harness/feature-phase/remote-backend.ts` — new. `class RemoteFeaturePhaseBackend implements FeaturePhaseBackend`. `start(scope, payload, agentRunId)` builds a `FeaturePhaseRunPayload` from the orchestrator's view of the feature (using the digest helper from step 4.1), calls `WorkerNetworkTransport.dispatchRun` with `scopeRef: scope`, and returns a `FeaturePhaseSessionHandle` whose `awaitOutcome()` resolves when the worker sends the terminal `result` frame. Reuse `createFeaturePhaseHandle` (`src/runtime/harness/feature-phase/index.ts:304`) — only the source of `outcome` changes.
- `src/runtime/harness/feature-phase/index.ts` — export a small dispatcher that consults `config.distributed.remoteFeaturePhases.<phase>` and routes to either `RemoteFeaturePhaseBackend` or the existing `DiscussFeaturePhaseBackend`.
- `src/compose.ts` — instantiate `RemoteFeaturePhaseBackend` with the registry/transport from phase 1–2 and the per-phase flag map from config; pass the dispatcher to `LocalWorkerPool` (`src/compose.ts:203`) instead of the bare `DiscussFeaturePhaseBackend`. (`LocalWorkerPool` keeps its existing `featurePhaseBackend?` slot — no signature change.)
- `src/config.ts` — add `distributed.remoteFeaturePhases: { discuss?: boolean; research?: boolean; summarize?: boolean; verify?: boolean; replan?: boolean; plan?: boolean }`. All default `false`.

**Tests:**

- `test/integration/distributed/remote-feature-phase-text.test.ts` — wire a faux remote worker (the harness from phase 2) and dispatch a `discuss` run. Assert (a) the orchestrator emits one outbound `run` frame with `scopeRef.kind === 'feature_phase'` and the payload's digest is populated; (b) the `result` frame's `output.kind === 'text_phase'`; (c) `agent_runs.payload_json` is updated identically to the in-process path.
- Update `test/unit/runtime/worker-pool-feature-phase-live.test.ts` to add a flag-on case asserting the dispatcher selects the remote backend.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the remote text-phase path: (1) the dispatcher consults the flag map per scope, never short-circuits on a global flag; (2) `agent_runs.payload_json` is written from orchestrator-side after the worker submits — worker is not authoritative for orchestrator state; (3) error frames from the worker translate to a `kind: 'error'` outcome on the existing handle plumbing without bypassing `onTaskComplete`; (4) the in-process path still works when flag is off (no behaviour change); (5) the digest is built once per dispatch and not on every retry. Flag any silent fallback that hides a missing remote worker. Under 400 words.

**Commit:** `feat(runtime): remote feature-phase backend for text phases`

---

### Step 4.4 — Remote verification

**What:** lift `VerificationService.verifyFeature` (`src/orchestrator/services/verification-service.ts:25`) onto the worker for both the LLM `verify` phase and the headless `ci_check` phase. The worker holds the worktree (already the wire model from phase 2), so it runs the shell commands locally; the orchestrator ships `VerificationLayerConfig` in the payload and consumes the JSON result. Behind `config.distributed.remoteFeaturePhases.verify` (gates LLM verify) and a separate `config.distributed.remoteCiCheck` (gates ci_check, which has no LLM).

**Files:**

- `src/runtime/contracts.ts` — extend `FeaturePhaseRunPayload` with `verification?: { layerConfig: VerificationLayerConfig }`. Extend `PhaseOutput` discriminator so the existing `verification` and `ci_check` variants (`src/runtime/contracts.ts:64-65`) survive unchanged — only their producer changes.
- `src/runtime/worker/feature-phase-runtime.ts` — add the verify code path: instantiate the LLM `Agent` exactly like the text phases, plus build a `WorkerVerificationRunner` (new tiny class wrapping `runShell` from `src/orchestrator/services/verification-shell.ts`) that the verify toolset calls to actually execute checks on the worker's worktree. For `ci_check` (no LLM), the runtime skips the agent entirely and just runs the shell commands, posting back a `result` frame with `output.kind: 'ci_check'`.
- `src/runtime/worker/verification-runner.ts` — new. Re-export `runShell`, `formatVerificationResult`, `truncateSummary` from `src/orchestrator/services/verification-shell.ts` for worker-side use. Justification: the helpers are pure shell wrappers with no orchestrator coupling — moving them keeps the orchestrator-side `VerificationService` consumer-only after migration.
- `src/orchestrator/services/verification-service.ts` — gate the `verifyFeature` body on the same flag: when remote verification is enabled, throw if called (the `ci_check` feature-phase backend should be the only path that ever invokes it on the orchestrator side, and that path is now also remote). Add a doc comment stating this is a transitional shim — phase 4 step 4.9 deletes the body.
- `src/runtime/harness/feature-phase/remote-backend.ts` — extend to handle `verify` and `ci_check`. For `ci_check`, no LLM agent on the worker, but the dispatch shape stays uniform.

**Tests:**

- `test/integration/distributed/remote-verification.test.ts` — drive a `ci_check` feature-phase scope through the faux remote worker; assert (a) the worker received the `VerificationLayerConfig`; (b) the resulting `VerificationSummary` round-trips intact; (c) `IntegrationCoordinator` still gates on the JSON `ok: false` result identically (`src/orchestrator/integration/index.ts` consumes `VerificationSummary`).
- `test/unit/runtime/worker/verification-runner.test.ts` — round-trip a faux command set; assert truncation behaviour matches `verification-shell.ts`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify remote verification: (1) `VerificationLayerConfig` ships in the payload exactly once per dispatch — not pulled from worker-local config (workers must not have project config); (2) `VerificationSummary` JSON shape is byte-identical between local and remote producers (the merge queue contract from `feature_verification_contract` depends on this); (3) on remote-`ci_check`, no LLM agent is constructed (zero token cost); (4) failed checks still produce `ok: false` with `failedChecks[]` populated, so `IntegrationCoordinator.runIntegration` reroutes to replanning correctly; (5) shell-command stdout truncation matches `truncateSummary` exactly. Flag any orchestrator-side fallback that silently runs the local runner when the flag is on. Under 450 words.

**Commit:** `feat(verification): execute verify and ci_check on remote workers`

---

### Step 4.5 — Worker-side proposal host + live-mirror IPC

**What:** lift `GraphProposalToolHost` onto the worker for planner/replanner runs. The host's `subscribe` listener on the worker side translates each `op_recorded` and `submitted` event into new IPC frames `proposal_op` and `proposal_submitted`. The orchestrator side replays them into `proposalOpSink` (i.e. `UiPort.onProposalOp`) and into `agent_runs.payload_json` on submit. This is the single highest-stakes step of the phase. It is still gated behind the `replan` and `plan` flags from step 4.3's flag map; no scope flips on yet.

**Files:**

- `src/runtime/contracts.ts` — add `WorkerToOrchestratorMessage` variants. Each carries `fence: number` per the README "Fence tokens" cross-cutting decision: phase 5 step 5.5 enforces, this step declares the field at frame introduction so phase 5 only flips enforcement on. Pre-phase-5 the orchestrator-side adapter accepts any fence (workers stamp `0`); after phase 5, mismatched fences are dropped.

  `proposal_op` and `proposal_submitted` additionally carry `seq: number`, a monotonically-increasing sequence id scoped to the `(agentRunId)` pair. The orchestrator-side adapter records last-seen `seq`; on a worker reconnect mid-stream (per phase 1 `reconnect` frame), the orchestrator can ask the worker to replay from the last-seen `seq` to avoid lost ops without rerunning the planner from scratch. (`proposal_phase_ended` is a one-shot terminal frame and does not need `seq`.)
  - `{ type: 'proposal_op'; agentRunId; scopeRef; op: GraphProposalOp; draftSnapshot: GraphSnapshot; seq: number; fence: number }`
  - `{ type: 'proposal_submitted'; agentRunId; scopeRef; details: ProposalPhaseDetails; proposal: GraphProposal; submissionIndex: number; seq: number; fence: number }`
  - `{ type: 'proposal_phase_ended'; agentRunId; scopeRef; outcome: 'completed' | 'failed'; fence: number }`
- `src/runtime/ipc/frame-schema.ts` — mirror.
- `src/runtime/worker/feature-phase-runtime.ts` — wire the proposal-host code path. Build host with `createProposalToolHost(...)`, attach a subscriber that emits the three new frame variants over `transport.send`, then run the planner/replanner agent. On agent settle, call `host.buildProposal()` / `host.getProposalDetails()` and bundle into the existing `result` frame with `output.kind: 'proposal'` (which the orchestrator already consumes from `DispatchRunResult.kind: 'awaiting_approval'`, `src/runtime/contracts.ts:117`).
- `src/runtime/harness/feature-phase/remote-backend.ts` — register a worker-message handler that translates the three new frames into calls on the existing `proposalOpSink` (today wired in `compose.ts:180-190`). The signal sink is passed to the backend at construction so it stays the same callback chain that `UiPort.onProposalOp` is already wired to.
- `src/agents/runtime.ts` — leave the in-process planner/replanner code path intact for now; this step only adds the remote alternative. The two paths must produce structurally-equivalent `proposalOpSink` event streams.
- `src/runtime/worker-pool.ts` — extend `registerWorkerHandler` (`src/runtime/worker-pool.ts:617`) to dispatch proposal frames. They are not terminal frames — must not delete the live session entry. Existing `result`/`error` paths are unchanged.

**Tests:**

- `test/integration/distributed/remote-planner-mirror.test.ts` — drive a planner run through the faux remote worker; the worker's faux model issues `addFeature`, `addTask`, `addDependency`, `submit`. Assert that `UiPort.onProposalOp` is called once per op with `draftSnapshot` matching the worker's draft state at that point, and `UiPort.onProposalSubmitted` is called once with the proposal payload that matches `host.buildProposal()` on the worker. The streams must be ordered (subscribe semantics from `bd2fb83`) — assert ordering.
- `test/unit/runtime/ipc-frame-schema.test.ts` — extend with the three new variants.
- `test/unit/runtime/worker-pool.test.ts` — assert proposal frames don't terminate the live session.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the proposal-host network seam end-to-end: (1) the worker's `GraphProposalToolHost` is the only one constructed for the run (the orchestrator does not ALSO construct one — that would cause double-mirror); (2) every `op_recorded` event becomes exactly one `proposal_op` IPC frame, in order; (3) `proposal_submitted` carries the same `proposal: GraphProposal` value the orchestrator will later persist via approval — i.e. the wire payload is the authoritative checkpoint, not a summary; (4) the orchestrator-side adapter calls `proposalOpSink.onOpRecorded` / `onSubmitted` / `onPhaseEnded` with the same arguments the in-process path produces today (compare against the in-process call sites in `src/agents/runtime.ts:319-355`); (5) `ProposalPhaseSessionImpl` semantics (sendUserMessage / abort / awaitOutcome from `src/agents/runtime.ts:113-175`) survive the network seam — sendUserMessage routes through `LocalWorkerPool.sendRunManualInput` (`src/runtime/worker-pool.ts:393`), abort through `abortRun`. Flag any path where a worker `proposal_op` could arrive after `proposal_phase_ended`. Under 500 words.

**Commit:** `feat(runtime): worker-side proposal host with live-mirror IPC`

---

### Step 4.6 — Migrate replan, then plan, then bootstrap planner

**What:** flip the per-scope flags one at a time, in order: `replan` → `plan` → bootstrap. Each flip is a one-line config change at this point — the wire path landed in step 4.5 — but each gets its own commit so a regression isolates to one scope. The bootstrap planner is the same code path as `plan`; it differs only in that the feature being planned has no prior proposal events. Confirm via the digest from step 4.1 that an empty-events feature still produces a usable digest, and add the bootstrap path test fixture if not already covered.

This step is intentionally **three commits**, not one. They're listed together because they share zero code; each is a config flip plus one test.

**Files:**

- `src/config.ts` — flip `distributed.remoteFeaturePhases.replan` default to `true` (commit 4.6.a), then `plan` (commit 4.6.b), then add a `distributed.remoteBootstrapPlanner` flag and flip it on (commit 4.6.c). The bootstrap flag is separate so we can roll it back without disabling regular `plan` runs.

**Tests:**

- `test/integration/distributed/remote-replanner.test.ts` (commit 4.6.a) — drive a replan with a non-trivial feature graph; assert `proposalOpSink` events match an in-process baseline.
- `test/integration/distributed/remote-planner.test.ts` (commit 4.6.b) — drive a plan from an existing feature with prior discuss/research events; same assertion.
- `test/integration/distributed/remote-bootstrap-planner.test.ts` (commit 4.6.c) — empty graph, bootstrap user request, assert the resulting feature graph round-trips through approval and matches the worker-side `host.buildProposal()`.

**Verification (each commit):** `npm run check:fix && npm run check`.

**Review subagent (run once after all three commits land):**

> Verify the planner migration: (1) all four planner scopes (`plan`, `replan`, plus the bootstrap variant of `plan`) succeed end-to-end through the remote path with no orchestrator-side `Agent` instantiation (grep `new Agent(` under `src/orchestrator/**` and `src/agents/runtime.ts` — should be zero hits in the remote path); (2) approve / reject / rerun flows from `src/tui/proposal-controller.ts:307-339` still drive the same orchestrator-side state transitions (the TUI's local `GraphProposalToolHost` for manual draft authoring is untouched and still local); (3) `agent_runs.payload_json` after submit contains the same `GraphProposal` shape regardless of in-process vs remote source (test must compare); (4) the rare race where the user aborts mid-stream (issued before any `proposal_op` arrives) terminates the worker via `LocalWorkerPool.abortRun` and produces a `proposal_phase_ended` with `outcome: 'failed'`. Under 500 words.

**Commit subjects:**
- `feat(distributed): default replanner to remote`
- `feat(distributed): default planner to remote`
- `feat(distributed): default bootstrap planner to remote`

---

### Step 4.7 — Default remote text phases + verification on

**What:** flip the remaining flag defaults to `true`: `discuss`, `research`, `summarize`, `verify`, `ci_check`, `remoteCiCheck`. The wire paths landed in 4.3 and 4.4; this step is the cutover.

**Files:**

- `src/config.ts` — flip the six flag defaults.
- `docs/architecture/worker-model.md` — update the "where do agents run" section to reflect that all feature-phase agents now run on workers.
- `docs/architecture/planner.md` — update line 16 ("The host is instantiated by the planner/replanner runtime in `src/agents/runtime.ts`...") to note the host now lives on the worker; the orchestrator-side adapter relays events to `UiPort`.

**Tests:** existing integration suite covers all six scopes once the flags flip; the per-scope tests from steps 4.3, 4.4, 4.6 now run with default config, no flag override.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Confirm the cutover. Verify: (1) every default in `config.distributed.remoteFeaturePhases.*` is `true`; (2) the doc updates accurately describe the new wire model — no stale reference to in-process planner/verifier; (3) `npm run test` passes with no flag overrides; (4) the suite does not silently skip any feature-phase test when remote workers are unavailable in CI (it should fail loudly, since CI must run the faux remote harness). Under 250 words.

**Commit:** `feat(distributed): default all feature-phase agents to remote`

---

### Step 4.7.5 — Pre-retire trace: `verifyFeature` call sites

**What:** before deleting `VerificationService.verifyFeature` in step 4.8, trace every call site and retarget it. Greppping for `verifyFeature(` and naive deletion miss the orchestrator-side direct caller; this step makes the rewiring explicit so the deletion is mechanical.

Confirmed call sites today:

- `src/orchestrator/integration/index.ts:128-129` — `IntegrationCoordinator` calls `verificationService.verifyFeature(...)` directly during the merge train. After phase 4 step 4.4 verification is dispatched as a feature-phase scope; this site must be retargeted to read the latest `VerificationSummary` from `agent_runs.payload_json` (whichever run produced it on the worker) instead of re-running the local shell.
- The `ci_check` feature-phase backend (`src/runtime/harness/feature-phase/index.ts:204-210` per the background) used to invoke `verifyFeature` inside the in-process `DiscussFeaturePhaseBackend`. After step 4.4 this path executes on the worker; the in-process call site goes away with the backend itself in step 4.8.

**Files:**

- `src/orchestrator/integration/index.ts:128-129` — replace the direct `verifyFeature` call with a read against the latest `verification`-output `agent_runs` row for the feature, produced by the remote `verify` / `ci_check` scope. The merge-queue contract from `feature_verification_contract` already requires `VerificationSummary` JSON; this just sources it from the remote-produced row.
- `src/runtime/harness/feature-phase/index.ts` — confirm via grep that no remaining call sites import `verifyFeature` outside `VerificationService` itself.

**Tests:**

- Extend `test/integration/orchestrator/integration-verification-source.test.ts` (new or extend existing integration coordinator test) to assert that `IntegrationCoordinator.runIntegration` consumes a remote-produced `VerificationSummary` and never invokes `VerificationService.verifyFeature` after this step.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the retarget: (1) every call site of `VerificationService.verifyFeature` outside the service itself is gone, retargeted to read the remote-produced `VerificationSummary`; (2) the merge-queue contract (`IntegrationCoordinator.runIntegration` consumes `{ ok, summary, failedChecks? }`) is byte-identical regardless of whether the row was produced locally pre-phase-4 or remotely post-phase-4; (3) no in-process invocation of the verification shell runner remains; (4) the test asserts the source of the `VerificationSummary`, not just its shape. Under 350 words.

**Commit:** `refactor(orchestrator/integration): consume verification result from remote agent_runs row`

---

### Step 4.8 — Retire the in-process FeaturePhaseOrchestrator

**What:** delete `FeaturePhaseOrchestrator` (`src/agents/runtime.ts:177`), `DiscussFeaturePhaseBackend` (`src/runtime/harness/feature-phase/index.ts:75`), and the local body of `VerificationService.verifyFeature` (`src/orchestrator/services/verification-service.ts:25`). Step 4.7.5 already retargeted every external caller of `verifyFeature`; this step is now a mechanical deletion. The compose flag from step 4.3 routed everything through the remote backend; the local code path has had three commits worth of soak time. Now we excise it to make the non-negotiable structural, not configurational.

`ProposalPhaseSessionImpl` (`src/agents/runtime.ts:113`) stays — it is the session-handle abstraction the worker-pool returns to callers. Its `bindAgent(agent)` method is dead on the orchestrator side, but the sendUserMessage / abort / awaitOutcome shape is what `LocalWorkerPool.sendRunManualInput` and `abortRun` already use. Repurpose it as a remote-session wrapper: `bindAgent` becomes `bindRemoteRun` and operates on the `SessionHandle` instead of an in-process `Agent`. Test coverage in `test/unit/agents/runtime.test.ts` updates accordingly.

`persistPhaseOutputToFeature` (`src/agents/runtime.ts:528`) stays — it is the orchestrator-side helper that applies a phase's extra output to the feature row after the run lands. It is **not** an agent loop; the non-negotiable does not apply.

**Files:**

- `src/agents/runtime.ts` — delete `FeaturePhaseOrchestrator` and helpers below it that only `FeaturePhaseOrchestrator` consumed (`createAgent`, `executeAgent`, `loadMessages`, `persistMessages`, `phaseToTemplateName`, `phaseRoutingTier`). Keep `ProposalPhaseSessionImpl`, `persistPhaseOutputToFeature`, `findLatestPlanEvent` (consumed by orchestrator-side digest building from step 4.1). Refactor `ProposalPhaseSessionImpl` to wrap `SessionHandle` not `Agent`.
- `src/agents/index.ts` — drop the `FeaturePhaseOrchestrator` export. Keep `ProposalPhaseSessionImpl` and `persistPhaseOutputToFeature`.
- `src/runtime/harness/feature-phase/index.ts` — delete `DiscussFeaturePhaseBackend` and `ProposalPhaseAgent` interface; keep the `FeaturePhaseBackend` interface and the synthetic-handle helpers (still used by tests).
- `src/orchestrator/services/verification-service.ts` — delete `verifyFeature` body; keep the class as a thin shim that throws "verification runs on workers; orchestrator-side runner removed in phase 4". The merge queue's `IntegrationCoordinator` (`src/orchestrator/integration/index.ts:54`) does not call `VerificationService` directly — it consumes the `VerificationSummary` returned by the feature-phase scope, which now arrives over the wire. Confirm via grep before deletion.
- `src/compose.ts` — remove `new FeaturePhaseOrchestrator(...)` (`src/compose.ts:189-209`) and `new DiscussFeaturePhaseBackend(...)`. The `RemoteFeaturePhaseBackend` from step 4.3 is the only backend.
- Dispatch path for feature-phase runs sets `worker_pid` to NULL on the orchestrator-side `runningRunPatch` (no orchestrator-side pid for a remote agent). The legacy column persists until phase 5 step 5.9 drops it; setting it NULL avoids a confusing pid that points at the orchestrator process for a run that lives on a worker VM.
- `package.json` — confirm `@mariozechner/pi-agent-core` becomes a worker-side dependency only. The orchestrator can keep the dep for type-only imports (the `Agent` type is referenced in IPC contracts via type-only paths). No change needed unless a dependency-pruning sweep is desired (defer to a separate commit if so).

**Tests:**

- `test/unit/agents/runtime.test.ts` — drop the `FeaturePhaseOrchestrator` cases; keep `ProposalPhaseSessionImpl` semantics tests with a faux `SessionHandle`.
- `test/unit/runtime/worker-pool-feature-phase-live.test.ts` — drop the in-process backend branches; keep the remote backend coverage.
- `test/unit/orchestrator/services/verification-service.test.ts` (if present) — delete or re-target at the worker-side runner.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the in-process retirement: (1) grep `new Agent(` under `src/orchestrator/**`, `src/agents/**` (excluding the worker module path) — must be zero hits; (2) `FeaturePhaseOrchestrator` has no remaining importers; (3) `DiscussFeaturePhaseBackend` has no remaining importers; (4) `ProposalPhaseSessionImpl` semantics (sendUserMessage queueing pre-bind, abort queueing pre-bind from `src/agents/runtime.ts:121-175`) are preserved against `SessionHandle` exactly as the original test fixture asserted; (5) `persistPhaseOutputToFeature` is still called from the orchestrator-side approval path (it is not an agent loop); (6) `package.json` orchestrator-side imports of `@mariozechner/pi-agent-core` are type-only or deleted. Flag any in-process agent path that survives. Under 500 words.

**Commit:** `refactor(agents): retire in-process FeaturePhaseOrchestrator`

---

### Step 4.9 — Audit guard: lint rule + runtime assertion

**What:** prevent regression of the non-negotiable. The lint rule's scope is **inverted**: rather than restricting imports under `src/orchestrator/**` (which is too narrow — the regression vector is anywhere that constructs an `Agent` outside the worker process), allowlist worker-side modules and scan everything else. This catches `src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, and all `src/agents/**` (excluding worker-side modules) without requiring a per-directory rule. Runtime assertion in `compose.ts` throws on startup if any `FeaturePhaseOrchestrator`-equivalent in-process backend is registered (after step 4.8 there is none, so the assertion is a tripwire for future regressions). The env override variable is **`GVC_FORCE_REMOTE_AGENTS`** — used consistently across the audit guard. Setting it disabled (i.e. opting into dev-only local agents) requires `GVC_FORCE_REMOTE_AGENTS=0`; default is on.

**Files:**

- `eslint.config.js` (or `.eslintrc.cjs` per repo convention — verify before edit) — add `no-restricted-imports` rule with **inverted scope**: target everything under `src/**`, allow imports of `@mariozechner/pi-agent-core` only from `src/runtime/worker/**` and `src/agents/tools/**` (where the real agent code lives) plus type-only imports anywhere. The rule fires on `src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, all `src/agents/**` outside the worker subtree, and `src/orchestrator/**`. This catches the wider regression surface than scoping to `src/orchestrator/**` alone.
- `src/compose.ts` — add a startup check: if `featurePhaseBackend` is anything other than `RemoteFeaturePhaseBackend` (or its dispatcher wrapper), and `process.env.GVC_FORCE_REMOTE_AGENTS` is not `'0'`, throw `Error('orchestrator must use remote feature-phase backend; set GVC_FORCE_REMOTE_AGENTS=0 for dev-only override')`.
- `docs/implementation/02-distributed/README.md` — append a "Phase 4 enforcement" note pointing at the lint rule and the `GVC_FORCE_REMOTE_AGENTS` override, so a future reader knows where the guard lives.

**Tests:**

- `test/unit/runtime/audit-no-local-agents.test.ts` — at-rest scan of `src/` asserting zero matches for `new Agent(` under `src/orchestrator/**` and `src/agents/runtime.ts`. Lints alone catch new imports; this catches dynamic patterns the linter misses (e.g. `Reflect.construct(Agent, ...)`).
- `eslint` runs as part of `npm run lint:ci` — confirm coverage by adding a small fixture that imports `Agent` directly and asserting the rule fires (use `eslint --rulesdir` or a scoped fixture under `test/fixtures/eslint/`).

**Verification:** `npm run check:fix && npm run check && npm run lint:ci`.

**Review subagent:**

> Verify the audit guard: (1) the ESLint rule scope is **inverted** — allowlist worker-side modules (`src/runtime/worker/**`, `src/agents/tools/**`), scan everything else (`src/compose.ts`, `src/runtime/harness/**`, `src/runtime/worker-pool.ts`, all `src/agents/**` outside the worker subtree, and `src/orchestrator/**`); (2) `allowTypeImports` is enabled so type-only imports of `Agent` types (used in IPC contracts) still work; (3) the runtime assertion uses `GVC_FORCE_REMOTE_AGENTS` (default on; `=0` is the dev-only override); (4) the at-rest scan test catches the obvious bypasses (`Reflect.construct(Agent, ...)`, dynamic `import()` of pi-agent-core); (5) `npm run lint:ci` actually invokes the new rule (config wired correctly). Flag any orchestrator-side path that legitimately needs `pi-agent-core` at runtime — that is a design bug and should fail review, not be allow-listed. Under 400 words.

**Commit:** `feat(audit): forbid in-process agent loops on the orchestrator`

---

### Step 4.10 — End-to-end integration smoke (optional)

**What:** one integration test drives a fresh project from empty graph all the way through bootstrap-plan → discuss → research → plan → execute → verify → integrate, with every agent loop on a faux remote worker. This is the proof the non-negotiable holds in a non-trivial flow, not just per-scope unit tests. Optional because the per-scope tests from steps 4.3–4.6 cover the same wire seam; the smoke is here so a future regression that only manifests across multiple scopes (e.g. a context digest field that's fine for `discuss` but breaks `verify`) is caught.

**Files:**

- `test/integration/distributed/phase-4-end-to-end.test.ts` — new. Use the faux remote harness from phase 2 plus the `fauxModel` pattern from `test/integration/harness/`. Script the worker with FauxResponse sequences for each phase. Assertions: (a) the orchestrator process instantiates zero pi-sdk `Agent` instances (use a `vi.spyOn` or module-level counter); (b) the `agent_runs` row sequence matches the expected phase progression; (c) the final feature reaches `merged` after `IntegrationCoordinator.runIntegration` consumes a remote-produced `VerificationSummary`; (d) `UiPort.onProposalOp` was called for every planner op the faux model issued.

**Tests:** the file is itself the test.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the smoke test: (1) the spy / counter for `new Agent(...)` covers all in-process construction paths, including reflective ones; (2) the test does not depend on real network — the faux transport must be in-process but topologically identical to the network path (same frame validation, same ordering); (3) the assertions about `UiPort.onProposalOp` ordering are strict — out-of-order ops would let a bug land silently; (4) the test's runtime is bounded (ms-scale) — no real timeouts; (5) the test asserts the merge queue actually consumed the remote verification result (i.e. the JSON-shape contract from step 4.4 holds). Under 350 words.

**Commit:** `test(distributed): end-to-end smoke for fully-remote feature graph`

---

## Phase exit criteria

- All ten implementation commits land in order on a feature branch (4.1 through 4.7.5 through 4.9). Step 4.6 splits into three sub-commits (4.6.a / 4.6.b / 4.6.c). Step 4.10's smoke test is optional but recommended.
- `npm run verify` passes on the final commit with default config (no flag overrides).
- The orchestrator process instantiates zero pi-sdk `Agent` instances during a representative end-to-end flow. The audit-guard test from step 4.9 enforces this at-rest; the optional smoke test from step 4.10 enforces it in motion.
- The TUI live-planner mirror still renders proposal ops in real time. Manual sanity check: drive a planner run and confirm the TUI proposal pane updates per op (the integration tests from steps 4.5 and 4.6 already assert this programmatically; the manual check is for the rendering layer).
- Final review subagent across all ten implementation commits (4.1–4.9) confirms the seam is one coherent layer: scope routing, prompt digest, worker-side feature-phase runtime, remote backend, proposal-host network seam, verification, planner migrations, verify-call-site retarget, retirement of the in-process orchestrator, and audit guard. Specifically check that no path silently falls back to in-process (the runtime assertion + lint rule together must close the regression vector). Address findings before declaring the phase complete.

## Known gaps left for phase 5

- **Recovery still uses pid/proc liveness for feature-phase runs.** Phase 1's heartbeat covers liveness while the agent is running, but the orphan-recovery path on orchestrator restart still grep's `/proc/<pid>/environ`. This was the local model and does not work for runs whose pid lives on a remote worker VM. Phase 5's lease model replaces it. Leave a `// TODO(phase-5)` marker in `RecoveryService` (`src/orchestrator/services/recovery-service.ts`) at every site where the pid check still applies to feature-phase runs, so phase 5's review subagent can find them.
- **Disconnect handling.** If a worker disconnects mid-planner-run, today's behaviour is "the run hangs until orchestrator restart". Phase 5 introduces lease-takeover; phase 4 inherits this gap. Heartbeat-driven `health_timeout` from baseline phase 1 still classifies the run as `retry_await`, which is not quite right semantically (the worker hasn't necessarily failed, only its network has) — phase 5 disambiguates. Document the gap in `docs/operations/recovery.md` if not already present.
- **Session persistence — already settled.** Phase 2 made session storage centralized on the orchestrator (track README, "Session persistence — orchestrator is authoritative"). The worker-side feature-phase runtime added in step 4.2 uses the same `RemoteSessionStore` IPC seam phase 2 introduced for task scope. No worker-local fallback. The `feature_phase_recovery_persistence_assumption` memo is superseded by the README cross-cutting decision.
