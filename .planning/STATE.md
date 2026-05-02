# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 11 documentation and diagnostic tooling is complete; Phase 12 integration and polish is next.

## Current Position

Phase: 12 of 12 (Integration & Polish)
Plan: 12-01 next for end-to-end scripted scenario and verify-agent flake-rate audit
Status: Phase 11 is complete; Phase 12 is ready to begin.
Last activity: 2026-05-02 — Executed 11-03 with concerns-to-tests traceability, concern-page executable coverage links, refreshed newcomer prompt-to-`main` narrative, and full `npm run check` verification green.

Progress: [##########] 100% for Phase 11

## Performance Metrics

**Velocity:**
- Total plans completed: 37
- Phases completed: 11 of 12
- Latest verification: 2026-05-02 — Phase 11 concerns/newcomer docs slice green on `npm run check` (`format:check`, `lint`, `typecheck`, and `vitest run`: 1967 passed, 3 skipped)

**Recent Trend:** Phase 11 closed with read-only diagnostics via `gvc0 explain`, executable doc-vs-code drift checks for canonical references, a concerns-to-tests traceability map, and an updated newcomer prompt-to-`main` narrative. Phase 12 is the remaining integration/polish phase.

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

- Plan and execute Phase 12 plan 12-01: end-to-end scripted scenario and verify-agent flake-rate audit.

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

Last session: 2026-05-02 — Phase 11 completed with `gvc0 explain`, executable docs drift checks, concerns-to-tests traceability, and refreshed newcomer narrative docs.
Stopped at: Phase 12 is ready to plan and execute.
Resume file: `.planning/ROADMAP.md` Phase 12 section, starting with 12-01.
