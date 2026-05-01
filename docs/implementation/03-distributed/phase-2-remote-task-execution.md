# Phase 2 — Remote task execution

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-0-migration-consolidation (migration numbering baseline), phase-1-protocol-and-registry (`WorkerRegistry`, network IPC transport, `agent_runs.worker_id`, IPC schema validation gate)
- Default verify: npm run check:fix && npm run check
- Phase exit verify: npm run verify
- Phase exit smoke: Run the end-to-end remote-task test from step 2.7 against an in-process fake remote worker; confirm the task dispatches over the remote harness, the worker clones / commits / pushes, the centralized session store has a saved checkpoint, the orchestrator fetches and squash-merges, and the feature-branch tip is the squash commit.
- Doc-sweep deferred: none

Ships as 8 commits, in order.

## Contract

- Goal: move a single task end-to-end onto a remote worker. The orchestrator picks a registered remote worker, hands it a task, and that worker runs a real pi-sdk `Agent` loop on its own VM — talking back over a network IPC transport, pulling and pushing branches against an orchestrator-hosted bare git repo, and persisting session state through a storage layer that is not the orchestrator's local filesystem. The local-spawn path (`PiSdkHarness` forking via `child_process.fork` in `src/runtime/harness/index.ts:85+`) keeps working unchanged; local and remote dispatch coexist, with selection per-dispatch.
- Scope:
  - In:
    - Orchestrator-hosted bare git repo over ssh; workers `git fetch` / `git push` against it as their sole worktree-sync path.
    - `gvc0 repo init` admin command that creates `~/.gvc0/repos/<project-id>.git` (or a configured location), pushes current `main` plus existing feature branches, installs a `pre-receive` hook, and writes the chosen ssh URL into the project config block.
    - Worker-side worktree provisioner (`WorkerGitClient`) mirroring the local `GitWorktreeProvisioner` (`src/runtime/worktree/index.ts:12`) but running on the worker VM against its own clone of the bare repo.
    - Centralized session storage: `RemoteSessionStore` proxies `save` / `load` / `saveCheckpoint` / `delete` over IPC; the orchestrator-side handler writes through to a `SessionStore` instance.
    - Run-plane router on the registry server that forwards `run` frames to the right worker connection and routes inbound run-plane frames back to the harness sink by `agentRunId`.
    - `RemoteWsHarness` implementing the existing `SessionHarness` / `FeaturePhaseBackend` seams (`src/runtime/harness/index.ts:48+`) over the network transport.
    - `MultiHarnessPool` that picks `PiSdkHarness` vs `RemoteWsHarness` per run by `capabilities.transportKind`.
    - Branch sync-back: orchestrator fetches worker-pushed task-branch SHAs and feeds them into the existing squash-merge step in the integration coordinator (`src/orchestrator/integration/index.ts:78-117`).
    - End-to-end happy-path integration test against a faux remote worker.
  - Out:
    - More than one remote worker active at a time; the picker stays single-worker (phase-3-multi-worker-scheduling lifts this).
    - Feature-phase agents (`discuss` / `research` / `verify` / `plan` / `replan` / `summarize` still run on the orchestrator process; phase-4-remote-feature-phases).
    - Lease semantics; `worker_shutdown` and bare-close are dirty closes with no `onExit` (phase-5-leases-and-recovery wires takeover).
    - Fence-token enforcement on the wire; frames carry `fence: 0` placeholder (phase-5-leases-and-recovery flips enforcement on).
    - SSH key provisioning for the bare repo (operator concern; out of this track).
    - mTLS and worker-to-worker traffic (out of this track).
- Exit criteria:
  - All eight commits land in order on a feature branch.
  - `npm run verify` passes on the final commit.
  - The end-to-end test from step 2.7 runs green.
  - A final review subagent confirms the eight commits compose into one coherent transport seam: local and remote dispatch coexist, no path silently degrades to local when remote was requested, and no branch on the bare repo can be force-pushed by either side.
  - Open follow-ups are recorded in `docs/concerns/` if surfaced during review:
    - Multi-worker capacity and queueing → phase-3-multi-worker-scheduling.
    - Feature-phase agents to remote → phase-4-remote-feature-phases.
    - Lease-based recovery to replace pid/proc liveness → phase-5-leases-and-recovery.

## Plan

- Background: on the verified state, the spawn boundary at `src/runtime/harness/index.ts:85+` only knows local `child_process.fork`; the IPC framing at `src/runtime/ipc/index.ts:21+` accepts only stdio transport even though `IpcTransport` is interface-pluggable; frame schemas at `src/runtime/contracts.ts:339+` lack session-op variants; worktree provisioning at `src/runtime/worktree/index.ts:12` assumes orchestrator-local filesystem; session storage at `src/runtime/sessions/index.ts:46` only has `FileSessionStore` writing to local disk; the dispatch-transport selection at `src/orchestrator/scheduler/dispatch.ts:293-432` is single-harness; and the branch consumer at `src/orchestrator/integration/index.ts:78-117` reads `featureBranch` post-task assuming the local working tree is authoritative. The registry server from phase-1-protocol-and-registry currently accepts `register` / `heartbeat` / `reconnect` / `worker_shutdown` and drops every other frame, so a `run` frame has nowhere to go. This phase wires all seven seams into a coherent remote path, keeping local-spawn bit-identical at every checkpoint.

- Notes:
  - Filesystem model: the orchestrator owns the bare repo as the network-facing ref store. Workers never share filesystem with the orchestrator or with other workers. Worktrees, session files, and pid markers all need their assumptions reconsidered; this phase moves worktrees and sessions, leaves pid markers for phase-5-leases-and-recovery.
  - Worktree relocation: each worker keeps its own clone at `<worker-fs-root>/.gvc0/clones/<project-id>` and worktrees at `<worker-fs-root>/.gvc0/worktrees/<task-branch>`. `<worker-fs-root>` resolves from `GVC0_WORKER_FS_ROOT` or defaults to `~/.gvc0/worker`. The locking and disposal rules from `01-baseline/phase-4-recovery` carry over port-for-port; the orchestrator does not reach into the worker's filesystem.
  - Session authority: sessions live on the orchestrator side. Workers proxy reads/writes through `RuntimePort` over the IPC transport; later phases that introduce takeover (phase-5-leases-and-recovery) need no session migration because the new worker streams the same session ops as the old one. Implementation tracking lives in `docs/feature-candidates/runtime/centralized-conversation-persistence.md`.
  - Fence stamping: every state-mutating frame this phase introduces carries `fence: number`; workers stamp `0` until phase-5-leases-and-recovery flips enforcement. Read-only frames omit it.
  - Bare-close vs terminal-frame semantics: in the remote model the connection and the worker process are decoupled. Bare transport close is dirty (no `onExit`) so the lease layer in phase-5-leases-and-recovery owns cleanup via TTL expiry; only worker-initiated terminal frames (`result`, `error`) fire `onExit`. This is intentionally unlike `PiSdkHarness`'s `child.on('exit')` wiring at `src/runtime/harness/index.ts:247-252` where the kernel guarantees pipe-close ↔ child-exit equivalence. See `_archive/INVESTIGATION-architectural.md` §D15 and the squid-track Phase A streaming `SessionHandle` design for prior art.
  - Survey of code that moves:
    | Concern | File:line today | Why it changes |
    |---|---|---|
    | Spawn boundary | `src/runtime/harness/index.ts:85+` | New `RemoteWsHarness` next to `PiSdkHarness`. |
    | IPC framing | `src/runtime/ipc/index.ts:21+` | The phase-1-protocol-and-registry network transport plugs into the same `IpcTransport` interface. |
    | Frame schemas | `src/runtime/contracts.ts:339+` | Two new ops for centralized session storage; rest unchanged. |
    | Worktree provisioning | `src/runtime/worktree/index.ts:12` | Worker-side analogue ships in this phase. |
    | Session storage | `src/runtime/sessions/index.ts:46` | `FileSessionStore` becomes one of two `SessionStore` impls; centralized path added. |
    | Dispatch transport selection | `src/orchestrator/scheduler/dispatch.ts:293-432` | Picks `PiSdkHarness` vs. `RemoteWsHarness` per run. |
    | Branch consumer | `src/orchestrator/integration/index.ts:78-117` | Reads `featureBranch` post-task; relies on remote-pushed SHA being authoritative. |

## Steps

### 2.1 Orchestrator-hosted bare repo and admin command [risk: high, size: L]

What: every gvc0 project gets an orchestrator-side bare repo. Local worktrees keep using the working-tree clone they already use; the bare repo is the network-facing ref store for workers. Add a `gvc0 repo init` admin command that creates `~/.gvc0/repos/<project-id>.git` (or a configured location), pushes the current `main` plus every existing feature branch into it, and writes the chosen ssh URL into the project config block.

Git plane transport is **ssh** (per track README): `ssh://<host>/<path>.git`, no HTTP backend, no `git daemon`.

Ref naming and force-push rules:
  - Feature branch name on the bare repo matches the orchestrator's local name (`featureBranchName()` in `src/core/naming/index.ts:22`): `feat-<slug>-<feature-id>`.
  - Task branch name matches `taskBranchName()` / `resolveTaskWorktreeBranch()` (`src/core/naming/index.ts:30,38`): `feat-<slug>-<feature-id>-<task-id>`.
  - Branches are owned by their creator. The orchestrator pushes `main` and every feature branch; the worker pushes its task branch and only its task branch. The bare repo must reject `push --force` and `push --delete` from worker keys via a `pre-receive` hook installed by `gvc0 repo init`. Orchestrator key has the same restriction — there is no force-push path in this phase.
  - Every push is by namespace: workers can only push refs matching `refs/heads/feat-<slug>-<feature-id>-<task-id>` for the task they are currently dispatched to. The hook reads `agent_run_id` from a push option (`-o agent_run_id=<id>`); the orchestrator answers whether that id maps to that branch.

Files:
  - `src/orchestrator/git/bare-repo.ts` — new. `BareRepoLayout`, `ensureBareRepo(config)`, `installPreReceiveHook(...)`, `bareRepoSshUrl(layout, config)`. Pure path / fs / git-ops module.
  - `src/orchestrator/git/sync.ts` — new. `syncBranchToBare(branchName)` used by integration code to push `main` and feature branches into the bare repo. Wraps `simple-git`.
  - `src/cli/admin/repo-init.ts` — new. Wired into the existing CLI surface (alongside whatever admin entry points already exist; if none, this becomes the first one and the README pointer is added).
  - `src/config.ts` — add `distributed.bareRepo` block: `{ url, layout, enabled }`. When `enabled = false`, every later step in this phase short-circuits and the system stays local-only.

Tests:
  - `test/unit/orchestrator/git/bare-repo.test.ts` — `ensureBareRepo` on a tmp dir creates the right layout, idempotent on second call, pre-receive hook is executable and refuses a force-push in a fixture push session.
  - `test/unit/orchestrator/git/sync.test.ts` — push + reflect-back ref read-back round-trip against a tmp bare repo.

Review goals (cap 200 words):
  1. Verify the `pre-receive` hook rejects exactly force-pushes and deletions, and the rejection message names the offending ref.
  2. Flag any path where the orchestrator force-pushes.
  3. Flag any case where a worker key gets push access outside its task namespace.

Commit: feat(orchestrator/git): bare repo layout and ssh-only push contract
Rollback: `git revert` removes the code; if an operator already ran `gvc0 repo init`, the on-disk `~/.gvc0/repos/<project-id>.git` directory persists and must be `rm -rf`'d manually before re-init against the same path.

### 2.2 Worker-side git client [risk: high, size: L]

What: the worker's analogue to `GitWorktreeProvisioner`. On task dispatch, the worker clones from the bare repo (or fetches if its clone already exists), creates a worktree at `<worker-fs-root>/.gvc0/worktrees/<task-branch>` rooted at the feature branch HEAD, runs the task in it, and on completion pushes the task branch back to the bare repo. On task abort, it pushes whatever commits exist on the task branch (so the orchestrator can salvage work) but does **not** delete the branch or worktree.

The locking rules from `01-baseline/phase-4-recovery` carry over: worktrees survive across task attempts; `WIP snapshot` commits cover stale-worktree GC. On the worker side, the worktree manager applies the same disposal rules port-for-port — the orchestrator does not reach into the worker's filesystem to clean up.

Files:
  - `src/runtime/remote/worker-git.ts` — new. `WorkerGitClient` class with `ensureClone(bareUrl, projectId)`, `ensureFeatureCheckout(featureBranch, baseSha)`, `ensureTaskWorktree(taskBranch, featureBranch)`, `pushTaskBranch(taskBranch, agentRunId)`, `wipSnapshot(worktreePath)`. Mirrors the surface of `src/runtime/worktree/index.ts:7-10`.
  - `src/runtime/remote/worker-fs-root.ts` — new. Worker-side FS layout helpers; resolves `<worker-fs-root>` from `GVC0_WORKER_FS_ROOT` env or defaults to `~/.gvc0/worker`.
  - `src/runtime/remote/worker-entry-remote.ts` — new. Worker-side bootstrap that runs **on the worker VM**, not in the orchestrator tree, but lives in this repo because the worker binary ships from here. Mirrors `src/runtime/worker/entry.ts` but reads its task payload from the network IPC transport from phase-1-protocol-and-registry instead of stdin.

Tests:
  - `test/unit/runtime/remote/worker-git.test.ts` — clone + fetch + worktree-add round-trip against a tmp bare repo. Push authorization failure (force-push attempt) surfaces as a typed error, not a hang.
  - `test/integration/remote/worker-git-roundtrip.test.ts` — full cycle: orchestrator pushes feature branch → worker clones, worktrees, commits, pushes task branch → orchestrator reads back the pushed SHA via `git ls-remote`. Uses two tmp dirs and a tmp bare repo, no network.

Review goals (cap 200 words):
  1. Verify `pushTaskBranch` uses `-o agent_run_id=<id>` and is non-force.
  2. Verify abort leaves the task branch readable: commits intact, no force-reset.
  3. Flag any path that mutates a branch outside the task's namespace.

Commit: feat(runtime/remote): worker-side git client and worktree manager

### 2.3 Centralized session storage seam [risk: high, size: L]

What: centralize sessions on the orchestrator and stream session ops over IPC (option (a) in the track README). The worker calls `save` / `load` / `saveCheckpoint` via two new IPC frames; the orchestrator-side handler writes through to the existing `SessionStore`. One source of truth for resume across local and remote runs; phase-5-leases-and-recovery's lease/takeover needs this.

The new IPC frames:
  - Worker→Orchestrator: `session_op` (`save` / `saveCheckpoint` / `delete`) and `session_load_request` (correlation id, expects reply).
  - Orchestrator→Worker: `session_load_response` (correlation id, result envelope).

These must be added to the discriminated unions in `src/runtime/contracts.ts:412-468` and `:339-410` and to the TypeBox schemas added in the phase-1-protocol-and-registry IPC validation work.

`session_op` carries `fence: number` (workers stamp `0` until phase-5-leases-and-recovery step 5.5 flips enforcement). Read-only frames omit it.

Files:
  - `src/runtime/sessions/remote-proxy.ts` — new. `RemoteSessionStore` implements `SessionStore` by sending `session_op` frames and awaiting `session_load_response`. One outstanding load at a time per `agentRunId`; correlation ids are random per request.
  - `src/runtime/contracts.ts` — extend the message unions (and the schema mirror from phase-1-protocol-and-registry).
  - `src/runtime/sessions/orchestrator-side-handler.ts` — new. Adapter that lives orchestrator-side; receives `session_op` frames and forwards to a `SessionStore` instance. Constructed per-run and torn down on `result` / `error`.
  - `src/runtime/worker/entry.ts` and `worker-entry-remote.ts` — wire `RemoteSessionStore` instead of `FileSessionStore` when running in remote mode (selected by env or by an init-frame flag from phase-1-protocol-and-registry).

Tests:
  - `test/unit/runtime/sessions/remote-proxy.test.ts` — every `SessionStore` method round-trips through a fake transport; out-of-order responses route by correlation id; transport close rejects pending loads.
  - `test/integration/runtime/centralized-session.test.ts` — full loop: orchestrator-side handler + worker-side proxy backed by an in-memory transport. Save → reload returns the same checkpoint.

Review goals (cap 250 words):
  1. Verify `RemoteSessionStore` implements every `SessionStore` method with no silent no-op.
  2. Flag any path where session writes silently drop on transport close.
  3. Flag any case where the orchestrator-side handler leaves correlation tables behind after teardown.

Commit: feat(runtime/sessions): centralized session storage with IPC proxy

### 2.3.a Make live worker connections dispatchable [risk: high, size: L]

What: the phase-1-protocol-and-registry registry server (`src/runtime/registry/server.ts`) currently accepts `register` / `heartbeat` / `reconnect` / `worker_shutdown` and drops every other frame. To dispatch a task to a remote worker, the orchestrator needs to send a `run` frame over the same socket and route the worker's reply frames (`progress`, `result`, `error`, `manual_input`, `claim_lock`, `request_help`, `request_approval`, `session_op`) back to the harness that owns the run. This step extends the server with a `connection ↔ workerId` map (already stashed by `register` per phase-1-protocol-and-registry step 1.4) plus a run-plane router that forwards inbound run frames to the appropriate per-run handler and outbound `OrchestratorToWorkerMessage` frames to the right connection.

This is plumbing, not policy. The harness from step 2.4 plugs into the resulting `WorkerNetworkTransport` shape; the dispatcher in step 2.5 picks the worker; this step makes the channel bidirectional for run traffic.

Files:
  - `src/runtime/registry/server.ts` — extend the per-connection state with a `Map<agentRunId, RunFrameSink>` for the runs the worker is currently hosting. On inbound run-plane frame (`progress`, `result`, etc.), validate the discriminator against `WorkerToOrchestratorMessage`, look up the sink by `agentRunId`, and forward. On terminal frame, drop the entry.
  - `src/runtime/registry/run-router.ts` — new. `WorkerNetworkTransport` shape that exposes `dispatchRun(workerId, frame): Promise<void>` and `subscribeRun(agentRunId, sink): unsubscribe`. Internally consults the connection map.
  - `src/runtime/index.ts` — re-export `WorkerNetworkTransport`.

Tests:
  - `test/integration/runtime/registry-run-router.test.ts` — boot the registry server; connect a fake worker; register; subscribe a sink for a fake `agentRunId`; have the worker emit a `progress` frame; assert the sink fires. Have the orchestrator send a `run` frame; assert the worker receives it on the same socket.

Review goals (cap 350 words):
  1. Verify inbound frames addressed to an unknown `agentRunId` are dropped with a log, not silently swallowed.
  2. Verify the connection map survives `heartbeat` / `reconnect` cycles — a transient drop must not leave dangling sinks. The reconnect handler from phase-1-protocol-and-registry step 1.4 reattaches sinks for leases the worker still holds.
  3. Verify outbound `dispatchRun` against an unknown `workerId` returns a typed error, not `undefined`.
  4. Verify the router does not import any harness module — harness wiring belongs to step 2.4.

Commit: feat(runtime/registry): route run-plane frames to live worker connections

### 2.4 RemoteWsHarness [risk: high, size: L]

What: the remote analogue of `PiSdkHarness`. Implements `SessionHarness` (`src/runtime/harness/index.ts:48-54`) by addressing a worker over the phase-1-protocol-and-registry network IPC transport. `start(...)` and `resume(...)` send a `run` frame across the wire just like the local path.

`SessionHandle.onExit` semantics — diverges from local-spawn (per `_archive/INVESTIGATION-architectural.md` §D15):
  - **Bare transport close** (network drop, unclean worker exit, partition) is treated as **dirty**: log it, but do **not** fire `onExit`. The handle's `runStatus` stays `running`; the lease layer from phase-5-leases-and-recovery handles cleanup via TTL expiry. Firing `onExit` on bare close would terminate the run on every flap and contradicts the partition model where the worker is fine but unreachable.
  - **Worker-initiated terminal frame** (`result`, `error`) is the clean path: `onExit` fires with the terminal outcome.
  - **`worker_shutdown` voluntary release** (registry plane, see phase-1-protocol-and-registry step 1.2): the lease moves to `released` (phase-5-leases-and-recovery) and the run reroutes immediately without waiting for grace; this phase logs it and treats it as a dirty close (no `onExit`) since lease semantics are not yet wired.

This is intentionally *unlike* `PiSdkHarness`'s `child.on('exit')` wiring (`src/runtime/harness/index.ts:247-252`) where the kernel guarantees pipe-close ↔ child-exit equivalence. In the remote model the connection and the worker process are decoupled — see also the streaming `SessionHandle` design in the squid track Phase A (harness-agnostic backend with explicit terminal-frame contract) for prior art.

Worker addressing: phase-1-protocol-and-registry introduced a `WorkerRegistry`. The harness consumes a `WorkerLease` (or whatever phase-1-protocol-and-registry called the addressable handle) at `start` time. The harness does **not** own worker selection — the dispatcher does.

Files:
  - `src/runtime/harness/remote-ws.ts` — new. `RemoteWsHarness` class. Constructor takes the registry port from phase-1-protocol-and-registry, the `WorkerNetworkTransport` from step 2.3.a, and the centralized session-side handler factory from step 2.3.
  - `src/runtime/harness/index.ts` — re-export `RemoteWsHarness`. Touch the file only for the export; the existing `PiSdkHarness` class is unchanged.
  - `src/runtime/remote/worker-protocol.ts` — new. Worker-bootstrap frames (`worker_ready`, `worker_init_ack`) that ride on top of the phase-1-protocol-and-registry transport, so this harness knows when the worker is past its own startup. These frames stay separate from the task IPC unions in `contracts.ts` — they are connection-level, not task-level.

Tests:
  - `test/unit/runtime/harness/remote-ws.test.ts` — fake transport; assert `start` issues exactly one `run` frame, `abort` issues `abort`, terminal `result` fires `onExit` exactly once, **bare transport close does NOT fire `onExit`** (handle stays alive; only logs).
  - `test/integration/runtime/remote-harness-bootstrap.test.ts` — spin up a fake worker over an in-memory pipe; round-trip a worker_ready / run / progress / result sequence.

Review goals (cap 400 words):
  1. Verify `RemoteWsHarness` implements every method of `SessionHarness` and `SessionHandle` from `src/runtime/harness/index.ts:22-54` — no method silently stubbed.
  2. Verify `onExit` is wired ONLY to terminal `result` / `error` frames, NOT to bare transport close — bare close logs and lets the lease layer from phase-5-leases-and-recovery handle cleanup.
  3. Verify `harnessKind` reported by the handle is a new `HarnessKind` discriminator (added to `core/types`) so existing dispatch code that branches on `harnessKind` (e.g. recovery) can detect remote runs without inspecting an internal field.
  4. Verify the harness does not assume any local filesystem path — session state goes via step 2.3, worktrees via step 2.2.

Commit: feat(runtime/harness): RemoteWsHarness over network IPC

### 2.5 Dispatch transport selection [risk: high, size: L]

What: the dispatcher picks between `PiSdkHarness` and `RemoteWsHarness` per run. Selection rule:
  - A worker capability declared in phase-1-protocol-and-registry (`capabilities.transportKind` — `local-spawn` vs `remote-ws`) determines which harness can service that worker.
  - For each task ready to dispatch, the dispatcher asks the registry for the next available worker (single worker for now — phase-3-multi-worker-scheduling lifts this) and reads its capability.
  - If the chosen worker is local, dispatch goes through `PiSdkHarness` unchanged.
  - If the chosen worker is remote, dispatch goes through `RemoteWsHarness`.
  - Per-dispatch override is **not** added — selection is a worker property.

The transport-aware `LocalWorkerPool` (`src/runtime/worker-pool.ts:62+`) gets a wrapper that holds both harnesses and routes by worker capability. The `RuntimePort` surface (`src/runtime/contracts.ts:232+`) is unchanged — this phase keeps the seam stable.

Files:
  - `src/runtime/multi-harness-pool.ts` — new. `MultiHarnessPool` implements `RuntimePort`. Holds both harnesses, plus the registry port from phase-1-protocol-and-registry. Routes `dispatchRun` to the right backend per scope+worker. Reuses the live-runs / feature-phase-live-sessions bookkeeping pattern from `LocalWorkerPool` (lines 29-67) so the control surface (`abortRun`, `steerRun`, etc.) stays unchanged.
  - `src/orchestrator/scheduler/dispatch.ts` — call sites at lines 305 / 312 / 425 / 432 acquire the worker before dispatch and pass its id into the runtime port (additive; no signature break — the registry handle is read from a closure on the runtime impl).
  - `src/compose.ts` — wire `MultiHarnessPool` when `config.distributed.enabled === true`; otherwise keep `LocalWorkerPool` directly.
  - `src/orchestrator/scheduler/dispatch.ts:160-225` — `harnessKind` patch logic already accepts both kinds; double-check it matches the new `remote-ws` discriminator (phase-1-protocol-and-registry D2).

Tests:
  - `test/unit/runtime/multi-harness-pool.test.ts` — given a fake registry that returns either a local or remote worker, dispatch routes to the right harness and the live-runs bookkeeping is shared (e.g. `abortRun(agentRunId)` finds the run regardless of which harness owns it).
  - `test/integration/scheduler/dispatch-transport-selection.test.ts` — scheduler advances a feature with `distributed.enabled = true`, one local worker, one remote worker; confirm tasks go to the declared kinds.

Review goals (cap 200 words):
  1. Verify the live-runs map is shared so control ops route by `agentRunId` regardless of harness kind.
  2. Verify `compose.ts` falls back to `LocalWorkerPool` when `distributed.enabled = false`.
  3. Flag any place a remote dispatch falls back silently to local.

Commit: feat(runtime): MultiHarnessPool routes dispatch by worker capability

### 2.6 Branch sync-back into integration [risk: high, size: L]

What: make the orchestrator read worker-pushed task-branch SHAs back into its state, and feed them into the squash-merge step that already lives in the integration coordinator (`src/orchestrator/integration/index.ts:78-117`).

Remote runs `git fetch <bare> <task-branch>` first; local runs skip the fetch. Both converge on the same squash-merge call site.

Files:
  - `src/orchestrator/integration/task-merge.ts` — new (or extend the existing task-merge module if one exists; verify by Read first). Adds `mergeTaskBranchIntoFeature(task, source: 'local' | 'remote')`. For `remote`, fetches from the bare repo first.
  - `src/orchestrator/scheduler/events.ts` — terminal `result` handler reads the harnessKind on the run and routes through the new helper. No transport-specific code leaks above this layer.
  - `src/runtime/contracts.ts` — `result` frame may optionally carry `branchHeadSha` so the orchestrator can verify the fetched ref matches what the worker reports. Optional, not required, so the local path does not need to be updated.

Tests:
  - `test/integration/orchestrator/remote-task-merge.test.ts` — end-to-end: fake remote worker pushes a task branch, orchestrator fetches and squash-merges; resulting feature-branch SHA is reachable on the orchestrator and contains the worker's commit.
  - `test/unit/orchestrator/integration/task-merge.test.ts` — local vs. remote source paths produce the same final feature-branch state for an identical commit set.

Review goals (cap 400 words):
  1. Verify the remote path fetches before merge and verifies the fetched SHA matches `result.branchHeadSha` when the worker reports one — mismatch surfaces as a typed error, not a silent "merge whatever I just fetched".
  2. Verify the local path is bit-identical to baseline behavior — no code path moves through a fetch that previously did not.
  3. Verify `mergeTaskBranchIntoFeature` never force-pushes or rewrites history on the feature branch.
  4. Verify rebase-conflict handling in the integration coordinator (`src/orchestrator/integration/index.ts:178-194`) still owns conflict reroute, and the new helper does not duplicate it.

Commit: feat(orchestrator/integration): fetch and squash-merge remote task branches

### 2.7 End-to-end happy-path with a fake remote worker [risk: med, size: M]

What: an integration test that drives one full task through the remote path end to end, using an in-process "fake remote" worker (same harness wiring, same phase-1-protocol-and-registry network transport, same Node process). Crosses every seam: registry, harness, network IPC, worker-side git client, centralized session storage, dispatch routing, branch sync-back. Uses the `fauxModel` pattern from `test/integration/harness/`.

Files:
  - `test/integration/remote/remote-task-end-to-end.test.ts` — new. Spins up: a tmp bare repo with `main` and one feature branch; a registered remote worker (in-process); a `MultiHarnessPool` with `distributed.enabled = true`; one feature with one task. Drives the scheduler one tick, asserts: task dispatches over remote harness; worker clones / commits / pushes; centralized session store has a saved checkpoint; orchestrator fetches and squash-merges; feature branch tip is the squash commit; usage delta on `agent_runs` is non-empty.
  - `test/helpers/remote-fake.ts` — shared helper to spawn an in-process fake remote worker. Reusable in later phases of this track.

Tests: the file above is the test.

Review goals (cap 400 words):
  1. Verify the test actually exercises every seam introduced in this phase — bare repo, centralized session storage, `RemoteWsHarness`, `MultiHarnessPool`, branch sync-back — and is not silently bypassing one with a direct mock.
  2. Verify the assertion set covers branch state, session state, and `agent_runs` row state, not just "no exception thrown".
  3. Verify the fake-remote helper is reusable for later phases of this track (no test-private state baked into it).
  4. Verify the local-task integration tests still pass alongside this one — both transports coexist.

Commit: test(remote): end-to-end happy-path remote task execution

---
Shipped in <SHA1>..<SHA8> on <YYYY-MM-DD>
