# Deferred Items — Phase 04

Items discovered during plan execution but out of scope for the plan that surfaced them. Each entry captures the lint/test error category, file, and why it was deferred.

## Plan 04-01

### Pre-existing ESLint violations (47 total, reported by `npm run lint:ci`)

These errors exist on commit `1ab097b3c76f29798e4e28d8a952345c84d52762` (the plan's EXPECTED_BASE) and are unrelated to Plan 04-01 changes. Per the SCOPE BOUNDARY rule ("Only auto-fix issues DIRECTLY caused by the current task's changes"), they are logged here rather than fixed.

Representative violations:

- **test/unit/orchestrator/scheduler-loop.test.ts** (4 errors on lines 707, 2099, 2431, 2508) — `@typescript-eslint/require-await`, `@typescript-eslint/no-unsafe-assignment`. All in code that predates Plan 04-01 — the new `SchedulerLoop — enqueue wake semantics` describe block added by this plan (lines ~5203–5268) is clean.
- **test/unit/tui/commands.test.ts** (3 errors) — `@typescript-eslint/require-await` on async arrow helpers.
- **test/unit/tui/view-model.test.ts** (1 error) — unsafe `any` assignment.
- Remaining ~39 errors — `@typescript-eslint/unbound-method` on various mock/fixture helpers throughout the test tree.

Suggested follow-up: a dedicated lint-sweep commit on a separate branch, keeping per-phase deliverables clean.

### Format-only churn in unrelated files

Running `npm run check:fix` reformats 10–20 unrelated files under `src/` and `test/` to bring them to the canonical biome style. These changes are safe but noisy; they were stashed during this plan to keep commits focused and are not part of the plan's deliverables.

Suggested follow-up: a dedicated `chore(format):` commit.
