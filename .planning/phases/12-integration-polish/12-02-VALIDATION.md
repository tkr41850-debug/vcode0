# Phase 12-02 Validation Architecture: TUI E2E Smoke

## Scope

This validation architecture applies only to Phase 12 plan 12-02: the `@microsoft/tui-test` TUI end-to-end smoke lane for the operator-visible golden path.

Out of scope for this validation artifact:

- README/source-install dry-run work, which remains plan 12-03.
- Final v1 requirement traceability green-out, which remains plan 12-03.
- Replacing the deterministic backend prompt-to-main proof from 12-01.

## Validation Goal

The TUI lane must prove that a real pseudo-terminal can launch the production `src/main.ts` TUI entrypoint, accept operator commands, render durable user-visible graph and steering feedback, and quit cleanly.

## Test Framework

| Property | Value |
|---|---|
| Runner | `@microsoft/tui-test` |
| Config | `/home/alpine/vcode0/tui-test.config.ts` |
| TUI entrypoint | `npm run tui -- --cwd <temp-workspace>` |
| Smoke lane command | `npm run test:tui:e2e` |
| Full phase gate | `npm run check && npm run test:tui:e2e` |
| Test directory | `/home/alpine/vcode0/test/integration/tui/` |

The TUI lane is separate from Vitest. `npm run test` does not run `test/integration/tui/**`.

## Current Stabilization Gate

The current blocker is the known `@microsoft/tui-test` workerpool `SIGSEGV` failure recorded in Phase 8/Phase 12 state. Plan 12-02 must treat this as the first validation gate.

The stabilization gate passes only when:

1. `npm run test:tui:e2e` no longer exits with workerpool `SIGSEGV`.
2. Existing smoke tests execute assertions rather than failing before app assertions run.
3. At least one existing startup/composer smoke assertion reaches visible `gvc0 progress` through the production TUI entrypoint.

Allowed stabilization changes are narrow runner/lane changes only:

- `tui-test.config.ts` isolation, timeout, shell, viewport, trace, or environment settings.
- `package.json` script adjustment if required to invoke the same `@microsoft/tui-test` lane reliably.
- Dependency lockfile changes only if a version pin is proven necessary by the minimal repro and the package remains `@microsoft/tui-test`.

Do not replace `@microsoft/tui-test` with Vitest, direct `node-pty`, or a custom terminal runner.

## Phase Requirements to Validation Map

| ID | Required behavior | Validation file | Automated command |
|---|---|---|---|
| SC12-3A | Real `src/main.ts` TUI entrypoint launches in PTY and reaches visible startup state. | Existing `/home/alpine/vcode0/test/integration/tui/smoke.test.ts` plus the new golden-path smoke. | `npm run test:tui:e2e` |
| SC12-3B | Command entry creates starter milestone/feature and renders graph/status feedback. | New grep-friendly golden-path smoke under `/home/alpine/vcode0/test/integration/tui/`. | `npm run test:tui:e2e` |
| SC12-3C | Operator steering overlays are visible through slash commands or graph hotkeys. | New golden-path smoke, asserting durable overlay text such as `Help [h/q/esc hide]`, `Inbox [0 pending]`, or `Config [c/q/esc hide]`. | `npm run test:tui:e2e` |
| SC12-3D | Draft task entry reaches proposal approval-ready composer state without live provider calls. | New golden-path smoke using deterministic local graph state and proposal draft commands. | `npm run test:tui:e2e` |
| SC12-3E | TUI exits cleanly through `/quit` or graph `q`. | New golden-path smoke includes explicit quit action; test teardown still kills the PTY defensively. | `npm run test:tui:e2e` |

## Golden-Path Smoke Shape

The golden-path smoke must have a grep-friendly test title containing both:

- `golden path`
- `tui e2e smoke`

Required user-visible sequence:

1. Create an isolated temp workspace and `.gvc0/` directory.
2. Launch `npm run tui -- --cwd <temp-workspace>` through `@microsoft/tui-test`.
3. Assert startup strings: `gvc0 progress`, `[command] [composer]`, `gvc0 startup`, and `Run /init to create first milestone and planning feature.`
4. Submit `/init --milestone-name "Milestone 1" --milestone-description "Initial milestone" --feature-name "Project startup" --feature-description "Plan initial project work"`.
5. Assert graph/status strings: `m-1: Milestone 1`, `f-1: Project startup`, `queue: 1`, and `work: planning`.
6. Open at least one steering overlay and assert durable visible text. Preferred: `/help` with `Help [h/q/esc hide]` and `Show or hide keyboard help.`
7. Exercise graph focus and at least one graph hotkey after asserting `focus: graph`.
8. Enter a draft task for the selected feature: `task-add --description "Golden path task" --weight small` from composer state seeded by `/`.
9. Assert draft/proposal strings: `gvc0 progress [draft]`, `t-1: Golden path task`, `view: draft`.
10. Submit `/submit` and assert `[approval] [composer] approval plan f-1 /approve /reject /rerun`.
11. Quit cleanly via `/quit` or graph `q` with no overlay open.

## Assertion Rules

Use durable visible strings, not cursor coordinates or exact box geometry.

Preferred assertions:

- `gvc0 progress`
- `[command] [composer]`
- `gvc0 startup`
- `m-1: Milestone 1`
- `f-1: Project startup`
- `queue: 1`
- `work: planning`
- `Help [h/q/esc hide]`
- `Config [c/q/esc hide]`
- `Inbox [0 pending]`
- `focus: graph`
- `focus: composer`
- `gvc0 progress [draft]`
- `view: draft`
- `[approval] [composer] approval plan f-1 /approve /reject /rerun`

Avoid:

- Live provider calls.
- Full worker/planner/verify/merge-train orchestration inside PTY.
- Pixel, cell, or snapshot assertions.
- Reusing repo-root `.gvc0/state.db`.

## Required Commands

Run during implementation:

```bash
npm run test:tui:e2e
```

Run at final phase gate:

```bash
npm run check && npm run test:tui:e2e
```

Run for grep-friendly traceability:

```bash
grep -R "golden path tui e2e smoke" /home/alpine/vcode0/test/integration/tui
```

## Pass Criteria

Plan 12-02 validation passes when:

- `npm run test:tui:e2e` runs without the current workerpool `SIGSEGV` failure.
- The golden-path smoke title is grep-friendly for 12-03 traceability.
- The golden-path smoke launches the real TUI through `npm run tui -- --cwd <temp-workspace>`.
- The smoke proves startup, command entry, graph feedback, steering overlay visibility, draft approval state, and clean quit using visible terminal text.
- `npm run check && npm run test:tui:e2e` is green.
