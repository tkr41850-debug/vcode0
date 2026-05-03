# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** v1 milestone is archive-only complete; active requirements remain in place until the next milestone is defined.

## Current Position

Phase: 12 of 12 (Integration & Polish)
Plan: complete
Status: v1 milestone archive-only completion prepared; all roadmap phases complete; v1 milestone audit passed.
Last activity: 2026-05-03 — Archive-only milestone closeout: created v1 roadmap, requirements, and audit archives under `.planning/milestones/`; compacted `.planning/ROADMAP.md`; updated `.planning/PROJECT.md`; kept active `.planning/REQUIREMENTS.md` and skipped git tag per user choice.

Progress: [##########] 100% for Phase 12 | [##########] 100% milestone complete (12/12 phases)

## Performance Metrics

**Velocity:**
- Total plans completed: 38
- Phases completed: 12 of 12
- Latest verification: 2026-05-03 — Post-audit prompt-to-main focused proof green: `npx vitest run test/integration/prompt-to-main-e2e.test.ts --reporter=verbose` passed 1/1; `npm run check` green (94 files, 1969 passed, 3 skipped).

**Recent Trend:** Phase 12 closed the v1 integration chain: 12-01 proves backend prompt-to-main from top-level prompt through merge-train drain plus verify-agent 5/5 audit; 12-02 stabilized the PTY/TUI golden path; 12-03 added source-install docs, fixed clean Alpine/musl source installs, and completed v1 traceability.

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

Last session: 2026-05-03 — v1 audit prompt-to-main gap closed: backend E2E now starts from `top_planner_requested`, approves the top-level proposal, executes feature lifecycle with inbox help, verifies, and drains the merge train to merged.
Stopped at: v1 archive-only milestone closeout complete; cleanup/tag/delete-requirements intentionally skipped.
Resume file: `.planning/ROADMAP.md` Phase 12 section and `.planning/phases/12-integration-polish/12-03-SUMMARY.md`.
