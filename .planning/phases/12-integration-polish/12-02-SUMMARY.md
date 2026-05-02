---
phase: 12-integration-polish
plan: "02"
subsystem: testing
tags: [tui-test, node-pty, musl, alpine, e2e, ptty, golden-path, SC12-3]

# Dependency graph
requires:
  - phase: 12-01
    provides: "Backend prompt-to-main lifecycle proof (planner→approval→inbox→commit→verify→merge-train→merged); remains authoritative for backend semantics"
provides:
  - "@microsoft/tui-test lane stabilized for Alpine/musl (node-pty rebuilt from source via postinstall)"
  - "Grep-friendly golden-path TUI E2E smoke: startup→/init→graph feedback→steering overlay→draft→approval→quit"
  - "All 9 smoke tests pass: npm run test:tui:e2e — 9 passed, 0 failed"
affects:
  - "12-03 (README/source-install dry-run and final traceability will cite this smoke as SC12-3 evidence)"

# Tech tracking
tech-stack:
  added:
    - "scripts/rebuild-node-pty.cjs — project postinstall hook that detects broken node-pty prebuild and falls back to node-gyp rebuild"
  patterns:
    - "createWorkspace() writes gvc0.config.json with minimal 4-role models map — required for all TUI e2e fixtures"
    - "Fixture seeding via seed.mts script file (not --eval) to avoid tsx CJS/ESM mismatch with @mariozechner/pi-ai"
    - "tuiReadyTimeoutMs = 60_000 and test timeout = 120_000 to accommodate ~26s tsx startup on Alpine"
    - "task-add --feature f-1 with two keyDown() navigations to reach f-1 after /init"

key-files:
  created:
    - "scripts/rebuild-node-pty.cjs"
  modified:
    - "tui-test.config.ts"
    - "package.json"
    - "test/integration/tui/smoke.test.ts"

key-decisions:
  - "Root cause of SIGSEGV: node-pty glibc prebuild is not loadable under Alpine musl libc; NAPI symbols missing. Fix is node-gyp rebuild from source; encapsulated in postinstall script."
  - "Fixture seeding uses a written .mts file instead of tsx --eval to avoid CJS loader failing on ESM-only @mariozechner/pi-ai in the compose.ts import chain."
  - "tuiReadyTimeoutMs raised to 60s (was 30s) and test timeout raised to 120s because tsx startup on this environment consistently takes ~26s."
  - "Autocomplete dropdown in tui-test renders command names without a leading slash (task-remove not /task-remove); assertion corrected."
  - "Golden-path test uses --feature f-1 and two keyDown() presses after /init because DAG renders milestone node first; one keyDown selects m-1, second selects f-1."
  - "12-01 remains the authoritative backend lifecycle proof; 12-02 covers operator-visible PTY surface only."

patterns-established:
  - "Pattern: Every TUI e2e workspace needs gvc0.config.json with models map — createWorkspace() now always writes it."
  - "Pattern: Seed .mts script written to disk and executed as tsx script file, not --eval, for ESM compatibility."

requirements-completed: [SC12-3]

# Metrics
duration: 85min
completed: 2026-05-02
---

# Phase 12 Plan 02: TUI E2E Smoke Tests Summary

**@microsoft/tui-test lane stabilized on Alpine/musl via node-pty source rebuild; golden-path smoke proves startup→/init→graph→overlay→draft→approval→/quit in a real PTY without live LLM calls**

## Performance

- **Duration:** ~85 min
- **Started:** 2026-05-02T20:53:11Z
- **Completed:** 2026-05-02T22:17:52Z
- **Tasks:** 2
- **Files modified:** 4 (+ 1 created)

## Accomplishments

- Identified and fixed the workerpool SIGSEGV root cause: node-pty glibc prebuild fails under Alpine musl libc (NAPI symbol resolution errors trigger SIGSEGV). Added `scripts/rebuild-node-pty.cjs` project postinstall that detects a broken prebuild and falls back to `node-gyp rebuild`.
- Fixed three additional smoke-test blockers discovered after SIGSEGV was resolved: missing `gvc0.config.json` in test workspaces, tsx CJS/ESM mismatch for fixture seeding, and insufficient timeouts for slow Alpine tsx startup (~26s).
- Added grep-friendly golden-path smoke test (`golden path tui e2e smoke: init, steer, draft, submit, and quit`) covering all SC12-3 surfaces: startup text, `/init` graph feedback, Help overlay, graph focus navigation, draft `task-add`, `/submit` approval state, and `/quit`.
- All 9 TUI e2e smoke tests pass: `npm run test:tui:e2e` — 9 passed, 0 failed.
- `npm run check` remains green: 94 test files, 1969 passed, 3 skipped.

## SIGSEGV Stabilization Detail

**Prior signature (all 8 tests, < 1.1s each):**
```
Error: Workerpool Worker terminated Unexpectedly
    exitCode: `null`
    signalCode: `SIGSEGV`
    workerpool.script: node_modules/@microsoft/tui-test/lib/runner/worker.js
```

**Root cause:** `node-pty@1.2.0-beta.11` ships linux-x64 prebuild compiled against glibc. This environment is Alpine Linux with musl libc. `ldd` on the prebuild showed 40+ missing NAPI/glibc symbols (`napi_call_threadsafe_function`, `fcntl64`, `__asprintf_chk`, etc.). The prebuild script only checks whether the directory exists, not whether the binary is loadable, so npm install silently selected the incompatible glibc binary.

**Fix:** `scripts/rebuild-node-pty.cjs` — project `postinstall` hook that tries to `require()` the native binary; if it fails, runs `node-gyp rebuild` inside `node_modules/node-pty`. Build succeeds because gcc 15.2.0, python3 12.12, and node-gyp 12.2.0 are all present. `node-pty/lib/utils.js` checks `build/Release/` first (before prebuilds), so the rebuilt binary is used automatically.

**Secondary blockers fixed during Task 1:**

1. **Missing gvc0.config.json:** `createWorkspace()` never wrote a config file. After SIGSEGV resolved, all tests failed with "Config file not found". Fixed: `createWorkspace()` now writes a minimal 4-role `models` JSON config to every temp workspace.

2. **Fixture seeding ESM/CJS mismatch:** The `npx tsx --eval` form used the CJS loader which cannot resolve `@mariozechner/pi-ai` (ESM-only, no `"."` CJS export). Fixed: seed code is written to a `.mts` file and executed as a script (`tsx seed.mts`), allowing ESM resolution.

3. **Timeout too small:** tsx compilation of `src/main.ts` and all dependencies takes ~26s on this environment. The previous `tuiReadyTimeoutMs = 30_000` gave only ~4s margin, causing random test timeouts. Raised to `tuiReadyTimeoutMs = 60_000` and config `timeout: 120_000` / `expect.timeout: 60_000`.

## Golden-Path Test

**File:** `test/integration/tui/smoke.test.ts`
**Test title:** `golden path tui e2e smoke: init, steer, draft, submit, and quit`

**Covered surfaces (all SC12-3 requirements):**
1. Startup: `gvc0 progress`, `[command] [composer]`, `gvc0 startup`, empty-state init guidance
2. `/init` graph feedback: `m-1: Milestone 1`, `f-1: Project startup`, `queue: 1`, `work: planning`
3. Steering overlay (Help): `Help [h/q/esc hide]`, `Show or hide keyboard help.`
4. Graph focus: `focus: graph`, two `keyDown()` to reach `f-1: Project startup`
5. Draft task: `task-add --feature f-1 --description "Golden path task" --weight small` → `gvc0 progress [draft]`, `t-1: Golden path task`, `view: draft`
6. Approval state: `/submit` → `[approval] [composer] approval plan f-1 /approve /reject /rerun`
7. Clean quit: `/quit` from composer

**No live LLM calls.** Backend lifecycle proof remains 12-01.

## Task Commits

1. **Task 1: Stabilize @microsoft/tui-test lane** - `88c238c` (fix)
2. **Task 2: Add golden-path TUI E2E smoke coverage** - `2d3675c` (feat)

**Plan metadata:** *(added below)*

## Files Created/Modified

- `scripts/rebuild-node-pty.cjs` — Created: project postinstall hook for node-pty source rebuild on musl/Alpine
- `package.json` — Modified: added `"postinstall": "node scripts/rebuild-node-pty.cjs"` script
- `tui-test.config.ts` — Modified: raised `timeout` to 120s, `expect.timeout` to 60s
- `test/integration/tui/smoke.test.ts` — Modified: `gvc0.config.json` injection, seed script ESM fix, timeout increase, autocomplete assertion fix, new golden-path test

## Decisions Made

- **node-pty rebuild via postinstall**: chose project-level postinstall over `.npmrc` `build-from-source` because the npmrc approach would remove prebuilds for all platforms; the postinstall only rebuilds when the prebuild is actually broken.
- **Seed via script file not --eval**: tsx CJS loader (used by `--eval`) cannot resolve ESM-only packages; writing a `.mts` file and executing as a script uses the ESM loader correctly.
- **60s/120s timeouts**: tsx startup of ~26s on this Alpine environment is real and persistent; the raised timeouts make the lane reliable rather than racing against compilation.
- **golden-path in smoke.test.ts not golden-path.test.ts**: the plan preferred extending smoke.test.ts to reuse helpers, and the tests all pass without file-level isolation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing gvc0.config.json in test workspace createWorkspace()**
- **Found during:** Task 1 (stabilization spike)
- **Issue:** After SIGSEGV was resolved, all tests failed with "Config file not found". `createWorkspace()` created `.gvc0/` but never wrote `gvc0.config.json`. This was never surfaced before because SIGSEGV killed the worker before any app code ran.
- **Fix:** Added `MINIMAL_CONFIG` constant and `fs.writeFile` in `createWorkspace()` to inject minimal 4-role models config into every temp workspace.
- **Files modified:** `test/integration/tui/smoke.test.ts`
- **Verification:** Tests proceed past `loading...` and reach `gvc0 progress`.
- **Committed in:** `88c238c` (Task 1 commit)

**2. [Rule 1 - Bug] tsx --eval CJS/ESM mismatch for fixture seeding**
- **Found during:** Task 1 (stabilization spike, while fixing test 8)
- **Issue:** `npx tsx --eval` uses CJS loader which fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` on `@mariozechner/pi-ai` (ESM-only package in `compose.ts` transitive chain).
- **Fix:** Replaced inline `--eval` string with a written `.mts` script file executed via `tsx seed.mts`. ESM loader handles the import chain correctly.
- **Files modified:** `test/integration/tui/smoke.test.ts`
- **Verification:** Test 8 (`creates planner draft`) seeds workspace and reaches `f-1: Planner feature`.
- **Committed in:** `88c238c` (Task 1 commit)

**3. [Rule 1 - Bug] Autocomplete assertion used wrong string (/task-remove vs task-remove)**
- **Found during:** Task 1 (after stabilization, test 7 failed)
- **Issue:** Test asserted `getByText('/task-remove')` but the dropdown renders `task-remove` (without leading slash). This was a pre-existing test bug masked by SIGSEGV.
- **Fix:** Changed assertion to `task-remove` with `{ strict: false }`.
- **Files modified:** `test/integration/tui/smoke.test.ts`
- **Committed in:** `88c238c` (Task 1 commit)

**4. [Rule 2 - Missing Critical] Added scripts/rebuild-node-pty.cjs postinstall and package.json hook**
- **Found during:** Task 1 (after node-gyp rebuild fixed SIGSEGV)
- **Issue:** The manual `node-gyp rebuild` only persisted until `npm install` was re-run. Without a postinstall hook, any fresh install would restore the broken glibc prebuild.
- **Fix:** Added `scripts/rebuild-node-pty.cjs` and `"postinstall"` script in `package.json`.
- **Files modified:** `package.json`, `scripts/rebuild-node-pty.cjs` (created)
- **Committed in:** `88c238c` (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (3 Rule 1 bugs surfaced by SIGSEGV fix, 1 Rule 2 missing persistence)
**Impact on plan:** All fixes essential for correctness of the TUI e2e lane. No scope creep. Golden-path test scope matches plan spec exactly.

## Issues Encountered

- The SIGSEGV in `@microsoft/tui-test` workerpool was caused by the node-pty glibc prebuild being incompatible with Alpine musl libc. This was not a tui-test framework bug but an environment/native binary incompatibility. The fix (source rebuild via postinstall) is robust and does not change any test logic.

## Handoff Notes

- **12-01 remains the authoritative backend lifecycle proof** (planner→approval→inbox→commit→verify→merge-train→merged). 12-02 covers operator-visible PTY surface only.
- **12-03 owns** README/source-install dry-run and final v1 REQ traceability green-out. The `golden path tui e2e smoke` test title is grep-friendly for 12-03 traceability citation.
- **Known limitation:** tsx compilation takes ~26s on Alpine. This is an environment characteristic; the raised timeouts accommodate it. A production environment or CI with pre-warmed module caches would be faster.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- SC12-3 satisfied: TUI e2e smoke lane is stable and the golden-path test covers all required surfaces.
- 12-03 can cite `npm run test:tui:e2e` and `grep -R "golden path tui e2e smoke"` as evidence for SC12-3.
- `npm run check && npm run test:tui:e2e` passes cleanly.

---
*Phase: 12-integration-polish*
*Completed: 2026-05-02*

## Self-Check: PASSED

- `scripts/rebuild-node-pty.cjs`: FOUND
- `tui-test.config.ts`: FOUND
- `test/integration/tui/smoke.test.ts`: FOUND
- `.planning/phases/12-integration-polish/12-02-SUMMARY.md`: FOUND
- Commit `88c238c`: FOUND
- Commit `2d3675c`: FOUND
- `grep -R "golden path tui e2e smoke" test/integration/tui`: PASSED
