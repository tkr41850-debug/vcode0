# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 5 (Feature Lifecycle) — about to discuss.

## Current Position

Phase: 5 of 12 (Feature Lifecycle)
Plan: 0 of TBD in current phase
Status: Pending discuss
Last activity: 2026-04-24 — Phase 4 complete. VERIFICATION 4/5 PASS + 1 PARTIAL (perf smoke gated behind LOAD_TEST=1; both tiers pass when run). Contract surface stable for Phase 5 to build on.

Progress: [████░░░░░░] 33%

## Performance Metrics

**Velocity:**
- Total plans completed: 14
- Average duration: ~60 min/plan
- Total execution time: ~10h across phases 1-4

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 (Foundations & Clarity) | 3 | ~45m | ~15m |
| 2 (Persistence & Port Contracts) | 3 | ~75m | ~25m |
| 3 (Worker Execution Loop + Spike) | 5 | ~6h | ~70m |
| 4 (Scheduler Tick + Event Queue) | 3 | ~3h | ~60m |

**Recent Trend:** Phase 4 three serial waves (each wave one plan, no parallelism benefit). Wave 1 (event-queue hygiene + tick-boundary guard), Wave 2 (7-key priority sort + canonical DAG fixtures + retry backoff), Wave 3 (feature-dep merge gate + dispatch guard + perf smoke + E2E). Plan-checker PASS first iteration; verifier 4/5 PASS + 1 PARTIAL.

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

None yet.

### Blockers/Concerns

- **Pi-sdk Agent resume/replay fidelity** RESOLVED 2026-04-23: spike chose persist-tool-outputs fallback (Agent.continue() throws on assistant-terminated transcripts across all 5 scenarios). `@runtime/resume` facade + ToolOutputStore landed for Phase 7. Live-provider re-validation deferred to Phase 7 (07-03) and crash-recovery UX to Phase 9.
- **Merge-train serial throughput** (acknowledged): strict-main merge train is a known v1 bottleneck under many parallel features. Optimization deferred (see `docs/feature-candidates/` and REQ-MERGE-V2-01/02).
- **`@microsoft/tui-test` pre-1.0**: treat TUI e2e coverage as smoke-only in Phase 12; full e2e deferred.
- **Parallel-vitest flakes** (Phase 3): 5 pre-existing unit tests flake under parallel-load (worktree.test.ts x4, tui/view-model.test.ts x1); logged as follow-up in 03-02-SUMMARY.md.
- **Phase 4 perf smoke gated** (2026-04-24): Both tiers of scheduler-perf-smoke run only under `LOAD_TEST=1`. Default CI doesn't exercise the <100ms p95 budget. Follow-up in `.planning/phases/04-scheduler-tick-event-queue/deferred-items.md`.
- **Biome format-only churn in ~17 unrelated files** (2026-04-24): `npm run check:fix` normalizes formatting in runtime/agents/config/warnings files; plans 04-01/02/03 left them out of scope. Tree is clean after each plan commit.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Phase 4 | Perf smoke default tier gated behind LOAD_TEST=1 | Open follow-up | 2026-04-24 |
| Phase 4 | AST boundary walker narrowed to compose.ts + agents/runtime.ts (CONTEXT said orchestrator/**) | Open follow-up | 2026-04-24 |
| Phase 4 | `GVC_ASSERT_TICK_BOUNDARY` off by default in CI | Open follow-up | 2026-04-24 |

## Session Continuity

Last session: 2026-04-24 — Phase 4 complete end-to-end (discuss → research → plan → execute → verify). HEAD at `1a6328d`.
Stopped at: Phase 4 done. Auto-chain advancing to Phase 5 (Feature Lifecycle).
Resume file: discuss Phase 5 next.
