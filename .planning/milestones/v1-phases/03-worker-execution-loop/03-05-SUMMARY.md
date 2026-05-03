---
phase: 03-worker-execution-loop
plan: 05
subsystem: runtime/resume
tags: [spike, pi-sdk, resume, replay, phase-7-prep, REQ-EXEC-04, REQ-INBOX-02, REQ-INBOX-03]
dependency_graph:
  requires:
    - 03-03 (worker lifecycle shim + session persistence)
  provides:
    - "@runtime/resume facade (resume() + RESUME_STRATEGY)"
    - "persist-tool-outputs strategy implementation"
    - "five-scenario pi-sdk resume test harness (regression guard)"
    - "docs/spikes/pi-sdk-resume.md (decision record)"
  affects:
    - Phase 7 plan 07-03 (two-tier pause + respawn-with-replay)
    - Phase 9 (crash recovery — same resume surface)
tech_stack:
  added: []
  patterns:
    - "conditional-resume-strategy (compile-time decision; runtime fallback)"
    - "persisted tool-output splicing to satisfy pi-sdk continue() invariants"
    - "atomic write via tmp+rename for the file-backed ToolOutputStore"
key_files:
  created:
    - test/integration/spike/fixtures.ts
    - test/integration/spike/pi-sdk-resume.test.ts
    - src/runtime/resume/index.ts
    - src/runtime/resume/tool-output-store.ts
    - test/unit/runtime/resume/tool-output-store.test.ts
    - docs/spikes/pi-sdk-resume.md
    - .planning/phases/03-worker-execution-loop/spike-run-output.txt
  modified:
    - src/runtime/sessions/index.ts (marker comment only; no behavior change)
decisions:
  - "Resume strategy = persist-tool-outputs (not native, not hybrid). pi-sdk Agent.continue() throws 'Cannot continue from message role: assistant' on every realistic resume path we measured."
  - "Facade returns a discriminated outcome ({ kind: 'resumed' | 'already-terminated' }) so Phase 7 can branch without re-inspecting agent state."
  - "Missing tool-output results are a bail signal, not a best-effort synthesis — synthesizing would make the transcript lie about tool execution."
  - "Sessions can safely be saved at either message_end OR turn_end; the fallback splice handles both shapes."
metrics:
  duration_minutes: 75
  completed_date: 2026-04-23
  commit_count: 5
  tests_added: 10  # 6 unit + 4 integration (5 scenarios + 1 facade, scenario 1 existed before as a baseline)
  files_created: 7
  files_modified: 1
---

# Phase 3 Plan 05: pi-sdk Resume/Replay Fidelity Spike Summary

One-liner: Ran a five-scenario harness against pi-sdk 0.66.1's `Agent.continue()`, observed it throws `"Cannot continue from message role: assistant"` on every realistic resume path, and landed a `persist-tool-outputs` facade (`@runtime/resume`) plus regression test so Phase 7's two-tier pause/respawn-with-replay can import a stable resume surface.

## Objective & Outcome

**Objective:** Settle the Phase 7 resume-strategy question with measurements. Produce a doc + minimal implementation + regression test.

**Outcome:** Three deliverables landed:
1. `docs/spikes/pi-sdk-resume.md` — scenario matrix, measurements, decision, Phase 7 checklist.
2. `src/runtime/resume/` — `resume()` facade + `ToolOutputStore` (in-memory + file-backed).
3. `test/integration/spike/pi-sdk-resume.test.ts` — six scenario tests (5 observational + 1 facade smoke test).

Phase 7 plan 07-03 can now `import { resume, RESUME_STRATEGY } from '@runtime/resume'` and ignore the underlying strategy.

## What Landed

### Spike harness (Tasks 1–3)
- `test/integration/spike/fixtures.ts`: five scripted `FauxResponseStep` sequences (cold-start, mid-tool, mid-response, post-commit, catastrophic).
- `test/integration/spike/pi-sdk-resume.test.ts`: five scenario runs that drive a real `Agent` against pi-ai's faux provider and log `[SPIKE][Sn]` observations. Spike output saved to `.planning/phases/03-worker-execution-loop/spike-run-output.txt`.

### Decision doc (Task 4)
- `docs/spikes/pi-sdk-resume.md` (165 lines): scenario matrix with real observations quoted from the spike run, decision reasoning, minimal impl description, Phase 7 integration checklist, known follow-ups, and §Verification pointer to Task 7's smoke test.

### Checkpoint decision (Task 5 — auto-selected under auto-mode)
- **Decision: persist-tool-outputs.** Observations conclusively show `continue()` throws in all four resume-relevant scenarios (S2–S5). Native was unworkable; hybrid added complexity without saving code.

### Resume facade (Task 6)
- `src/runtime/resume/tool-output-store.ts`: `ToolOutputStore` interface with in-memory (Map-backed) and file-backed (one JSON file per `toolCallId`, atomic write via tmp+rename, id sanitization) implementations.
- `src/runtime/resume/index.ts`: `resume({ agent, savedMessages, toolOutputs })` plus `RESUME_STRATEGY` const. Discriminated `ResumeOutcome` ({ kind: 'resumed' | 'already-terminated' }). Handles three cases:
  1. Transcript already ends on user/tool-result → call `continue()` directly.
  2. Terminal assistant message with no tool calls → no-op `already-terminated`.
  3. Terminal assistant message with tool calls → splice matching `ToolResultMessage` entries from the store, then `continue()`. Missing outputs → bail with `already-terminated: missing-tool-outputs:<ids>`.
- `src/runtime/sessions/index.ts`: added the `// === Resume / replay (plan 03-05) ===` marker comment pointing at the spike doc. No behavior change — just documents the save-site contract.
- `test/unit/runtime/resume/tool-output-store.test.ts`: six tests covering roundtrip, missing-id, clear, overwrite, cross-instance durability (simulating process restart), id sanitization, and atomic rename.

### Facade smoke test (Task 7)
- Appended `Facade — resume() via @runtime/resume handles saved-and-rehydrated Agent without throwing` to the spike test suite. Asserts `RESUME_STRATEGY === 'persist-tool-outputs'` and that `resume()` returns `already-terminated` instead of throwing on a cold-start transcript.

## Key Measurements (from spike-run-output.txt)

| # | Scenario | `lastRole` | `pendingToolCalls` | `continue()` outcome |
|---|----------|-----------|---------------------|----------------------|
| 1 | Cold start (prompt+submit) | assistant | 0 | N/A (cold) |
| 2 | Mid-tool abort | assistant | 0 | **throws** `Cannot continue from message role: assistant` |
| 3 | Mid-response abort | assistant | 0 | **throws** same error |
| 4 | Post-commit (clean turn_end) | assistant | 0 | **throws** same error |
| 5 | Catastrophic (session roundtrip + rehydrated Agent) | assistant | 0 | **throws** same error |

Crucial finding: **every realistic resume path leaves the transcript with `lastRole === 'assistant'`**, which pi-sdk's `continue()` hard-rejects. The fallback strategy is non-negotiable.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Incorrect path-traversal assertion in the ToolOutputStore unit test**
- **Found during:** Task 6 unit test run
- **Issue:** Asserted that the sanitized filename must NOT contain `..` as a substring. But the sanitizer correctly replaces `/` with `_`, leaving `tc/../evil` → `tc_.._evil.json`. The dots are harmless (no path separator), so they're safe but failed the naive assertion.
- **Fix:** Relaxed the assertion to check no platform path separator exists (`/` or `path.sep`) and pinned the exact expected filename (`tc_.._evil.json`). The security property (single-directory confinement) is preserved.
- **Files modified:** test/unit/runtime/resume/tool-output-store.test.ts
- **Commit:** fc57a0b (amended inline before commit)

**2. [Rule 3 — Blocking] Missing node_modules in fresh worktree**
- **Found during:** Task 1 typecheck
- **Issue:** The worktree was created clean but `node_modules/` is not a git-tracked directory, so fresh worktrees have no dependencies.
- **Fix:** Symlinked `/home/alpine/vcode0/node_modules` into the worktree. The root repo has the correct dependency versions for pi-sdk 0.66.1.
- **Files modified:** (symlink, not tracked in git)

### Other notes

- The plan's proposed `reporter=basic` flag for vitest is not supported by this project's vitest version. Used the default reporter — same information, minor cosmetic difference.
- Biome autoformat reorganized some imports in `src/runtime/resume/index.ts`, `test/integration/spike/fixtures.ts`, and `test/integration/spike/pi-sdk-resume.test.ts`. Cosmetic; no behavior change.

### Out-of-scope discoveries (logged, not fixed)

- `test/unit/agents/runtime.test.ts > runs discuss with structured submit tool and persists transcript` timed out (5s timeout) on one run but passed on a clean re-run. This appears to be a flake triggered by parallel load (two worktrees running vitest simultaneously). Not caused by this plan — left untouched.

## Threat Flags

None. This plan adds no new network surface, no new auth paths, no new file access patterns at trust boundaries, and no schema changes. The `FileToolOutputStore` writes inside a caller-provided directory (Phase 7 owns the directory choice) and sanitizes tool-call IDs to prevent path traversal.

## TDD Gate Compliance

Plan was `type: execute`, not `type: tdd`, so RED/GREEN/REFACTOR gate enforcement does not apply. However, the spike harness (Tasks 1–2) landed before the implementation (Task 6), which is functionally equivalent to RED-first discovery — the spike measurements drove the implementation decision.

## Phase 7 / Phase 9 Integration Notes

- Phase 7 plan 07-03 should:
  1. `import { resume, RESUME_STRATEGY, createFileToolOutputStore } from '@runtime/resume'`.
  2. Wire `afterToolCall` on the worker's `Agent` to record `{ toolCallId, toolName, content, details, isError, timestamp }` into a per-agent-run `ToolOutputStore`.
  3. On respawn, load the transcript via `FileSessionStore.load()`, instantiate a matching `createFileToolOutputStore(<per-run-dir>)`, and call `resume(...)`.
  4. Branch on `outcome.kind`: `resumed` → live again; `already-terminated` → surface as inbox item.
- Phase 9 (crash recovery) uses the same facade — the spike doc (§Phase 7 integration checklist) calls out that the store must be keyed on `{ agentRunId, toolCallId }` to survive tool-retry scenarios.

## Commits

| Task | Commit | Title |
|------|--------|-------|
| 1 | 4174cb4 | test(integration/spike): scripted FauxResponse fixtures for pi-sdk resume spike |
| 2 | 22d0a25 | test(integration/spike): five-scenario pi-sdk Agent.continue() harness |
| 4 | f504532 | docs(spikes): pi-sdk Agent resume/replay decision + scenario matrix |
| 6 | fc57a0b | feat(runtime/resume): persist-tool-outputs resume facade + ToolOutputStore |
| 7 | 1958792 | test(integration/spike): @runtime/resume facade smoke test + biome fixes |

## Verification

- `npx tsc --noEmit` — exit 0.
- `npm run test:unit -- test/unit/runtime/resume` — 1497 tests passed (6 new in `tool-output-store.test.ts`, 1491 baseline).
- `npm run test:integration -- test/integration/spike/pi-sdk-resume` — 56 passed / 1 skipped (all six spike tests green, 50 baseline integration tests unaffected).
- `npx biome check src/runtime/resume/ test/integration/spike/ test/unit/runtime/resume/ docs/spikes/pi-sdk-resume.md src/runtime/sessions/index.ts` — 6 files, no fixes needed.

## Self-Check: PASSED

All claimed files exist and commits are present:

- `test/integration/spike/fixtures.ts` — FOUND
- `test/integration/spike/pi-sdk-resume.test.ts` — FOUND
- `src/runtime/resume/index.ts` — FOUND
- `src/runtime/resume/tool-output-store.ts` — FOUND
- `test/unit/runtime/resume/tool-output-store.test.ts` — FOUND
- `docs/spikes/pi-sdk-resume.md` — FOUND (165 lines)
- `.planning/phases/03-worker-execution-loop/spike-run-output.txt` — FOUND
- src/runtime/sessions/index.ts marker comment — present (verified with grep `=== Resume / replay (plan 03-05) ===`)
- Commits 4174cb4, 22d0a25, f504532, fc57a0b, 1958792 — all found in `git log`
