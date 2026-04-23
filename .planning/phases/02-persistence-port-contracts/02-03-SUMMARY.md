---
phase: 02-persistence-port-contracts
plan: 03
subsystem: config
tags: [config, zod, schema, boot, per-role-models, budget]
requires: []
provides:
  - typed-gvc-config
  - per-role-model-map
  - boot-time-config-validation
affects:
  - src/compose.ts
  - src/orchestrator/scheduler/warnings.ts
  - src/orchestrator/services/verification-service.ts
  - src/core/warnings/index.ts
tech-stack:
  added:
    - zod@^4.3.6
  patterns:
    - zod-derived-config-schema
    - boot-time-validation
    - parked-alias-optional-fields
key-files:
  created:
    - src/config/schema.ts
    - src/config/load.ts
    - src/config/index.ts
    - src/config/verification-layer.ts
    - test/helpers/config-fixture.ts
    - test/unit/config/schema.test.ts
    - test/unit/config/load.test.ts
    - test/integration/config/config-boot.test.ts
  modified:
    - src/core/types/config.ts
    - src/core/types/index.ts
    - src/compose.ts
    - src/orchestrator/scheduler/warnings.ts
    - src/orchestrator/services/verification-service.ts
    - src/core/warnings/index.ts
    - tsconfig.json
    - package.json
    - package-lock.json
    - test/unit/compose.test.ts
    - test/unit/agents/runtime.test.ts
    - test/unit/orchestrator/services.test.ts
    - test/unit/orchestrator/conflicts.test.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/unit/orchestrator/recovery.test.ts
    - test/integration/feature-phase-agent-flow.test.ts
  deleted:
    - src/config.ts
    - test/unit/config.test.ts
decisions:
  - zod-v4-accepted-not-v3
  - park-legacy-keys-as-optional-aliases
  - do-not-auto-create-config-on-missing
metrics:
  duration: ~45m
  completed: 2026-04-23
---

# Phase 2 Plan 3: Typed Config Schema Summary

Replaced the 80-line hand-rolled `src/config.ts` with a Zod-first config module
under `src/config/`, landing REQ-CONFIG-01 (per-role model map for
`topPlanner` / `featurePlanner` / `taskWorker` / `verifier`) and REQ-CONFIG-02
(budget knobs parsed, enforcement deferred). Boot path remains one-line
(`new JsonConfigLoader().load()`); all existing call-sites keep compiling via
parked-alias optional fields on the schema.

## Tech stack

- **zod@^4.3.6** installed (plan assumed `^3.23.x` — v4 is current stable; shape
  compatible with the schema the plan specified; `z.record(Enum, Schema)` in v4
  already enforces key completeness for enum keys, making the `superRefine`
  belt-and-braces but harmless).

## Schema field map

| Field | Default | Validation | Source |
|-------|---------|------------|--------|
| `dbPath` | `.gvc0/state.db` | non-empty string | REQ-STATE-01 cross-cut |
| `models.topPlanner` | — (required) | `{provider, model}`, both non-empty | REQ-CONFIG-01 |
| `models.featurePlanner` | — (required) | `{provider, model}` | REQ-CONFIG-01 |
| `models.taskWorker` | — (required) | `{provider, model}` | REQ-CONFIG-01 |
| `models.verifier` | — (required) | `{provider, model}` | REQ-CONFIG-01 |
| `workerCap` | `4` | positive int | Phase 2 SC #4 |
| `retryCap` | `5` | positive int | Phase 2 SC #4 |
| `reentryCap` | `10` | positive int | Phase 2 SC #4 |
| `pauseTimeouts.hotWindowMs` | `600_000` (10 min) | positive int | REQ-INBOX-02 hot window |
| `budget.globalUsd` | — (required when `budget` present) | `>= 0` | REQ-CONFIG-02 |
| `budget.perTaskUsd` | — (required when `budget` present) | `>= 0` | REQ-CONFIG-02 |
| `budget.warnAtPercent` | `80` | `0..100` | REQ-CONFIG-02 |
| `tokenProfile` | `'balanced'` | `'budget' \| 'balanced' \| 'quality'` | parked alias |
| `modelRouting` | optional | matches legacy shape | parked alias |
| `verification` | optional | matches legacy shape | parked alias |
| `warnings` | optional | matches legacy shape | parked alias |

## Plan-checker flag resolutions

### `config.warnings` / `config.verification` orphans — PARK AS ALIASES

These four keys (`tokenProfile`, `modelRouting`, `verification`, `warnings`)
are out of REQ-CONFIG scope but still consumed by pre-existing subsystems.
Per the flag resolution ("park-as-aliases OR defer"), they stay on
`GvcConfigSchema` as **optional** fields with their legacy shapes:

- `tokenProfile` — **3 call-sites** (`src/compose.ts:compose → SummaryCoordinator`,
  `src/orchestrator/scheduler/index.ts:103`,
  `src/orchestrator/summaries/index.ts`). Defaults to `'balanced'`.
- `modelRouting` — **4 call-sites** (`src/compose.ts:214`,
  `src/agents/runtime.ts:329,332`, `src/runtime/routing/model-bridge.ts:109`,
  `src/runtime/routing/index.ts:22,42`). Optional.
- `verification` — **1 call-site** (`src/orchestrator/services/verification-service.ts`
  via `resolveVerificationLayerConfig`, plus `src/orchestrator/scheduler/warnings.ts`).
  Relocated the helper `resolveVerificationLayerConfig` + the
  `VerificationLayerName` type into `src/config/verification-layer.ts` so the
  callers import from `@config` instead of the deleted `@root/config`.
- `warnings` — **4 call-sites** (`src/orchestrator/scheduler/index.ts:110,113`,
  `src/orchestrator/scheduler/warnings.ts:32`, test fixtures).

A follow-up plan can retire these aliases once the matching subsystems reshape.
Nothing new depends on them.

### `ConfigSource.watch()` stub

Landed as `() => { close(): void }` disposable per the plan-checker
confirmation. No-op implementation in `JsonConfigLoader.watch()`; Phase 7
replaces the body with real `fs.watch` teardown.

## Call-site migrations performed

All imports redirected from `@root/config` to `@config`:

| File | Before | After |
|------|--------|-------|
| `src/compose.ts:23` | `from '@root/config'` | `from '@config'` |
| `src/orchestrator/scheduler/warnings.ts:10-13` | `from '@root/config'` | `from '@config'` |
| `src/orchestrator/services/verification-service.ts:11` | `from '@root/config'` | `from '@config'` |
| `src/core/warnings/index.ts:2` | `from '@root/config'` | `from '@config'` |

No `config.tokenProfile` → per-role replacements were necessary this plan —
the parked alias keeps existing callers functioning without semantic change.
Phase 3/5 worker + feature-planner landings will migrate those sites to
`config.models[role]` as part of their own scope.

## Test fixture updates

- New `test/helpers/config-fixture.ts` exports `testGvcConfigDefaults()`
  returning the required per-role map + `dbPath` / `workerCap` / `retryCap` /
  `reentryCap` / `pauseTimeouts`. Test `createConfig()` factories spread this
  in so the one-liner call-site `createConfig({ tokenProfile: 'balanced' })`
  still type-checks.
- Factories updated: `test/unit/agents/runtime.test.ts`,
  `test/unit/orchestrator/{services,conflicts,scheduler-loop,recovery}.test.ts`,
  `test/integration/feature-phase-agent-flow.test.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Installed zod@^4.3.6 (plan specified ^3.23.x)**
- **Found during:** Task 1
- **Issue:** `npm install zod` pulled the latest v4 stable because of
  transitive constraints (`@anthropic-ai/sdk`, `openai`, `zod-to-json-schema`
  all require `^3.25 || ^4.0`). A v3-only install was refused by npm.
- **Fix:** Accepted zod v4. Schema shape is unchanged; `z.record(Enum, Schema)`
  in v4 even strengthens the completeness guarantee for enum keys (no longer
  silently accepts missing keys), so `REQ-CONFIG-01` is satisfied both via the
  record-with-enum and via the defensive `superRefine`.
- **Commit:** `9091098`

**2. [Rule 3 — Blocking] Seeded `gvc0.config.json` in
`test/unit/compose.test.ts` beforeEach**
- **Found during:** Task 7 verification
- **Issue:** The old `JsonConfigLoader` auto-created `.gvc0/config.json` with
  `tokenProfile: 'balanced'` when the file was missing. The new loader throws
  (per the plan's "do NOT auto-create the config file when missing" directive),
  which failed 3 `composeApplication` tests expecting auto-create behavior.
- **Fix:** Write a minimal valid `gvc0.config.json` in each test's
  `beforeEach`, and drop the dead `tokenProfile-default` assertion tied to
  auto-create behavior.
- **Commit:** `9808d77`

### Auto-added Critical Functionality

**3. [Rule 2 — Correctness] Relocated `resolveVerificationLayerConfig` + `VerificationLayerName`**
- **Found during:** Task 4
- **Issue:** Deleting `src/config.ts` would have broken 3 live consumers
  (`src/orchestrator/scheduler/warnings.ts`,
  `src/orchestrator/services/verification-service.ts`,
  `src/core/warnings/index.ts`).
- **Fix:** New `src/config/verification-layer.ts` ports the helper + type
  unchanged; `src/config/index.ts` re-exports both.
- **Commit:** `42e08e7`

## Commits (7 + 1 deviation fix)

| # | Hash | Subject |
|---|------|---------|
| 1 | `9091098` | feat(02-03): add Zod schema for typed GvcConfig |
| 2 | `11e4c62` | feat(02-03): add JsonConfigLoader with ConfigSource.watch() stub |
| 3 | `76b463a` | refactor(02-03): re-export GvcConfig from @config/schema |
| 4 | `42e08e7` | refactor(02-03): delete src/config.ts, migrate callers to @config |
| 5 | `84ead69` | test(02-03): add unit tests for schema + loader |
| 6 | `5f5a5cd` | test(02-03): add config-boot integration test |
| 7 | `9808d77` | fix(02-03): seed gvc0.config.json in compose.test.ts beforeEach |

## Verification

- `npx tsc --noEmit` — **green** (0 errors, full repo).
- `npx vitest run test/unit/config/ test/integration/config/` — **21 passed** (3 files, 18 unit + 3 integration).
- `npx vitest run test/unit` — **1391 passed / 0 failed** (60 files) — no regression
  from the schema reshape.
- `src/config.ts` deleted (`test ! -f src/config.ts` passes).
- `src/config/{schema,load,index,verification-layer}.ts` created.
- `src/core/types/config.ts` reduced to a 20-line pure re-export file.
- `JsonConfigLoader.watch()` returns `{ close(): void }` disposable (no-op).
- Every REQ-CONFIG-01 role (topPlanner, featurePlanner, taskWorker, verifier) is required by the schema (verified by test `rejects missing role mapping`).
- REQ-CONFIG-02 budget knobs parse + default correctly (verified by tests `accepts budget knobs and applies warnAtPercent default` + `rejects budget.warnAtPercent outside 0-100`).

## Known Stubs

- `JsonConfigLoader.watch()` — Phase-2 no-op disposable documented in the
  source. Phase 7 replaces with real `fs.watch` wiring (RESEARCH §Open Question
  #3 / 02-CONTEXT §F). This is an intentional stub, not a gap.

## Self-Check

```bash
[ -f src/config/schema.ts ] && echo FOUND            # FOUND
[ -f src/config/load.ts ] && echo FOUND              # FOUND
[ -f src/config/index.ts ] && echo FOUND             # FOUND
[ -f src/config/verification-layer.ts ] && echo FOUND # FOUND
[ ! -f src/config.ts ] && echo DELETED               # DELETED
[ -f test/unit/config/schema.test.ts ] && echo FOUND # FOUND
[ -f test/unit/config/load.test.ts ] && echo FOUND   # FOUND
[ -f test/integration/config/config-boot.test.ts ] && echo FOUND # FOUND
git log --oneline | grep -q 9091098 && echo FOUND    # FOUND
```

## Self-Check: PASSED
