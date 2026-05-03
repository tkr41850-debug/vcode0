---
phase: 12-integration-polish
plan: "03"
subsystem: docs-traceability
tags: [readme, source-install, node-pty, musl, traceability, v1, SC12-4, SC12-5]

# Dependency graph
requires:
  - phase: 12-01
    provides: "Backend prompt-to-main lifecycle proof and verify-agent 5/5 flake audit"
  - phase: 12-02
    provides: "Operator-visible TUI golden-path smoke via @microsoft/tui-test"
provides:
  - "Root README source-install runbook for source-checkout v1 users"
  - "Fresh-clone source-install dry-run evidence: npm install rebuilds node-pty on Alpine/musl and TUI E2E lane passes"
  - "All 37 v1 requirements marked Complete with traceability evidence; 0 explicit follow-ups"
affects:
  - "Milestone/v1 roadmap closure"

# Tech tracking
tech-stack:
  modified:
    - "scripts/rebuild-node-pty.cjs — musl/Linux now skips glibc prebuild trust and forces source build when no source build exists"
    - "package-lock.json — root hasInstallScript metadata recorded for existing postinstall"
  patterns:
    - "Root README stays source-install focused and links to docs landing pages"
    - "Requirements traceability rows cite primary evidence instead of duplicating phase summaries"

key-files:
  created:
    - "README.md"
    - ".planning/phases/12-integration-polish/12-03-SUMMARY.md"
  modified:
    - "scripts/rebuild-node-pty.cjs"
    - "package-lock.json"
    - ".planning/REQUIREMENTS.md"
    - ".planning/ROADMAP.md"
    - ".planning/STATE.md"
    - ".planning/phases/12-integration-polish/12-03-PLAN.md"

requirements-completed: [SC12-4, SC12-5]

# Metrics
duration: 150min
completed: 2026-05-03
---

# Phase 12 Plan 03: README Runbook + v1 Traceability Green-Out Summary

**Phase 12 is complete: source-install runbook exists, fresh-clone install/TUI smoke passes on Alpine/musl, and all 37 v1 requirements are traceability-green.**

## Performance

- **Duration:** ~150 min
- **Completed:** 2026-05-03
- **Tasks:** 4 planned tasks plus one source-install bug fix discovered by dry-run
- **Files created:** 2
- **Files modified:** 6

## Accomplishments

- Added root `README.md` with source-install runbook: prerequisites, `npm install`, minimal `gvc0.config.json`, `npm run tui`, `npm run tui -- --cwd <workspace>`, verification commands, and docs links.
- Ran a fresh-clone source-install dry-run. The first attempt reproduced the original `@microsoft/tui-test` workerpool `SIGSEGV` from a clean install, proving the 12-02 postinstall detector was still too permissive for fresh Alpine/musl installs.
- Fixed `scripts/rebuild-node-pty.cjs` so musl/Linux does not trust the glibc prebuild even if `require()` succeeds. Clean installs now rebuild `node-pty` from source and use `build/Release/pty.node`.
- Re-ran the fresh-clone dry-run successfully: `npm install` rebuilt `node-pty`; `npm run test:tui:e2e` passed all 9 TUI smoke tests from the fresh clone.
- Updated `.planning/REQUIREMENTS.md`: all 37 v1 requirements are `[x]` and traceability table statuses are `Complete — <evidence>`. Explicit follow-ups: 0.
- Updated `.planning/ROADMAP.md` and `.planning/STATE.md` to mark Phase 12 and the v1 roadmap complete.

## Source-Install Dry-Run Evidence

### Initial failed dry-run

Command shape:

```bash
timeout 900 bash -lc 'tmp=$(mktemp -d); git clone --no-local /home/alpine/vcode0 "$tmp/gvc0"; cd "$tmp/gvc0"; npm install; ...; timeout 600 npm run test:tui:e2e'
```

Observed failure after clean install:

```text
Error: Workerpool Worker terminated Unexpectedly
signalCode: `SIGSEGV`
workerpool.script: `/tmp/tmp.MiFCGo/gvc0/node_modules/@microsoft/tui-test/lib/runner/worker.js`
```

Root cause: the 12-02 postinstall detector allowed the linux-x64 glibc prebuild on Alpine/musl if `require(prebuildPath)` succeeded, but `@microsoft/tui-test` still crashed when spawning PTYs from the clean install.

### Fix

`src` unchanged. The install fix is limited to `scripts/rebuild-node-pty.cjs`:

- checks `process.report.getReport().header.glibcVersionRuntime`;
- treats Linux without glibc runtime as musl;
- accepts existing `build/Release/pty.node` if present;
- skips prebuild trust on musl and runs `node-gyp rebuild` instead;
- keeps prebuild fast-path for non-musl platforms.

### Passing dry-run

Fresh clone command:

```bash
timeout 900 bash -lc 'tmp=$(mktemp -d); git clone --no-local /home/alpine/vcode0 "$tmp/gvc0"; cd "$tmp/gvc0"; npm install; workspace=$(mktemp -d); mkdir -p "$workspace/.gvc0"; node -e '\''const fs=require("node:fs"),path=require("node:path");const workspace=process.argv[1];const config={models:{topPlanner:{provider:"anthropic",model:"claude-haiku-4-5"},featurePlanner:{provider:"anthropic",model:"claude-haiku-4-5"},taskWorker:{provider:"anthropic",model:"claude-haiku-4-5"},verifier:{provider:"anthropic",model:"claude-haiku-4-5"}}};fs.writeFileSync(path.join(workspace,"gvc0.config.json"),JSON.stringify(config,null,2)+"\n");'\'' "$workspace"; timeout 600 npm run test:tui:e2e'
```

Observed install evidence:

```text
[gvc0 postinstall] node-pty native binary not loadable for this environment. Rebuilding from source via node-gyp...
gyp info ok
[gvc0 postinstall] node-pty rebuilt successfully.
added 454 packages in 3m
```

Observed TUI evidence:

```text
Running 9 tests using 1 worker
✔ starts with composer focus and runs help from composer
...
✔ golden path tui e2e smoke: init, steer, draft, submit, and quit
tests: 9 passed, 9 total
```

The TUI E2E lane launches `npm run tui -- --cwd <temp-workspace>` and asserts startup text including `gvc0 progress` and `Run /init to create first milestone and planning feature.`

## Traceability Closeout

`.planning/REQUIREMENTS.md` final counts:

- v1 requirements: 37 total
- Complete: 37
- Explicit follow-up: 0
- Mapped to phases: 37
- Unmapped: 0

Verification command:

```bash
! grep -n "| REQ-.*Pending\|- \[ \] \*\*REQ-" .planning/REQUIREMENTS.md
```

Result: passed with no output.

## Verification

Commands run during 12-03:

```bash
grep -n "npm install\|npm run tui\|gvc0.config.json" README.md
npm run check:fix
npm run check
npm run test:tui:e2e
! grep -n "| REQ-.*Pending\|- \[ \] \*\*REQ-" .planning/REQUIREMENTS.md
```

Latest recorded full-check before final state write:

```text
npm run check
Test Files 94 passed | 2 skipped (96)
Tests 1969 passed | 3 skipped (1972)
```

Fresh-clone dry-run after the node-pty fix:

```text
npm install — passed, node-pty rebuilt from source
npm run test:tui:e2e — 9 passed, 0 failed
```

## Commits

- `82b9e7c` — `docs(12-03): plan README runbook traceability closeout`
- `1093cea` — `docs(12-03): add source install runbook`
- `0901816` — `fix(12-03): rebuild node-pty on musl source installs`
- `d196fde` — `docs(12-03): green out v1 requirement traceability`

## Deviations from Plan

### Auto-fixed Issue: fresh source install still crashed on Alpine/musl

- **Found during:** Task 2 fresh-clone source-install dry-run.
- **Issue:** `npm install` completed but `npm run test:tui:e2e` failed all 9 tests with workerpool `SIGSEGV` in the fresh clone.
- **Cause:** The 12-02 postinstall script accepted the glibc prebuild if `require()` succeeded. On Alpine/musl, that was insufficient; the worker still crashed under real PTY use.
- **Fix:** Detect musl/Linux via Node process report and skip prebuild trust there unless a source-built `build/Release/pty.node` already exists.
- **Files modified:** `scripts/rebuild-node-pty.cjs`, `package-lock.json`, `12-03-PLAN.md`.
- **Verification:** Fresh clone `npm install` rebuilt `node-pty` from source; fresh clone `npm run test:tui:e2e` passed 9/9.

## Final Status

Phase 12 success criteria are complete:

1. SC12-1 — prompt-to-main lifecycle proof: complete in 12-01.
2. SC12-2 — verify-agent flake-rate audit: complete in 12-01.
3. SC12-3 — TUI golden-path E2E smoke: complete in 12-02.
4. SC12-4 — source-install runbook and fresh-clone dry-run: complete in 12-03.
5. SC12-5 — v1 requirement traceability green-out: complete in 12-03.

The v1 roadmap is complete.

---
*Phase: 12-integration-polish*
*Completed: 2026-05-03*
