# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 12 integration and polish is complete; v1 milestone implementation is complete pending any release/publish decision outside this roadmap.

## Current Position

Phase: 12 of 12 (Integration & Polish)
Plan: complete
Status: Phase 12 complete; all roadmap phases complete.
Last activity: 2026-05-03 — Executed 12-03: added root README source-install runbook, fixed fresh source installs on Alpine/musl by forcing node-pty source rebuild instead of trusting the glibc prebuild, verified a fresh clone with `npm install` and `npm run test:tui:e2e` (9 passed), and greened out all 37 v1 requirements in `.planning/REQUIREMENTS.md`.

Progress: [##########] 100% for Phase 12 | [##########] 100% milestone complete (12/12 phases)

## Performance Metrics

**Velocity:**
- Total plans completed: 38
- Phases completed: 12 of 12
- Latest verification: 2026-05-03 — Phase 12 source-install dry-run green from fresh clone (`npm install`; postinstall rebuilt node-pty from source; `npm run test:tui:e2e`: 9 passed). Latest full repo verification before final state update: `npm run check` green (94 files, 1969 passed, 3 skipped).

**Recent Trend:** Phase 12 closed the v1 integration chain: 12-01 proved backend prompt-to-main lifecycle plus verify-agent 5/5 audit; 12-02 stabilized the PTY/TUI golden path; 12-03 added source-install docs, fixed clean Alpine/musl source installs, and completed v1 traceability.

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

- None in the v1 roadmap. Release packaging/global distribution remains deferred to v2 distribution requirements.

### Blockers/Concerns

- **Pi-sdk Agent resume/replay fidelity** RESOLVED 2026-04-23: spike chose persist-tool-outputs fallback (Agent.continue() throws on assistant-terminated transcripts across all 5 scenarios). Phase 7 shipped checkpointed waits + replay around that decision.
- **Merge-train serial throughput** (acknowledged): strict-main merge train is a known v1 bottleneck under many parallel features. Optimization deferred (see `docs/feature-candidates/` and REQ-MERGE-V2-01/02).
- **`@microsoft/tui-test` pre-1.0**: RESOLVED 2026-05-03 for v1 smoke coverage. SIGSEGV was node-pty glibc prebuild incompatible with Alpine/musl; fixed by rebuilding node-pty from source on musl source installs. All 9 smoke tests pass including golden path.
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

Last session: 2026-05-03 — Phase 12 plan 03 completed: root README source-install runbook added; fresh clone source-install dry-run passed; all 37 v1 requirements marked complete with traceability evidence.
Stopped at: v1 roadmap complete.
Resume file: `.planning/ROADMAP.md` Phase 12 section and `.planning/phases/12-integration-polish/12-03-SUMMARY.md`.
