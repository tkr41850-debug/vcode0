# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-23)

**Core value:** From one prompt, orchestrate parallel autonomous coding that lands on `main` without breaking it — live-steerable from a single TUI.
**Current focus:** Phase 11 documentation and diagnostic tooling is complete; Phase 12 integration and polish is next.

## Current Position

Phase: 12 of 12 (Integration & Polish)
Plan: 12-03 next
Status: Phase 12 plan 12-02 complete; 12-03 is next.
Last activity: 2026-05-02 — Executed 12-02: stabilized @microsoft/tui-test SIGSEGV (node-pty glibc prebuild incompatible with Alpine musl; fixed via postinstall node-gyp rebuild). Added golden-path TUI E2E smoke (SC12-3). All 9 tui-test smoke tests pass. npm run check green (94 files, 1969 passed).

Progress: [##########] 100% for Phase 11 | [####      ] ~33% for Phase 12 (2/6 plans)

## Performance Metrics

**Velocity:**
- Total plans completed: 37
- Phases completed: 11 of 12
- Latest verification: 2026-05-02 — Phase 11 concerns/newcomer docs slice green on `npm run check` (`format:check`, `lint`, `typecheck`, and `vitest run`: 1967 passed, 3 skipped)

**Recent Trend:** Phase 12 plan 02 stabilized the @microsoft/tui-test lane (SIGSEGV root cause: node-pty glibc prebuild incompatible with Alpine musl; fixed via postinstall node-gyp rebuild from source). Added golden-path TUI E2E smoke covering SC12-3: startup→/init→graph feedback→Help overlay→graph focus→draft task→approval state→/quit. All 9 smoke tests pass. Fixed 4 secondary blockers: missing gvc0.config.json in workspaces, tsx --eval CJS/ESM mismatch for seeding, wrong autocomplete assertion string, and timeout too small for ~26s Alpine tsx startup.

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

- Execute Phase 12 plans 12-03 through 12-06 (source-install dry-run, README polish, final traceability green-out, and release checklist).

### Blockers/Concerns

- **Pi-sdk Agent resume/replay fidelity** RESOLVED 2026-04-23: spike chose persist-tool-outputs fallback (Agent.continue() throws on assistant-terminated transcripts across all 5 scenarios). Phase 7 shipped checkpointed waits + replay around that decision; live-provider re-validation remains deferred to Phase 9 crash-recovery UX.
- **Merge-train serial throughput** (acknowledged): strict-main merge train is a known v1 bottleneck under many parallel features. Optimization deferred (see `docs/feature-candidates/` and REQ-MERGE-V2-01/02).
- **`@microsoft/tui-test` pre-1.0**: treat TUI e2e coverage as smoke-only in Phase 12; full e2e deferred. RESOLVED 2026-05-02 (12-02): SIGSEGV was node-pty glibc prebuild incompatible with Alpine musl; fixed via postinstall node-gyp rebuild. All 9 smoke tests now pass including golden-path (SC12-3 satisfied).
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

Last session: 2026-05-02 — Phase 12 plan 02 completed: stabilized @microsoft/tui-test SIGSEGV (node-pty musl fix), added golden-path TUI E2E smoke (SC12-3), all 9 smoke tests pass, npm run check green.
Stopped at: 12-02 complete; 12-03 is next.
Resume file: `.planning/ROADMAP.md` Phase 12 section, starting with 12-03.
