---
phase: 12-integration-polish
plan: "01"
subsystem: integration-tests
tags:
  - integration-proof
  - e2e
  - merge-train
  - verify-agent
  - faux-provider
dependency_graph:
  requires:
    - test/helpers/feature-lifecycle-fixture.ts
    - test/integration/harness/faux-stream.ts
    - test/integration/harness/in-process-harness.ts
    - src/orchestrator/scheduler/integration-runner.ts
  provides:
    - test/integration/prompt-to-main-e2e.test.ts
    - test/integration/verify-flake-audit.test.ts
  affects:
    - src/orchestrator/scheduler/integration-runner.ts
tech_stack:
  added: []
  patterns:
    - yieldEventLoop (setImmediate-based) for help-wait phase without blocking drain
    - dual-path inbox help delivery (respondToInboxHelp vs pool.respondToHelp)
    - integration agent run row pre-creation in integration-runner
key_files:
  created:
    - test/integration/prompt-to-main-e2e.test.ts
    - test/integration/verify-flake-audit.test.ts
  modified:
    - src/orchestrator/scheduler/integration-runner.ts
decisions:
  - "Use yieldEventLoop(setImmediate) instead of stepUntil/harness.drain while worker is blocked on request_help; harness.drain blocks indefinitely if any live session is unresolved"
  - "Mock simpleGit.raw() to return 'greeting.ts' so verify prompt rendering succeeds; getChangedFiles calls git.raw which requires the mock to include that method"
  - "Pre-create run-integration:* agent run in integration-runner before calling verifyFeature; PiFeatureAgentRuntime.persistMessages requires an existing store row"
  - "Mark integration run completed with payloadJson after verifyFeature returns so test assertions on runStatus and payloadJson pass"
metrics:
  duration: "~35 minutes (including debugging three sequential root causes)"
  completed: "2026-05-02T19:23:59Z"
  task_count: 2
  file_count: 3
---

# Phase 12 Plan 01: Integration Proof Summary

Deterministic non-TUI prompt-to-main lifecycle proof and verify-agent flake-rate audit using faux-provider in-process harness; post-audit gap closure upgraded the lifecycle proof to start from a top-level prompt and drain to merged in one chain.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | prompt-to-main-e2e.test.ts — full lifecycle proof | 1437ad8 |
| 2 | verify-flake-audit.test.ts — 5/5 known-good consistency audit | 1437ad8 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Add raw() mock to simpleGit for verify prompt rendering**
- **Found during:** Task 1, Phase 4 — verify agent entering retry_await loop
- **Issue:** `getChangedFiles` in `feature-phase-host.ts` calls `simpleGit(worktreePath).raw(...)` to build the verify prompt's changed-files list. The test's `vi.mock('simple-git')` only provided `merge`, so `raw` was undefined → verify agent threw → `feature_phase_error` → `runStatus: retry_await` → 15-tick stepUntil loop exhausted.
- **Fix:** Added `raw: vi.fn().mockResolvedValue('greeting.ts\n')` to the `simpleGitMock` return value in `beforeEach`.
- **Files modified:** `test/integration/prompt-to-main-e2e.test.ts`
- **Commit:** 1437ad8

**2. [Rule 2 - Missing Critical Functionality] Create integration agent run row before verifyFeature call**
- **Found during:** Task 1, Phase 5 — integration runner invoking verifyFeature
- **Issue:** `runIntegrationIfPending` called `agents.verifyFeature(feature, {agentRunId:'run-integration:f-p2m'})` without first creating the agent run in the store. `PiFeatureAgentRuntime.persistMessages` calls `store.updateAgentRun(agentRunId, ...)` which throws "agent run does not exist" for unknown run IDs. The merge-train unit tests never hit this because they mock `agents.verifyFeature` directly; the prompt-to-main e2e is the first test to run the real runtime through the integration runner.
- **Fix:** Added `store.createAgentRun({id:'run-integration:*', ...})` before the `verifyFeature` call in `integration-runner.ts`, plus an idempotent update path for re-entry. After the agent returns, marks the run `completed` with `payloadJson` so test assertions on `runStatus` and `payloadJson.ok` pass.
- **Files modified:** `src/orchestrator/scheduler/integration-runner.ts`
- **Commit:** dfa999c

**3. [Rule 1 - Bug] harness.drain() hangs if called while worker is blocked on request_help**
- **Found during:** Task 1, Phase 3 — first timeout attempt
- **Issue:** `InProcessHarness.drain()` awaits all live session `done` promises. If a worker is blocked waiting for `help_response` IPC, `done` never resolves. The original test used `fixture.stepUntil()` for the help-wait phase, but `stepUntil` calls `harness.drain()` after each tick — causing indefinite blocking.
- **Fix:** Replaced `stepUntil` for the help-wait phase with a custom while loop using `yieldEventLoop(8)` (setImmediate-based, non-blocking). `harness.drain()` is only called after the help response is delivered and the worker can complete.
- **Files modified:** `test/integration/prompt-to-main-e2e.test.ts`
- **Commit:** 1437ad8

## Test Coverage

### SC1: prompt-to-main lifecycle (REQ-PLAN-01/02, REQ-EXEC-01/02, REQ-INBOX-01, REQ-MERGE-01/02/04)
- Top-level prompt enqueues `top_planner_requested` and creates `run-top-planner` ✓
- Top-level planner proposal lands in `await_approval`; approval creates feature `f-1` ✓
- Top-created feature runs discuss and research before feature planning ✓
- Feature planner proposal lands in `await_approval`; approval applies task DAG and feature → executing ✓
- Worker blocks on `request_help`, inbox item created, test delivers answer ✓
- Worker resumes, commits with `trailerOk=true` and valid SHA ✓
- Feature advances: ci_check → verifying → awaiting_merge ✓
- Merge-train drains: `collabControl === 'merged'` ✓
- Integration agent run `run-integration:f-1` exists, completed, `ok: true` ✓

### SC2: verify-agent flake audit (REQ-MERGE-04)
- 5/5 isolated verify attempts all pass with known-good faux response ✓
- Each attempt uses a fresh project root, faux provider, and scheduler ✓

## Known Stubs

None — both tests make substantive assertions against real state transitions.

## Self-Check: PASSED

- `test/integration/prompt-to-main-e2e.test.ts` exists and now starts from `top_planner_requested` ✓
- `test/integration/verify-flake-audit.test.ts` exists ✓
- `src/orchestrator/scheduler/integration-runner.ts` modified ✓
- Commits dfa999c and 1437ad8 exist ✓
- Post-audit focused verification: `npx vitest run test/integration/prompt-to-main-e2e.test.ts --reporter=verbose` passed 1/1 ✓
- `npm run check`: 94 test files, 1969 tests, all passed ✓
