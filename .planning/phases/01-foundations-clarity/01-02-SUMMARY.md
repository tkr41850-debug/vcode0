---
phase: 01-foundations-clarity
plan: 02
subsystem: tooling/linting
tags: [boundary, lint, biome, architecture]
requires: []
provides:
  - ci-enforced @core/* import boundary
  - structural-test safety net for @core/* imports
affects:
  - biome.json
  - test/unit/core/boundary.test.ts
tech-stack:
  added: []
  patterns:
    - Biome overrides scoped to path glob (src/core/**/*.ts)
    - Structural boundary test via source-grep walker
key-files:
  created:
    - test/unit/core/boundary.test.ts
  modified:
    - biome.json
decisions:
  - "Chose Biome as linter host — `lint/style/noRestrictedImports` exists in Biome 2.4.10 and fires with custom messages."
  - "Used `paths` (exact) + `patterns.group` (glob) split because `paths` keys cannot contain wildcards in Biome 2.x."
  - "Kept structural test as redundant safety net independent of lint config."
metrics:
  completed: 2026-04-23
  duration: prior-executor + continuation session
---

# Phase 01 Plan 02: Enforce @core/* Import Boundary — Summary

CI-enforced architectural boundary preventing `src/core/**` from importing any of `@runtime`, `@persistence`, `@tui`, `@orchestrator`, `@agents`, `@app` — with a redundant structural unit test that survives lint-config drift.

## What Shipped

- **biome.json** — added an `overrides` entry scoped to `src/core/**/*.ts` activating `lint/style/noRestrictedImports`. Bare aliases blocked via `paths`; glob forms (`@runtime/*`, etc.) blocked via `patterns.group`. Each entry carries a directive message explaining the boundary and pointing at the port/type remediation.
- **test/unit/core/boundary.test.ts** — walks every `.ts`/`.tsx` under `src/core/`, grep-asserts each against four import-specifier regexes (static `from`, static `from` with subpath, dynamic `import()`, dynamic `import()` with subpath) across all six disallowed aliases. Generates one `it.each` case per core file (30 cases at time of write, all passing).

## Tasks Completed

| # | Task | Status |
|---|------|--------|
| 1 | Inventory linter config; chose Biome (`lint/style/noRestrictedImports` exists in 2.4.10) | Done |
| 2 | Add scoped boundary rule to biome.json overrides | Done (commit `ca85fd0`) |
| 3 | Intentional-violation probe — rule fires with expected message, probe deleted | Done (verified in continuation session) |
| 4 | Structural safety-net test in test/unit/core/boundary.test.ts | Done (commit `94542e2`, formatter fixes in `10122ec`) |
| 5 | Confirm full check pipeline — see Deviations | Partial (see below) |

## Probe Verification (Task 3)

Placed `src/core/__boundary-violation-probe.ts` importing `@runtime/worker-pool`. Biome output:

```
src/core/__boundary-violation-probe.ts:2:33 lint/style/noRestrictedImports
  × src/core/* must not import from @runtime/* — violates architectural
    boundary. Use a port/type in @core/* and let @runtime/* implement.
```

Probe file deleted; `src/core/__boundary-violation-probe.ts` does not exist at plan completion.

## Deviations from Plan

**1. [Rule 3 - Blocking, environmental] `npm run check` / `npm run lint` cannot run from inside the `.claude/worktrees/*` worktree.**
- **Root cause:** `biome.json` top-level `files.includes` contains `"!!**/.claude"`, which matches the worktree's path prefix and causes `biome check .` to exclude every file when the CWD is inside `.claude/worktrees/agent-aa8a8030`.
- **Verified pre-existing:** Reverting `biome.json` to its pre-plan state reproduces the same "No files were processed" error, confirming it is not caused by this plan.
- **Workaround used:** Ran `npx biome check src/core test/unit/core/boundary.test.ts` with explicit paths — clean (0 errors). Ran `npx vitest run test/unit/core/boundary.test.ts` directly — 30 tests passed.
- **Action:** Out of scope for plan 01-02 (concerns the Biome config's interaction with the agent-worktree convention). Left unchanged; flagged here for a future tooling plan.

**2. [Rule 1 - Style] Formatter adjustments to boundary.test.ts** (commit `10122ec`)
- Biome formatter reordered named imports alphabetically and compacted the `it.each(...)` block; applied and committed as `style(01-02): apply Biome formatter fixes to boundary test`. No behavior change.

## Verification Status

| Check | Result | Note |
|-------|--------|------|
| `biome check src/core` | PASS | 0 lint errors on clean tree |
| `biome check test/unit/core/boundary.test.ts` | PASS | formatter + lint clean |
| Probe placement (`@runtime/worker-pool` import in src/core) | FIRES | emits exact message from config |
| `npx vitest run test/unit/core/boundary.test.ts` | PASS | 30/30 tests pass |
| `npm run check` / `npm run verify` (from within worktree) | NOT RUN | blocked by pre-existing `.claude` ignore glob; see deviation 1 |

## Commits

| SHA | Subject |
|-----|---------|
| `ca85fd0` | `feat(01-02): add Biome noRestrictedImports boundary rule for src/core/**` |
| `94542e2` | `test(01-02): add structural boundary safety-net test for src/core` |
| `10122ec` | `style(01-02): apply Biome formatter fixes to boundary test` |

## Self-Check: PASSED

- biome.json contains the `src/core/**/*.ts` override with `noRestrictedImports`: FOUND
- test/unit/core/boundary.test.ts exists and passes 30/30: FOUND
- `src/core/__boundary-violation-probe.ts` does NOT exist: CONFIRMED
- Commits `ca85fd0`, `94542e2`, `10122ec` exist in `git log`: FOUND
