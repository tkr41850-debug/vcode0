# Existing-Plan Relevance Check — structured-growing-squid.md

## Plan summary

`structured-growing-squid.md` is a five-phase plan (A–E) to (1) unify the
orchestrator's dispatch surface so any harness can serve any scope (task,
feature-phase, ci_check) through a single `dispatchRun` call and (2) add a
`ClaudeCodeHarness` that spawns `claude -p` subprocesses, talks to the
orchestrator via an HTTP MCP server, and uses Claude Code hooks for
PreToolUse/PostToolUse coordination. The unifying thesis is "the orchestrator
should not care which agent runtime backs a phase." It is fundamentally a
**harness/runtime-pluralism** plan, not a **distribution** plan.

## Done sections (A, B)

### Phase A — Full dispatch unification (done)

A.1–A.16 collapse the three dispatch backends (`PiSdkHarness`,
`PiFeatureAgentRuntime`, `VerificationService`) and seven per-phase methods on
`OrchestratorPorts.agents` into a single `RuntimePort.dispatchRun(scope,
dispatch, payload)`. Concretely landed:

- `RunScope` / `RuntimeDispatch` / `DispatchRunResult` / `PhaseOutput` types
  in `src/runtime/contracts.ts`.
- `scopeRef` field on `OrchestratorToWorkerMessage` /
  `WorkerToOrchestratorMessage` envelopes (legacy `taskId` retained).
- `LocalWorkerPool.liveRuns` rekeyed from `taskId` to `agentRunId`; control
  methods (`steer`, `suspend`, `resume`, `respondToHelp`, `decideApproval`,
  `sendManualInput`, `respondClaim`, `abort`) all keyed on `agentRunId`.
- `FeaturePhaseBackend` interface; `PiSdkFeaturePhaseBackend` wraps the old
  in-process feature-phase runtime as a streaming `SessionHandle` so feature
  phases ride the same dispatch shape as tasks.
- Scheduler dispatch site (`src/orchestrator/scheduler/dispatch.ts`) collapsed
  to one `dispatchRun` call; per-scope payload assembly and event synthesis
  centralized.
- `PiFeatureAgentRuntime` renamed `FeaturePhaseOrchestrator`, retained for
  prompt/event/feature-row persistence helpers; `OrchestratorPorts.agents`
  removed.
- `recovery-service.ts` generalized to sweep any scope kind.

### Phase B — Config + persistence (done)

B.1–B.6 adds harness-aware config and persistence:

- `harness: { kind: 'pi-sdk' | 'claude-code', claudeCode?: {...} }` block on
  `GvcConfig` + loader.
- Migration `004_agent_run_harness_metadata.ts` adds `harness_kind`,
  `worker_pid`, `worker_boot_epoch`, `harness_meta_json` columns; pre-fills
  `harness_kind = 'pi-sdk'` on existing rows.
- `LocalWorkerPool.dispatchRun` records `worker_pid` / `worker_boot_epoch` /
  `harness_kind` on `agent_runs` rows.
- Reconciler kills runs whose `(worker_pid, worker_boot_epoch)` mismatch the
  current orchestrator boot.
- Task-worker model resolved via config (no more hardcoded id in
  `src/runtime/worker/entry.ts`); model id flows through `TaskPayload`.

### Phase C onward — not done

C (orchestration MCP HTTP server), D (`ClaudeCodeHarness` + hooks +
stream-json parser), and E (E2E + docs flip) are not started.

## Topical overlap with 02-distributed

**Partial, on different axes.** The two plans answer different questions:

| Axis | structured-growing-squid | 02-distributed |
|---|---|---|
| Primary problem | Multiple agent harnesses on one machine | Workers across many machines |
| Spawn model | Local fork / local subprocess | Network-addressable remote workers |
| FS model | Shared local disk assumed | No shared FS; bare repo is sync layer |
| IPC | Stdio NDJSON (and HTTP MCP for Claude Code) | WebSocket / network transport |
| Recovery | `worker_pid` + `worker_boot_epoch` on local boot | Heartbeat + leases + network liveness |
| Dispatch unification | Yes — collapses 3 backends to 1 | Assumes a unified `dispatchRun` already exists |

The overlap that matters: **02-distributed phase 2 step 2.4 (`RemoteSshHarness`)
implements `SessionHarness` / `FeaturePhaseBackend`** — the very seams
structured-growing-squid Phase A introduced. 02-distributed builds on Phase A's
dispatch unification as a starting assumption. The README of 02-distributed
even says "the changes cut across spawn model, filesystem model, scheduling, and
recovery" — none of which were the focus of the squid plan.

So: not "same problem space," but the squid plan's done work (A and B) is a
**de-facto prerequisite** of 02-distributed. 02-distributed phase 1 step 1.1's
opening claim that "`RuntimePort` is scope-aware dispatch + control" is only
true *because* Phase A landed. Phase B's `harness_kind` /
`worker_boot_epoch` columns on `agent_runs` are also assumed-existing
infrastructure: phase 2 step 2.4 cites a new `HarnessKind` discriminator
without re-landing the migration.

The unfinished parts (C, D, E — MCP server, ClaudeCodeHarness, stream-json)
are unrelated to distribution. They are about a *different harness*, not a
*distributed* harness.

## Reusable parts

### From done sections (A, B) — already in main, no work to lift

The 02-distributed track silently inherits these. No action needed; they are
already merged. Two specific places where the inheritance is worth being
explicit in the phase docs:

- **Phase 1 step 1.1**, defining `WorkerCapabilities.harnessKinds: readonly
  HarnessKind[]`, references the `HarnessKind` union added in squid Phase B.
  Worth a one-line "the union currently is `'pi-sdk'`; phase 2 of this track
  adds `'remote-ssh'`; the squid plan's Phase D will add `'claude-code'` (a
  separate, orthogonal track)" so reviewers do not assume the union is closed.
- **Phase 2 step 2.4** ("Worker addressing... the harness consumes a
  `WorkerLease` ... at `start` time") leans on the unified `SessionHarness`
  surface created in squid Phase A. Worth citing
  `src/runtime/harness/index.ts:48-54` as the contract being implemented, not
  introduced.

### From not-done sections (C, D, E) — limited, mostly unrelated

- **C.7 `/claim-lock` HTTP endpoint** for hook callers — irrelevant to
  02-distributed; that endpoint is for Claude Code's PreToolUse hook to talk
  back to the orchestrator. The 02-distributed track uses WebSocket frames for
  a different purpose.
- **D.5 `--session-id=<agentRunId>` pinning** — irrelevant; pi-sdk path
  already pins via separate prerequisite PR P.2.
- **D.11 feature-phase scope over `claude -p`** — there is *one* sentence
  worth flagging: it proves the streaming `SessionHandle` contract works
  across harness kinds. 02-distributed Phase 4 makes the same claim for remote
  feature-phase backends. The reasoning is generalizable: *if the streaming
  `SessionHandle` shape works for both an in-process and a subprocess feature
  phase, it should also work for a remote network feature phase.* Worth
  adding a "see also" pointer in 02-distributed Phase 4 to squid D.11 as
  prior art for the streaming-by-default design decision.
- **E.7's per-scope harness override flag** (deferred follow-up about routing
  short feature phases to a cheaper harness) — orthogonal but informative.
  02-distributed Phase 4 might want to keep the same shape of override —
  per-scope routing — so a "verify-on-local, plan-on-remote" config is later
  expressible.

Concretely:

- squid Phase A's streaming `SessionHandle` design → could be cited as
  prior art in **02-distributed phase 2 step 2.4** (`RemoteSshHarness.start`'s
  `onExit` semantics) and **phase 4** (remote feature-phase backend
  contract).
- squid D.11 (feature-phase over alternate harness) → could be cited as
  prior art in **02-distributed phase 4** as evidence the
  `FeaturePhaseBackend` seam is harness-agnostic.

That is the extent of cherry-pickable material. Nothing else lifts cleanly.

## Conflicts with 02-distributed non-negotiables

| Non-negotiable | Squid plan stance | Conflict? |
|---|---|---|
| No agents run on the orchestrator | Phase A deliberately keeps `FeaturePhaseOrchestrator` retained for prompt/persistence helpers; the in-process `PiSdkFeaturePhaseBackend` runs feature-phase agents *inside the orchestrator process* via the in-process backend | **Yes, in spirit.** Squid's checkpoint-end state has feature phases (planner, replanner, verifier, etc.) running in-process. 02-distributed phase 4's whole point is to retire that. They are not in direct contradiction — squid's design is a stepping stone — but anyone reading squid's "Rollout" section ("`FeaturePhaseOrchestrator` retained — harness-agnostic helpers still live there after Phase A") might assume that is the steady state. It is not, under 02-distributed. |
| Single orchestrator authority | Not addressed | None. |
| No shared FS between orchestrator and worker | Squid plan's local model assumes shared FS (forked children, `.gvc0/sessions/*.json`, local worktrees) | **Yes, structurally.** Squid Phase A's `LocalWorkerPool` and `PiSdkHarness` are inherently shared-FS designs. 02-distributed phase 2 step 2.3 explicitly retires the `FileSessionStore` shared-disk assumption with a `RemoteSessionStore` IPC proxy. That is a future evolution, not a contradiction with current squid behavior, but it does mean any code added in unfinished squid phases (C/D/E) that further entrenches local-FS assumptions would conflict. The MCP server in C runs on the orchestrator and worker hooks talk to it via HTTP — that part is already network-friendly and aligns. |
| Transport-agnostic ports | Squid plan keeps `RuntimePort` transport-agnostic; new HTTP MCP server is in a separate concrete implementation | None. Squid plan respects this. |
| No GitHub as operational sync | Not addressed | None. |

**Net:** no direct contradictions, but two areas of latent tension. (1) Squid
plan's "feature-phase backends can run in-process" is incompatible with
02-distributed phase 4's "no agents on orchestrator" end state — the squid
plan must eventually drop the in-process backend, and a future Claude Code
harness must always be remote-spawn (not in-orchestrator-process), which the
plan already implies but does not promise. (2) Squid C/D, if implemented
naively (orchestrator hosts an MCP HTTP server bound to localhost, worker
talks via stdio + hooks via localhost), would entrench the
shared-machine assumption. 02-distributed will need the MCP server to be
network-reachable by remote workers, or the `claude-code` harness will be
local-only forever. That is a future-design constraint to bake into squid C.2
if/when it is picked up: the HTTP server must bind to a network-reachable
host, not just `127.0.0.1`.

## Recommendation

**Cherry-pick — minimal.**

Phases A and B of `structured-growing-squid.md` are already merged on `main`
and silently underpin 02-distributed. Nothing to lift; the dependency is
implicit.

Phases C/D/E are an unrelated track (multiple agent runtimes on one
orchestrator, not multiple machines hosting one orchestrator's runtime). They
should not be folded into 02-distributed. The 02-distributed phase docs are
already tightly scoped and folding in MCP-server / stream-json / hook design
would dilute them with concerns that are orthogonal to distribution.

That said, two small, low-cost edits to the 02-distributed track would record
the relationship:

1. **02-distributed phase 1 step 1.1** — when defining
   `WorkerCapabilities.harnessKinds`, note that the union is open and that
   the `claude-code` harness from a separate (unfinished) track will extend
   it. Prevents reviewers assuming the union closes at `pi-sdk` +
   `remote-ssh`.
2. **02-distributed phase 2 step 2.4** and **phase 4 README** — cite the
   streaming `SessionHandle` design from squid Phase A as prior art for the
   `FeaturePhaseBackend` contract being harness-agnostic. One sentence.

The standalone `structured-growing-squid.md` file should remain where it is
(as a parked plan for the unfinished C/D/E work). It is not a candidate for
subsumption: its problem domain (one machine, multiple harnesses) is genuinely
different from 02-distributed's (multiple machines, one logical runtime).
Conflating them would produce a worse plan in both directions.

If/when squid C/D/E is picked up, the author should ensure (a) the MCP HTTP
server binds to a network-reachable host (not `127.0.0.1`) so future remote
workers can reach it, and (b) the `claude-code` harness assumes nothing about
shared filesystem with the orchestrator. Those constraints flow naturally
from 02-distributed's non-negotiables and should be honored in the squid
plan's later phases regardless of whether it is ever folded in here.
