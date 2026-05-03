---
phase: 03-worker-execution-loop
plan: 03
subsystem: runtime-worker-lifecycle
tags: [retry-policy, commit-trailer, inbox-stub, model-routing, req-exec-02, req-exec-04, req-config-01]

# Dependency graph
requires:
  - phase: 03-worker-execution-loop
    plan: 03-01
    provides: worker PID registry + migrations 0003; compose-side harness surface
  - phase: 03-worker-execution-loop
    plan: 03-02
    provides: typebox IPC frame schemas (including pre-declared CommitDoneFrame) + migration 0004 + heartbeat loop
provides:
  - "src/runtime/retry-policy.ts — pure decideRetry(error, attempt, config) + buildRetryPolicyConfig + DEFAULT_TRANSIENT_PATTERNS"
  - "src/agents/worker/tools/commit-trailer.ts — pure maybeInjectTrailer / isGitCommitCommand / validateTrailers"
  - "src/agents/worker/tools/run-command.ts — rewrites git commit invocations with gvc0-task-id + gvc0-run-id trailers; fires onCommitDone after successful commits"
  - "src/agents/worker/toolset.ts — threads taskId/agentRunId/onCommitDone into run-command"
  - "src/runtime/worker/index.ts — emits commit_done IPC frame from run-command's onCommitDone"
  - "src/runtime/worker/entry.ts — hard-error when GVC0_TASK_MODEL_PROVIDER/ID missing; no more hardcoded sonnet id"
  - "src/runtime/harness/index.ts — forkWorker env carries GVC0_TASK_MODEL_PROVIDER + GVC0_TASK_MODEL_ID from config.models.taskWorker"
  - "src/runtime/worker-pool.ts — LocalWorkerPool.retryDeps {store, config} + per-task attempts/payload cache + handleErrorFrame branching on decideRetry"
  - "src/compose.ts — wires taskWorker ModelRef to PiSdkHarness + retryDeps to LocalWorkerPool"
  - "src/config/schema.ts — retry {baseDelayMs, maxDelayMs, transientErrorPatterns} subschema + worktreeRoot default"
  - "src/persistence/migrations/0005_inbox_items.sql — stub escalation table with partial index on unresolved rows"
  - "src/persistence/migrations/0006_agent_runs_last_commit_sha.sql — additive ALTER for last_commit_sha column"
  - "src/persistence/sqlite-store.ts + InMemoryStore — appendInboxItem + setLastCommitSha implementations"
  - "src/orchestrator/ports/index.ts — InboxItemAppend interface + Store.appendInboxItem + Store.setLastCommitSha contract"
  - "src/orchestrator/scheduler/events.ts — handles commit_done by calling store.setLastCommitSha and emits commit_trailer_missing event on trailerOk=false"
affects:
  - "03-04 (integration wave) — retry-policy now in-pool; scheduler continues to see error frames only after escalation"
  - "06 (merge-train) — can walk agent_runs.last_commit_sha or grep commit messages for gvc0-task-id/run-id"
  - "07 (inbox / replan) — inbox_items schema + appendInboxItem contract ready for semantic_failure consumers"
  - "09 (crash recovery) — last_commit_sha persisted per run, unresolved inbox rows available at boot"

# Tech tracking
tech-stack:
  added:
    - "maybeInjectTrailer / validateTrailers — zero-dep pure text transforms"
    - "RetryDecision discriminated union + exponential backoff + uniform jitter [0, 250) ms"
    - "ScriptedHarness test helper pattern — scripted error/result frames drive LocalWorkerPool without a live agent"
  patterns:
    - "Tool-factory dependency bundling (RunCommandDeps) replaces string-argument signature while preserving back-compat via inline union narrowing"
    - "SQLite migration numbering pre-allocated per wave to eliminate cross-plan merge conflicts"
    - "Harness env injection as the single seam for config-to-child value transport (no global state reads in worker process)"
    - "Graceful degradation: retryDeps optional so scheduler-loop unit tests can keep constructing bare pools"

key-files:
  created:
    - "src/runtime/retry-policy.ts"
    - "src/agents/worker/tools/commit-trailer.ts"
    - "src/persistence/migrations/0005_inbox_items.sql"
    - "src/persistence/migrations/0006_agent_runs_last_commit_sha.sql"
    - "test/unit/runtime/retry-policy.test.ts"
    - "test/unit/agents/commit-trailer.test.ts"
    - "test/integration/worker-retry-commit.test.ts"
  modified:
    - "src/config/schema.ts"
    - "src/agents/worker/tools/run-command.ts"
    - "src/agents/worker/toolset.ts"
    - "src/runtime/harness/index.ts"
    - "src/runtime/worker/entry.ts"
    - "src/runtime/worker/index.ts"
    - "src/runtime/worker-pool.ts"
    - "src/compose.ts"
    - "src/persistence/sqlite-store.ts"
    - "src/orchestrator/ports/index.ts"
    - "src/orchestrator/scheduler/events.ts"
    - "test/integration/harness/store-memory.ts"
    - "test/helpers/config-fixture.ts"
    - "test/unit/config/schema.test.ts"
    - "test/unit/orchestrator/recovery.test.ts"
    - "test/unit/orchestrator/scheduler-loop.test.ts"

decisions:
  - "decideRetry kept pure — no Store / Pool / setTimeout inside the function. Pool owns timer + inbox I/O."
  - "CommitDoneFrame reused the variant pre-declared by 03-02; no schema migration needed."
  - "run-command rewrite fires only on the literal first-two-tokens `git commit` — global options like `-C <dir>` not yet handled (noted as a Phase 6 cleanup, see plan's scope discussion)."
  - "ScriptedHarness lives in the integration test file, not a shared helper, since only this plan exercises synthetic error frames — promote to test/integration/harness/ if plan 03-04 needs the same surface."
  - "setLastCommitSha stays UPDATE-on-missing-no-op in SqliteStore; InMemoryStore mirrors that for parity."
  - "Retry deps on LocalWorkerPool are optional to preserve the pre-03-03 worker-smoke.test.ts + scheduler-loop.test.ts fixtures that construct bare pools."

# Execution metrics
metrics:
  duration: 3h10m
  completed: 2026-04-23
  tasks: 8
  files: 18
  tests_added: 28
---

# Phase 3 Plan 3: Worker Lifecycle Correctness Summary

Locks REQ-EXEC-02 (commit trailer contract), REQ-EXEC-04 (retry + inbox escalation), and REQ-CONFIG-01 (per-role model threading) into the worker loop. Every worker-produced `git commit` now carries `gvc0-task-id` + `gvc0-run-id` trailers, transient failures backoff in-pool while semantic failures escalate to `inbox_items`, and `config.models.taskWorker` flows from the harness to the child via env.

## What Landed

- **Commit trailer contract (REQ-EXEC-02).** Every `git commit` issued through the worker's `run_command` tool is rewritten to carry `--trailer gvc0-task-id=<task>` + `--trailer gvc0-run-id=<run>`. On exit 0 the worker verifies the trailers with `git interpret-trailers --parse`, sends a `commit_done` frame with `sha` + `trailerOk`, and the scheduler persists the SHA to `agent_runs.last_commit_sha`. Missing trailers surface a `commit_trailer_missing` event.
- **Retry policy + inbox escalation (REQ-EXEC-04).** `src/runtime/retry-policy.ts` is a pure decision function (exponential backoff + 250ms uniform jitter, cap at `config.retryCap`). `LocalWorkerPool` intercepts `error` frames, caches the dispatch payload, retries transient failures transparently, and writes an `inbox_items` row (migration 0005) for semantic failures.
- **Config-driven model selection (REQ-CONFIG-01).** `PiSdkHarness.forkWorker` now sets `GVC0_TASK_MODEL_PROVIDER` + `GVC0_TASK_MODEL_ID` from `config.models.taskWorker`. `worker/entry.ts` hard-errors when either is missing — no more stale `claude-sonnet-4-20250514` default. `WorkerRuntime` composes a `provider:modelId` spec parsed by the existing model-bridge.
- **Persistence surface.** Migrations `0005_inbox_items.sql` and `0006_agent_runs_last_commit_sha.sql` land the schema both SqliteStore and InMemoryStore implementations target. `Store.appendInboxItem` / `Store.setLastCommitSha` contracts added to the port interface.
- **Tests.** 12 unit tests for `retry-policy.ts`, 13 unit tests for `commit-trailer.ts`, 3 integration tests for trailer assertion + transient retry + semantic escalation. Full suite: 1538 tests pass, 1 skipped.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Test Store mocks missing new port methods**
- **Found during:** Task 4 typecheck, Task 3 ripples
- **Issue:** After adding `appendInboxItem` + `setLastCommitSha` to the Store port, `test/unit/orchestrator/recovery.test.ts` and `test/unit/orchestrator/scheduler-loop.test.ts` failed TS2739 because their `createStoreMock()` factories did not implement the new methods.
- **Fix:** Added `appendInboxItem: vi.fn() / no-op` and `setLastCommitSha: vi.fn() / no-op` to both mocks so the mocks satisfy the widened interface without changing test behavior.
- **Files modified:** `test/unit/orchestrator/recovery.test.ts`, `test/unit/orchestrator/scheduler-loop.test.ts`
- **Commit:** `965354f`

**2. [Rule 3 — Blocking] Zod v4 `.default({})` requires full object literal**
- **Found during:** Task 1 schema extension
- **Issue:** `RetryConfigSchema.default({})` failed typecheck under Zod v4 because every inner field is marked required. The schema compiler cannot infer the defaults from the nested `z.number().default(n)` calls when the parent `.default()` receives `{}`.
- **Fix:** Passed the full default object literal to `.default({...})` with `DEFAULT_TRANSIENT_ERROR_PATTERNS` spread inline.
- **Files modified:** `src/config/schema.ts`, `test/helpers/config-fixture.ts`
- **Commit:** `ab42a7d`

**3. [Rule 1 — Bug] Integration retry timing dominated by jitter**
- **Found during:** Task 8 first test run
- **Issue:** Retry test waited 40ms past a 1ms `baseDelayMs` and failed because `MAX_JITTER_MS = 250` in `retry-policy.ts` adds uniform [0, 250) ms to every retry delay. The test observed 1 dispatch instead of the expected 2.
- **Fix:** Extended the wait window to 350ms to cover the worst-case jitter envelope; added a comment explaining the rationale so future readers do not collapse it back.
- **Files modified:** `test/integration/worker-retry-commit.test.ts`
- **Commit:** `d688233`

**4. [Rule 1 — Bug] `git log --pretty=%B` renders trailers in RFC-822 `key: value` form, not the `--trailer key=value` injection syntax**
- **Found during:** Task 8 first test run
- **Issue:** Trailer assertion looked for `gvc0-task-id=t-trailer` in the log body but git rewrites trailers on storage.
- **Fix:** Asserted on the RFC-822 form (`gvc0-task-id: t-trailer`). Added an inline comment distinguishing the two.
- **Files modified:** `test/integration/worker-retry-commit.test.ts`
- **Commit:** `d688233`

### Scope-Preserved Boundaries

- **Biome `check`/`check:fix` not runnable from the worktree path.** The project's `biome.json` `includes` list targets the main repo. Verified the plan's standing direction in PLAN.md: "NOTE: `git commit --no-verify` is required because Biome hook blocks verify in worktrees." Formatter/linter gates will run when the orchestrator merges this branch into `gsd`. Used `--no-verify` on all 8 commits.
- **`run_command` trailer rewrite only recognizes literal `git commit` (no `-C <dir>` prefix support).** Called out in the plan's Task 5 scope discussion as Wave-3 follow-up; left a comment in `commit-trailer.ts`.

## Threat Flags

None — every new surface is internal to the worker process, the pool, and persistence. No new network endpoints, no new auth paths, no schema changes at trust boundaries beyond the two additive migrations already in scope.

## Boundary Comments for Wave-3 Coordination

- `src/agents/worker/tools/commit-trailer.ts` — leading docstring block marked `=== Commit trailer contract (plan 03-03) ===` so the Wave-3 merge-train reconciler implementor can grep for it.
- `src/agents/worker/tools/run-command.ts` — inline `=== Commit trailer + commit_done (plan 03-03) ===` marker at the trailer-rewrite branch.
- `src/runtime/worker/index.ts` — same marker at the `onCommitDone` callback wiring.
- `src/orchestrator/scheduler/events.ts` — same marker at the `commit_done` frame handler where `setLastCommitSha` + `commit_trailer_missing` event fire.
- `src/runtime/worker-pool.ts` — `=== Retry policy + inbox escalation (plan 03-03) ===` at the compose-side retry-deps construction.

## Commits (8)

| Commit   | Type | Description                                                                                 |
| -------- | ---- | ------------------------------------------------------------------------------------------- |
| ab42a7d  | feat | add `retry.{baseDelayMs,maxDelayMs,transientErrorPatterns}` + `worktreeRoot` to config schema |
| 8851953  | feat | add `retry-policy.ts` — pure `decideRetry` with transient/semantic split                    |
| 269cd83  | feat | `inbox_items` + `agent_runs.last_commit_sha` migrations + Store methods                     |
| 965354f  | feat | thread taskWorker model via `GVC0_TASK_MODEL_*` env                                         |
| 878ec41  | feat | inject `gvc0` trailers + emit `commit_done` frame                                           |
| 349f660  | test | commit-trailer shim unit tests                                                              |
| 6829423  | feat | wire retry-policy into `LocalWorkerPool`                                                    |
| d688233  | test | trailer + retry/inbox integration suite                                                     |

## Verification

- [x] `npx tsc --noEmit` — clean
- [x] `npm run typecheck` — clean
- [x] `npm run test` — 1538 passed, 1 skipped, 0 failed
- [x] No hard-coded model id remains under `src/runtime/worker/` (verified with `grep -r 'claude-sonnet' src/runtime/worker` → 0 hits)
- [x] Every worker `git commit` carries both trailers (integration test proves it with real `git log`)
- [x] `commit_done` frame carries SHA + `trailerOk`, `agent_runs.last_commit_sha` persisted
- [x] `retry-policy.ts` has zero imports from `@runtime/worker-pool`, `@persistence/*`, `@orchestrator/*` (verified)
- [x] `LocalWorkerPool` retries transient errors with exp backoff + jitter, caps at `retryCap`
- [x] Semantic failures append to `inbox_items` via `Store.appendInboxItem`
- [x] Extended integration tests cover trailer, retry, and escalation

## Self-Check: PASSED

All files created exist, all commits are present in `git log`, and both typecheck + full test suite are green. The only skipped item is `npm run check` (Biome) which cannot run from the worktree path — the orchestrator will run it on the merge commit.
