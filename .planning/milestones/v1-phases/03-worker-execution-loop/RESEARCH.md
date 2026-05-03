# Phase 3: Worker Execution Loop (+ Pi-SDK Resume Spike) — Research

**Researched:** 2026-04-23
**Domain:** Node.js child-process worker pool, pi-sdk `Agent` lifecycle, NDJSON IPC, git-worktree management
**Confidence:** HIGH (pi-sdk API + existing runtime inventoried from source; only resume-semantics open question remains)

## Summary

Phase 3 turns an abstract `RuntimePort` contract into a real worker pool that forks a pi-sdk `Agent` per task inside an isolated git worktree, exchanging NDJSON frames over stdio, enforcing a claim-lock-driven write pre-hook, and writing commits with a `gvc0-*` trailer for merge-train attribution. A fifth plan is an explicit spike on pi-sdk resume/replay that gates the Phase 7 pause design.

**The existing runtime is materially complete.** `src/runtime/worker-pool.ts` (326 LOC), `src/runtime/harness/index.ts` (261 LOC), `src/runtime/ipc/index.ts` (81 LOC), `src/runtime/worker/index.ts` (527 LOC), and `src/agents/worker/**` (12 tools + path-lock + ipc-bridge) already implement the happy paths for all of REQ-EXEC-01, REQ-EXEC-03 (partially), REQ-EXEC-05 scaffolding, and the `claim_lock` round-trip. The orchestrator side `src/orchestrator/scheduler/claim-lock-handler.ts` (205 LOC) already routes grants to `runtime.respondClaim` and denies into `ConflictCoordinator`. Tests `worker-smoke.test.ts` (247 LOC) and `claim-lock-prehook.test.ts` (187 LOC) prove the core loop end-to-end against pi-ai's faux provider. Four concrete gaps remain: worktree `remove/prune/sweep` + PID registry (plan 03-01), frame-schema validation + health-check + quarantine log (plan 03-02), retry policy + commit-trailer shim + configurable model per REQ-CONFIG-01 (plan 03-03), destructive-op detection + inbox stub (plan 03-04), and the resume/replay measurement deliverable (plan 03-05).

**Primary recommendation:** Treat the existing runtime as extend-not-rewrite. Three of five CONTEXT Gray-Area decisions need revision (detailed in §"User Constraints — decisions to flip"). Lean on pi-sdk's native `beforeToolCall` hook as the second enforcement surface for the write pre-hook — it composes cleanly with the existing tool-level `claimer.claim()` call without duplicating work.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **Process-per-task**: Each task spawns its own child process running a pi-sdk `Agent`; workers are isolated at the OS level.
- **Feature branches**: `feat-<name>-<feature-id>` (long-lived). Task worktrees: `feat-<name>-<feature-id>-<task-id>`, squash-merged back into the feature branch on completion.
- **NDJSON over stdio**: transport swappable; schema-validated frames.
- **Write pre-hook**: enforced inside the worker via a `claim_lock` IPC round-trip before every file write; cwd enforcement blocks writes outside the task worktree.
- **Destructive git ops** (`push --force`, `branch -D`, `reset --hard`) → inbox approval stub (Phase 7 will materialize the inbox; stub here must produce a persistent approval request via `Store`).
- **Retry policy** driven by typed config (from 02-03): transient auto-retry up to configurable cap, then semantic failures route to inbox.
- **Commit trailer**: every worker commit carries a `gvc0` trailer (task-id, run-id) for merge-train attribution (consumed by Phase 6).
- **Spike gate**: pi-sdk Agent resume/replay fidelity decides whether Phase 7 two-tier pause uses native replay or persist-tool-outputs fallback.

### Claude's Discretion (Gray Areas auto-answered by CONTEXT)

- A. Worker process boundary — **see "decisions to flip" below**
- B. Worktree manager scope (`add/remove/prune/stale-lock sweep` + PID registry)
- C. NDJSON bridge invariants — **see "decisions to flip" below**
- D. Write pre-hook mechanism (tool-wrapping + `claim_lock`)
- E. Retry policy surface (`src/runtime/retry-policy.ts`, exponential backoff + whitelist)
- F. Commit-with-trailer contract (tool-call shim appends `gvc0-task-id` / `gvc0-run-id`)
- G. Pi-sdk resume spike structure (`docs/spikes/pi-sdk-resume.md` + scenario matrix)
- H. Existing runtime code — **see "decisions to flip" below**

### Decisions to Flip / Modify

1. **CONTEXT §C says "Frame schema via Zod"** — REQ-EXEC-03 (line 24 of REQUIREMENTS.md) locks `@sinclair/typebox`. The codebase already uses typebox for every pi-sdk `AgentTool` parameter schema (`src/agents/worker/tools/*.ts`) and Zod only in `src/config/schema.ts`. Planner should use **typebox for IPC frame validation** to align with REQ-EXEC-03 and avoid importing Zod into a new subsystem.
2. **CONTEXT §A says `spawn()` with `['pipe','pipe','pipe','ipc']`** — the existing harness (`src/runtime/harness/index.ts:167-175`) uses `child_process.fork()` with `['pipe','pipe','inherit']` and no IPC FD. `child.on('exit')` + `child.on('error')` already cover lifecycle (harness.ts:209-214). `fork()` is the correct primitive for TS workers launched via `--import tsx`; adding a 4th IPC FD is architecturally dead weight. **Recommend:** keep `fork()` + `['pipe','pipe','inherit']`, add the "health ping/pong" invariant over the same stdout/stdin stream using typed frames.
3. **CONTEXT §H says "Reference, not baseline; expect rewrites in all 5 plans"** — 2,422 LOC of working runtime is NOT a candidate for rewrite. Plans 03-02/03/04 should be **additive extensions** of `ipc/index.ts`, `worker/index.ts`, and the `toolset.ts` builder. Only `worktree/index.ts` (missing remove/prune) and new files (`retry-policy.ts`, `pid-registry.ts`, `frame-schema.ts`, `destructive-ops.ts`, `docs/spikes/pi-sdk-resume.md`) are green-field.

### Deferred Ideas (OUT OF SCOPE)

- Scheduler tick loop (Phase 4).
- Feature-level planner agent (Phase 5).
- Merge train serialization (Phase 6 — only the trailer contract lands here).
- Two-tier pause hot-window flush (Phase 7 — spike output is the gate).
- TUI worker view (Phase 8).
- Full crash-recovery UX (Phase 9 — this phase persists PIDs but does not implement boot rehydration of worktrees).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-EXEC-01 | Each task runs as a child-process pi-sdk `Agent` in its own worktree (`feat-<name>-<feature-id>-<task-id>`) | Existing `PiSdkHarness.forkWorker` (harness.ts:166-183) + `GitWorktreeProvisioner.ensureTaskWorktree` (worktree/index.ts:28-33) cover start. `core/naming/index.ts:93-118` provides canonical branch/path helpers. Gap: remove/prune/stale-lock sweep + PID registry. |
| REQ-EXEC-02 | Exactly one squash-merge commit on the feature branch; commit carries `gvc0` trailer | Merge is Phase 6; trailer contract is Phase 3. No trailer code exists today. `run_command` tool (run-command.ts:50-54) can run `git commit --trailer=...` but worker never prompts for it. Gap: commit-with-trailer shim + trailer verification on `commit_done` frame. |
| REQ-EXEC-03 | NDJSON over stdio, schema-validated via `@sinclair/typebox`; malformed messages quarantined not fatal | Line-buffered NDJSON via readline exists (`ipc/index.ts:22-48`). Malformed currently drops to stderr (`ipc/index.ts:38-40`). Gap: typebox frame schema, quarantine log via `Store`, typed `health_ping` / `health_pong` frames. |
| REQ-EXEC-04 | Transient errors auto-retry with backoff (hard cap); semantic failures route to inbox | `src/runtime/retry-policy.ts` does not exist. `src/orchestrator/scheduler/events.ts:124,334` and `dispatch.ts:160` reference a `retry_await` status but no policy implementation. Gap: policy module + transient whitelist + inbox stub append via `Store`. |
| REQ-EXEC-05 | Global worker-count cap governs concurrent parallelism (configurable, sane default) | `LocalWorkerPool.maxConcurrency` (worker-pool.ts:33) + `idleWorkerCount()` (worker-pool.ts:278-280) already implement the cap against `config.workerCap` (schema.ts:120). Config default = 4. No gap. |
| REQ-CONFIG-01 | Single global config — one model per agent role | Schema lives at `src/config/schema.ts:7-26` (`AgentRoleEnum`, `ModelRefSchema`). `worker/entry.ts:35` hard-codes `claude-sonnet-4-20250514`. Gap: thread `config.models.taskWorker` through `PiSdkHarness` → fork env → `WorkerRuntime.config.modelId`. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Fork worker child process | `@runtime/harness` | `@runtime/worker-pool` (live-run registry) | OS-level process isolation belongs at the harness seam so the transport is swappable (remote future). |
| NDJSON framing + line buffering | `@runtime/ipc` | — | Pure transport concern; same module serves both orchestrator side (`NdjsonStdioTransport`) and child side (`ChildNdjsonStdioTransport`). |
| Frame schema validation + quarantine | `@runtime/ipc` | `@persistence` (quarantine log) | Schema lives adjacent to transport; persistence layer owns durable capture. |
| Worker lifecycle (live-run registry, cap, abort) | `@runtime/worker-pool` | `@orchestrator/scheduler` (future dispatch caller) | Pool is a stateless map keyed by taskId; scheduler (Phase 4) is the pool's user. |
| Pi-sdk `Agent` hosting + event subscription | `@runtime/worker` | `@agents/worker` (toolset) | Host translates IPC frames into `prompt/continue/followUp/steer/abort`; separate from the tools. |
| Claim-lock round trip (worker side) | `@agents/worker/path-lock` + `@agents/worker/ipc-bridge` | `@runtime/worker` (promise-mux) | Path lock is a cross-cutting wrapper for every mutating tool; ipc-bridge is the write-side of the IPC. |
| Claim-lock grant/deny (orchestrator side) | `@orchestrator/scheduler/claim-lock-handler` | `@orchestrator/scheduler/active-locks` | Handler routes to `ActiveLocks.tryClaim`; denials fan out to `ConflictCoordinator`. |
| Write pre-hook (path escape + claim) | `@agents/worker/tools/_fs` + `path-lock` | pi-sdk `beforeToolCall` (optional belt-and-suspenders) | Tool-level `resolveInsideWorkdir` + `claimer.claim()` are both already in place; pi-sdk hook adds a second backstop for ad-hoc tools (Phase 7+). |
| Destructive-op detection | `@agents/worker/tools/run-command` wrapper | `@runtime/worker` (approval promise mux) | Regex match on command args at execute-time; routes through existing `requestApproval` flow. |
| Retry policy | `@runtime/retry-policy` (NEW) | `@runtime/worker-pool` (dispatcher caller) | Pure function of (error, attempt) → decision; pool calls into it before re-dispatch. |
| Commit trailer enforcement | `@agents/worker/tools/run-command` shim | `@runtime/worker` (`commit_done` frame verifier) | Shim rewrites `git commit ...` args to always include the trailer; parent double-checks. |
| Worktree add/remove/prune/sweep + PID registry | `@runtime/worktree` | `@orchestrator/ports.Store` (PID persist) | Filesystem and git semantics belong with `GitWorktreeProvisioner`; PID row lives on `agent_runs`. |

## Standard Stack

### Core (already in the tree — `package.json:43-50`)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@mariozechner/pi-agent-core` | `^0.66.1` | Pi-sdk `Agent` class; lifecycle events, tool execution, steering queues | [VERIFIED: package.json:44] The project's execution substrate. No alternative is in scope per PROJECT.md. |
| `@mariozechner/pi-ai` | `^0.66.1` (transitive) | `Model`, `Message`, `AssistantMessage`, `streamSimple`, faux provider | [VERIFIED: pi-agent-core/package.json:19] Used in integration tests via `registerFauxProvider`. |
| `@sinclair/typebox` | `^0.34.49` | Tool parameter schemas + NEW: IPC frame schemas | [VERIFIED: package.json:45] Already every tool's parameter schema; REQ-EXEC-03 locks it. |
| `better-sqlite3` | `^12.8.0` | Synchronous SQLite for `Store` (quarantine log, PID registry, inbox stub rows) | [VERIFIED: package.json:47] Phase 2 standard. |
| `simple-git` | `^3.35.2` | Git worktree + trailer commands | [VERIFIED: package.json:48] Already used in `worktree/index.ts:13-16`. |
| `zod` | `^4.3.6` | Config schema validation (REQ-CONFIG-01) | [VERIFIED: package.json:49] Keep in config layer only — do NOT cross over into IPC frames. |

### Supporting (Node built-ins)

| Module | Purpose | When to Use |
|--------|---------|-------------|
| `node:child_process.fork` | Spawn the TS worker with automatic `--import tsx` and piped stdio | Existing harness.ts:167; do NOT switch to `spawn` just to add `ipc` FD. |
| `node:readline.createInterface` | Line-buffered NDJSON over a Readable | Existing ipc/index.ts:27; preserves atomic per-line JSON parse. |
| `node:crypto.randomUUID` | `claimId`, `sessionId` | Already used in ipc-bridge / harness. |
| `node:fs/promises` | Worker tool file IO, atomic session-store rename | Already used in `write-file.ts`, `sessions/index.ts`. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `fork()` (current) | `spawn('node', ...)` + `['pipe','pipe','pipe','ipc']` (CONTEXT §A) | `fork()` auto-configures the child as a Node module runner and is correct for `--import tsx`; the `ipc` FD's value is "structured disconnect events" but `child.on('exit')` already fires on worker death. CONTEXT §A is over-engineered. |
| typebox for IPC frames | Zod (CONTEXT §C) | REQ-EXEC-03 mandates typebox; Zod would duplicate runtime concepts and require a new dev-dep surface area. Typebox `Static<T>` composes with pi-sdk's existing tool-schema idiom. |
| JSON-Lines with length prefix | plain NDJSON with `\n` (current) | Length-prefix would add framing overhead; `readline` already handles partial reads correctly. Keep NDJSON. |
| `git hooks` for trailer enforcement | tool-call shim wrapping `git commit` | Per-worktree git hooks can't distinguish tasks sharing a repo root; shim-at-tool-layer is the CONTEXT-mandated approach. |

**Installation:** nothing new needs installing. All deps already resolved.

**Version verification:** all versions confirmed against `package.json` on 2026-04-23; `pi-agent-core@0.66.1` resolved in `node_modules/@mariozechner/pi-agent-core/package.json:3`. [VERIFIED: filesystem]

## Pi-SDK `Agent` API Inventory

All citations from `/home/alpine/vcode0/node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` and `types.d.ts`.

| Surface | Signature | Phase-3 use |
|---------|-----------|-------------|
| `new Agent(options?: AgentOptions)` | `initialState?`, `streamFn?`, `getApiKey?`, `beforeToolCall?`, `afterToolCall?`, `sessionId?`, `transport?`, `thinkingBudgets?`, `maxRetryDelayMs?`, `toolExecution?` (agent.d.ts:5-21, 51) | Constructed once per worker run in `WorkerRuntime.run` (worker/index.ts:121). |
| `subscribe(listener)` | `(event: AgentEvent, signal: AbortSignal) => Promise<void> \| void` → unsubscribe fn (agent.d.ts:62) | Worker subscribes for `message_end` / `turn_end` (worker/index.ts:126-128, 322-354). |
| `prompt(message \| messages)` / `prompt(text, images?)` | Starts a new prompt (agent.d.ts:100-101) | Cold-start dispatch (worker/index.ts:135). |
| `continue()` | Resumes from current transcript; **last message must be user or tool-result** (agent.d.ts:103) | Warm-resume dispatch (worker/index.ts:133). **Throws** if last message is `assistant` — critical for spike. |
| `steer(message)` | Queues message injected after current assistant turn finishes (agent.d.ts:76) | Orchestrator `steer` frame (worker/index.ts:181-188). |
| `followUp(message)` | Queues message for after agent would stop (agent.d.ts:78) | `suspend` / `resume` / `manual_input` (worker/index.ts:194-208, 247-251). |
| `abort()` | Aborts current run via `AbortSignal` (agent.d.ts:90) | Orchestrator `abort` frame (worker/index.ts:212). |
| `waitForIdle()` | Resolves after `agent_end` listeners settle (agent.d.ts:96) | NOT currently used; useful for clean-shutdown tests. |
| `reset()` | Clears transcript + queues (agent.d.ts:98) | NOT used in-phase; reserved. |
| `state.messages` / `state.pendingToolCalls` / `state.isStreaming` / `state.errorMessage` | Accessors (types.d.ts:231-245) | `WorkerRuntime` reads `state.messages` post-run (worker/index.ts:141). |
| `beforeToolCall(ctx, signal?) → Promise<{ block?, reason? }>` | Fires after arg validation, before execute (types.d.ts:31-34, 174) | **Available second enforcement surface** for destructive-op detection — returning `{ block: true, reason }` triggers an error tool result automatically. |
| `afterToolCall(ctx, signal?) → Promise<{ content?, details?, isError? }>` | Fires after execute, before emit (types.d.ts:46-50, 186) | Optional audit hook for commit-trailer post-verification. |
| `AgentEvent` union | `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` (types.d.ts:284-322) | Used for progress + assistant-output streaming; no spike-relevant checkpoint event exists. |

**Verified (HIGH confidence):**
- `Agent.continue()` docstring explicitly forbids assistant-as-last-message (agent.d.ts:103). Behavior when violated: at agent.js:221-242 (previously grepped) throws `"Cannot continue from message role: assistant"`. This is the single most important fact for the spike.
- There is no first-class `checkpoint` or `snapshot` export on the default index. The only runtime-state persistence surface is `AgentState.messages` (an `AgentMessage[]`) — which `FileSessionStore` (`src/runtime/sessions/index.ts`) already saves.

## Existing Runtime Inventory (keep / extend / rewrite / delete)

File-by-file map, 2,422 LOC total.

### `@runtime` layer

| File | LOC | Status | What it does today | Phase-3 change |
|------|-----|--------|-------------------|----------------|
| `src/runtime/worker-pool.ts` | 326 | **keep + extend** | `LocalWorkerPool implements RuntimePort`: `dispatchTask` (start + resume), `steerTask`, `suspendTask`, `resumeTask`, `respondToHelp`, `decideApproval`, `respondClaim`, `abortTask`, `sendManualInput`, `stopAll`, `idleWorkerCount`; wires `onExit` to synthesize an `error` frame when the worker dies unexpectedly (worker-pool.ts:311-324). | Add retry-policy hook on `onTaskComplete` path; widen `onExit` synthesis to route to retry-or-inbox. |
| `src/runtime/harness/index.ts` | 261 | **keep + extend** | `PiSdkHarness implements SessionHarness`: `start`/`resume` via `child_process.fork` with `['pipe','pipe','inherit']`, `execArgv:['--import','tsx']`, env `GVC0_PROJECT_ROOT`; `SessionHandle` fans out `onWorkerMessage` / `onExit`; `abort()` sends frame then `SIGKILL` after 5s. | Add PID registry call on `forkWorker`; add health-check scheduler (send `health_ping` every Nms, track pong deadline). |
| `src/runtime/ipc/index.ts` | 81 | **extend (bigger)** | `NdjsonStdioTransport` (parent→child) + `ChildNdjsonStdioTransport` (child→parent), both readline-backed; on parse failure writes to `process.stderr` and drops (ipc/index.ts:38-40). | Replace drop-to-stderr with typebox `Check()` + quarantine-log call via `Store`; add `health_ping`/`health_pong` typed frames; keep Message types unchanged. |
| `src/runtime/worker/index.ts` | 527 | **keep + minor extend** | `WorkerRuntime` owns the pi-sdk Agent, pending-help / pending-approval / pending-claim (map keyed by `claimId`) registries, builds the system prompt + toolset, subscribes to `message_end`/`turn_end`, formats steering/suspend/resume messages, persists session. | Add retry-policy call site on error path (worker/index.ts:149-159); wire destructive-op detection through `run_command` wrapper; thread model ID from env (currently hard-coded in entry.ts:35). |
| `src/runtime/worker/entry.ts` | 58 | **extend** | Child entrypoint; redirects console to stderr; instantiates `ChildNdjsonStdioTransport`, `FileSessionStore`, `WorkerRuntime`; hard-codes `modelId: 'claude-sonnet-4-20250514'`. | Read `modelId` from env (set by harness from `config.models.taskWorker`). |
| `src/runtime/worker/project-root.ts` | 6 | **keep** | Reads `GVC0_PROJECT_ROOT` env. | No change. |
| `src/runtime/worker/system-prompt.ts` | 137 | **keep** | Builds the worker system prompt from Task + TaskPayload. | No change. |
| `src/runtime/worktree/index.ts` | 84 | **extend (major)** | `GitWorktreeProvisioner.ensureFeatureWorktree` / `ensureTaskWorktree` via `git worktree add`; idempotent for races. | Add `removeWorktree(branch)`, `pruneStaleWorktrees()`, `sweepStaleLocks()`, PID registry integration. |
| `src/runtime/contracts.ts` | 266 | **keep** | `RuntimePort` + full `OrchestratorToWorkerMessage` / `WorkerToOrchestratorMessage` unions (already match `docs/architecture/worker-model.md`). | Expand `WorkerToOrchestratorMessage` union to include `health_pong`; expand `OrchestratorToWorkerMessage` to include `health_ping`. |
| `src/runtime/sessions/index.ts` | 66 | **keep** | `FileSessionStore` with atomic-rename write. | No change. |
| `src/runtime/context/index.ts` | 58 | **keep** | `TaskPayload` shape. | No change. |
| `src/runtime/routing/index.ts` | 71 | **keep** | `resolveModel` + tier routing. | No change (Phase 3 uses tier 'standard' identity). |
| `src/runtime/routing/model-bridge.ts` | 130 | **keep** | `resolveModel(model, routingConfig)` returns pi-ai `Model`. | No change. |

### `@agents/worker` layer

| File | LOC | Status | What it does today | Phase-3 change |
|------|-----|--------|-------------------|----------------|
| `src/agents/worker/ipc-bridge.ts` | — | **keep** | `IpcBridge` with `progress`, `requestHelp`, `requestApproval`, `claimLock(paths) → Promise<ClaimLockResult>`, `submitResult`. | No change. |
| `src/agents/worker/path-lock.ts` | 27 | **keep** | `createPathLockClaimer(ipc)` — caches granted paths, throws on denial (path-lock.ts:21). | No change. |
| `src/agents/worker/toolset.ts` | 60 | **extend** | `buildWorkerToolset(deps)` assembles the 14 tools (toolset.ts:44-58). | Wrap `run_command` with destructive-op detection + commit-trailer shim. |
| `src/agents/worker/tools/write-file.ts` | 47 | **keep** | Calls `claimer.claim(params.path)` then `resolveInsideWorkdir` — already enforces both pre-hook gates (write-file.ts:33-38). | No change. |
| `src/agents/worker/tools/edit-file.ts` | 77 | **keep** | Same claim + path-escape pattern as write-file. | No change. |
| `src/agents/worker/tools/_fs.ts` | 53 | **keep** | `resolveInsideWorkdir(workdir, rel)` enforces no `../..` escape (cited in most tools). | No change. |
| `src/agents/worker/tools/run-command.ts` | 174 | **extend** | Executes `sh -c` with 1 MB stream caps, `detached: true` for process-group kill, timeout, abort signal. | Add destructive-op regex wrapper (rejects or routes to `requestApproval`); add commit-trailer shim when command matches `git commit`. |
| `src/agents/worker/tools/submit.ts` | 49 | **keep** | Worker terminal-result submit (wires `ipc.submitResult`). | No change. |
| `src/agents/worker/tools/confirm.ts` | 28 | **keep** | Post-implementation confirm prompt. | No change. |
| `src/agents/worker/tools/request-help.ts` / `request-approval.ts` | 38 / 83 | **keep** | Blocking round-trips via `ipc.requestHelp` / `ipc.requestApproval`. `ApprovalPayload` already has a `destructive_action` kind (contracts.ts:95). | No change. |
| `src/agents/worker/tools/{read,list,search}-files`, `git-status`, `git-diff`, `append-knowledge`, `record-decision` | ~330 combined | **keep** | Read-only; no claim needed. | No change. |

### Delete candidates

None. No dead code identified.

## NDJSON IPC Framing

**Current shape** (`ipc/index.ts:22-48`):
- Parent side: `NdjsonStdioTransport` — writes `JSON.stringify(message)+"\n"` to child stdin; reads child stdout via `readline.createInterface`.
- Child side: `ChildNdjsonStdioTransport` — writes to `process.stdout`, reads from `process.stdin`.
- Line parsing: `readline` `'line'` event fires once per `\n`; `try { JSON.parse(line) } catch { stderr.write + drop }`.

**Add for Phase 3 (plan 03-02):**
1. Typebox frame schemas for every message in `contracts.ts` (one `T.Union` each for `OrchestratorToWorkerMessage` and `WorkerToOrchestratorMessage`).
2. `Value.Check(schema, parsed)` before handing to the handler; failure → push to a bounded in-memory ring (last 64 lines) AND `store.appendQuarantinedFrame({ ts, direction, raw, error })` (new `Store` method).
3. Typed `health_ping` / `health_pong` frames; parent sends `health_ping` every `config.workerHealthTimeoutMs/2` (default 5s for a 10s timeout); if two consecutive pongs missed, parent treats the worker as dead, sends SIGKILL, synthesizes `error` frame.
4. **Do not** change the wire format — stay `\n`-terminated JSON for dev-tool friendliness (tail -f the stdout pipe).

## Worktree Manager + PID Registry

**Naming** (from `src/core/naming/index.ts:93-118`):
- Feature branch: `feat-<slug>-<feature-id>`
- Task branch: `feat-<slug>-<feature-id>-<task-id>`
- Worktree path: `.gvc0/worktrees/<branch>`

**Current provisioner** (`src/runtime/worktree/index.ts:28-60`): only `add`. Idempotent via `hasRegisteredWorktree(target)` list check.

**Phase-3 additions:**
- `removeWorktree(branch): Promise<void>` — `git worktree remove --force .gvc0/worktrees/<branch>`; tolerate `not a working tree` error as idempotent success.
- `pruneStaleWorktrees(): Promise<string[]>` — `git worktree prune -v` + return list of removed names for logging.
- `sweepStaleLocks(): Promise<void>` — scan `.git/worktrees/<name>/locked` markers; remove any whose owning PID is not alive (check via `process.kill(pid, 0)` — throws ESRCH if dead).
- PID registry: add `worker_pid INTEGER NULL` column to `agent_runs` (already in persistence plan per `docs/architecture/persistence.md`); write PID on `harness.start`, clear on `onExit`. **No** separate `worker_pid_registry` table — one column is enough.

## Write Pre-Hook Mechanism

**Two enforcement surfaces, already in place:**
1. **Path escape** — `resolveInsideWorkdir(workdir, rel)` at `src/agents/worker/tools/_fs.ts:46-53`, called by `write-file` and `edit-file`. Throws `Error: path escapes workdir` for any `..` traversal.
2. **Claim-lock round-trip** — `createPathLockClaimer` at `src/agents/worker/path-lock.ts:13-27`. Every `write-file.execute` / `edit-file.execute` calls `claimer.claim(params.path)` BEFORE touching the filesystem. Cached grants avoid re-round-tripping for paths already held.

**Orchestrator side** (`src/orchestrator/scheduler/claim-lock-handler.ts:9-21`):
- Wraps `ActiveLocks.tryClaim(runId, paths)` (active-locks.ts).
- On grant → `runtime.respondClaim({ claimId, kind: 'granted' })`.
- On deny → `ConflictCoordinator` decides same-feature-suspend-and-rebase vs cross-feature pause.
- On release → `locks.releaseByRun(runId)` on result/error frame.

**Latency measurement (OPEN QUESTION):** CONTEXT implies the round-trip must be cheap enough to not serialize the worker. Prior profiling not available in repo. Plan 03-02 should measure the claim_lock RTT end-to-end (worker → parent → handler → worker) with faux provider and publish the number — target <5ms for the no-conflict happy path.

**pi-sdk `beforeToolCall` as a second surface (OPTIONAL):**
- `BeforeToolCallResult { block?: boolean; reason?: string }` (types.d.ts:31-34).
- Could register a hook that checks `toolCall.name === 'run_command'` and rejects if args contain `push --force` / `branch -D` / `reset --hard`. Redundant with the tool-layer wrapper but composes without interference. **Recommend:** use `beforeToolCall` for destructive-op detection (single central surface for all shell-y tools, avoids duplicating in each tool wrapper). Keep `claimer.claim()` at tool-layer because it needs the resolved `params.path` which `beforeToolCall` receives as unvalidated `args: unknown`.

## Destructive-Op Detection

**Targets (CONTEXT §D):**
- `git push --force` / `git push -f`
- `git branch -D <name>` / `git branch --delete --force`
- `git reset --hard` (including `reset --hard HEAD~N`)

**Pattern** (pure string match is adequate — the commands always run via `sh -c "..."`, so we match on the full command line):
```
/\bgit\s+push\s+.*(--force|-f)\b/
/\bgit\s+branch\s+.*(-D|--delete\s+--force)\b/
/\bgit\s+reset\s+.*--hard\b/
```
False positives (e.g., `echo "git push --force"` inside a string): acceptable — erring on the safe side is cheaper than a missed dangerous op. Document in the hook code.

**Flow on match:**
1. `beforeToolCall` returns `{ block: true, reason: 'destructive: ... — awaiting approval' }`.
2. Worker tool emits an error tool result (pi-sdk does this automatically).
3. Worker separately sends `request_approval` with `{ kind: 'destructive_action', description, affectedPaths }` (payload kind already exists in `contracts.ts:95`).
4. Orchestrator (stub for Phase 3) writes `inbox_item` row via `Store.appendInboxItem(...)` (NEW method — Phase 7 materializes the inbox UI).
5. On approval, worker re-runs the command (the first call returned blocked, agent sees the error and will retry; tests must verify retry-after-approve flow).

**Inbox stub schema (minimum):** `inbox_items (id TEXT PRIMARY KEY, ts INTEGER, task_id TEXT, agent_run_id TEXT, kind TEXT, payload JSON, resolution TEXT NULLABLE)`. Phase 7 extends; Phase 3 only appends.

## Retry Policy

**Module location:** `src/runtime/retry-policy.ts` (NEW).

**Surface:**
```typescript
export interface RetryDecision {
  kind: 'retry';
  delayMs: number;
  attempt: number;
} | {
  kind: 'escalate_inbox';
  reason: string;
};

export interface RetryPolicyConfig {
  maxAttempts: number;          // config.retryCap (existing, default 5)
  baseDelayMs: number;          // 250ms
  maxDelayMs: number;           // 30000ms
  transientErrorWhitelist: RegExp[];
}

export function decideRetry(error: unknown, attempt: number, config: RetryPolicyConfig): RetryDecision;
```

**Transient whitelist (match against error message or stringified cause):**
- `/ECONNRESET/`, `/ETIMEDOUT/`, `/ENOTFOUND/`, `/EAI_AGAIN/` (DNS)
- `/\b5\d\d\b/` (any HTTP 5xx status embedded in error)
- `/rate limit/i`, `/too many requests/i`
- pi-sdk-specific: `/provider error/i` (pi-ai wraps transport failures this way)

**Semantic failures (immediate inbox escalate):**
- Schema validation failure (from typebox frame check or tool-arg validation).
- Write pre-hook denial (claim denied, path escape).
- Non-zero git commit status with a non-transient message (e.g., merge conflict).
- Worker crash with `code !== 0` AND error message does NOT match transient whitelist.

**Backoff:** `delay = min(maxDelayMs, baseDelayMs * 2^(attempt-1)) + jitter(0..250ms)`.

**Call site:** `LocalWorkerPool.registerWorkerHandler` (worker-pool.ts:290-325) — on `error` message or unexpected `onExit`, call `decideRetry`. If `retry` → schedule a fresh `dispatchTask` after `delayMs`; if `escalate_inbox` → call `Store.appendInboxItem({ kind: 'semantic_failure', ... })`.

## Commit-With-Trailer Contract

**Trailer shape (Phase 6 consumer depends on this):**
```
gvc0-task-id: <task-id>
gvc0-run-id: <agent-run-id>
```

**Enforcement (tool-call shim, CONTEXT §F):**
- In the `run_command` tool wrapper, detect `git commit` commands via regex `/^\s*git\s+commit(\s|$)/`.
- Rewrite by appending `--trailer "gvc0-task-id=<taskId>" --trailer "gvc0-run-id=<agentRunId>"` BEFORE execution (git accepts `--trailer` flags; simpler than editing commit-msg files).
- If the command already contains either trailer, leave as-is (idempotent).
- After execution, verify trailer presence by running `git log -1 --format=%B | git interpret-trailers --parse` and checking output — if missing, emit `error` frame requesting redo.

**Parent-side verification:** on the `commit_done` frame (NEW) from worker, parent validates the trailer via the same parse; if absent, reject the completion and retry. This is defense-in-depth: the shim should never miss but Phase 6's correctness depends on the invariant.

**Frame additions to `contracts.ts`:**
- `WorkerToOrchestratorMessage | { type: 'commit_done'; taskId; agentRunId; sha: string; trailerOk: boolean }`.
- Parent stores the SHA on `agent_runs.last_commit_sha` for merge-train consumption.

## Pi-SDK Resume Spike (Plan 03-05)

**Deliverable:** `docs/spikes/pi-sdk-resume.md` with observed behavior + decision.

**Scenario matrix:**

| Scenario | Setup | Measurement |
|----------|-------|-------------|
| **Cold start** | Fresh worker, new task, no messages | `agent.prompt(task.description)` — baseline success case |
| **Mid-tool-call pause** | Worker runs long tool (say 10s `sleep 30`); abort before tool finishes | On resume: is `pendingToolCalls` restored? Does `continue()` re-invoke the same tool with the same `toolCallId`? |
| **Mid-response-stream pause** | Abort while `message_update` events streaming but before `message_end` | Post-resume: is `state.streamingMessage` present (types.d.ts:241)? Does `continue()` rewind or start fresh turn? |
| **Post-commit pause** | Worker ran `git commit` + emitted `commit_done`; then abort | On resume: `continue()` should succeed if last message is a tool-result; measure whether the committed state survives. |
| **Catastrophic worker crash** | `process.kill(pid, 'SIGKILL')` mid-prompt | Session file (`FileSessionStore`) — is the last durable write recoverable? Measure: how many messages survive? |

**Observation method:**
- Use `InProcessHarness` (`test/integration/harness/in-process-harness.ts`) for fast iteration (no fork overhead).
- Pair with `createFauxProvider` (`test/integration/harness/faux-stream.ts`) with scripted `FauxResponse` sequences to inject deterministic tool calls and responses.
- Abort via `agent.abort()` at specific `AgentEvent` boundaries (use `subscribe`).
- Inspect `agent.state.messages` pre/post abort; inspect what `FileSessionStore.save` persisted.

**Spike decision gates (written into the spike doc):**
- **Native replay works** iff: `continue()` after abort-at-tool-call successfully re-emits the same `toolCallId` AND the tool's idempotency can be trusted OR `pendingToolCalls` is surfaced in a way that lets us skip re-emitting.
- **Persist-tool-outputs fallback needed** iff: `continue()` throws on any of the above scenarios (especially mid-tool-call) OR the transcript after resume is incoherent (e.g., re-emits the prompt as a new user turn).

**Known fact driving the fallback hypothesis:** `Agent.continue()` throws `"Cannot continue from message role: assistant"` if the last message is an assistant (see worker/index.ts:132-133 has a guard for `messages.length > 0` but NOT for last role). If `message_end` fires before session save and a `tool_execution_end` hasn't synthesized a tool-result yet, the saved transcript may be assistant-terminated, breaking resume.

**If fallback is needed**, minimal implementation:
- Intercept `afterToolCall` to persist the executed tool result to a durable store BEFORE pi-sdk appends it to the transcript.
- On resume: detect assistant-terminated transcript; look up the missing tool result; splice it in; THEN call `continue()`.

## Config Touch Points

Current schema (`src/config/schema.ts:116-144`):
- `workerCap` (default 4) — already used by `LocalWorkerPool`.
- `retryCap` (default 5) — maps to `retry.maxAttempts`.
- `reentryCap` (default 10) — Phase 7.
- `pauseTimeouts.hotWindowMs` (default 600_000) — Phase 7.
- `models` (REQ-CONFIG-01) — `taskWorker` ModelRef is the Phase-3 consumer.

**Additions Phase 3 needs (add to `GvcConfigSchema` in plan 03-03):**
- `workerHealthTimeoutMs: number` (default 10_000, CONTEXT §C).
- `retry.baseDelayMs: number` (default 250).
- `retry.maxDelayMs: number` (default 30_000).
- `retry.transientErrorPatterns: string[]` (RegExp sources, default above list).
- `worktreeRoot: string` (default `.gvc0/worktrees`) — optional override for tests.

**Model wiring gap:** `worker/entry.ts:35` hard-codes `'claude-sonnet-4-20250514'`. Plan 03-03 must thread `config.models.taskWorker.model` from orchestrator → harness fork env (`GVC0_TASK_MODEL_ID` + `GVC0_TASK_MODEL_PROVIDER`) → `entry.ts` reads env → `WorkerRuntime.config.modelId`.

## Runtime State Inventory

(Phase 3 is greenfield implementation, not a rename/refactor. This section is included because the phase adds state surfaces.)

| Category | Items | Action Required |
|----------|-------|-----------------|
| Stored data | `agent_runs.worker_pid` (new column), `agent_runs.last_commit_sha` (new column), `inbox_items` table (new, stub), `ipc_quarantine` table or in-memory ring (decision TBD) | Add migrations via Phase 2 `Store` |
| Live service config | None — no external services in Phase 3 | — |
| OS-registered state | PID registry rows; worktree locks in `.git/worktrees/*/locked` | PID registry is rehydrated on boot (Phase 9); locks swept by `pruneStaleWorktrees` on startup |
| Secrets / env vars | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (already consumed by entry.ts:37-41), `GVC0_PROJECT_ROOT` (harness.ts:173), NEW: `GVC0_TASK_MODEL_ID` / `GVC0_TASK_MODEL_PROVIDER` | Ensure harness forwards to child env |
| Build artifacts | None — TypeScript compiled on-the-fly via tsx | — |

## Common Pitfalls

### Pitfall 1: `Agent.continue()` throws on assistant-last transcript
**What goes wrong:** Phase 7 pause saves the session after `message_end` but before the next turn's user/tool-result message is appended → resume fails.
**Why it happens:** pi-sdk contract (agent.d.ts:103); enforced at agent.js runtime.
**How to avoid:** Either (a) only save sessions at known-safe boundaries (`turn_end` only, not `message_end`) OR (b) implement the persist-tool-outputs fallback. Spike decides.
**Warning sign:** Spike scenario "mid-response-stream pause" throws.

### Pitfall 2: stdout contamination breaks NDJSON
**What goes wrong:** Any `console.log` inside the worker corrupts the NDJSON frame stream because stdout carries IPC.
**Why it happens:** Shared `process.stdout`.
**How to avoid:** `entry.ts:10-14` already redirects `console.log/info/warn` to stderr. Any new dependency must be audited — specifically `simple-git` is noisy; confirm its output is captured as return values, not printed.
**Warning sign:** `[ipc] failed to parse worker message` in stderr (ipc/index.ts:39).

### Pitfall 3: process-group detached spawn in run_command breaks kill on some platforms
**What goes wrong:** `detached: true` + `process.kill(-pid, sig)` is POSIX-only; Windows crashes.
**Why it happens:** run-command.ts:54, 91-98.
**How to avoid:** Project is Linux-only per `env` block above; document assumption. If Windows support is ever needed, swap to `taskkill /F /T /PID`.
**Warning sign:** `process.kill(-pid, ...)` throws `ENOSYS` or similar.

### Pitfall 4: race between `onExit` synthesis and normal `result` frame
**What goes wrong:** Worker sends `result` frame, then exits normally; `onExit` handler fires AFTER the pool already deleted the entry (worker-pool.ts:301-309) — but if the order inverts (exit fires before the line is fully parsed), pool synthesizes a spurious `error` frame.
**Why it happens:** readline buffering + exit event ordering.
**How to avoid:** worker-pool.ts:311-324 already checks `this.liveRuns.has(taskId)` before synthesizing. Keep that guard. Add test: inject a 1ms delay between sending `result` and `process.exit(0)` in entry.ts to stress the race.
**Warning sign:** flaky tests reporting "worker_exited: code=0 signal=null" after a successful run.

### Pitfall 5: stale worktree locks from crashed workers
**What goes wrong:** A SIGKILLed worker leaves `.git/worktrees/<name>/locked` marker; next run of the same task branch fails to `worktree add` because git thinks it's in use.
**Why it happens:** git's crash-safety mechanism.
**How to avoid:** `sweepStaleLocks()` on startup + PID liveness check; remove lock if owner PID dead.
**Warning sign:** "worktree add" fails with "cannot add worktree, working tree is locked".

## Code Examples

### Typebox frame schema (plan 03-02)

```typescript
// src/runtime/ipc/frame-schema.ts (NEW)
// Source pattern from: src/agents/worker/tools/write-file.ts:9-16 (existing typebox use)
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const HealthPingFrame = Type.Object({
  type: Type.Literal('health_ping'),
  ts: Type.Number(),
});

export const HealthPongFrame = Type.Object({
  type: Type.Literal('health_pong'),
  ts: Type.Number(),
});

export const WorkerToOrchestratorFrame = Type.Union([
  // ...each variant from contracts.ts:220-266
  HealthPongFrame,
]);
export type WorkerToOrchestratorFrameT = Static<typeof WorkerToOrchestratorFrame>;

// Check usage:
if (!Value.Check(WorkerToOrchestratorFrame, parsed)) {
  const errors = [...Value.Errors(WorkerToOrchestratorFrame, parsed)];
  // quarantine
}
```

### Destructive-op detection hook (plan 03-04)

```typescript
// src/agents/worker/destructive-ops.ts (NEW)
import type { BeforeToolCallContext, BeforeToolCallResult } from '@mariozechner/pi-agent-core';

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bgit\s+push\s+.*(--force|-f)\b/,
  /\bgit\s+branch\s+.*(-D|--delete\s+--force)\b/,
  /\bgit\s+reset\s+.*--hard\b/,
];

export async function destructiveOpGuard(ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
  if (ctx.toolCall.name !== 'run_command') return undefined;
  const cmd = (ctx.args as { command?: string }).command;
  if (typeof cmd !== 'string') return undefined;
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(cmd)) {
      return { block: true, reason: `destructive_op_requires_approval: ${pat.source}` };
    }
  }
  return undefined;
}
```

### Commit-trailer shim (plan 03-03)

```typescript
// In createRunCommandTool wrapper (src/agents/worker/tools/run-command.ts extension)
function maybeInjectTrailer(cmd: string, taskId: string, runId: string): string {
  if (!/^\s*git\s+commit(\s|$)/.test(cmd)) return cmd;
  if (/--trailer[= ]["']?gvc0-task-id/.test(cmd)) return cmd; // already present
  return `${cmd} --trailer "gvc0-task-id=${taskId}" --trailer "gvc0-run-id=${runId}"`;
}
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.4 |
| Config file | `vitest.config.ts` (tsconfigPaths enabled) |
| Quick run | `npm run test:unit` |
| Full suite | `npm run test` (unit + integration, including faux-provider) |

### Phase Requirements → Test Map

| Req | Behavior | Type | Command | File exists? |
|-----|----------|------|---------|--------------|
| REQ-EXEC-01 | task end-to-end in worktree | integration | `vitest run test/integration/worker-smoke.test.ts` | ✅ (happy path covered; extend for trailer) |
| REQ-EXEC-02 | commit carries gvc0 trailer | integration | `vitest run test/integration/worker-smoke.test.ts -t "trailer"` | ❌ Wave 0 |
| REQ-EXEC-03 | NDJSON schema validation + quarantine | unit | `vitest run test/unit/ipc/frame-schema.test.ts` | ❌ Wave 0 |
| REQ-EXEC-03 | malformed line quarantined not fatal | integration | `vitest run test/integration/worker-smoke.test.ts -t "malformed"` | ❌ Wave 0 |
| REQ-EXEC-03 | health_pong within timeout | integration | `vitest run test/integration/worker-smoke.test.ts -t "health"` | ❌ Wave 0 |
| REQ-EXEC-04 | retry policy transient vs semantic | unit | `vitest run test/unit/runtime/retry-policy.test.ts` | ❌ Wave 0 |
| REQ-EXEC-05 | worker cap gates concurrency | integration | existing pool test | ✅ (verify in `test/integration/harness/`) |
| Write pre-hook | path escape rejected | unit | existing `_fs` tests | ✅ (extend) |
| Write pre-hook | claim denied → task error | integration | `claim-lock-prehook.test.ts` | ✅ (already green) |
| Destructive op | push --force → approval stub | integration | `vitest run test/integration/destructive-op-approval.test.ts` | ❌ Wave 0 |
| Worktree mgr | remove idempotent | unit | `vitest run test/unit/runtime/worktree.test.ts` | ❌ Wave 0 |
| Worktree mgr | stale-lock sweep | unit | same | ❌ Wave 0 |
| Resume spike | scenario matrix | integration (spike) | `vitest run test/integration/spike/pi-sdk-resume.test.ts` | ❌ Wave 0 (spike) |

### Sampling Rate
- **Per task commit:** `npm run test:unit` (<10s target)
- **Per wave merge:** `npm run test`
- **Phase gate:** `npm run verify`

### Wave 0 Gaps
- [ ] `test/unit/ipc/frame-schema.test.ts` — REQ-EXEC-03 schema-validate + quarantine
- [ ] `test/unit/runtime/retry-policy.test.ts` — REQ-EXEC-04
- [ ] `test/unit/runtime/worktree.test.ts` — remove/prune/sweep
- [ ] `test/unit/agents/destructive-ops.test.ts` — pattern matching
- [ ] `test/integration/destructive-op-approval.test.ts` — end-to-end approval-stub path
- [ ] `test/integration/spike/pi-sdk-resume.test.ts` — spike scenario matrix harness
- [ ] Extend `test/integration/worker-smoke.test.ts` — trailer assertion, malformed-line path, health-ping path

## Security Domain

Phase 3 introduces worker-initiated filesystem + shell-command surfaces. ASVS V5 / V1 applicable.

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V1 Architecture | yes | Process isolation (one child per task); untrusted AI output stays inside worktree cwd |
| V2 Authentication | no (local-only) | — |
| V3 Session Management | partial | `sessionId` is random UUID (`crypto.randomUUID`); tied to agent run, not a user |
| V4 Access Control | yes | `claim_lock` enforces cross-task non-interference; `resolveInsideWorkdir` enforces path containment |
| V5 Input Validation | yes | Typebox validates every tool call arg (pi-sdk schema check) AND every IPC frame (NEW in 03-02) |
| V6 Cryptography | no | — |
| V12 Files/Resources | yes | Write pre-hook + destructive-op approval stub |
| V14 Configuration | yes | Model IDs + secrets threaded via env, not embedded in frames |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Mitigation |
|---------|--------|-----------|
| AI emits `rm -rf /` | Tampering / Elevation | `run_command` runs inside worktree cwd, not repo root; destructive-op detection catches common `git` variants (but NOT arbitrary `rm` — this is a KNOWN GAP for Phase 3 → document in open questions) |
| AI attempts `../../../etc/passwd` write | Tampering | `resolveInsideWorkdir` (tools/_fs.ts:46-53) |
| AI invokes `git push` to arbitrary remote | Information disclosure | Destructive-op patterns catch force-push; non-force `git push` is currently NOT blocked (acceptable? — open question) |
| Stdout pollution breaks IPC | Tampering (of IPC stream) | entry.ts:10-14 redirects console to stderr |
| Malformed frame crashes orchestrator | Denial of Service | Typebox quarantine-not-fatal (NEW in 03-02) |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Central agent loop in one process | One child process per task | Phase 3 core decision | OS-level isolation, crash containment |
| Zod everywhere | typebox for schemas over IPC/tool-args, Zod only for config | REQ-EXEC-03 lock | Single validator per subsystem |
| Filesystem-level git hooks for write gate | Tool-wrapping `claim_lock` round-trip | CONTEXT §D | Works across concurrent tasks on shared repo root |

**Deprecated / outdated patterns:**
- Wrapping `git commit` via a `commit-msg` hook — rejected per CONTEXT §F; tool-level shim is simpler.
- Using `spawn('node', script)` — `fork()` is the idiomatic Node child-process primitive for Node modules.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `child.on('exit')` alone is sufficient for lifecycle; no IPC FD needed | §User Constraints flip #2 | If IPC FD has a reliability advantage on some edge (e.g., parent dies without SIGCHLD), we'd need to revisit. Current faux tests don't exercise this. |
| A2 | Claim-lock RTT will be <5ms for happy path | §Write Pre-Hook | If higher, worker throughput suffers; need to measure in plan 03-02 |
| A3 | Destructive-op regex covers the operationally-relevant cases | §Destructive-Op Detection | Shell-expansion tricks like `git $VAR push --force` or aliases would evade; documented acceptable risk |
| A4 | `continue()` on assistant-last throws — behavior assumed stable across pi-sdk 0.66.x | §Pi-SDK Spike | If pi-sdk changes, spike needs to re-run; pin the minor version in package.json? |
| A5 | `inbox_item` stub schema is forward-compatible with Phase 7 | §Destructive-Op Detection | Phase 7 may want additional columns; keep JSON `payload` column flexible |
| A6 | Non-force `git push` (regular) is safe in a task worktree | §Security | A task worktree pushing to a remote is unusual but not destructive per the CONTEXT-defined list; acceptable |

## Open Questions

1. **`rm -rf` and other non-git destructive ops** — CONTEXT §D only enumerates git operations. Should the destructive-op detector also guard `rm -rf`, `find ... -delete`, `dd`, `mkfs`, etc.?
   - **Recommendation:** Phase 3 scope = CONTEXT-listed git patterns only. File a docs/concerns/ note for Phase 7 expansion.

2. **Frame-schema location — where does `claim_lock` live?** CONTEXT §C lists `claim_lock` / `lock_result` as in-scope for `WorkerFrameSchema`. But `contracts.ts:160-218` puts them inside the existing `OrchestratorToWorkerMessage` / `WorkerToOrchestratorMessage` unions.
   - **Recommendation:** Define the typebox schemas by mirroring `contracts.ts`; keep one union per direction. No new `WorkerFrameSchema` umbrella.

3. **Quarantine storage — in-memory ring vs persistent row?** CONTEXT §C says "in-memory ring + `Store.appendQuarantinedFrame()`" (both). Persistent SQLite writes add latency; is this worth it in Phase 3?
   - **Recommendation:** both, but make the Store path async-fire-and-forget; the ring is the authoritative source for debugging.

4. **Do we measure claim-lock RTT as part of plan 03-02, or defer to a performance phase?**
   - **Recommendation:** measure in 03-02 integration test (`performance.now()` around the round-trip); document number in RESEARCH; no explicit budget lock yet.

5. **Does CONTEXT §H's "expect rewrites in all 5 plans" override the 2,422 LOC of working code?**
   - **Recommendation:** flipped above (§User Constraints flip #3). Planner treats existing code as baseline-with-extensions.

6. **Model wiring — is `modelId` the right granularity, or do we need `{ provider, model }` pair?**
   - REQ-CONFIG-01 `ModelRef` already carries both (`src/config/schema.ts:15-19`). `entry.ts:35` only takes `modelId`; `resolveModel` needs both. Planner must thread **both** via env.
   - **Recommendation:** use `GVC0_TASK_MODEL_PROVIDER` + `GVC0_TASK_MODEL_ID`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | All | ✓ | ≥24 per package.json:8 | — |
| git CLI | worktree + commit trailer | ✓ | — (simple-git wraps) | — |
| better-sqlite3 compiled addon | Store | ✓ | 12.8.0 | — |
| tsx | worker fork `--import` | ✓ | 4.21.0 | — |
| ANTHROPIC_API_KEY | worker LLM calls | runtime | — | faux provider in tests |
| OPENAI_API_KEY | worker LLM calls | runtime | — | faux provider in tests |

All Phase 3 dependencies are code-level; no external services.

## Sources

### Primary (HIGH confidence)

- `/home/alpine/vcode0/node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` — `Agent` class surface
- `/home/alpine/vcode0/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts` — `AgentEvent`, `BeforeToolCallResult`, `AgentState`, `AgentTool`
- `/home/alpine/vcode0/node_modules/@mariozechner/pi-agent-core/package.json` — version 0.66.1
- `/home/alpine/vcode0/src/runtime/**` and `/home/alpine/vcode0/src/agents/worker/**` — full existing runtime (direct file reads cited throughout)
- `/home/alpine/vcode0/docs/architecture/worker-model.md` — authoritative IPC shape (aligned with `contracts.ts`)
- `/home/alpine/vcode0/docs/architecture/persistence.md` — SQLite schema expectations
- `/home/alpine/vcode0/.planning/REQUIREMENTS.md` lines 22-27, 61 — REQ-EXEC-01..05, REQ-CONFIG-01
- `/home/alpine/vcode0/.planning/ROADMAP.md` § Phase 3 — plan breakdown
- `/home/alpine/vcode0/test/integration/worker-smoke.test.ts` and `claim-lock-prehook.test.ts` — proven baseline

### Secondary (MEDIUM confidence)

- `node:child_process.fork` vs `spawn` semantics — Node.js docs (not re-fetched this session; training-based knowledge, stable surface).

### Tertiary (LOW confidence)

- `git --trailer` flag behavior — not directly verified in-session; commonly supported on git ≥2.32; plan 03-03 must verify on target environment.

## Metadata

**Confidence breakdown:**
- Pi-SDK API inventory: **HIGH** — read directly from installed `.d.ts` files.
- Existing runtime inventory: **HIGH** — file-by-file LOC and function-level citations.
- NDJSON + typebox design: **HIGH** — pattern already used for tool schemas.
- Destructive-op pattern set: **MEDIUM** — regex covers CONTEXT-listed ops; acknowledged gap for non-git ops.
- Retry policy surface: **MEDIUM** — module doesn't exist yet; design extrapolated from config + REQ-EXEC-04.
- Commit trailer: **MEDIUM** — `git --trailer` flag support assumed stable on modern git.
- Resume spike: **MEDIUM** — behavior is a SPIKE deliverable; assumptions clearly flagged as assumptions.

**Research date:** 2026-04-23
**Valid until:** 2026-05-23 (pi-sdk is the one moving surface; re-verify if pi-agent-core bumps minor).
