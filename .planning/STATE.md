# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 10 re-plan flows and manual edits polish is in progress — 10-01 now has a read-only planner-audit overlay and `/planner-audit` command wired into the TUI on top of the event-backed audit reader, so the next work can close out 10-01 and move into proposal preview/collision polish for 10-02.

## Current Position

Phase: 10 of 12 (Re-plan Flows & Manual Edits Polish) in progress
Plan: 10-01 in progress in Phase 10
Status: Phase 10 is underway. Plan 10-01 now exposes planner audit history end-to-end in the TUI through the normalized reader, a feature-aware read-only overlay, and the `/planner-audit` command surface; the next work is to close out 10-01 and advance into 10-02 proposal-preview/collision polish.
Last activity: 2026-05-01 — Added the read-only planner-audit overlay and `/planner-audit` command surface on top of the normalized audit reader, then proved the slice with focused `typecheck` plus TUI view-model/command tests.

Progress: [██████████] 100% for Phase 9

## Performance Metrics

**Velocity:**
- Total plans completed: 33
- Phases completed: 9 of 12
- Latest verification: 2026-05-01 — focused green for the planner-audit overlay step (`npm run typecheck`; `npx vitest run test/unit/tui/view-model.test.ts test/unit/tui/commands.test.ts test/integration/tui/smoke.test.ts` → 46 passed)

**Recent Trend:** Phase 9 is complete: crash recovery is now operator-visible through the existing inbox and command surfaces, with startup summary/orphan triage backed by real-file restart coverage. The next phase can focus on planner session and manual-edit polish instead of recovery truthfulness gaps.

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

- Research, plan, and execute Phase 10 re-plan flows and manual edits polish: planner session picker, continue-vs-fresh UX, audit-log reader, proposal preview, and collision-surface polish.

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

Last session: 2026-05-01 — Phase 10 plan 10-01 planner-audit overlay step is complete locally and focused TUI verification is green.
Stopped at: rerun full `npm run check`, commit this planner-audit overlay step with `.planning`, then close out 10-01 and continue into 10-02.
Resume file: continue under `.planning/phases/10-re-plan-flows-and-manual-edits-polish/`.
