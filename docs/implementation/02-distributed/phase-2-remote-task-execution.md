# Phase 2 — Remote task execution

## Goal

Move a single task end-to-end onto a remote worker. After this phase the
orchestrator can pick a registered remote worker, hand it a task, and have
that worker run a real pi-sdk `Agent` loop on its own VM — talking back over
a network IPC transport, pulling and pushing branches against an
orchestrator-hosted bare git repo, and persisting session state through a
storage layer that is not the orchestrator's local filesystem.

The local-spawn path (`PiSdkHarness` forking a child via
`child_process.fork` in `src/runtime/harness/index.ts:85+`) keeps working
unchanged. Local and remote dispatch coexist; selection happens
per-dispatch.

## Background and scope constraints

### What lands here

- Orchestrator hosts a bare git repo. Workers `git fetch` / `git push`
  against it as their sole worktree-sync path.
- A new `RemoteWsHarness` implements the existing `SessionHarness` /
  `FeaturePhaseBackend` seams (`src/runtime/harness/index.ts:48+`) over a
  network transport. Frame shapes still come from
  `src/runtime/contracts.ts:339+`.
- A worker-side worktree provisioner mirrors the local
  `GitWorktreeProvisioner` in `src/runtime/worktree/index.ts:12` but runs
  on the worker VM against its own clone of the bare repo.
- Session storage stops assuming shared local disk. This phase adopts the
  centralized-conversation-persistence candidate path: sessions live on
  the orchestrator behind a `SessionStore` port, and the worker streams
  session ops over the IPC channel rather than writing
  `.gvc0/sessions/*.json` on its VM.
- Dispatch picks transport per run based on a worker capability declared
  by the registry from phase 1.

### What stays out of phase 2 (state explicitly so reviewers don't expect it)

- **Multi-worker scheduling.** The dispatcher will only address one
  remote worker at a time. Capacity-aware fan-out is phase 3.
- **Feature-phase agents.** Planner, replanner, verifier, summarizer,
  researcher, discusser keep running locally through
  `DiscussFeaturePhaseBackend` (`src/runtime/harness/feature-phase/index.ts:75`)
  and `FeaturePhaseOrchestrator` (`src/agents/runtime.ts:177`). They move
  to remote dispatch in phase 4.
- **Recovery.** `worker_pid` / `workerBootEpoch` / `/proc/<pid>/environ`
  liveness on `agent_runs` (see `src/orchestrator/services/recovery-service.ts:809-844`)
  stay the recovery model in this phase. Remote runs are simply marked
  unrecoverable on orchestrator restart and rerouted via the existing
  retry paths. Phase 5 replaces this with leases.
- **Auth hardening / mTLS / cross-trust-boundary deployments.** Per the
  track non-negotiables; transport-level auth is whatever the chosen
  network transport ships with (ssh keys for the bare repo, transport
  auth from phase 1 for the IPC plane).
- **Worker-to-worker traffic.** All coordination flows through the
  orchestrator.

### Prerequisites from phase 1

Phase 1 has already shipped:

- A `WorkerRegistry` port and persisted worker rows.
- Worker registration handshake, heartbeat, and capacity declaration.
- Network IPC transport scaffold (the wire format question is decided in
  phase 1 — this phase consumes the chosen transport, it does not
  re-pick it).
- `agent_runs` carries `worker_id` (or equivalent) so a run can be
  joined back to the worker that hosted it.

If `phase-1-protocol-and-registry.md` has not landed yet, treat the
above bullets as the phase-1 contract that this plan will adopt.

### Survey of code that moves

| Concern | File:line today | Why it changes |
|---|---|---|
| Spawn boundary | `src/runtime/harness/index.ts:85+` | New `RemoteWsHarness` next to `PiSdkHarness`. |
| IPC framing | `src/runtime/ipc/index.ts:21+` | Phase 1's network transport plugs into the same `IpcTransport` interface. |
| Frame schemas | `src/runtime/contracts.ts:339+` | Two new ops for centralized session storage; rest unchanged. |
| Worktree provisioning | `src/runtime/worktree/index.ts:12` | Worker-side analogue ships in this phase. |
| Session storage | `src/runtime/sessions/index.ts:46` | `FileSessionStore` becomes one of two `SessionStore` impls; centralized path added. |
| Dispatch transport selection | `src/orchestrator/scheduler/dispatch.ts:293-432` | Picks `PiSdkHarness` vs. `RemoteWsHarness` per run. |
| Branch consumer | `src/orchestrator/integration/index.ts:78-117` | Reads `featureBranch` post-task; relies on remote-pushed SHA being authoritative. |

## Steps

The phase ships as **8 commits**. Each commit is one of the steps below.
Steps are ordered so the suite stays green between commits — local
spawn keeps working at every checkpoint.

---

### Step 2.1 — Orchestrator-hosted bare repo + admin command

**What:** every gvc0 project gets an orchestrator-side bare repo. Local
worktrees keep using the working-tree clone they already use; the bare
repo is the network-facing ref store for workers. Add a `gvc0 repo init`
admin command that creates `~/.gvc0/repos/<project-id>.git` (or a
configured location), pushes the current `main` plus every existing
feature branch into it, and writes the chosen ssh URL into the project
config block.

The transport for the git plane is **ssh** (recommended in the track
README). Workers reach the bare repo via `ssh://<host>/<path>.git`. No
HTTP backend, no `git daemon`. Justification: ssh is one config item
(authorized keys), preserves push-side auth without a separate
daemon, and survives behind a firewall the same way the IPC transport
will. If a deployment cannot run ssh, that becomes a follow-up; it does
not block the LAN-default case.

**Ref naming and force-push rules:**

- Feature branch name on the bare repo matches the orchestrator's local
  name (`featureBranchName()` in `src/core/naming/index.ts:22`):
  `feat-<slug>-<feature-id>`.
- Task branch name matches `taskBranchName()` /
  `resolveTaskWorktreeBranch()` (`src/core/naming/index.ts:30,38`):
  `feat-<slug>-<feature-id>-<task-id>`.
- Branches are owned by their creator. The orchestrator pushes `main`
  and every feature branch; the worker pushes its task branch and only
  its task branch. The bare repo must reject `push --force` and
  `push --delete` from worker keys via a `pre-receive` hook installed
  by `gvc0 repo init`. Orchestrator key has the same restriction —
  there is no force-push path in this phase.
- Every push is by namespace: workers can only push refs matching
  `refs/heads/feat-<slug>-<feature-id>-<task-id>` for the task they
  are currently dispatched to. The hook reads `agent_run_id` from a
  push option (`-o agent_run_id=<id>`); the orchestrator answers
  whether that id maps to that branch.

**Files:**

- `src/orchestrator/git/bare-repo.ts` — new. `BareRepoLayout`,
  `ensureBareRepo(config)`, `installPreReceiveHook(...)`,
  `bareRepoSshUrl(layout, config)`. Pure path / fs / git-ops module.
- `src/orchestrator/git/sync.ts` — new. `syncBranchToBare(branchName)`
  used by integration code to push `main` and feature branches into
  the bare repo. Wraps `simple-git`.
- `src/cli/admin/repo-init.ts` — new. Wired into the existing CLI
  surface (alongside whatever admin entry points already exist; if
  none, this becomes the first one and the README pointer is added).
- `src/config.ts` — add `distributed.bareRepo` block: `{ url, layout,
  enabled }`. When `enabled = false`, every later step in this phase
  short-circuits and the system stays local-only.

**Tests:**

- `test/unit/orchestrator/git/bare-repo.test.ts` — `ensureBareRepo`
  on a tmp dir creates the right layout, idempotent on second call,
  pre-receive hook is executable and refuses a force-push in a fixture
  push session.
- `test/unit/orchestrator/git/sync.test.ts` — push + reflect-back ref
  read-back round-trip against a tmp bare repo.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Review the `BareRepoLayout` work. Verify: (1) `ensureBareRepo` is
> idempotent and never deletes refs; (2) the `pre-receive` hook
> rejects exactly force-pushes and deletions, and the rejection
> message names the offending ref; (3) `bareRepoSshUrl` produces a
> URL the standard ssh client can resolve without extra config; (4)
> `gvc0 repo init` is safe to re-run on an existing project (no ref
> loss, no auth-key rewrite). Flag any path where the orchestrator
> writes a force-push, or any case where a worker key path is granted
> push access to a branch outside its task namespace. Under 350 words.

**Commit:** `feat(orchestrator/git): bare repo layout and ssh-only push contract`

---

### Step 2.2 — Worker-side git client

**What:** the worker's analogue to `GitWorktreeProvisioner`. On task
dispatch, the worker clones from the bare repo (or fetches if its
clone already exists), creates a worktree at
`<worker-fs-root>/.gvc0/worktrees/<task-branch>` rooted at the feature
branch HEAD, runs the task in it, and on completion pushes the task
branch back to the bare repo. On task abort, it pushes whatever
commits exist on the task branch (so the orchestrator can salvage
work) but does **not** delete the branch or worktree.

The locking rules from baseline phase 4 carry over: worktrees survive
across task attempts; `WIP snapshot` commits cover stale-worktree GC.
On the worker side, the worktree manager applies the same disposal
rules port-for-port — the orchestrator does not reach into the
worker's filesystem to clean up.

**Files:**

- `src/runtime/remote/worker-git.ts` — new. `WorkerGitClient` class
  with `ensureClone(bareUrl, projectId)`, `ensureFeatureCheckout(featureBranch, baseSha)`,
  `ensureTaskWorktree(taskBranch, featureBranch)`, `pushTaskBranch(taskBranch, agentRunId)`,
  `wipSnapshot(worktreePath)`. Mirrors the surface of
  `src/runtime/worktree/index.ts:7-10`.
- `src/runtime/remote/worker-fs-root.ts` — new. Worker-side FS layout
  helpers; resolves `<worker-fs-root>` from `GVC0_WORKER_FS_ROOT`
  env or defaults to `~/.gvc0/worker`.
- `src/runtime/remote/worker-entry-remote.ts` — new. Worker-side
  bootstrap that runs **on the worker VM**, not in the orchestrator
  tree, but lives in this repo because the worker binary ships from
  here. Mirrors `src/runtime/worker/entry.ts` but reads its task
  payload from the network IPC transport from phase 1 instead of
  stdin.

**Tests:**

- `test/unit/runtime/remote/worker-git.test.ts` — clone + fetch +
  worktree-add round-trip against a tmp bare repo. Push
  authorization failure (force-push attempt) surfaces as a typed
  error, not a hang.
- `test/integration/remote/worker-git-roundtrip.test.ts` — full
  cycle: orchestrator pushes feature branch → worker clones,
  worktrees, commits, pushes task branch → orchestrator reads back
  the pushed SHA via `git ls-remote`. Uses two tmp dirs and a tmp
  bare repo, no network.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Verify worker-side git: (1) `ensureClone` is idempotent — second
> call against an existing clone fetches and does not re-clone; (2)
> `ensureTaskWorktree` always branches from feature-branch HEAD as
> reported by the bare repo, never from a cached local SHA; (3)
> `pushTaskBranch` uses non-force push and tags the push with
> `-o agent_run_id=<id>` so the bare-repo hook can authorize; (4) on
> abort, the task branch is left in a state the orchestrator can
> read (commits intact, no force-reset). Flag any path that mutates
> a branch outside the task's namespace. Under 350 words.

**Commit:** `feat(runtime/remote): worker-side git client and worktree manager`

---

### Step 2.3 — Centralized session storage seam

**What:** decide and implement the session-storage shape. The
decision: **centralize sessions on the orchestrator and stream
session ops over IPC** — option (a) in the track README. The worker
calls `save` / `load` / `saveCheckpoint` via two new IPC frames; the
orchestrator-side handler writes through to the existing `SessionStore`
implementation.

Justification:

- One source of truth for resume across local and remote runs. The
  centralized-conversation-persistence candidate already calls this
  out as the eventual shape; phase 2 is a forced trigger to land it
  at minimum coverage for task scope.
- Recovery semantics stay the same: `agent_runs.session_id` keeps
  pointing at one location, regardless of which worker hosted the
  run. Phase 5's lease/takeover work needs this to be true.
- Worker filesystems are treated as scratch. Nothing on the worker
  is authoritative.
- Per the `centralized-conversation-persistence.md` candidate, the
  baseline `SessionStore` interface (`src/runtime/sessions/index.ts:35-44`)
  is already provider-agnostic; we add a remote-side proxy
  implementation, not a new contract.

The new IPC frames:

- Worker→Orchestrator: `session_op` (`save` / `saveCheckpoint` /
  `delete`) and `session_load_request` (correlation id, expects
  reply).
- Orchestrator→Worker: `session_load_response` (correlation id,
  result envelope).

These must be added to the discriminated unions in
`src/runtime/contracts.ts:412-468` and `:339-410` and to the
TypeBox schemas added in phase 1's IPC validation work.

`session_op` is state-mutating and therefore carries `fence: number` per the
README "Fence tokens" cross-cutting decision. The field is declared in
this step's schema so phase 5 step 5.5 can flip enforcement on without a
schema migration. Until phase 5 lands, the orchestrator-side handler accepts
any fence value (workers stamp `0`); after phase 5, mismatched fences are
dropped. `session_load_request` and `session_load_response` are read-only and
do not carry a fence.

**Files:**

- `src/runtime/sessions/remote-proxy.ts` — new. `RemoteSessionStore`
  implements `SessionStore` by sending `session_op` frames and
  awaiting `session_load_response`. One outstanding load at a time
  per `agentRunId`; correlation ids are random per request.
- `src/runtime/contracts.ts` — extend the message unions (and the
  schema mirror from phase 1).
- `src/runtime/sessions/orchestrator-side-handler.ts` — new.
  Adapter that lives orchestrator-side; receives `session_op`
  frames and forwards to a `SessionStore` instance. Constructed
  per-run and torn down on `result` / `error`.
- `src/runtime/worker/entry.ts` and `worker-entry-remote.ts` — wire
  `RemoteSessionStore` instead of `FileSessionStore` when running
  in remote mode (selected by env or by an init-frame flag from
  phase 1).

**Tests:**

- `test/unit/runtime/sessions/remote-proxy.test.ts` — every
  `SessionStore` method round-trips through a fake transport;
  out-of-order responses route by correlation id; transport close
  rejects pending loads.
- `test/integration/runtime/centralized-session.test.ts` — full
  loop: orchestrator-side handler + worker-side proxy backed by an
  in-memory transport. Save → reload returns the same checkpoint.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Verify centralized session storage: (1) `RemoteSessionStore`
> implements every method of `SessionStore` from
> `src/runtime/sessions/index.ts:35` with no method silently
> downgraded to a no-op; (2) load correlation id collisions are
> impossible (random + per-run scope) or detected; (3) the
> orchestrator-side handler tears down on `result` / `error` /
> transport close, with no leaked correlation tables; (4) frame
> schemas added to `contracts.ts` are mirrored in the phase-1 TypeBox
> validator. Flag any path where session writes silently drop on
> transport close. Under 400 words.

**Commit:** `feat(runtime/sessions): centralized session storage with IPC proxy`

---

### Step 2.3.5 — Make live worker connections dispatchable

**What:** phase 1's registry server (`src/runtime/registry/server.ts`) currently accepts `register` / `heartbeat` / `reconnect` / `worker_shutdown` and drops every other frame. To dispatch a task to a remote worker, the orchestrator needs to send a `run` frame over the same socket and route the worker's reply frames (`progress`, `result`, `error`, `manual_input`, `claim_lock`, `request_help`, `request_approval`, `session_op`) back to the harness that owns the run. This step extends the server with a `connection ↔ workerId` map (already stashed by `register` per phase 1 step 1.4) plus a run-plane router that forwards inbound run frames to the appropriate per-run handler and outbound `OrchestratorToWorkerMessage` frames to the right connection.

This is plumbing, not policy. The harness from step 2.4 plugs into the resulting `WorkerNetworkTransport` shape; the dispatcher in step 2.5 picks the worker; this step makes the channel bidirectional for run traffic.

**Files:**

- `src/runtime/registry/server.ts` — extend the per-connection state with a `Map<agentRunId, RunFrameSink>` for the runs the worker is currently hosting. On inbound run-plane frame (`progress`, `result`, etc.), validate the discriminator against `WorkerToOrchestratorMessage`, look up the sink by `agentRunId`, and forward. On terminal frame, drop the entry.
- `src/runtime/registry/run-router.ts` — new. `WorkerNetworkTransport` shape that exposes `dispatchRun(workerId, frame): Promise<void>` and `subscribeRun(agentRunId, sink): unsubscribe`. Internally consults the connection map.
- `src/runtime/index.ts` — re-export `WorkerNetworkTransport`.

**Tests:**

- `test/integration/runtime/registry-run-router.test.ts` — boot the registry server; connect a fake worker; register; subscribe a sink for a fake `agentRunId`; have the worker emit a `progress` frame; assert the sink fires. Have the orchestrator send a `run` frame; assert the worker receives it on the same socket.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Verify the run-plane router: (1) inbound frames addressed to an unknown `agentRunId` are dropped with a log, not silently swallowed; (2) the connection map survives `heartbeat` / `reconnect` cycles — a transient drop must not leave dangling sinks (the reconnect handler from phase 1 step 1.4 reattaches sinks for leases the worker still holds); (3) outbound `dispatchRun` against an unknown `workerId` returns a typed error, not `undefined`; (4) the router does not import any harness module — harness wiring belongs to step 2.4. Under 350 words.

**Commit:** `feat(runtime/registry): route run-plane frames to live worker connections`

---

### Step 2.4 — `RemoteWsHarness`

**What:** the remote analogue of `PiSdkHarness`. Implements
`SessionHarness` (`src/runtime/harness/index.ts:48-54`) by
addressing a worker over the phase-1 network IPC transport.
`start(...)` and `resume(...)` send a `run` frame across the wire
just like the local path.

**`SessionHandle.onExit` semantics — diverges from local-spawn (per `INVESTIGATION-architectural.md` §D15):**

- **Bare transport close** (network drop, unclean worker exit, partition) is treated as **dirty**: log it, but do **not** fire `onExit`. The handle's `runStatus` stays `running`; the lease layer (phase 5) handles cleanup via TTL expiry. Firing `onExit` on bare close would terminate the run on every flap and contradicts the partition model where the worker is fine but unreachable.
- **Worker-initiated terminal frame** (`result`, `error`) is the clean path: `onExit` fires with the terminal outcome.
- **`worker_shutdown` voluntary release** (registry plane, see phase 1 step 1.2): the lease moves to `released` (phase 5) and the run reroutes immediately without waiting for grace; phase 2 logs it and treats it as a dirty close (no `onExit`) since lease semantics are not yet wired.

This is intentionally *unlike* `PiSdkHarness`'s `child.on('exit')` wiring (`src/runtime/harness/index.ts:247-252`) where the kernel guarantees pipe-close ↔ child-exit equivalence. In the remote model the connection and the worker process are decoupled — see also the streaming `SessionHandle` design in the squid track Phase A (harness-agnostic backend with explicit terminal-frame contract) for prior art.

Worker addressing: phase 1 introduced a `WorkerRegistry`. The
harness consumes a `WorkerLease` (or whatever phase 1 called the
addressable handle) at `start` time. The harness does **not** own
worker selection — the dispatcher does.

**Files:**

- `src/runtime/harness/remote-ws.ts` — new. `RemoteWsHarness`
  class. Constructor takes the registry port from phase 1, the `WorkerNetworkTransport` from step 2.3.5, and the
  centralized session-side handler factory from step 2.3.
- `src/runtime/harness/index.ts` — re-export `RemoteWsHarness`.
  Touch the file only for the export; the existing `PiSdkHarness`
  class is unchanged.
- `src/runtime/remote/worker-protocol.ts` — new. Worker-bootstrap
  frames (`worker_ready`, `worker_init_ack`) that ride on top of
  the phase-1 transport, so this harness knows when the worker is
  past its own startup. These frames stay separate from the task
  IPC unions in `contracts.ts` — they are connection-level, not
  task-level.

**Tests:**

- `test/unit/runtime/harness/remote-ws.test.ts` — fake transport;
  assert `start` issues exactly one `run` frame, `abort` issues
  `abort`, terminal `result` fires `onExit` exactly once, **bare transport close does NOT fire `onExit`** (handle stays alive; only logs).
- `test/integration/runtime/remote-harness-bootstrap.test.ts` —
  spin up a fake worker over an in-memory pipe; round-trip a
  worker_ready / run / progress / result sequence.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Verify `RemoteWsHarness`: (1) implements every method of
> `SessionHarness` and `SessionHandle` from
> `src/runtime/harness/index.ts:22-54` — no method silently
> stubbed; (2) `onExit` is wired ONLY to terminal `result` / `error` frames, NOT to bare transport close — bare close logs and lets the lease layer handle cleanup (phase 5); (3) `harnessKind` reported by the handle is a new
> `HarnessKind` discriminator (added to `core/types`) so existing
> dispatch code that branches on `harnessKind` (e.g. recovery)
> can detect remote runs without inspecting an internal field;
> (4) the harness does not assume any local filesystem path —
> session state goes via step 2.3, worktrees via step 2.2. Under
> 400 words.

**Commit:** `feat(runtime/harness): RemoteWsHarness over network IPC`

---

### Step 2.5 — Dispatch transport selection

**What:** the dispatcher picks between `PiSdkHarness` and
`RemoteWsHarness` per run. Selection rule:

- A worker capability declared in phase 1 (`worker.capabilities` —
  e.g. `local-spawn` vs. `remote-ssh`) determines which harness can
  service that worker.
- For each task ready to dispatch, the dispatcher asks the registry
  for the next available worker (single worker for now — multi-worker
  is phase 3) and reads its capability.
- If the chosen worker is local, dispatch goes through `PiSdkHarness`
  unchanged.
- If the chosen worker is remote, dispatch goes through
  `RemoteWsHarness`.
- Per-dispatch override is **not** added — selection is a property of
  the worker, not the dispatch. (Per-dispatch flags would push
  scheduling decisions into runtime-construction code; we want them
  in one place. Phase 3's capacity-aware dispatcher is the right
  layer to extend if a "force-local" knob ever becomes necessary.)

The transport-aware `LocalWorkerPool` (`src/runtime/worker-pool.ts:62+`)
gets a wrapper that holds both harnesses and routes by worker
capability. The `RuntimePort` surface (`src/runtime/contracts.ts:232+`)
is unchanged — phase 2 keeps the seam stable.

**Files:**

- `src/runtime/multi-harness-pool.ts` — new. `MultiHarnessPool`
  implements `RuntimePort`. Holds both harnesses, plus the registry
  port from phase 1. Routes `dispatchRun` to the right backend per
  scope+worker. Reuses the live-runs / feature-phase-live-sessions
  bookkeeping pattern from `LocalWorkerPool` (lines 29-67) so the
  control surface (`abortRun`, `steerRun`, etc.) stays unchanged.
- `src/orchestrator/scheduler/dispatch.ts` — call sites at lines
  305 / 312 / 425 / 432 acquire the worker before dispatch and pass
  its id into the runtime port (additive; no signature break — the
  registry handle is read from a closure on the runtime impl).
- `src/compose.ts` — wire `MultiHarnessPool` when
  `config.distributed.enabled === true`; otherwise keep
  `LocalWorkerPool` directly.
- `src/orchestrator/scheduler/dispatch.ts:160-225` — `harnessKind`
  patch logic already accepts both kinds; double-check it matches
  the new `remote-ssh` discriminator.

**Tests:**

- `test/unit/runtime/multi-harness-pool.test.ts` — given a fake
  registry that returns either a local or remote worker, dispatch
  routes to the right harness and the live-runs bookkeeping is
  shared (e.g. `abortRun(agentRunId)` finds the run regardless of
  which harness owns it).
- `test/integration/scheduler/dispatch-transport-selection.test.ts`
  — scheduler advances a feature with `distributed.enabled = true`,
  one local worker, one remote worker; confirm tasks go to the
  declared kinds.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Verify transport selection: (1) `MultiHarnessPool` exposes the
> exact same `RuntimePort` surface — no extra public methods leak
> in; (2) the live-runs map is shared so control ops route by
> `agentRunId` regardless of harness kind; (3) `compose.ts` falls
> back to `LocalWorkerPool` when `distributed.enabled = false`,
> and the regression-test path for the local-only baseline still
> exercises the unchanged class; (4) no call site in
> `dispatch.ts` hard-codes `PiSdkHarness`. Flag any place a remote
> dispatch falls back silently to local. Under 350 words.

**Commit:** `feat(runtime): MultiHarnessPool routes dispatch by worker capability`

---

### Step 2.6 — Branch sync-back into integration

**What:** make the orchestrator read worker-pushed task-branch SHAs
back into its state, and feed them into the squash-merge step that
already lives in the integration coordinator
(`src/orchestrator/integration/index.ts:78-117`).

Local task workers commit on the local feature-branch worktree
directly; remote workers commit on a worktree on a different machine
and push the resulting branch to the bare repo. The integration
path needs a single shape for "where does the post-task SHA come
from?". The answer:

- After a remote task's terminal `result` frame, the harness fetches
  the task branch from the bare repo into the orchestrator's local
  feature-branch worktree (`git fetch <bare> <task-branch>`), then
  performs the same squash-merge against the feature branch that the
  local path uses.
- After a local task's terminal `result` frame, the existing path
  runs unchanged — no fetch needed; the branch is already on local
  disk.

Both paths converge on the same squash-merge call site.

**Files:**

- `src/orchestrator/integration/task-merge.ts` — new (or extend the
  existing task-merge module if one exists; verify by Read first).
  Adds `mergeTaskBranchIntoFeature(task, source: 'local' | 'remote')`.
  For `remote`, fetches from the bare repo first.
- `src/orchestrator/scheduler/events.ts` — terminal `result` handler
  reads the harnessKind on the run and routes through the new helper.
  No transport-specific code leaks above this layer.
- `src/runtime/contracts.ts` — `result` frame may optionally carry
  `branchHeadSha` so the orchestrator can verify the fetched ref
  matches what the worker reports. Optional, not required, so the
  local path does not need to be updated.

**Tests:**

- `test/integration/orchestrator/remote-task-merge.test.ts` —
  end-to-end: fake remote worker pushes a task branch, orchestrator
  fetches and squash-merges; resulting feature-branch SHA is
  reachable on the orchestrator and contains the worker's commit.
- `test/unit/orchestrator/integration/task-merge.test.ts` — local
  vs. remote source paths produce the same final feature-branch
  state for an identical commit set.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Verify branch sync-back: (1) the remote path fetches before merge
> and verifies the fetched SHA matches `result.branchHeadSha` when
> the worker reports one — mismatch surfaces as a typed error, not
> a silent "merge whatever I just fetched"; (2) the local path is
> bit-identical to baseline behavior — no code path moves through a
> fetch that previously did not; (3) `mergeTaskBranchIntoFeature`
> never force-pushes or rewrites history on the feature branch; (4)
> rebase-conflict handling in the integration coordinator
> (`src/orchestrator/integration/index.ts:178-194`) still owns
> conflict reroute, and the new helper does not duplicate it. Under
> 400 words.

**Commit:** `feat(orchestrator/integration): fetch and squash-merge remote task branches`

---

### Step 2.7 — End-to-end happy-path with a fake remote worker

**What:** an integration test that drives one full task through the
remote path, end to end, using an in-process "fake remote" worker —
same harness wiring, same network transport from phase 1, but the
remote endpoint runs in the same Node process as the orchestrator
behind a transport that simulates the wire.

This is a sanity check, not a phase blocker — but it is the only
test in this phase that crosses every seam: registry, harness,
network IPC, worker-side git client, centralized session storage,
dispatch routing, branch sync-back. Without it, every previous
step's tests pass in isolation while the system as a whole could
silently regress on a wiring mistake.

The fauxModel pattern from `test/integration/harness/` covers the
agent loop — same `FauxResponse` script as a local-task integration
test, just running through the new remote stack.

**Files:**

- `test/integration/remote/remote-task-end-to-end.test.ts` — new.
  Spins up: a tmp bare repo with `main` and one feature branch; a
  registered remote worker (in-process); a `MultiHarnessPool` with
  `distributed.enabled = true`; one feature with one task. Drives
  the scheduler one tick, asserts: task dispatches over remote
  harness; worker clones / commits / pushes; centralized session
  store has a saved checkpoint; orchestrator fetches and
  squash-merges; feature branch tip is the squash commit; usage
  delta on `agent_runs` is non-empty.
- `test/helpers/remote-fake.ts` — shared helper to spawn an
  in-process fake remote worker. Reusable in phases 3-5.

**Tests:** the file above is the test.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent prompt:**

> Review the end-to-end remote task test. Verify: (1) it actually
> exercises every seam introduced in this phase — bare repo,
> centralized session storage, `RemoteWsHarness`, `MultiHarnessPool`,
> branch sync-back — and is not silently bypassing one with a
> direct mock; (2) the assertion set covers branch state, session
> state, and `agent_runs` row state, not just "no exception
> thrown"; (3) the fake-remote helper is reusable for phases 3-5
> (no test-private state baked into it); (4) the local-task
> integration tests still pass alongside this one — both transports
> coexist. Under 400 words.

**Commit:** `test(remote): end-to-end happy-path remote task execution`

---

## Phase exit criteria

- All eight commits land in order on a feature branch.
- `npm run verify` passes on the final commit.
- The end-to-end test from step 2.7 runs green.
- A final review subagent confirms the eight commits compose into
  one coherent transport seam — local and remote dispatch coexist,
  no path silently degrades to local when remote was requested,
  and no branch on the bare repo can be force-pushed by either
  side. Address findings before declaring the phase complete.
- Open follow-ups for the next phases are recorded in
  `docs/concerns/` if surfaced during review:
  - Multi-worker capacity and queueing → phase 3.
  - Feature-phase agents to remote → phase 4.
  - Lease-based recovery to replace pid/proc liveness → phase 5.
