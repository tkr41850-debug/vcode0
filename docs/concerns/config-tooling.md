# Concern: Config + Tooling Gaps

Snapshot from a 2026-04-10 audit. Low-severity, easy-to-forget items that compound over time.

## Concern

The repo's TypeScript/test/lint config has a few rough edges that erode rigor without producing visible failures.

1. **`@types/node` major version mismatch** — `package.json` declares `@types/node ^25.5.2` but `engines.node` is `>=24`. TS will accept Node 25-only APIs that fail at runtime on Node 24.
2. **`passWithNoTests: true` in `vitest.config.ts`** — CI passes even when test globs stop matching, hiding accidental test loss.
3. **Dual lint surface** — Biome handles formatting and primary lint; ESLint is layered in via `lint:ci`. Drift risk if rule sets are not kept aligned.
4. **No coverage reporting** — No coverage commands, reporters, or thresholds configured anywhere.
5. **`skipLibCheck: true`** — Common and pragmatic, but weakens type rigor across dependency boundaries.

## Why to Watch

None of these are blockers, but they degrade the signal-to-noise ratio of the verification pipeline. Item 1 is the most likely to cause a real bug.

## What to Observe

- runtime errors on Node 24 that did not surface in `tsc`
- silently-empty test runs
- formatting / lint disagreements between Biome and ESLint
- regressions that a coverage gate would have caught

## Mitigation Sketch

Fix opportunistically:

- Pin `@types/node` to a 24.x line, or bump the engine to `>=25` if Node 25-only APIs are intentional.
- Set `passWithNoTests: false` and accept that empty globs fail loudly.
- Audit Biome and ESLint rule overlap; pick one as canonical for each concern.
- Add `vitest --coverage` with a baseline threshold once tests stabilise.
- Re-evaluate `skipLibCheck` only if a dependency boundary actively bites.
