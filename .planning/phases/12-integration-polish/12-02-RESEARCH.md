# Phase 12-02: TUI E2E Smoke Tests - Research

**Researched:** 2026-05-02 [VERIFIED: currentDate]
**Domain:** PTY-driven TUI end-to-end smoke testing with `@microsoft/tui-test` [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:10-17]
**Confidence:** HIGH for current repo state and commands; MEDIUM for upstream `@microsoft/tui-test` stabilization tactics because the installed runner currently SIGSEGVs before assertions run. [VERIFIED: npm run test:tui:e2e]

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
## Implementation Decisions

### 12-02 scope
- 12-02 covers only `@microsoft/tui-test` golden-path smoke coverage for the TUI lane.
- Do not add README/source-install dry-run work; that remains 12-03.
- Do not add final v1 traceability tables; that remains 12-03.
- Do not replace the deterministic Vitest proof from 12-01 with TUI-only assertions.

### TUI e2e proof shape
- Use the existing `npm run test:tui:e2e` / `npx tui-test` lane and existing `test/integration/tui/**` patterns.
- Keep tests smoke-level and user-visible: launch real `src/main.ts` in a pseudo-terminal, send keys or slash commands, and assert visible terminal text/state.
- Prefer a minimal golden path that exercises startup, prompt/command entry, visible graph or composer feedback, overlay/help surfaces needed for operator steering, and clean quit.
- If full autonomous execution through the TUI remains too slow or unstable for the e2e lane, cover the surface-level golden path and cite 12-01 for backend lifecycle proof.

### Known blockers to respect
- `@microsoft/tui-test` is pre-1.0 and had a prior workerpool `SIGSEGV` history across existing smoke tests. 12-02 should stabilize or isolate the lane enough for smoke coverage, not grow it into a large brittle suite.
- Existing parallel Vitest flakes are unrelated; keep this work in the TUI e2e lane, not default Vitest.
- TUI tests should avoid live LLM calls and should use deterministic/local modes or harnessable app paths where available.

### Claude's Discretion
## Specific Ideas

- Inventory existing `test/integration/tui/**` tests before deciding whether to extend one smoke test or add a dedicated golden-path spec.
- Keep test names grep-friendly for 12-03, e.g. include `golden path` and `tui e2e smoke`.
- If the historical `SIGSEGV` is still reproducible, the plan should include a narrow stabilization task before adding coverage.
- Prefer asserting durable visible strings from command/help/overlay output rather than brittle cursor coordinates.

### Deferred Ideas (OUT OF SCOPE)
## Deferred Ideas

- README/source-install dry-run belongs to 12-03.
- Final v1 REQ traceability green-out belongs to 12-03.
- Deep full-run PTY orchestration with live agents remains out of scope unless current deterministic local seams make it reliable as a smoke test.
</user_constraints>

## Summary

Phase 12-02 should keep the TUI E2E lane narrow: prove the real interactive `src/main.ts` entrypoint starts under `@microsoft/tui-test`, accepts slash-command input, renders visible graph/composer feedback, opens steering overlays, and exits cleanly. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:10-17][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179][VERIFIED: /home/alpine/vcode0/src/main.ts:38-41] The deterministic backend prompt-to-main lifecycle and verify flake audit already landed in 12-01, so 12-02 should not attempt to reproduce full autonomous execution through a PTY unless the existing deterministic seams make it reliable. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-01-SUMMARY.md:46-56][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:29-34]

The existing TUI lane is present but currently blocked in this environment: `npm run test:tui:e2e` runs 8 tests with 1 worker and all 8 fail because the `@microsoft/tui-test` workerpool child terminates with `SIGSEGV` before assertions can prove behavior. [VERIFIED: npm run test:tui:e2e][VERIFIED: /home/alpine/vcode0/.planning/STATE.md:49-54] This reproduces the historical Phase 8 blocker recorded across the roadmap and summaries, so the first implementation task should be a stabilization/isolation spike before adding or broadening smoke coverage. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:20][VERIFIED: codebase grep]

**Primary recommendation:** First stabilize the existing `@microsoft/tui-test` runner enough to execute one focused smoke file, then add a single grep-friendly `golden path tui e2e smoke` test that composes the already-working startup, `/init`, overlay, draft/approval, and `/quit` interactions without live LLM calls. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-210][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:30-39]

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SC12-3 | TUI e2e smoke tests using `@microsoft/tui-test` cover the golden path. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:221-236] | Use the existing `npm run test:tui:e2e` lane and `test/integration/tui/**` harness; stabilize the current SIGSEGV blocker first; cover real TUI startup, command entry, visible graph/composer feedback, steering overlays, and clean quit. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179][VERIFIED: npm run test:tui:e2e] |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- The repo is a single root TypeScript package, not a monorepo; source boundaries live under `src/` with TS path aliases such as `@core/*`, `@orchestrator/*`, `@runtime/*`, `@persistence/*`, and `@tui/*`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:46-57]
- The TUI layer belongs under `@tui/*`; core must not depend on runtime, persistence, or TUI. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:48-57][VERIFIED: /home/alpine/vcode0/CLAUDE.md:138-145]
- Tests use Vitest for unit and non-TUI integration tests; TUI E2E uses a separate `@microsoft/tui-test` lane. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:99-121][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:5-12]
- Integration tests should avoid live LLM calls and use deterministic faux-provider patterns where agent loops are required. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:111-118][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:64-72]
- Node version requirement is `>=24`; this environment has Node `v24.13.0`, npm `11.9.0`, and npx `11.9.0`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:123-129][VERIFIED: command -v node && node --version && command -v npm && npm --version && command -v npx && npx --version]
- Before commits, project convention is `npm run check`, but this research task must not modify code outside the research file. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:131-137][VERIFIED: user request]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| PTY launch of real TUI entrypoint | Browser / Client equivalent: Terminal UI | App lifecycle | `src/main.ts` writes `loading...`, composes the application, parses interactive/auto mode, and starts the app; `TuiApp.show()` requires interactive stdin/stdout. [VERIFIED: /home/alpine/vcode0/src/main.ts:38-41][VERIFIED: /home/alpine/vcode0/src/tui/app.ts:209-231] |
| Slash command entry and autocomplete | Terminal UI | Orchestrator command port | Composer submits slash commands through `handleComposerSubmit()` and `executeSlashCommand()`; commands call `TuiAppDeps`/orchestrator-facing operations rather than mutating core state directly. [VERIFIED: /home/alpine/vcode0/src/tui/app.ts:165-183][VERIFIED: /home/alpine/vcode0/src/tui/app-composer.ts:56-331] |
| Golden-path visible graph feedback | Terminal UI | Persistence-backed app composition | `/init` creates milestone/feature state via `initializeProject`, then TUI renders `m-1`, `f-1`, queue, and work status strings already asserted by existing smoke tests. [VERIFIED: /home/alpine/vcode0/src/tui/app-composer.ts:152-160][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:139-161] |
| Operator steering overlays | Terminal UI | View-model builder | Help, inbox, merge-train, config, transcript, proposal-review, planner-audit, and monitor overlays are TUI-owned rendering surfaces backed by view models and dependencies. [VERIFIED: /home/alpine/vcode0/src/tui/app.ts:101-110][VERIFIED: /home/alpine/vcode0/src/tui/app-overlays.ts:159-567] |
| Full autonomous prompt-to-main lifecycle | API / Backend / Orchestrator | Runtime workers and persistence | The full planner/approval/inbox/worker/verify/merge-train flow is already proven in 12-01's Vitest integration proof; 12-02 should cite it rather than duplicate it in PTY unless reliable. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-01-SUMMARY.md:82-96][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:29-34] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@microsoft/tui-test` | Installed `0.0.4`; latest npm `0.0.4`, published 2026-04-04. [VERIFIED: /home/alpine/vcode0/package-lock.json:1827-1856][VERIFIED: npm view @microsoft/tui-test version time --json] | PTY-driven terminal E2E runner for `test/integration/tui/**`. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179] | It is already the locked lane in package scripts and phase context; do not replace it with Vitest or a custom PTY runner. [VERIFIED: /home/alpine/vcode0/package.json:23-26][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:30-31] |
| `@mariozechner/pi-tui` | Installed `0.66.1`; latest npm `0.72.1`, published 2026-05-02. [VERIFIED: /home/alpine/vcode0/package-lock.json:1808-1825][VERIFIED: npm view @mariozechner/pi-tui version time --json] | TUI application framework used by `TuiApp`, `ProcessTerminal`, `TUI`, `Editor`, and overlays. [VERIFIED: /home/alpine/vcode0/src/tui/app.ts:8-12][VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:5-8] | It is the existing production TUI framework; 12-02 should test it through the real app, not introduce a rendering test substitute. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:179] |
| `tsx` | Declared `^4.21.0`. [VERIFIED: /home/alpine/vcode0/package.json:31-38] | Runs TypeScript entrypoints such as `npm run tui` and workspace setup evals in existing smoke tests. [VERIFIED: /home/alpine/vcode0/package.json:25-26][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:220-250] | It is already used by package scripts and existing TUI fixture seeding. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:220-250] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:fs/promises`, `node:os`, `node:path`, `node:child_process` | Node built-ins under Node `v24.13.0`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:1-5][VERIFIED: node --version] | Create isolated temp workspaces and seed `.gvc0/state.db` before launching TUI. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-254] | Keep using this pattern for deterministic per-test isolation and cleanup. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:15-22] |
| `workerpool` | Installed transitive `9.3.4`. [VERIFIED: /home/alpine/vcode0/package-lock.json:7297-7303] | Used by `@microsoft/tui-test` runner workers. [VERIFIED: /home/alpine/vcode0/package-lock.json:1833-1846] | Relevant only for diagnosing the current `SIGSEGV`; do not use it directly in app tests. [VERIFIED: npm run test:tui:e2e] |
| `node-pty` | Optional dependency `1.2.0-beta.11` of `@microsoft/tui-test`. [VERIFIED: /home/alpine/vcode0/package-lock.json:1854-1856] | PTY substrate used by the runner when available. [VERIFIED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/package.json:49-51] | Treat as part of runner stabilization; do not hand-roll direct `node-pty` tests in 12-02. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:30-39] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@microsoft/tui-test` lane | Vitest unit/integration tests | Vitest already excludes `test/integration/tui/**`, and docs state PTY keyboard flows belong in TUI lane; using Vitest would not satisfy SC12-3. [VERIFIED: /home/alpine/vcode0/vitest.config.ts:11-18][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:174-179] |
| Existing real `npm run tui -- --cwd <workspace>` launch | Inject a fake `TuiAppDeps` into a component test | Component tests cannot prove the real `src/main.ts` terminal entrypoint launches in a pseudo-terminal. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:256-261][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:179] |
| A large PTY full-run suite | One focused smoke test plus existing 12-01 backend proof | Full autonomous execution inside PTY is explicitly out of scope unless reliable; the current lane SIGSEGVs before assertions, so suite growth increases brittleness. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:33-39][VERIFIED: npm run test:tui:e2e] |

**Installation:** No new install should be required because package.json and package-lock already include `@microsoft/tui-test`. [VERIFIED: /home/alpine/vcode0/package.json:31-33][VERIFIED: /home/alpine/vcode0/package-lock.json:1827-1856]

```bash
npm install
npm run test:tui:e2e
```

## Architecture Patterns

### System Architecture Diagram

```text
npx tui-test / npm run test:tui:e2e
  -> @microsoft/tui-test workerpool runner
     -> per-test pseudo-terminal shell
        -> terminal.submit("npm run tui -- --cwd '<tmp workspace>'")
           -> package script: tsx src/main.ts
              -> runCli(argv)
                 -> apply --cwd workspace
                 -> composeApplication()
                 -> app.start('interactive')
                    -> TuiApp.show()
                       -> ProcessTerminal + pi-tui render loop
                       -> composer starts focused
                       -> slash command input (/init, /help, /inbox, /submit, /quit)
                          -> handleComposerSubmit()
                          -> executeSlashCommand()
                          -> TuiAppDeps/orchestrator-facing command
                          -> refresh + visible terminal text
     -> assertions via terminal.getByText(...).toBeVisible()
     -> terminal.kill() + rm tmp workspace in afterEach
```

This is the actual data/control flow used by existing smoke tests: `terminal.submit()` launches `npm run tui -- --cwd`, `src/main.ts` applies `--cwd`, and `TuiApp.show()` starts only when stdin/stdout are TTYs. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:256-261][VERIFIED: /home/alpine/vcode0/src/main.ts:57-70][VERIFIED: /home/alpine/vcode0/src/tui/app.ts:209-231]

### Recommended Project Structure

```text
test/integration/tui/
├── README.md              # lane docs; keep updated only if commands change
├── smoke.test.ts          # existing PTY smoke tests; best place to extend or add grep-friendly golden-path test
└── golden-path.test.ts    # optional only if splitting improves isolation from existing flaky specs

src/tui/
├── app.ts                 # real TUI shell under test
├── app-composer.ts        # slash command execution path under test
├── app-overlays.ts        # overlay visibility paths under test
├── commands/index.ts      # keybinds/autocomplete/slash commands under test
└── view-model/            # unit-test territory; do not duplicate with brittle PTY assertions
```

Existing `test/integration/tui/smoke.test.ts` already contains helper patterns for `createWorkspace()`, `startTui()`, `waitForTuiReady()`, `shellQuote()`, and per-test cleanup. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:15-22][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-275]

### Pattern 1: Isolated workspace per TUI test

**What:** Create a temp directory, create `.gvc0/`, launch TUI with `--cwd <workspace>`, and remove the workspace in `afterEach`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:15-22][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-261]

**When to use:** Every `@microsoft/tui-test` spec should use this pattern to avoid persistent `.gvc0/state.db` bleed between tests. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-254]

**Example:** Use the existing `createWorkspace()` and `startTui()` helpers rather than new global state. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-275]

### Pattern 2: Assert durable visible strings, not coordinates

**What:** Existing tests assert strings such as `gvc0 progress`, `[command] [composer]`, `gvc0 startup`, `m-1: Milestone 1`, `f-1: Project startup`, `Inbox [0 pending]`, and `Config [c/q/esc hide]`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-210]

**When to use:** Use this for golden-path smoke because terminal coordinates are more brittle than user-visible text. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:67-69]

**Example:** A golden path should assert visible startup, initialized graph labels, overlay headers, draft mode, approval composer status, and quit behavior. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:32-49][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:147-160][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:199-209]

### Pattern 3: Seed deterministic state through real persistence when needed

**What:** Existing smoke tests seed a planning feature by running `npx tsx --eval` to open the workspace `.gvc0/state.db`, create `PersistentFeatureGraph`, and call `initializeProjectGraph()`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:219-250]

**When to use:** Use this to start from a known graph state without invoking live planners or workers. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:38-39]

**Example:** Keep this for draft/approval smoke, because it proves the TUI can read persistent graph state while avoiding model calls. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:177-210]

### Pattern 4: Explicitly separate TUI smoke from backend lifecycle proof

**What:** 12-01 proves backend lifecycle with deterministic Vitest; 12-02 proves operator-visible TUI surface in PTY. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-01-SUMMARY.md:82-96][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:14-17]

**When to use:** Cite 12-01 for planner/worker/verify/merge-train semantics and keep 12-02 smoke focused on terminal interactions. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:32-34]

### Anti-Patterns to Avoid

- **Growing a large PTY suite before stabilizing the runner:** The current lane fails all 8 tests with workerpool `SIGSEGV`, so adding coverage first may hide whether new tests are correct. [VERIFIED: npm run test:tui:e2e]
- **Using Vitest as the only proof for SC12-3:** `vitest.config.ts` excludes `test/integration/tui/**`, and docs say the TUI E2E lane is separate. [VERIFIED: /home/alpine/vcode0/vitest.config.ts:11-18][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:174-179]
- **Calling live LLM providers from PTY:** Context says TUI tests should avoid live LLM calls and use deterministic/local modes. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:35-39]
- **Asserting pixel/cell layout:** Phase context recommends durable visible strings instead of brittle cursor coordinates. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:67-69]
- **Testing unsupported plain-text planner chat as the golden path:** Docs say composer is command-first and plain text planner chat is not wired yet. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:145-147]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PTY process management | Custom `node-pty` runner or shell scripts | `@microsoft/tui-test` | Phase context locks the existing lane; runner provides terminal contexts, auto-wait assertions, and trace support. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:30-31][CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:50-68][CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:117-135] |
| Real TUI launch wrapper | Alternate app entrypoint for tests | `npm run tui -- --cwd <workspace>` | Existing smoke tests already launch the production entrypoint through package script and `src/main.ts`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:256-261][VERIFIED: /home/alpine/vcode0/package.json:25-26] |
| Deterministic backend lifecycle | Full worker/planner/merge train in PTY | 12-01 Vitest proof plus surface smoke in PTY | 12-01 already covers planner/approval/inbox/worker/verify/merge-train; 12-02 scope is operator-visible golden path. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-01-SUMMARY.md:82-96][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:29-34] |
| Fixture persistence | Ad-hoc JSON or in-memory UI mocks | `.gvc0/state.db` via `PersistentFeatureGraph` | Existing tests seed the same persistence shape the TUI reads after `--cwd`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:217-250] |

**Key insight:** The hard problem in 12-02 is not inventing a testing harness; it is making the locked `@microsoft/tui-test` lane run reliably enough to prove one narrow user-visible path. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:35-39][VERIFIED: npm run test:tui:e2e]

## Common Pitfalls

### Pitfall 1: Historical `SIGSEGV` is still current

**What goes wrong:** The TUI lane fails before behavior assertions because the `@microsoft/tui-test` workerpool child crashes with `SIGSEGV`. [VERIFIED: npm run test:tui:e2e]

**Why it happens:** The failure is in the runner's worker process (`node_modules/@microsoft/tui-test/lib/runner/worker.js`) rather than in an individual app assertion; the exact native/root cause was not determined in this research. [VERIFIED: npm run test:tui:e2e][ASSUMED]

**How to avoid:** Plan a Wave 0 stabilization task: reproduce on the existing 8-test file, enable `@microsoft/tui-test` trace or narrow to one test, inspect Node/package compatibility, and only then add golden-path coverage. [VERIFIED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:117-135][VERIFIED: npm run test:tui:e2e]

**Warning signs:** All tests fail in under ~1.1s with identical `Workerpool Worker terminated Unexpectedly` and `signalCode: SIGSEGV`. [VERIFIED: npm run test:tui:e2e]

### Pitfall 2: Node engine mismatch risk

**What goes wrong:** Package metadata for installed `@microsoft/tui-test@0.0.4` declares `node >=16.6.0 <25.0.0`, while this environment runs Node `v24.13.0`, which satisfies that range but is near the upper bound. [VERIFIED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/package.json:13-16][VERIFIED: node --version]

**Why it happens:** `@microsoft/tui-test` depends on optional/native PTY substrate and worker processes; native/worker failures can be environment-sensitive. [VERIFIED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/package.json:35-51][ASSUMED]

**How to avoid:** Do not upgrade/downgrade packages blindly in the plan; first capture exact installed versions (`@microsoft/tui-test@0.0.4`, `workerpool@9.3.4`, Node `v24.13.0`) and a minimal repro. [VERIFIED: /home/alpine/vcode0/package-lock.json:1827-1856][VERIFIED: /home/alpine/vcode0/package-lock.json:7297-7303][VERIFIED: node --version]

**Warning signs:** Runner crash occurs even for existing pre-12-02 tests. [VERIFIED: npm run test:tui:e2e]

### Pitfall 3: Over-scoping the golden path

**What goes wrong:** Trying to run the full autonomous prompt-to-main lifecycle through terminal E2E makes the suite slow, brittle, and dependent on workers/providers. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:32-39]

**Why it happens:** The newcomer narrative spans planner agents, orchestrator event queue, worker pool, inbox waits, verification, and merge train, but 12-02's target is only the user-visible TUI lane. [VERIFIED: /home/alpine/vcode0/docs/foundations/newcomer.md:9-247][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:14-17]

**How to avoid:** Assert a surface-level command path: startup -> `/init` -> graph feedback -> steering overlay(s) -> draft task -> `/submit` approval status -> `/quit`; cite 12-01 for backend semantics. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-210][VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-01-SUMMARY.md:82-96]

**Warning signs:** Test needs live provider credentials, waits for real workers, or asserts `main` commits. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:38-39]

### Pitfall 4: Plain text prompt mismatch

**What goes wrong:** A test types a natural-language prompt expecting planner chat, but docs say composer plain-text planner chat is not wired yet. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:145-147]

**Why it happens:** The newcomer narrative says the user starts in the TUI composer and submits a planning command; current implementation is command-first. [VERIFIED: /home/alpine/vcode0/docs/foundations/newcomer.md:9-18][VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:145-159]

**How to avoid:** Use slash commands such as `/init`, `/help`, `/inbox`, `/merge-train`, `/config`, `/task-add`, `/submit`, and `/quit`. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:161-230]

**Warning signs:** Expected visible string is `planner chat not wired yet` or no graph mutation occurs after text submit. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:145-147]

## Code Examples

Verified patterns from current repo sources:

### Launch real TUI in a temp workspace

```typescript
// Source: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:256-261
function startTui(
  terminal: { submit(data?: string): void },
  workspace: string,
): void {
  terminal.submit(`npm run tui -- --cwd ${shellQuote(workspace)}`);
}
```

This launches the package script `tui`, which is `tsx src/main.ts`. [VERIFIED: /home/alpine/vcode0/package.json:25-26]

### Wait for TUI readiness by visible text

```typescript
// Source: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:263-271
async function waitForTuiReady(
  terminal: Pick<TuiTerminal, 'getByText'>,
): Promise<void> {
  await expect(terminal.getByText('gvc0 progress')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
}
```

### Existing deterministic golden-path fragments to combine

- Startup/composer/help assertions exist in `starts with composer focus and runs help from composer`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-50]
- `/init` graph feedback assertions exist in `initializes starter milestone and planning feature from empty workspace`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:139-161]
- Draft/approval assertions exist in `creates planner draft and reaches approval-ready state`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:177-210]
- Overlay command and keybind assertions exist for inbox, merge-train, config, monitor, and help. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:52-137]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Treat TUI smoke as optional/deferred | Phase 12 SC3 requires `@microsoft/tui-test` golden-path smoke coverage | Roadmap Phase 12, current plan 12-02. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:221-236] | The planner must include stabilization and actual TUI lane execution rather than relying on Vitest only. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179] |
| Use TUI lane as non-blocking due SIGSEGV | 12-02 must confront and isolate/stabilize the SIGSEGV blocker first | Historical blocker recorded 2026-04-29; reproduced 2026-05-02. [VERIFIED: /home/alpine/vcode0/.planning/STATE.md:49-54][VERIFIED: npm run test:tui:e2e] | Plan should start with minimal repro/stabilization task. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:67-68] |
| Plain-text planner prompt in TUI | Slash-command-first composer (`/init`, `/feature-add`, `/task-add`, `/submit`) | Current docs and implementation. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:145-230][VERIFIED: /home/alpine/vcode0/src/tui/app-composer.ts:41-54] | Golden path should use slash commands, not natural-language planner chat. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:145-147] |

**Deprecated/outdated:** Treating `npm run test` as covering TUI E2E is outdated; docs and Vitest config exclude the TUI lane. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:12][VERIFIED: /home/alpine/vcode0/vitest.config.ts:11-18]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The exact native/root cause of the current `SIGSEGV` was not determined in this research; it appears runner-side because every existing test fails in the workerpool child before app-specific assertions. | Common Pitfalls | Planner may choose the wrong stabilization tactic if app startup is secretly triggering the runner crash. |
| A2 | `@microsoft/tui-test` native/worker failures can be environment-sensitive. | Common Pitfalls | Planner may under-prioritize environment capture if the crash is fully deterministic across all supported environments. |

## Open Questions

1. **What is the exact `SIGSEGV` root cause?**
   - What we know: `npm run test:tui:e2e` fails all 8 tests with `Workerpool Worker terminated Unexpectedly`, `signalCode: SIGSEGV`, and worker script `node_modules/@microsoft/tui-test/lib/runner/worker.js`. [VERIFIED: npm run test:tui:e2e]
   - What's unclear: Whether the crash is caused by Node 24.13.0, optional `node-pty`, workerpool, `@xterm/headless`, the shell environment, or app launch side effects. [ASSUMED]
   - Recommendation: Wave 0 should capture a minimal `@microsoft/tui-test` repro with trace enabled, then decide whether to isolate tests, adjust runner config, pin dependency versions, or document an upstream blocker. [CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:117-135]
2. **Should golden path be a new file or extension of `smoke.test.ts`?**
   - What we know: Existing `smoke.test.ts` already contains all helper functions and fragments for startup, overlays, `/init`, autocomplete, draft, and approval. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-275]
   - What's unclear: Whether splitting to `golden-path.test.ts` improves isolation once runner is stable. [ASSUMED]
   - Recommendation: Prefer extending `smoke.test.ts` if the runner remains sensitive to file count; otherwise add `golden-path.test.ts` for grep-friendly traceability. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:66-69]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | `tsx`, `@microsoft/tui-test`, package scripts | Yes | `v24.13.0` | None; package requires Node `>=24` and `@microsoft/tui-test` supports `<25`. [VERIFIED: node --version][VERIFIED: /home/alpine/vcode0/package.json:7-9][VERIFIED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/package.json:13-16] |
| npm | package scripts | Yes | `11.9.0` | None needed. [VERIFIED: npm --version][VERIFIED: /home/alpine/vcode0/package.json:6] |
| npx | `npm run test:tui:e2e`, fixture seeding | Yes | `11.9.0` | Use `npm exec` only if npx unavailable; not needed here. [VERIFIED: npx --version][VERIFIED: /home/alpine/vcode0/package.json:25] |
| `@microsoft/tui-test` CLI | TUI E2E lane | Installed but crashing | `0.0.4` | No acceptable replacement for SC12-3; must stabilize or document blocker. [VERIFIED: /home/alpine/vcode0/package-lock.json:1827-1856][VERIFIED: npm run test:tui:e2e] |
| `tsx` | `npm run tui` and workspace seeding | Declared installed via package lock | `^4.21.0` declared | No fallback recommended. [VERIFIED: /home/alpine/vcode0/package.json:25-38][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:220-250] |

**Missing dependencies with no fallback:** None found; the blocker is not absence but `@microsoft/tui-test` worker `SIGSEGV`. [VERIFIED: command availability audit][VERIFIED: npm run test:tui:e2e]

**Missing dependencies with fallback:** None found. [VERIFIED: command availability audit]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `@microsoft/tui-test@0.0.4` for TUI E2E; Vitest remains separate and excludes TUI E2E. [VERIFIED: /home/alpine/vcode0/package-lock.json:1827-1856][VERIFIED: /home/alpine/vcode0/vitest.config.ts:11-18] |
| Config file | None found at `/home/alpine/vcode0/tui-test.config.ts` or `/home/alpine/vcode0/tui-test.config.js`; Wave 0 may add one only if needed for trace/retries/isolation. [VERIFIED: ls /home/alpine/vcode0/tui-test.config.ts /home/alpine/vcode0/tui-test.config.js 2>/dev/null][CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:123-135] |
| Quick run command | `npm run test:tui:e2e` (currently fails with workerpool `SIGSEGV`). [VERIFIED: /home/alpine/vcode0/package.json:25][VERIFIED: npm run test:tui:e2e] |
| Full suite command | `npm run check && npm run test:tui:e2e` because `npm run check` covers format/lint/typecheck/Vitest and TUI lane is separate. [VERIFIED: /home/alpine/vcode0/package.json:10-28][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC12-3A | Real TUI entrypoint launches in PTY and reaches visible `gvc0 progress` startup state. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:179] | TUI E2E smoke | `npm run test:tui:e2e` | Existing coverage in `test/integration/tui/smoke.test.ts`, but currently blocked by SIGSEGV. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-50][VERIFIED: npm run test:tui:e2e] |
| SC12-3B | Command entry creates starter milestone/feature and shows durable graph/status feedback. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:30-33] | TUI E2E smoke | `npm run test:tui:e2e` | Existing partial coverage in `smoke.test.ts`; golden-path naming gap remains. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:139-161] |
| SC12-3C | Operator steering overlays required for golden path are visible through slash command and/or graph keybind. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:232-277] | TUI E2E smoke | `npm run test:tui:e2e` | Existing coverage for help, monitor, inbox, merge-train, and config. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-137] |
| SC12-3D | Draft task edit reaches proposal approval-ready composer state without live LLM calls. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:38-39] | TUI E2E smoke | `npm run test:tui:e2e` | Existing coverage in `smoke.test.ts`, but not named as golden path. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:177-210] |
| SC12-3E | Clean quit via `/quit` or graph `q` exits the TUI lane without hanging. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:114-143][VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:161-177] | TUI E2E smoke | `npm run test:tui:e2e` | Gap: no explicit quit assertion found in current `smoke.test.ts`; afterEach kills terminal instead. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:15-22][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-210] |

### Sampling Rate

- **Per task commit:** Run `npm run test:tui:e2e` after runner stabilization; before stabilization, run it to capture the same SIGSEGV signature and avoid misattributing failures. [VERIFIED: npm run test:tui:e2e]
- **Per wave merge:** Run `npm run check && npm run test:tui:e2e`. [VERIFIED: /home/alpine/vcode0/package.json:10-28][VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179]
- **Phase gate:** Full suite green should include `npm run check` plus `npm run test:tui:e2e` with the golden-path test name visible in output. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:66-69]

### Wave 0 Gaps

- [ ] Stabilize or isolate `@microsoft/tui-test` workerpool `SIGSEGV` before adding coverage; current command fails all 8 existing tests. [VERIFIED: npm run test:tui:e2e]
- [ ] Decide whether to add `tui-test.config.ts` for trace/retry/isolation; no config file exists today. [VERIFIED: ls /home/alpine/vcode0/tui-test.config.ts /home/alpine/vcode0/tui-test.config.js 2>/dev/null][CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:117-135]
- [ ] Add or rename a focused golden-path spec/test title containing `golden path` and `tui e2e smoke` for 12-03 traceability. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:66-67]
- [ ] Add explicit clean quit coverage because current tests rely on `terminal.kill()` in `afterEach` rather than asserting `/quit` or `q` exits cleanly. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:15-22][VERIFIED: /home/alpine/vcode0/docs/reference/tui.md:114-143]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | 12-02 TUI smoke tests should not add auth surfaces or live providers. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:38-39] |
| V3 Session Management | No | PTY test sessions are local test processes, not user auth sessions. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179] |
| V4 Access Control | Limited | Use isolated temp workspaces and `--cwd`; do not write outside temp workspace except repo test execution. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-261] |
| V5 Input Validation | Yes | Slash-command parsing is existing app behavior; tests should send valid slash commands and assert user-visible errors only where intentional. [VERIFIED: /home/alpine/vcode0/src/tui/commands/index.ts:317-358][VERIFIED: /home/alpine/vcode0/src/tui/app-composer.ts:68-331] |
| V6 Cryptography | No | No cryptographic behavior is in 12-02 scope. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:10-17] |

### Known Threat Patterns for TUI E2E Tests

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Shell injection through workspace path | Tampering | Keep `shellQuote()` when interpolating temp workspace into `terminal.submit()`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:256-275] |
| Test state bleed through persistent `.gvc0/state.db` | Tampering | Use per-test temp workspace and recursive cleanup in `afterEach`. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:15-22][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:212-254] |
| Accidental live LLM/provider calls | Information Disclosure / Denial of Service | Use deterministic/local graph seeding and slash commands; do not run full autonomous execution in PTY. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:33-39][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:219-250] |

## Recommended Scope for 12-02 Plan

1. **Wave 0: Runner stabilization.** Reproduce current `SIGSEGV`, capture exact versions and minimal repro, optionally add `tui-test.config.ts` trace/isolation if it helps, and get at least one existing smoke test executing assertions. [VERIFIED: npm run test:tui:e2e][CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md:117-135]
2. **Wave 1: Golden-path smoke.** Add one grep-friendly test named with `golden path` and `tui e2e smoke`; combine startup, `/init`, graph feedback, one or two steering overlays, draft task add, `/submit` approval state, and `/quit`. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md:66-69][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts:24-210]
3. **Wave 2: Verification and handoff.** Run `npm run check && npm run test:tui:e2e`; document any residual upstream runner limitation only if the stabilization task proves it cannot be resolved locally. [VERIFIED: /home/alpine/vcode0/package.json:10-28][VERIFIED: /home/alpine/vcode0/.planning/STATE.md:49-54]

## Sources

### Primary (HIGH confidence)

- `/home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md` — locked scope, proof shape, blockers, and deferred work. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-02-CONTEXT.md]
- `/home/alpine/vcode0/.planning/ROADMAP.md` — Phase 12 success criterion SC3 and plan split. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:221-236]
- `/home/alpine/vcode0/.planning/STATE.md` — current phase handoff and historical `@microsoft/tui-test` SIGSEGV blocker. [VERIFIED: /home/alpine/vcode0/.planning/STATE.md:49-54]
- `/home/alpine/vcode0/docs/operations/testing.md` — TUI lane split and current testing guidance. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179]
- `/home/alpine/vcode0/docs/reference/tui.md` — current TUI entrypoints, commands, overlays, and limitations. [VERIFIED: /home/alpine/vcode0/docs/reference/tui.md]
- `/home/alpine/vcode0/test/integration/tui/smoke.test.ts` — existing `@microsoft/tui-test` patterns and helpers. [VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts]
- `/home/alpine/vcode0/src/main.ts` and `/home/alpine/vcode0/src/tui/**` — real entrypoint and TUI implementation. [VERIFIED: /home/alpine/vcode0/src/main.ts][VERIFIED: /home/alpine/vcode0/src/tui/app.ts]
- `npm run test:tui:e2e` — current runner behavior and SIGSEGV reproduction. [VERIFIED: npm run test:tui:e2e]
- `npm view @microsoft/tui-test version time --json` and package lock — current package version/publish verification. [VERIFIED: npm registry][VERIFIED: /home/alpine/vcode0/package-lock.json:1827-1856]

### Secondary (MEDIUM confidence)

- `/home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md` — installed package README for runner capabilities, trace, and config. [CITED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/README.md]
- `/home/alpine/vcode0/node_modules/@microsoft/tui-test/package.json` — installed runner metadata and engine/dependency declarations. [VERIFIED: /home/alpine/vcode0/node_modules/@microsoft/tui-test/package.json]

### Tertiary (LOW confidence)

- Assumptions about the exact native cause of SIGSEGV and environment sensitivity; flagged in Assumptions Log. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — package.json, package-lock, npm registry, and docs were checked. [VERIFIED: /home/alpine/vcode0/package.json][VERIFIED: /home/alpine/vcode0/package-lock.json][VERIFIED: npm registry]
- Architecture: HIGH — traced from current `src/main.ts`, `src/tui/app.ts`, and existing smoke tests. [VERIFIED: /home/alpine/vcode0/src/main.ts][VERIFIED: /home/alpine/vcode0/src/tui/app.ts][VERIFIED: /home/alpine/vcode0/test/integration/tui/smoke.test.ts]
- Pitfalls: HIGH for existence of SIGSEGV, MEDIUM for root-cause guidance because the exact native cause was not isolated. [VERIFIED: npm run test:tui:e2e][ASSUMED]

**Research date:** 2026-05-02 [VERIFIED: currentDate]
**Valid until:** 2026-05-09 because `@microsoft/tui-test` and `pi-tui` are fast-moving/pre-1.0 surfaces in this repo. [VERIFIED: npm view @microsoft/tui-test version time --json][VERIFIED: npm view @mariozechner/pi-tui version time --json]
