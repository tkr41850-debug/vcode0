# Phase 9: Crash Recovery UX - Research

**Researched:** 2026-04-29
**Domain:** Crash recovery, worktree reconciliation, and replay-based worker respawn in a local TypeScript orchestrator [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts]
**Confidence:** HIGH

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-STATE-02 | Seamless auto-resume on orchestrator crash — restart rehydrates from SQLite, re-spawns workers for in-flight tasks, replays transcripts where needed, surfaces a recovery-summary inbox item; user sees live state rather than a triage dialog [VERIFIED: .planning/REQUIREMENTS.md] | Existing session persistence, tool-output replay, PID storage, and inbox plumbing already ship; missing work is boot-time lock/orphan reconciliation, recovery-summary surfacing, and kill-9 recovery coverage [VERIFIED: src/runtime/sessions/index.ts][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/compose.ts][VERIFIED: test/integration/persistence/rehydration.test.ts] |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Keep crash-recovery work inside existing architecture boundaries; `@core/*` stays pure, while implementation should primarily land under `@orchestrator/*`, `@runtime/*`, `@persistence/*`, and `@tui/*` [VERIFIED: CLAUDE.md].
- Preserve the existing single-package TypeScript ESM setup with Node `>=24`, strict typing, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` [VERIFIED: CLAUDE.md][VERIFIED: package.json].
- Use Vitest for unit and non-TUI integration coverage, and use the repo’s faux-backed integration style rather than live API calls [VERIFIED: CLAUDE.md][VERIFIED: docs/operations/testing.md].
- Follow current path-alias boundaries and avoid introducing cross-layer imports that would make `@core/*` depend on runtime, persistence, or TUI code [VERIFIED: CLAUDE.md][VERIFIED: ARCHITECTURE.md].
- Treat `npm run check` as the repo-wide verification gate; `vitest.config.ts` excludes `test/integration/tui/**` from the default test run, so crash-recovery gating should not depend on that lane [VERIFIED: CLAUDE.md][VERIFIED: package.json][VERIFIED: vitest.config.ts].
- The separate `@microsoft/tui-test` lane exists for PTY smoke coverage, but it is not part of default `npm run test` and is currently a known blocker lane in project state [VERIFIED: package.json][VERIFIED: docs/operations/testing.md][VERIFIED: .planning/STATE.md].

## Summary

Phase 9 does not need a new replay architecture. The repo already persists worker transcripts under `.gvc0/sessions/<sessionId>.json`, persists tool outputs under `.gvc0/tool-outputs/<sessionId>`, checkpoints sessions during `message_end` and `turn_end`, stores live worker PIDs on `agent_runs.worker_pid`, and can already dispatch resumable task runs through `taskDispatchForRun()` plus `@runtime/resume` [VERIFIED: src/runtime/sessions/index.ts][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/harness/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts].

The missing Phase 9 work is startup orchestration and operator UX. Boot currently calls only `recovery.recoverOrphanedRuns()` before the scheduler starts, and that pass is task-run-focused: it does not sweep `.git/index.lock` or `.git/worktrees/*/index.lock`, does not read persisted worker PIDs, does not classify orphan worktrees, does not append a recovery-summary inbox item, and does not return any structured startup report [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/index.ts].

The clean planning direction is to add one boot-time recovery coordinator that composes the existing `RecoveryService`, `WorkerPidRegistry`, `GitWorktreeProvisioner`, `SqliteStore`, and inbox/TUI surfaces, then prove the whole path with focused Vitest unit/integration coverage instead of relying on the currently blocked PTY smoke lane [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/runtime/worktree/index.ts][VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: docs/operations/testing.md][VERIFIED: .planning/STATE.md].

**Primary recommendation:** Add a startup recovery coordinator ahead of `scheduler.run()` that performs conservative lock sweep, PID reconciliation, orphan-worktree classification, auto-resume/reset of task runs, and recovery-summary inbox emission by reusing the existing runtime/persistence seams rather than inventing new state models [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/runtime/resume/index.ts].

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Boot-time stale lock sweep | API / Backend | Database / Storage | Startup sequencing lives in `composeApplication()` and recovery services, while persisted run/PID state can inform safe cleanup decisions [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/index.ts][VERIFIED: src/persistence/sqlite-store.ts] |
| PID reconciliation and run-state classification | API / Backend | Database / Storage | `agent_runs.worker_pid` and run statuses are persisted in SQLite, but the decision to resume/reset/park work is orchestrator logic [VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: src/orchestrator/services/recovery-service.ts] |
| Worker respawn with transcript replay | API / Backend | Database / Storage | Resume dispatch, session load/save, tool-output splicing, and restart counts are runtime/backend behavior backed by filesystem persistence [VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/sessions/index.ts] |
| Orphan worktree discovery | API / Backend | Database / Storage | Worktree metadata, PID liveness, and run ownership must be correlated before any user-facing action is shown [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/persistence/sqlite-store.ts] |
| Recovery-summary and orphan triage presentation | Browser / Client (TUI) | API / Backend | The inbox overlay and summary text live in TUI view-model/components, but the authoritative recovery items are appended by orchestrator/store code [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/components/index.ts][VERIFIED: src/orchestrator/ports/index.ts] |

## Current Implementation Inventory

- `runCli()` and `main()` are thin wrappers; the real boot sequence is `composeApplication()` -> `app.start(mode)` -> `await recovery.recoverOrphanedRuns()` -> `await scheduler.run()` -> `ui.refresh()` [VERIFIED: src/main.ts][VERIFIED: src/compose.ts].
- `RecoveryService.recoverOrphanedRuns()` currently iterates only task-scope agent runs, skips `retry_await`, converts live waits to checkpointed waits, tries resume for `running` runs with a `sessionId`, and otherwise resets `running` runs back to `ready` with incremented `restartCount` [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: test/unit/orchestrator/recovery.test.ts].
- The recovery pass already writes a `RECOVERY_REBASE` marker into the task worktree before resume so resumed worktrees can rebase onto the feature branch HEAD [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: test/unit/orchestrator/recovery.test.ts].
- The PID registry is already production-wired: `PiSdkHarness` records a child PID immediately after `fork()`, clears it before user exit handlers observe process exit, and persists through `Store.setWorkerPid()` / `clearWorkerPid()` / `getLiveWorkerPids()` [VERIFIED: src/runtime/harness/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: test/integration/worktree-pid-registry.test.ts].
- `GitWorktreeProvisioner` already supports `removeWorktree`, `deleteBranch`, `pruneStaleWorktrees`, and `sweepStaleLocks()`, but the current sweep only checks `.git/worktrees/<name>/locked` markers whose `gitdir` target is gone [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/runtime/worktree.test.ts].
- The runtime replay path is already real: `WorkerRuntime` loads saved messages, calls `resume({ agent, savedMessages, toolOutputs })`, checkpoints transcripts during `message_end` and `turn_end`, and saves the final transcript at the end of the run [VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/sessions/index.ts].
- The repo-standard replay strategy is `persist-tool-outputs`, not native `Agent.continue()` as a first-class primary strategy [VERIFIED: src/runtime/resume/index.ts][CITED: docs/spikes/pi-sdk-resume.md].
- Checkpointed waits already respawn truthfully from the inbox path: compose persists the real help/approval tool output to the file-backed tool-output store, dispatches the task in resume mode, and updates the run back to `running` [VERIFIED: src/compose.ts][CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md].
- The inbox model already allows arbitrary kinds and payloads through `InboxItemAppend`, while the TUI inbox overlay currently renders generic `kind` + `summary` strings and only has built-in response flows for help/approval style items [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/components/index.ts][VERIFIED: src/tui/commands/index.ts].
- The persistence rehydration invariant already exists on a real file-backed SQLite DB and explicitly “gates Phase 9 crash recovery” [VERIFIED: test/integration/persistence/rehydration.test.ts][CITED: docs/operations/testing.md].

## Gaps vs Roadmap

| Roadmap Success Criterion | Current State | Gap to Plan |
|---------------------------|---------------|-------------|
| `kill -9` during worker commit cleans stale `.git/index.lock` and `.git/worktrees/*/index.lock` on restart [VERIFIED: .planning/ROADMAP.md] | Current sweep logic only handles `.git/worktrees/<name>/locked`; no boot path currently sweeps root/worktree `index.lock` files [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: src/compose.ts] | Phase 09-01 needs explicit `index.lock` handling plus tests that model commit-crash leftovers [VERIFIED: .planning/ROADMAP.md][VERIFIED: test/unit/runtime/worktree.test.ts] |
| Orphan worktrees surface in inbox with clean / inspect / keep actions [VERIFIED: .planning/ROADMAP.md] | PID persistence exists, but startup recovery never calls `getLiveWorkerPids()` or `isAlive()`, and no orphan-worktree inbox/action flow exists [VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/tui/commands/index.ts] | Phase 09-01/09-03 must classify dead-PID worktrees and append actionable inbox items [VERIFIED: .planning/ROADMAP.md][VERIFIED: .planning/REQUIREMENTS.md] |
| In-flight workers re-spawn with transcript replay and reach the same logical state [VERIFIED: .planning/ROADMAP.md] | Task-run resume, checkpointed waits, transcript checkpoints, and tool-output replay already exist; startup recovery still only auto-resumes task execution runs and has no explicit UX for `resume_incomplete` [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/resume/index.ts][CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md] | Phase 09-02 should reuse the existing replay path and add explicit restart diagnostics rather than building a second resume mechanism [VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/worker/index.ts] |
| Boot never hangs on stale locks and sweep completes within 5 seconds [VERIFIED: .planning/ROADMAP.md] | No startup timing assertion or dedicated stale-lock boot test was found [VERIFIED: codebase grep] | Phase 09-01/09-03 needs measurable boot-sweep tests and a bounded-reporting path [VERIFIED: .planning/ROADMAP.md] |
| End-to-end crash test: mid-feature-execution kill -> restart -> coherent TUI state [VERIFIED: .planning/ROADMAP.md] | Rehydration and worker smoke coverage exist, but no dedicated kill-9 crash recovery integration test was found; the PTY TUI lane is separately blocked by a known workerpool `SIGSEGV` issue [VERIFIED: docs/operations/testing.md][VERIFIED: codebase grep][VERIFIED: .planning/STATE.md] | Plan for a Vitest integration crash test as the main gate, with PTY smoke remaining informative-only until the blocker is resolved [VERIFIED: docs/operations/testing.md][VERIFIED: .planning/STATE.md] |

## Likely Risks

- Blind cleanup of `index.lock` files can destroy live git operations if Phase 9 expands lock sweeping without the same conservative bias currently used by `sweepStaleLocks()` [VERIFIED: src/runtime/worktree/index.ts].
- `resume_incomplete: ...` currently exits the worker as a generic error frame, so restart UX can degrade into noisy failures unless Phase 9 explicitly classifies and surfaces that state [VERIFIED: src/runtime/worker/index.ts].
- The docs describe merge-train integration crash recovery via `integration_state`, but repo code search only found the migration schema and not a live startup reconciler implementation, so planning can accidentally absorb adjacent merge-train drift unless scope is stated explicitly [CITED: docs/operations/verification-and-recovery.md][VERIFIED: codebase grep][VERIFIED: src/persistence/migrations/0002_merge_train_executor_state.sql].
- The separate `@microsoft/tui-test` smoke lane is a known blocker because of a pre-existing workerpool `SIGSEGV`, so using it as the primary Phase 9 gate would make progress depend on an unrelated failure mode [VERIFIED: .planning/STATE.md][VERIFIED: .planning/ROADMAP.md].

## Relevant Existing Abstractions to Reuse

| Abstraction | Where | Why Reuse It |
|-------------|-------|--------------|
| `RecoveryService` | `src/orchestrator/services/recovery-service.ts` [VERIFIED: src/orchestrator/services/recovery-service.ts] | It already owns boot-time task-run reset/resume semantics and recovery-side `restartCount` updates, so Phase 9 should extend or wrap it rather than duplicating run classification logic [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: test/unit/orchestrator/recovery.test.ts] |
| `WorkerPidRegistry` | `src/runtime/worktree/pid-registry.ts` [VERIFIED: src/runtime/worktree/pid-registry.ts] | It already exposes persisted `list()` plus OS liveness checks via `process.kill(pid, 0)`, which is exactly the Phase 9 orphan/dead-worker classification seam [VERIFIED: src/runtime/worktree/pid-registry.ts][CITED: .planning/phases/03-worker-execution-loop/03-01-SUMMARY.md] |
| `GitWorktreeProvisioner` | `src/runtime/worktree/index.ts` [VERIFIED: src/runtime/worktree/index.ts] | It already centralizes worktree remove/prune/sweep behavior and has a real-git unit suite, which makes it the correct home for root/worktree lock sweeping and orphan discovery helpers [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/runtime/worktree.test.ts] |
| `@runtime/resume` facade | `src/runtime/resume/index.ts` [VERIFIED: src/runtime/resume/index.ts] | The replay spike already decided the resume strategy and the facade already handles assistant-last transcripts and missing tool outputs [VERIFIED: src/runtime/resume/index.ts][CITED: docs/spikes/pi-sdk-resume.md] |
| File-backed session and tool-output stores | `src/runtime/sessions/index.ts`, `src/runtime/resume/tool-output-store.ts` [VERIFIED: src/runtime/sessions/index.ts][VERIFIED: src/runtime/resume/index.ts] | These are the authoritative persisted artifacts that make restart replay possible, so Phase 9 should treat them as input, not replace them [VERIFIED: src/runtime/sessions/index.ts][VERIFIED: src/runtime/worker/index.ts] |
| Generic inbox item model | `src/orchestrator/ports/index.ts` and `src/persistence/sqlite-store.ts` [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/persistence/sqlite-store.ts] | Arbitrary `kind` + `payload` rows already exist, so recovery-summary and orphan-worktree attention can stay on the unified inbox surface required by REQ-TUI-02 [VERIFIED: .planning/REQUIREMENTS.md][VERIFIED: src/orchestrator/ports/index.ts] |
| TUI inbox summary mapping | `src/tui/view-model/index.ts` and `src/tui/components/index.ts` [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/components/index.ts] | Recovery items can render immediately through the generic overlay, with optional explicit summary formatting added later for better operator readability [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/components/index.ts] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | repo `12.8.0`; latest `12.9.0` published `2026-04-12` [VERIFIED: package.json][VERIFIED: npm registry] | Durable run, PID, inbox, and event persistence [VERIFIED: src/persistence/sqlite-store.ts] | The current crash-recovery truth model already depends on SQLite-backed `agent_runs`, `inbox_items`, and rehydrate semantics [VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: test/integration/persistence/rehydration.test.ts] |
| `simple-git` | repo `3.35.2`; latest `3.36.0` published `2026-04-12` [VERIFIED: package.json][VERIFIED: npm registry] | Worktree creation/removal/prune/sweep operations [VERIFIED: src/runtime/worktree/index.ts] | All existing worktree lifecycle logic is already wrapped around `simple-git`, so Phase 9 should extend that wrapper instead of dropping to ad-hoc shell scripts [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/runtime/worktree.test.ts] |
| `@mariozechner/pi-agent-core` | repo `0.66.1`; latest `0.70.6` published `2026-04-28` [VERIFIED: package.json][VERIFIED: npm registry] | Worker Agent runtime and resumed execution loop [VERIFIED: src/runtime/worker/index.ts] | The shipping replay path is already built around `Agent`, `resume()`, and persisted messages/tool outputs [VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/resume/index.ts] |
| `@sinclair/typebox` | repo/latest `0.34.49` published `2026-03-28` [VERIFIED: package.json][VERIFIED: npm registry] | NDJSON IPC schema validation [VERIFIED: src/runtime/ipc/frame-schema.ts] | Crash-recovery flows continue to ride the existing typed IPC channel, so new recovery-related frames or payloads should stay schema-validated [VERIFIED: src/runtime/ipc/frame-schema.ts] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | repo `4.1.4`; latest `4.1.5` published `2026-04-21` [VERIFIED: package.json][VERIFIED: npm registry] | Unit and non-TUI integration coverage [VERIFIED: package.json][VERIFIED: docs/operations/testing.md] | Use for the main Phase 9 gate, especially kill-9 restart and stale-lock/unit coverage [VERIFIED: docs/operations/testing.md] |
| `@mariozechner/pi-tui` | repo `0.66.1`; latest `0.70.6` published `2026-04-28` [VERIFIED: package.json][VERIFIED: npm registry] | Inbox/overlay rendering inside the TUI shell [VERIFIED: src/tui/components/index.ts] | Use the existing overlay/view-model surface for recovery summary and orphan triage text rather than creating a parallel UI channel [VERIFIED: src/tui/components/index.ts][VERIFIED: src/tui/view-model/index.ts] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Existing `@runtime/resume` facade [VERIFIED: src/runtime/resume/index.ts] | Native `Agent.continue()` directly [CITED: docs/spikes/pi-sdk-resume.md] | The repo’s replay spike found native `continue()` unusable as the primary resume path for assistant-last transcripts, so dropping the facade would re-open a solved problem [CITED: docs/spikes/pi-sdk-resume.md][VERIFIED: src/runtime/resume/index.ts] |
| Generic `inbox_items` recovery surfacing [VERIFIED: src/orchestrator/ports/index.ts] | Dedicated crash modal or separate warning screen [ASSUMED] | A separate surface would duplicate the unified “things waiting on you” model already required by REQ-TUI-02 [VERIFIED: .planning/REQUIREMENTS.md][VERIFIED: src/tui/components/index.ts] |
| Extending `GitWorktreeProvisioner` [VERIFIED: src/runtime/worktree/index.ts] | New standalone git-cleanup script [ASSUMED] | A separate script would bypass the existing wrapper’s tests, idempotency, and path conventions [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/runtime/worktree.test.ts] |

**Installation:**
```bash
npm install
```

No new Phase 9-specific dependency additions are required to reach roadmap scope because the checked-in code already contains the necessary replay, PID, inbox, and worktree seams [VERIFIED: package.json][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/orchestrator/ports/index.ts].

## Architecture Patterns

### System Architecture Diagram

The following recommended flow mirrors the current boot hook, current replay/resume path, and the roadmap’s missing recovery additions [VERIFIED: src/compose.ts][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: .planning/ROADMAP.md].

```text
CLI boot (`src/main.ts`)
  |
  v
composeApplication.start()
  |
  +--> Startup Recovery Coordinator
  |       |
  |       +--> SqliteStore: listAgentRuns() / getLiveWorkerPids() / appendInboxItem()
  |       |
  |       +--> WorkerPidRegistry.isAlive(pid)
  |       |
  |       +--> GitWorktreeProvisioner
  |       |       |- sweep root .git/index.lock
  |       |       |- sweep .git/worktrees/*/index.lock
  |       |       `- classify orphan worktrees
  |       |
  |       +--> RecoveryService
  |       |       |- resume running + resumable task runs
  |       |       |- reset dead non-resumable runs to ready
  |       |       `- preserve checkpointed waits
  |       |
  |       `- append recovery_summary + orphan_worktree inbox items [ASSUMED]
  |
  v
SchedulerLoop.run()
  |
  v
TuiApp refresh
  |
  `--> Inbox overlay shows recovery summary + orphan actions
```

### Recommended Project Structure

```text
src/
├── orchestrator/services/   # Boot-time recovery coordinator and structured recovery report
├── runtime/worktree/        # Lock sweep and orphan-worktree inspection helpers
├── persistence/             # Query widening only if the existing Store surface proves insufficient
├── tui/view-model/          # Recovery summary/orphan item wording
└── tui/commands/            # Explicit orphan triage commands if generic inbox actions are insufficient
```

This phase should extend existing folders rather than introducing a new top-level subsystem [VERIFIED: CLAUDE.md][VERIFIED: ARCHITECTURE.md].

### Pattern 1: Boot-Time Recovery Coordinator
**What:** Run one conservative startup pass before `scheduler.run()` that performs lock sweep, PID reconciliation, task-run recovery, orphan-worktree classification, and recovery-summary emission [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/runtime/worktree/index.ts].

**When to use:** Every orchestrator start, regardless of whether the app launches in interactive or auto mode, because the scheduler should see a reconciled state rather than raw crash leftovers [VERIFIED: src/main.ts][VERIFIED: src/compose.ts].

**Example:**
```typescript
// Source: synthesized from [VERIFIED: src/compose.ts],
// [VERIFIED: src/orchestrator/services/recovery-service.ts],
// [VERIFIED: src/runtime/worktree/index.ts], and
// [VERIFIED: src/runtime/worktree/pid-registry.ts]
const report = await startupRecovery.run();

if (report.requiresAttention) {
  store.appendInboxItem({
    id: `inbox-recovery-${Date.now()}`,
    ts: Date.now(),
    kind: 'recovery_summary',
    payload: report,
  });
}

await scheduler.run();
ui.refresh();
```

### Pattern 2: Preserve Running-vs-Checkpointed Distinctions
**What:** Auto-resume only work that was genuinely in-flight at crash time; keep `checkpointed_await_response` and `checkpointed_await_approval` parked until an operator answer arrives [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/core/fsm/index.ts][CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md].

**When to use:** Any startup reconciliation path that touches `agent_runs.run_status`, especially when PID state is missing or dead [VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: src/runtime/worktree/pid-registry.ts].

**Example:**
```typescript
// Source: synthesized from [VERIFIED: src/orchestrator/services/recovery-service.ts]
// and [VERIFIED: src/orchestrator/scheduler/events.ts]
if (run.runStatus === 'checkpointed_await_response' ||
    run.runStatus === 'checkpointed_await_approval') {
  return; // parked wait, not crash-orphan work
}

if (run.runStatus === 'running' && run.sessionId !== undefined) {
  await recoveryService.resumeTaskRun(task, run);
}
```

### Anti-Patterns to Avoid
- **Second recovery state model outside `agent_runs`:** Run/session truth already lives on `agent_runs`, and current recovery/dispatch code already consumes that shape [VERIFIED: ARCHITECTURE.md][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts].
- **Blind filesystem cleanup:** Current worktree sweeping is conservative by design; Phase 9 should extend that behavior, not replace it with unconditional `rm` logic [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/runtime/worktree.test.ts].
- **Separate crash UI surface:** The inbox is already the required unified attention surface, and the TUI already renders inbox items generically [VERIFIED: .planning/REQUIREMENTS.md][VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/components/index.ts].
- **Parallel bespoke replay logic:** The repo already standardized on `@runtime/resume` plus persisted tool outputs after the replay spike [VERIFIED: src/runtime/resume/index.ts][CITED: docs/spikes/pi-sdk-resume.md].

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Transcript replay after crash | New transcript-splicing logic | `@runtime/resume` + `FileSessionStore` + file-backed `ToolOutputStore` [VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/sessions/index.ts] | The existing facade already handles assistant-last transcripts and missing tool outputs in the exact failure mode Phase 9 cares about [VERIFIED: src/runtime/resume/index.ts][CITED: docs/spikes/pi-sdk-resume.md] |
| Worker liveness registry | New sidecar JSON file or separate registry table | `agent_runs.worker_pid` + `WorkerPidRegistry` [VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: src/runtime/worktree/pid-registry.ts] | PID storage, liveness checks, and clear-before-exit ordering are already implemented and integration-tested [VERIFIED: src/runtime/harness/index.ts][VERIFIED: test/integration/worktree-pid-registry.test.ts] |
| Recovery attention surface | Custom modal/wizard [ASSUMED] | `inbox_items` + existing inbox overlay [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/tui/components/index.ts] | REQ-TUI-02 already says the inbox is the unified “things waiting on you” surface, including orphan cleanup after crash [VERIFIED: .planning/REQUIREMENTS.md] |
| Worktree cleanup scripts | Ad-hoc shell parsing of git output [ASSUMED] | `GitWorktreeProvisioner` [VERIFIED: src/runtime/worktree/index.ts] | The existing wrapper already owns idempotent remove/prune logic and has real-git regression coverage [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/runtime/worktree.test.ts] |

**Key insight:** Phase 9 is mostly missing orchestration glue and UX surfacing, not missing persistence or replay primitives [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts].

## Common Pitfalls

### Pitfall 1: Expanding the existing sweep without covering `index.lock`
**What goes wrong:** Startup recovery appears to “have a lock sweep,” but commit-crash leftovers still block git because the current code only clears `locked` markers under `.git/worktrees/<name>/` [VERIFIED: src/runtime/worktree/index.ts].
**Why it happens:** The existing `sweepStaleLocks()` implementation predates the Phase 9 roadmap wording and intentionally only models one lock shape [VERIFIED: src/runtime/worktree/index.ts][CITED: .planning/phases/03-worker-execution-loop/03-01-SUMMARY.md].
**How to avoid:** Add explicit root `.git/index.lock` and `.git/worktrees/*/index.lock` handling plus unit tests that create those files directly [VERIFIED: .planning/ROADMAP.md][VERIFIED: test/unit/runtime/worktree.test.ts].
**Warning signs:** New recovery code changes only `sweepStaleLocks()` return values or boot order, but no new tests mention `index.lock` [VERIFIED: codebase grep].

### Pitfall 2: Treating checkpointed waits as crash-orphan work
**What goes wrong:** Delayed-answer tasks restart automatically on boot even though no answer exists yet [VERIFIED: src/orchestrator/services/recovery-service.ts][CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md].
**Why it happens:** `checkpointed_await_response` and `checkpointed_await_approval` are durable parked states, not “broken running” states [VERIFIED: src/core/fsm/index.ts][VERIFIED: src/persistence/sqlite-store.ts].
**How to avoid:** Restrict auto-resume to true in-flight crash cases and leave checkpointed waits parked until an operator response arrives [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/compose.ts].
**Warning signs:** Boot changes `checkpointed_await_*` runs back to `running` without any inbox resolution path being triggered [VERIFIED: codebase grep].

### Pitfall 3: Letting `resume_incomplete` disappear into generic error handling
**What goes wrong:** Restarted tasks fail, but operators only see generic worker error noise instead of a crisp recovery diagnostic [VERIFIED: src/runtime/worker/index.ts].
**Why it happens:** `resume()` currently returns `already-terminated` reasons that the worker reports as `resume_incomplete: <reason>`, and no startup-specific UX consumes that signal yet [VERIFIED: src/runtime/resume/index.ts][VERIFIED: src/runtime/worker/index.ts].
**How to avoid:** Add an explicit recovery classification for `resume_incomplete` outcomes and surface them through the inbox/report path rather than silent reset loops [VERIFIED: src/runtime/worker/index.ts][ASSUMED].
**Warning signs:** Crash tests emit worker `error` frames with `resume_incomplete:` prefixes but no corresponding recovery inbox item [VERIFIED: src/runtime/worker/index.ts][VERIFIED: codebase grep].

### Pitfall 4: Accidentally folding merge-train recovery drift into Phase 9 without deciding scope
**What goes wrong:** Crash-recovery planning balloons into merge-train executor reconciliation because docs and code are not fully aligned on `integration_state` startup handling [CITED: docs/operations/verification-and-recovery.md][VERIFIED: codebase grep].
**Why it happens:** The documentation describes a startup reconciler, but current code search found only the migration table and no runtime usage [CITED: docs/operations/verification-and-recovery.md][VERIFIED: src/persistence/migrations/0002_merge_train_executor_state.sql][VERIFIED: codebase grep].
**How to avoid:** Make the plan explicitly decide whether `integration_state` reconciliation is in-scope for Phase 9 or deferred as adjacent merge-train work [CITED: docs/operations/verification-and-recovery.md][VERIFIED: .planning/ROADMAP.md].
**Warning signs:** Planning tasks mention `integration_state` without also mentioning the Phase 9 roadmap criteria around stale locks, orphan worktrees, and recovery-summary UX [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/persistence/migrations/0002_merge_train_executor_state.sql].

## Suggested Slice Breakdown

| Slice | Scope | Primary Files | Exit Signal |
|------|-------|---------------|-------------|
| 09-01 | Conservative startup lock sweep, PID reconciliation, and orphan-worktree classification [VERIFIED: .planning/ROADMAP.md] | `src/compose.ts`, `src/orchestrator/services/recovery-service.ts`, `src/runtime/worktree/index.ts`, `src/runtime/worktree/pid-registry.ts` [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/index.ts][VERIFIED: src/runtime/worktree/pid-registry.ts] | Boot can clear stale `index.lock` leftovers, classify dead/live PIDs, and produce a structured recovery report without hanging [VERIFIED: .planning/ROADMAP.md][ASSUMED] |
| 09-02 | Reuse existing replay path for startup respawn, classify `resume_incomplete`, and keep checkpointed waits parked [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/runtime/resume/index.ts] | `src/orchestrator/services/recovery-service.ts`, `src/runtime/worker/index.ts`, `src/orchestrator/scheduler/dispatch.ts`, `src/compose.ts` [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/compose.ts] | In-flight task runs either resume truthfully or park with explicit diagnostics; checkpointed waits remain operator-driven [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worker/index.ts][ASSUMED] |
| 09-03 | Recovery-summary inbox item, orphan-worktree clean/inspect/keep actions, and crash fault-injection coverage [VERIFIED: .planning/ROADMAP.md] | `src/orchestrator/ports/index.ts`, `src/persistence/sqlite-store.ts`, `src/tui/view-model/index.ts`, `src/tui/commands/index.ts`, test suites [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/commands/index.ts] | Restart after synthetic crash yields coherent state plus operator-visible summary/orphan actions, with Vitest coverage gating the path [VERIFIED: .planning/ROADMAP.md][VERIFIED: docs/operations/testing.md][ASSUMED] |

## Concrete File and Test Targets

### Implementation Files

| File | Why It Matters | Expected Phase 9 Use |
|------|----------------|----------------------|
| `src/compose.ts` | Owns boot ordering and currently calls only `recoverOrphanedRuns()` before `scheduler.run()` [VERIFIED: src/compose.ts] | Insert startup recovery coordinator before scheduler start and before final `ui.refresh()` [VERIFIED: src/compose.ts] |
| `src/orchestrator/services/recovery-service.ts` | Owns current task-run recovery semantics and already knows how to resume or reset runs [VERIFIED: src/orchestrator/services/recovery-service.ts] | Extend or wrap to return structured recovery results, consume PID/orphan findings, and keep checkpointed waits distinct [VERIFIED: src/orchestrator/services/recovery-service.ts] |
| `src/runtime/worktree/index.ts` | Central worktree lifecycle wrapper and current stale-lock sweep home [VERIFIED: src/runtime/worktree/index.ts] | Add root/worktree `index.lock` sweep helpers and orphan discovery helpers here rather than elsewhere [VERIFIED: src/runtime/worktree/index.ts] |
| `src/runtime/worktree/pid-registry.ts` | Already exposes persisted PID list and liveness probe [VERIFIED: src/runtime/worktree/pid-registry.ts] | Reuse as the authoritative dead/live worker classifier on boot [VERIFIED: src/runtime/worktree/pid-registry.ts] |
| `src/orchestrator/ports/index.ts` | Defines inbox append/list/resolve and Store query seams [VERIFIED: src/orchestrator/ports/index.ts] | Widen only if recovery payloads need stronger typing or extra query helpers [VERIFIED: src/orchestrator/ports/index.ts][ASSUMED] |
| `src/persistence/sqlite-store.ts` | Backing store for `agent_runs`, PID rows, inbox items, and rehydrate snapshots [VERIFIED: src/persistence/sqlite-store.ts] | Add any query/report support needed by startup recovery without introducing new persistence silos [VERIFIED: src/persistence/sqlite-store.ts] |
| `src/tui/view-model/index.ts` | Generates inbox summaries and operator-facing text [VERIFIED: src/tui/view-model/index.ts] | Add clearer recovery/orphan summaries so the inbox is useful after restart [VERIFIED: src/tui/view-model/index.ts] |
| `src/tui/commands/index.ts` | Current direct TUI action surface contains no orphan-specific actions [VERIFIED: src/tui/commands/index.ts] | Add explicit orphan triage commands if generic inbox reply/approval actions are insufficient [VERIFIED: src/tui/commands/index.ts][ASSUMED] |

### Existing Tests to Extend First

| Test File | Existing Coverage | Phase 9 Extension |
|-----------|-------------------|-------------------|
| `test/unit/orchestrator/recovery.test.ts` | Running-run resume/reset, wait checkpointing, suspended/cancelled handling, `RECOVERY_REBASE` marker [VERIFIED: test/unit/orchestrator/recovery.test.ts] | Add PID-driven dead/live classification, orphan handling, and `resume_incomplete` branches [VERIFIED: test/unit/orchestrator/recovery.test.ts] |
| `test/unit/runtime/worktree.test.ts` | Real-git remove/prune and current `locked` marker sweep [VERIFIED: test/unit/runtime/worktree.test.ts] | Add `.git/index.lock` and `.git/worktrees/*/index.lock` cases plus orphan discovery helpers [VERIFIED: test/unit/runtime/worktree.test.ts][ASSUMED] |
| `test/unit/compose.test.ts` | Compose bootstrap, checkpointed wait replay helpers, lifecycle bootstrapping [VERIFIED: test/unit/compose.test.ts] | Assert startup recovery ordering and recovery-summary append semantics [VERIFIED: test/unit/compose.test.ts][ASSUMED] |
| `test/unit/tui/view-model.test.ts` | Existing blocked/wait summary wording for checkpointed waits [VERIFIED: codebase grep][VERIFIED: src/tui/view-model/index.ts] | Add summary rendering for recovery-summary/orphan-worktree items [VERIFIED: src/tui/view-model/index.ts][ASSUMED] |
| `test/integration/worker-smoke.test.ts` | Hot-window checkpointing and replay-backed delayed response flow [VERIFIED: test/integration/worker-smoke.test.ts] | Extend to cover restart-time respawn classification or pair it with a dedicated crash suite [VERIFIED: test/integration/worker-smoke.test.ts][ASSUMED] |
| `test/integration/persistence/rehydration.test.ts` | Real file-DB rehydrate invariant that explicitly gates Phase 9 [VERIFIED: test/integration/persistence/rehydration.test.ts] | Keep as invariant; do not weaken while adding new recovery artifacts [VERIFIED: test/integration/persistence/rehydration.test.ts] |

## Code Examples

Verified current patterns from the checked-in code:

### Current startup hook
```typescript
// Source: src/compose.ts
start: async () => {
  await recovery.recoverOrphanedRuns();
  await scheduler.run();
  ui.refresh();
},
```

### Current resumable dispatch selection
```typescript
// Source: src/orchestrator/scheduler/dispatch.ts
export function taskDispatchForRun(run: TaskAgentRun): TaskRuntimeDispatch {
  if (run.sessionId) {
    return {
      mode: 'resume',
      agentRunId: run.id,
      sessionId: run.sessionId,
    };
  }

  return {
    mode: 'start',
    agentRunId: run.id,
  };
}
```

### Current hot-window release path
```typescript
// Source: src/runtime/worker-pool.ts
const timeout = setTimeout(() => {
  const current = this.liveRuns.get(taskId);
  const activeTimer = this.waitTimers.get(taskId);
  if (current !== session || activeTimer?.timeout !== timeout) {
    return;
  }
  this.waitTimers.delete(taskId);
  this.liveRuns.delete(taskId);
  current.handle.release();
  this.onTaskComplete?.({
    type: 'wait_checkpointed',
    taskId,
    agentRunId: session.ref.agentRunId,
    waitKind: kind,
  });
}, hotWindowMs);
```

### Current incomplete-resume error path
```typescript
// Source: src/runtime/worker/index.ts
if (resumeOutcome?.kind === 'already-terminated') {
  this.transport.send({
    type: 'error',
    taskId: task.id,
    agentRunId: dispatch.agentRunId,
    error: `resume_incomplete: ${resumeOutcome.reason}`,
    usage,
  });
  return;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Terminal-only transcript persistence [CITED: docs/spikes/pi-sdk-resume.md] | Save during `message_end`, `turn_end`, and terminal completion [VERIFIED: src/runtime/worker/index.ts] | Phase 7 / 2026-04-28 [CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md] | Crash windows between turns are now replayable from disk [VERIFIED: src/runtime/worker/index.ts] |
| Live waits disappeared once the worker was released [CITED: docs/spikes/pi-sdk-resume.md] | Explicit `checkpointed_await_response` / `checkpointed_await_approval` states with replay on delayed answers [VERIFIED: src/core/types/runs.ts][VERIFIED: src/compose.ts] | Phase 7 / 2026-04-28 [CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md] | Pause/resume state now survives restart and remains operator-visible [VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: src/tui/view-model/index.ts] |
| No persisted worker liveness registry [ASSUMED] | `agent_runs.worker_pid` + `WorkerPidRegistry.list()/isAlive()` [VERIFIED: src/persistence/sqlite-store.ts][VERIFIED: src/runtime/worktree/pid-registry.ts] | Phase 3 / 2026-04-23 [CITED: .planning/phases/03-worker-execution-loop/03-01-SUMMARY.md] | Phase 9 can classify dead-vs-live workers without inventing new persistence [VERIFIED: src/runtime/worktree/pid-registry.ts] |
| No worktree cleanup helpers [ASSUMED] | Idempotent remove/prune plus current `locked`-marker sweep [VERIFIED: src/runtime/worktree/index.ts] | Phase 3 / 2026-04-23 [CITED: .planning/phases/03-worker-execution-loop/03-01-SUMMARY.md] | Phase 9 starts from real git lifecycle helpers, but still needs `index.lock` coverage [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: .planning/ROADMAP.md] |

**Deprecated/outdated:**
- Using native `Agent.continue()` as the primary recovery strategy is outdated for this repo; the checked-in standard is `persist-tool-outputs` behind `@runtime/resume` [CITED: docs/spikes/pi-sdk-resume.md][VERIFIED: src/runtime/resume/index.ts].
- Treating startup crash recovery as “task rows only” is outdated relative to the roadmap because Phase 9 explicitly requires stale-lock sweep, orphan-worktree triage, and recovery-summary UX in addition to task-run replay [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/orchestrator/services/recovery-service.ts].

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A dedicated inbox kind such as `recovery_summary` is the least-invasive way to satisfy the roadmap’s “recovery-summary inbox item” requirement because `inbox_items` already supports arbitrary kinds [ASSUMED] | Architecture Patterns / Suggested Slice Breakdown | Planner may under-scope a broader warning/event surface change |
| A2 | Explicit orphan-worktree actions will fit the existing TUI command/inbox model better than a brand-new full-screen recovery surface [ASSUMED] | Standard Stack / Concrete File and Test Targets | Planner may under-estimate TUI interaction work |
| A3 | Existing unit/integration suites can absorb most Phase 9 coverage, with only one dedicated crash-focused integration addition if needed [ASSUMED] | Concrete File and Test Targets / Validation Architecture | Planner may under-estimate test-suite churn or fixture setup |

## Open Questions

1. **Should Phase 9 also reconcile `integration_state`?**
   - What we know: the docs describe a startup reconciler for merge-train crash windows, but code search found only the migration schema and no runtime usage [CITED: docs/operations/verification-and-recovery.md][VERIFIED: src/persistence/migrations/0002_merge_train_executor_state.sql][VERIFIED: codebase grep].
   - What's unclear: whether this drift is meant to land inside Phase 9 or remain a later merge-train follow-up [VERIFIED: .planning/ROADMAP.md][CITED: docs/operations/verification-and-recovery.md].
   - Recommendation: make this a Wave 0 scoping decision so task-crash UX work does not silently absorb merge-train reconciler work.

2. **What should boot do with `resume_incomplete` outcomes?**
   - What we know: the worker emits `resume_incomplete: <reason>` as an error when replay cannot continue cleanly [VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/resume/index.ts].
   - What's unclear: whether the correct Phase 9 behavior is `ready`, `failed`, or inbox-parked diagnostic state [VERIFIED: src/runtime/worker/index.ts].
   - Recommendation: decide this explicitly in planning and keep the choice operator-visible rather than silently resetting work.

3. **How should the 5-second boot bound be proved?**
   - What we know: the roadmap sets the bound, but no current test asserts startup recovery timing [VERIFIED: .planning/ROADMAP.md][VERIFIED: codebase grep].
   - What's unclear: whether timing should be proven via deterministic unit tests, an integration harness, or both.
   - Recommendation: use deterministic unit coverage for classification logic and a focused integration assertion around boot startup, not the PTY lane.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | App runtime and Vitest execution [VERIFIED: package.json] | ✓ [VERIFIED: Bash] | `v24.13.0` [VERIFIED: Bash] | — |
| npm | Script runner and registry verification [VERIFIED: package.json] | ✓ [VERIFIED: Bash] | `11.9.0` [VERIFIED: Bash] | — |
| git | Worktree management and stale-lock/orphan recovery [VERIFIED: src/runtime/worktree/index.ts] | ✓ [VERIFIED: Bash] | `2.53.0` [VERIFIED: Bash] | — |

**Missing dependencies with no fallback:**
- None found during this audit [VERIFIED: Bash].

**Missing dependencies with fallback:**
- The PTY-driven `@microsoft/tui-test` lane is not a safe phase gate today because the repo records a pre-existing workerpool `SIGSEGV`; the fallback is Vitest-based unit/integration coverage for crash recovery [VERIFIED: .planning/STATE.md][VERIFIED: .planning/ROADMAP.md][VERIFIED: docs/operations/testing.md].

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest repo `4.1.4`; latest `4.1.5` verified in npm registry [VERIFIED: package.json][VERIFIED: npm registry] |
| Config file | `vitest.config.ts` [VERIFIED: vitest.config.ts] |
| Quick run command | `npx vitest run test/unit/orchestrator/recovery.test.ts test/unit/runtime/worktree.test.ts test/unit/compose.test.ts` [VERIFIED: package.json][VERIFIED: docs/operations/testing.md] |
| Full suite command | `npm run test` [VERIFIED: package.json] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-STATE-02-A | Sweep stale root/worktree git locks at boot [VERIFIED: .planning/ROADMAP.md] | unit | `npx vitest run test/unit/runtime/worktree.test.ts` | ✅ [VERIFIED: test/unit/runtime/worktree.test.ts] |
| REQ-STATE-02-B | Resume or reset in-flight task runs on restart using persisted session state [VERIFIED: .planning/REQUIREMENTS.md] | unit + integration | `npx vitest run test/unit/orchestrator/recovery.test.ts test/integration/worker-smoke.test.ts` | ✅ [VERIFIED: test/unit/orchestrator/recovery.test.ts][VERIFIED: test/integration/worker-smoke.test.ts] |
| REQ-STATE-02-C | Surface orphan worktrees and recovery summary through the inbox/TUI path [VERIFIED: .planning/ROADMAP.md][VERIFIED: .planning/REQUIREMENTS.md] | unit | `npx vitest run test/unit/compose.test.ts test/unit/tui/view-model.test.ts` | ✅ [VERIFIED: test/unit/compose.test.ts][VERIFIED: codebase grep] |
| REQ-STATE-02-D | Preserve checkpointed waits while still auto-recovering true crash orphans [VERIFIED: .planning/REQUIREMENTS.md] | unit | `npx vitest run test/unit/orchestrator/recovery.test.ts` | ✅ [VERIFIED: test/unit/orchestrator/recovery.test.ts] |
| REQ-STATE-02-E | Mid-execution crash -> restart -> coherent recovered state [VERIFIED: .planning/ROADMAP.md] | integration | `npx vitest run test/integration/*crash*` | ❌ Wave 0 [VERIFIED: codebase grep] |

### Sampling Rate

- **Per task commit:** `npx vitest run test/unit/orchestrator/recovery.test.ts test/unit/runtime/worktree.test.ts test/unit/compose.test.ts` [VERIFIED: package.json].
- **Per wave merge:** `npm run test` [VERIFIED: package.json].
- **Phase gate:** `npm run check` plus focused crash-recovery integration coverage before `/gsd-verify-work` [VERIFIED: package.json][VERIFIED: CLAUDE.md].

### Wave 0 Gaps

- [ ] Add `index.lock` sweep cases to `test/unit/runtime/worktree.test.ts` [VERIFIED: test/unit/runtime/worktree.test.ts].
- [ ] Extend `test/unit/orchestrator/recovery.test.ts` to cover PID-driven dead/live classification and `resume_incomplete` handling [VERIFIED: test/unit/orchestrator/recovery.test.ts][VERIFIED: src/runtime/worker/index.ts].
- [ ] Extend `test/unit/compose.test.ts` to assert recovery runs before scheduler start and can append a recovery-summary inbox item [VERIFIED: test/unit/compose.test.ts][VERIFIED: src/compose.ts].
- [ ] Extend `test/unit/tui/view-model.test.ts` for recovery-summary and orphan-worktree summaries [VERIFIED: codebase grep][VERIFIED: src/tui/view-model/index.ts].
- [ ] Add dedicated crash-restart integration coverage under `test/integration/` so kill-9 style recovery is gated outside the PTY lane [VERIFIED: docs/operations/testing.md][ASSUMED].
- [ ] Keep `@microsoft/tui-test` crash-path assertions non-blocking until the known workerpool `SIGSEGV` smoke-lane issue is resolved [VERIFIED: .planning/STATE.md].

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no [VERIFIED: .planning/REQUIREMENTS.md] | — |
| V3 Session Management | no for user-auth sessions; resume sessions here are local worker transcripts rather than auth/session cookies [VERIFIED: src/runtime/sessions/index.ts][VERIFIED: ARCHITECTURE.md] | — |
| V4 Access Control | no for user authorization flows in this phase [VERIFIED: .planning/REQUIREMENTS.md] | — |
| V5 Input Validation | yes [VERIFIED: src/runtime/ipc/frame-schema.ts][VERIFIED: src/compose.ts] | TypeBox-validated IPC frames plus narrow JSON payload parsing for persisted wait payloads [VERIFIED: src/runtime/ipc/frame-schema.ts][VERIFIED: src/compose.ts] |
| V6 Cryptography | no [VERIFIED: package.json] | None in scope; do not introduce hand-rolled crypto [ASSUMED] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Deleting a live lock or live worktree because PID ownership was misclassified [VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/runtime/worktree/index.ts] | Tampering / Denial of Service | Reuse persisted `worker_pid`, OS liveness checks via `process.kill(pid, 0)`, and conservative cleanup rules that prefer leaking stale state over deleting live state [VERIFIED: src/runtime/worktree/pid-registry.ts][VERIFIED: src/runtime/worktree/index.ts] |
| Cleaning or inspecting the wrong path because recovery actions bypass existing worktree naming/wrappers [VERIFIED: src/runtime/worktree/index.ts][VERIFIED: src/runtime/harness/index.ts] | Tampering | Keep cleanup inside `GitWorktreeProvisioner` and existing worktree path helpers rather than raw shell path concatenation [VERIFIED: src/runtime/worktree/index.ts] |
| Malformed recovery/replay payloads producing invalid operator actions or invalid state transitions [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/core/fsm/index.ts] | Tampering | Continue to validate IPC frames with TypeBox and parse persisted JSON payloads narrowly before replay or action delivery [VERIFIED: src/runtime/ipc/frame-schema.ts][VERIFIED: src/compose.ts] |
| Silent replay mismatch causing infinite restart/error churn [VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/runtime/resume/index.ts] | Denial of Service | Surface `resume_incomplete` explicitly and bound retry/restart behavior through existing run status and inbox attention handling [VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][ASSUMED] |

## Sources

### Primary (HIGH confidence)
- `.planning/ROADMAP.md` - Phase 9 goal, requirements, and success criteria [VERIFIED: .planning/ROADMAP.md]
- `.planning/REQUIREMENTS.md` - REQ-STATE-02 and REQ-TUI-02 wording [VERIFIED: .planning/REQUIREMENTS.md]
- `CLAUDE.md` - project boundaries, testing rules, Node/version constraints, verification commands [VERIFIED: CLAUDE.md]
- `ARCHITECTURE.md` - state split and subsystem ownership [VERIFIED: ARCHITECTURE.md]
- `docs/operations/testing.md` - current test-lane behavior and Phase 9 gating note [VERIFIED: docs/operations/testing.md]
- `docs/architecture/worker-model.md` - current documented startup recovery scope [CITED: docs/architecture/worker-model.md]
- `docs/operations/verification-and-recovery.md` - documented integration crash-recovery expectations [CITED: docs/operations/verification-and-recovery.md]
- `docs/spikes/pi-sdk-resume.md` - replay strategy decision and rationale [CITED: docs/spikes/pi-sdk-resume.md]
- `src/compose.ts` - boot order, checkpointed wait replay helpers, runtime wiring [VERIFIED: src/compose.ts]
- `src/orchestrator/services/recovery-service.ts` - current orphaned task-run recovery logic [VERIFIED: src/orchestrator/services/recovery-service.ts]
- `src/runtime/worktree/index.ts` - current worktree cleanup and stale-lock sweep scope [VERIFIED: src/runtime/worktree/index.ts]
- `src/runtime/worktree/pid-registry.ts` - persisted PID list and liveness checks [VERIFIED: src/runtime/worktree/pid-registry.ts]
- `src/runtime/harness/index.ts` - PID set/clear lifecycle ordering [VERIFIED: src/runtime/harness/index.ts]
- `src/runtime/worker/index.ts` - replay, checkpoints, and `resume_incomplete` error path [VERIFIED: src/runtime/worker/index.ts]
- `src/runtime/resume/index.ts` - active replay strategy [VERIFIED: src/runtime/resume/index.ts]
- `src/runtime/sessions/index.ts` - session persistence path [VERIFIED: src/runtime/sessions/index.ts]
- `src/orchestrator/ports/index.ts` and `src/persistence/sqlite-store.ts` - inbox/PID/store contracts [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/persistence/sqlite-store.ts]
- `src/tui/view-model/index.ts`, `src/tui/components/index.ts`, `src/tui/commands/index.ts` - current inbox rendering and action surface [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/components/index.ts][VERIFIED: src/tui/commands/index.ts]
- `test/unit/orchestrator/recovery.test.ts` - recovery behavior coverage [VERIFIED: test/unit/orchestrator/recovery.test.ts]
- `test/unit/runtime/worktree.test.ts` - worktree cleanup/sweep coverage [VERIFIED: test/unit/runtime/worktree.test.ts]
- `test/integration/worktree-pid-registry.test.ts` - PID persistence lifecycle [VERIFIED: test/integration/worktree-pid-registry.test.ts]
- `test/integration/persistence/rehydration.test.ts` - file-DB rehydration invariant [VERIFIED: test/integration/persistence/rehydration.test.ts]
- `.planning/phases/03-worker-execution-loop/03-01-SUMMARY.md` - Phase 3 crash-recovery hooks handoff [CITED: .planning/phases/03-worker-execution-loop/03-01-SUMMARY.md]
- `.planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md` - Phase 7 handoff and remaining Phase 9 work [CITED: .planning/phases/07-top-level-planner-inbox-pause-resume/07-03-SUMMARY.md]
- `package.json` and npm registry (`npm view`) - verified package versions and publish dates [VERIFIED: package.json][VERIFIED: npm registry]
- Shell environment audit (`node --version`, `npm --version`, `git --version`) - external dependency availability [VERIFIED: Bash]

### Secondary (MEDIUM confidence)
- None — this research relied on repo code/docs plus npm registry verification [VERIFIED: codebase grep][VERIFIED: npm registry].

### Tertiary (LOW confidence)
- Design-shape recommendations for a dedicated `recovery_summary` inbox kind, orphan action command shape, and exact test-file split remain assumptions to validate during planning [ASSUMED].

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - package choices are already fixed by the checked-in repo and current npm registry verification [VERIFIED: package.json][VERIFIED: npm registry].
- Architecture: HIGH - boot order, replay path, PID lifecycle, inbox seams, and worktree cleanup behavior were verified directly from code and tests [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worktree/index.ts][VERIFIED: test/unit/orchestrator/recovery.test.ts].
- Pitfalls: HIGH - the largest gaps are direct roadmap-vs-code mismatches visible in the current implementation and test inventory [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/runtime/worktree/index.ts][VERIFIED: codebase grep].

**Research date:** 2026-04-29
**Valid until:** 2026-05-06