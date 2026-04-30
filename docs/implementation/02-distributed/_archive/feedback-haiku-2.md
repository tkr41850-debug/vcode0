# Phase Review — Haiku 2, citation accuracy (02-distributed track)

## Critical issues (block landing)

- Phase 4 step 4.8 has a materially false migration note around verification.
  - The plan says `IntegrationCoordinator` at `src/orchestrator/integration/index.ts:54` does not call `VerificationService` directly and only consumes a `VerificationSummary` produced elsewhere.
  - On current `main`, `src/orchestrator/integration/index.ts:128-129` directly calls `this.deps.ports.verification.verifyFeature(feature)`.
  - If an implementer follows the current text literally and deletes the orchestrator-side verification body before moving that integration path, the merge/integration flow breaks.

- Phase 5’s lease-renewal framing is inconsistent with Phase 1 of the same track.
  - Phase 1 defines registry traffic as `register` / `register_ack` / `register_reject` / `heartbeat` / `heartbeat_ack` on a separate registry-frame family.
  - Phase 5 step 5.3 is written around extending a phase-1 `health_pong` frame.
  - That is not just naming drift: it points the reader at the wrong message family and the wrong schema extension point.

- Session-storage assumptions drift across phases in a way that changes recovery semantics.
  - Phase 2 step 2.3 explicitly chooses centralized orchestrator-owned session storage over IPC.
  - Phase 3 background/sticky-resume text still talks about “phase 2’s worker-side `FileSessionStore`”.
  - Phase 4 known-gaps text reintroduces a disk-backed `FileSessionStore` assumption and treats centralization as optional.
  - Sticky resume, takeover, and resumability checks need one consistent source of truth before implementation starts.

## Significant issues (worth addressing)

- Phase 1 has stale `src/compose.ts` line anchors.
  - `LocalWorkerPool` is not at `src/compose.ts:193-205`; the current instantiation is at `src/compose.ts:211-223`.
  - The shutdown lifecycle is not at `:237-244`; the current `stop` block begins at `src/compose.ts:255`.

- Phase 1 step 1.6 cites the wrong file path for the worker-model doc.
  - The plan cites `src/architecture/worker-model.md:439-461`.
  - The actual file is `docs/architecture/worker-model.md`, and the cited crash-recovery section is there.

- Phase 2’s “feature-phase agents still run locally” citations are off enough to slow implementation.
  - `DiscussFeaturePhaseBackend` is at `src/runtime/harness/feature-phase/index.ts:75`, not `:62`.
  - `FeaturePhaseOrchestrator` is at `src/agents/runtime.ts:177`, not `:68`.

- Phase 2 points at the wrong subsystem for pid/`/proc` recovery.
  - The plan cites `src/orchestrator/scheduler/dispatch.ts:164-186`.
  - Those lines only persist harness metadata.
  - The actual local pid/boot-epoch liveness logic is in `src/orchestrator/services/recovery-service.ts:809-844`.

- Phase 5’s bare-repo hook location does not match Phase 2’s proposed layout.
  - Phase 2 introduces bare-repo orchestration under `src/orchestrator/git/bare-repo.ts` and `src/orchestrator/git/sync.ts`.
  - Phase 5 step 5.5 switches to `src/runtime/git/bare-repo-hooks.ts`, a path that does not exist today and is not the path established earlier in the track.

- Phase 5 background understates what Phase 3 already plans to land.
  - Phase 5 says Phase 3 ownership remains “implicit”.
  - Phase 3 step 3.1 explicitly adds persisted `owner_worker_id` / `owner_assigned_at` columns to `agent_runs`.
  - That background text should be updated so the lease phase builds on the actual prior phase contract.

## Minor / nits

- Phase 1’s migration-number note is fine only if the reader keeps the baseline-merged assumption in mind. On current `main`, the next free migration is `010`, not `012`.

- Phase 2’s `SessionHarness` / `FeaturePhaseBackend` seam citation should be split.
  - `SessionHarness` is indeed in `src/runtime/harness/index.ts:48-54`.
  - `FeaturePhaseBackend` lives in `src/runtime/harness/feature-phase/index.ts`, not in that same line range.

- Phase 2’s task-branch naming sentence leans on `resolveTaskWorktreeBranch()` as though it enforces the canonical branch shape.
  - `taskBranchName()` matches the documented pattern.
  - `resolveTaskWorktreeBranch()` has a fallback (`feat-${task.featureId}-task-${task.id}`) that is not the same proof point.

- Phase 4’s TUI wiring citations are loose.
  - The plan references `src/compose.ts:180-190` and `src/tui/app.ts:71`.
  - The current `proposalOpSink` wiring is at `src/compose.ts:198-208`, and `TuiApp.onProposalOp` is at `src/tui/app.ts:355-376`.

- Several “new file” citations are sensible by parent directory, but not yet line-verifiable. That is fine; just avoid presenting them as if they are current-path anchors.

## Cross-phase inconsistencies

- Heartbeat frame naming drifts between phases.
  - Phase 1 uses `heartbeat` / `heartbeat_ack`.
  - Phase 5 uses `health_pong` and assumes it came from phase 1.
  - Pick one vocabulary and keep it through the full track.

- Migration numbering tells three different stories.
  - Current repo ends at `009`.
  - Phase 1 says the next free number is `012` after baseline reserves `010`/`011`.
  - Phase 3 step 3.1 says its new migration is `010`, with fallback renumbering logic.
  - Phase 5 uses `0NN` placeholders.
  - The track should state one numbering policy relative to the target branch, then use it consistently.

- Ownership progression is inconsistent.
  - Phase 2 prerequisites imply phase 1 already gives `agent_runs` a worker identity “or equivalent”.
  - Phase 3 says ownership becomes persisted there.
  - Phase 5 background walks that back to “implicit”.
  - The phase sequence should describe one monotonic evolution: registry identity → persisted owner columns → leases/fences.

- Session-storage ownership is inconsistent.
  - Phase 2 makes the orchestrator authoritative for sessions.
  - Phase 3 sticky-resume rationale assumes worker-hosted sessions.
  - Phase 4 known gaps partially reopens the question.
  - Recovery and takeover steps should all reference the same session model.

- Verification migration needs an explicit bridge.
  - Phase 4 wants remote verification to own the authoritative result.
  - Current integration still calls `VerificationService` directly.
  - The plan should say exactly when that call site is switched, not imply it is already abstracted away.

## Verification log

Sampled 30 citations across the five phase docs plus the track README. I did not exhaustively walk every cited file; new-file paths are marked as plausible when only the parent directory could be checked.

| phase | claimed citation | status |
|---|---|---|
| 1 | `src/runtime/worker-pool.ts:62-76` — `LocalWorkerPool` constructor is the only live task-execution path today | verified |
| 1 | `src/runtime/contracts.ts:232-337` — `RuntimePort` lives here and has no worker-target field today | verified |
| 1 | `src/runtime/ipc/index.ts:9-19` — `IpcTransport` / `ChildIpcTransport` stdio-only seam | verified |
| 1 | `src/persistence/migrations/` ends at `009`; “next free is 012” | plausible-not-checked |
| 1 | `src/compose.ts:193-205` — direct `LocalWorkerPool` instantiation (actual current block is `211-223`) | wrong-line |
| 1 | `src/architecture/worker-model.md:439-461` — crash-recovery section for doc update target | phantom |
| 2 | `src/runtime/harness/index.ts:85+` — local path still forks via `child_process.fork` | verified |
| 2 | `src/runtime/worktree/index.ts:12` — `GitWorktreeProvisioner` is the local worktree seam | verified |
| 2 | `src/runtime/sessions/index.ts:46` — `FileSessionStore` is the current disk-backed implementation | verified |
| 2 | `src/runtime/harness/feature-phase/index.ts:62` — local `DiscussFeaturePhaseBackend` citation (actual class starts at `75`) | wrong-line |
| 2 | `src/agents/runtime.ts:68` — local `FeaturePhaseOrchestrator` citation (actual class starts at `177`) | wrong-line |
| 2 | `src/orchestrator/scheduler/dispatch.ts:164-186` — local pid/`/proc` recovery model | wrong-file |
| 3 | `src/runtime/worker-pool.ts:572-574` — `idleWorkerCount()` is `maxConcurrency - liveRuns.size` | verified |
| 3 | `src/orchestrator/scheduler/dispatch.ts:797,813-816` — scheduler gates dispatch on one idle-worker integer | verified |
| 3 | `src/runtime/contracts.ts:239-244` — `dispatchRun(...)` has no worker hint today | verified |
| 3 | `src/orchestrator/scheduler/dispatch.ts:145-158` — `taskDispatchForRun` resumes by `sessionId` only | verified |
| 3 | `src/runtime/worktree/index.ts:12` — `GitWorktreeProvisioner` already takes an explicit project root | verified |
| 3 | `src/persistence/migrations/010_agent_run_owner_worker.ts` as the next free migration on current `main` | verified |
| 4 | `src/agents/runtime.ts:177` — `FeaturePhaseOrchestrator` is the in-process feature-phase surface | verified |
| 4 | `src/compose.ts:171` — orchestrator instantiation site (actual current block is `189-209`) | wrong-line |
| 4 | `src/agents/tools/proposal-host.ts:51` — `GraphProposalToolHost` definition | verified |
| 4 | `src/compose.ts:180-190` — `proposalOpSink` wiring to `UiPort` (actual current block is `198-208`) | wrong-line |
| 4 | `src/orchestrator/services/verification-service.ts:25` — orchestrator-side `verifyFeature()` currently runs shell checks locally | verified |
| 4 | `src/orchestrator/integration/index.ts:54` — “IntegrationCoordinator does not call VerificationService directly” (actual direct call is at `128-129`) | wrong-line |
| 5 | `src/orchestrator/services/recovery-service.ts:788-807` — `rebaseTaskWorktree` / `RECOVERY_REBASE` live here today | verified |
| 5 | `src/orchestrator/services/recovery-service.ts:809-844` — `killStaleWorkerIfNeeded` lives here today | verified |
| 5 | `src/persistence/migrations/009_agent_run_harness_metadata.ts:14-19` — `worker_pid` / `worker_boot_epoch` columns were added there | verified |
| 5 | `src/persistence/sqlite-store.ts:25-26,43-44,69-70,110,124-125,190-191` — pid/boot metadata is threaded through the store | verified |
| 5 | `src/runtime/git/bare-repo-hooks.ts` — planned pre-receive-hook location | phantom |
| 5 | `test/unit/orchestrator/recovery.test.ts:1145` — existing `RECOVERY_REBASE` assertion | verified |

## What the plan gets right

- The core runtime seam citations are mostly solid.
  - `RuntimePort` in `src/runtime/contracts.ts`
  - `LocalWorkerPool` in `src/runtime/worker-pool.ts`
  - `dispatchReadyWork` in `src/orchestrator/scheduler/dispatch.ts`
  - current pid/boot recovery in `src/orchestrator/services/recovery-service.ts`

- The proposal-host and feature-phase hotspots are correctly identified.
  - `GraphProposalToolHost` really is centered in `src/agents/tools/proposal-host.ts`.
  - `FeaturePhaseOrchestrator.createAgent()` really is the main in-process `new Agent(...)` site.
  - `proposalOpSink` really is the right seam to preserve for the TUI live mirror.

- The verification and worktree anchors are generally well chosen.
  - `VerificationService.verifyFeature()` is the current orchestrator-local shell runner.
  - `GitWorktreeProvisioner` and `FileSessionStore` are the right places to call out when describing filesystem-local assumptions.

- The new-file parents are sensible.
  - `src/runtime/`, `src/orchestrator/`, `test/integration/`, and `docs/architecture/` all exist and are credible landing zones for the proposed additions.

- Most line drift is routine maintenance drift, not evidence that the implementation plan picked the wrong subsystem.
  - Once the false verification statement and the cross-phase session/heartbeat inconsistencies are corrected, the rest looks like normal citation refresh work rather than plan redesign.
