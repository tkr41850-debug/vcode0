# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 9 crash recovery UX is in progress — 09-01 startup recovery substrate completed on 2026-04-29, and 09-02 startup respawn + transcript replay hookup completed on 2026-05-01 with immediate startup fallback for `not_resumable` runs, structured replay-incomplete diagnostics, parked recovery inbox visibility, and readable TUI recovery wording. Next slice: 09-03 recovery-summary inbox item + crash fault-injection coverage.

## Current Position

Phase: 9 of 12 (Crash Recovery UX) next
Plan: 5 of 5 completed in Phase 8
Status: Phase 8 complete. 08-01 inbox, 08-02 merge-train, 08-03 manual DAG edit actions, 08-04 per-task transcript surface, and 08-05 authoritative config plus visible cancel controls are synced to shipped code.
Last activity: 2026-04-29 — Phase 8 plan 08-05 recorded. The TUI now exposes authoritative config through `/config`, graph keybind `c`, and `/config-set`; supported settings persist and hot-apply without restart; `topPlanner`, `featurePlanner`, `taskWorker`, and `verifier` now map to distinct runtime model consumers; and the three cancel levers now ship as distinct visible actions (`/task-cancel-preserve`, `/task-cancel-clean`, `/feature-abandon`). Verification is green for focused runtime/agent-runtime/feature-lifecycle/TUI/scheduler-boundary lanes and for `npm run check` (`1917 passed`, `3 skipped`). The separate `@microsoft/tui-test` smoke lane remains blocked by the existing workerpool `SIGSEGV` crash across all eight smoke tests.

Progress: [██████████] 100% for Phase 8

## Performance Metrics

**Velocity:**
- Total plans completed: 30
- Phases completed: 8 of 12
- Latest focused verification: 2026-04-29 — `npm run typecheck`, runtime/worktree/agent-runtime/feature-lifecycle/TUI/scheduler-boundary lanes green, and `npm run check` green

**Recent Trend:** Phase 8 is complete: the TUI now exposes inbox, merge-train, transcript, command-first manual DAG edit actions, authoritative config controls, and visible cancel levers directly in the shell. The next phase can focus on crash recovery UX rather than operator-surface gaps.

*Updated after each plan completion.*

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md Key Decisions table. Highlights from initialization:

- No persistent "goal" entity — prompts are ephemeral, persisted as per-feature audit log.
- Milestones are persistent feature groupings; multiple may overlap.
- Two-level planner (top-level features + feature-level tasks); additive re-invocation; manual edits always win.
- Inbox is the unified "things waiting on you" surface.
- Two-tier pause: hot window (configurable, ~10 min) → checkpoint + release.
- Verification before merge is an agent review (not tests).
- Merge-train re-entry capped at 10 (configurable) before parking to inbox.
- Existing code is reference, not baseline — rewrites welcome if they serve clarity.

### Pending Todos

- Research, plan, and execute Phase 9 crash recovery UX: stale-lock sweep, orphan-worktree triage, in-flight worker respawn, and recovery-summary inbox flow.

### Blockers/Concerns

- **Pi-sdk Agent resume/replay fidelity** RESOLVED 2026-04-23: spike chose persist-tool-outputs fallback (Agent.continue() throws on assistant-terminated transcripts across all 5 scenarios). Phase 7 shipped checkpointed waits + replay around that decision; live-provider re-validation remains deferred to Phase 9 crash-recovery UX.
- **Merge-train serial throughput** (acknowledged): strict-main merge train is a known v1 bottleneck under many parallel features. Optimization deferred (see `docs/feature-candidates/` and REQ-MERGE-V2-01/02).
- **`@microsoft/tui-test` pre-1.0**: treat TUI e2e coverage as smoke-only in Phase 12; full e2e deferred. Current status (2026-04-29): workerpool `SIGSEGV` crash across all eight smoke tests, including pre-existing cases.
- **Parallel-vitest flakes** (Phase 3): 5 pre-existing unit tests flake under parallel-load (worktree.test.ts x4, tui/view-model.test.ts x1); logged as follow-up in 03-02-SUMMARY.md.
- **Phase 4 perf smoke gated** (2026-04-24): Both tiers of scheduler-perf-smoke run only under `LOAD_TEST=1`. Default CI doesn't exercise the <100ms p95 budget. Follow-up in `.planning/phases/04-scheduler-tick-event-queue/deferred-items.md`.
- **AST boundary walker narrowed to compose.ts + agents/runtime.ts** (2026-04-24): follow-up remains open from Phase 4.
- **`GVC_ASSERT_TICK_BOUNDARY` off by default in CI** (2026-04-24): follow-up remains open from Phase 4.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Phase 4 | Perf smoke default tier gated behind LOAD_TEST=1 | Open follow-up | 2026-04-24 |
| Phase 4 | AST boundary walker narrowed to compose.ts + agents/runtime.ts (CONTEXT said orchestrator/**) | Open follow-up | 2026-04-24 |
| Phase 4 | `GVC_ASSERT_TICK_BOUNDARY` off by default in CI | Open follow-up | 2026-04-24 |

## Session Continuity

Last session: 2026-05-01 — Phase 09 plan 09-02 synced to shipped code and artifacts; focused recovery/runtime/TUI verification green for `npm run typecheck` and the targeted recovery, scheduler-loop, worker-runtime, TUI view-model, IPC frame-schema, and compose suites.
Stopped at: Phase 9 is in progress with 09-01 and 09-02 complete. Next slice is 09-03 recovery-summary inbox item + crash fault-injection coverage.
Resume file: continue under `.planning/phases/09-crash-recovery-ux/`.
