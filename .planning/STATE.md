# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 11 documentation and diagnostic tooling is underway, starting with 11-01: a read-only `gvc0 explain` CLI that reuses shipped state/view-model summaries for feature, task, and run diagnostics.

## Current Position

Phase: 11 of 12 (Documentation & Diagnostic Tooling)
Plan: 11-01 ready to execute
Status: Research and planning are complete for a pre-TUI `gvc0 explain` path backed by read-only compose/store helpers and shared summary builders.
Last activity: 2026-05-01 — Wrote `11-RESEARCH.md` and `11-01-PLAN.md`, synced roadmap/state, and verified the planning slice with `npm run check`; 11-01 implementation is next.

Progress: [----------] 0% for Phase 11

## Performance Metrics

**Velocity:**
- Total plans completed: 35
- Phases completed: 10 of 12
- Latest verification: 2026-05-01 — Phase 11 planning slice green on `npm run check` (`format:check`, `lint`, `typecheck`, and `vitest run`: 1948 passed, 3 skipped)

**Recent Trend:** Phase 10 closed the operator-visibility gap inside the TUI, and Phase 11 is now shifting that clarity into read-only diagnostics and documentation truthfulness, starting with a pre-TUI `gvc0 explain` CLI.

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

- Execute Phase 11 plan 11-01: add a pre-TUI `gvc0 explain` CLI for feature/task/run diagnostics using read-only compose/store helpers and shared state/view-model summaries.
- After 11-01 lands, plan and execute 11-02 doc-vs-code drift checks/state-diagram consolidation and 11-03 concerns-to-tests mapping plus newcomer narrative docs.

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

Last session: 2026-05-01 — Phase 11 research and 11-01 planning are complete and verified for the read-only `gvc0 explain` CLI slice.
Stopped at: begin 11-01 implementation for the pre-TUI `gvc0 explain` path and shared text-summary reuse.
Resume file: continue under `.planning/phases/11-documentation-diagnostic-tooling/11-01-PLAN.md`.
