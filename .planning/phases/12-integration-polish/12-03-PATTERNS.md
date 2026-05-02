# Phase 12-03 Pattern Map: README Runbook + Traceability

**Mapped:** 2026-05-02
**Files analyzed:** root docs, Phase 12 artifacts, requirements inventory

## File Classification

| New/Modified File | Role | Closest Analog | Match Quality |
|---|---|---|---|
| `README.md` | source-install quickstart | `docs/README.md`, `ARCHITECTURE.md` | partial |
| `.planning/REQUIREMENTS.md` | traceability ledger | existing same file | exact |
| `.planning/phases/12-integration-polish/12-03-SUMMARY.md` | phase summary/evidence | `12-02-SUMMARY.md` | exact |
| `.planning/ROADMAP.md` | progress ledger | prior phase updates | exact |
| `.planning/STATE.md` | current project state | prior phase updates | exact |

## README Pattern

There is no root `README.md`. Create one as a short source-install runbook, not a replacement docs catalog.

Recommended shape:

```md
# gvc0

Short thesis.

## Requirements

- Node.js 24+
- npm
- git
- native build tools if node-pty rebuilds on Alpine/musl

## Install from source

```bash
npm install
```

## Configure a workspace

Minimal `gvc0.config.json` example with four model roles.

## Run the TUI

```bash
npm run tui
# or
npm run tui -- --cwd /path/to/workspace
```

## Verify the checkout

```bash
npm run check
npm run test:tui:e2e
```

## Documentation

Link to `ARCHITECTURE.md`, `docs/README.md`, and key docs.
```

Keep claims aligned with `package.json`:

- `node >=24`
- `npm run tui`
- `npm run check`
- `npm run test:tui:e2e`

## Requirements Traceability Pattern

Current `.planning/REQUIREMENTS.md` uses:

```md
- [ ] **REQ-PLAN-01**: ...
```

and a table:

```md
| Requirement | Primary Phase | Status |
|-------------|---------------|--------|
| REQ-PLAN-01 | Phase 7 ... | Pending |
```

For final closeout, update both the checkbox and table consistently:

- `[x]` only when status is complete for v1.
- Table status should be concise and evidence-bearing, e.g. `Complete — Phase 7; 12-01 prompt-to-main proof; docs/foundations/newcomer.md`.
- Use `v1.x follow-up — <pointer>` if a requirement is not complete.

Do not create a separate traceability file unless the table becomes unreadable; the roadmap says all v1 REQ-ids must be green or have follow-up, and `.planning/REQUIREMENTS.md` is the canonical flat view.

## Source-Install Dry-Run Pattern

The existing TUI E2E test helpers in `test/integration/tui/smoke.test.ts` establish the reliable startup assertion pattern:

- create temp workspace;
- write minimal `gvc0.config.json`;
- launch `npm run tui -- --cwd <workspace>`;
- wait for `gvc0 progress`;
- assert init guidance text;
- quit or kill after proof.

For 12-03, prefer a one-off verification command rather than adding permanent test coverage unless a reusable dry-run test is necessary. Permanent coverage already exists in 12-02 for startup from the working tree; 12-03 is about fresh source-install proof.

## Summary Pattern

Match `12-02-SUMMARY.md` frontmatter style:

```yaml
---
phase: 12-integration-polish
plan: "03"
subsystem: docs-traceability
tags: [readme, source-install, traceability, v1]
...
requirements-completed: [SC12-4, SC12-5]
---
```

Include:

- files created/modified;
- exact source-install dry-run command and observed startup evidence;
- final traceability count: v1 total, complete, follow-up;
- verification commands/results;
- final handoff status for milestone closure.

## Scope Guardrails

- Do not add public npm/global install instructions as v1; source checkout is the v1 distribution mode.
- Do not require live LLM calls for install verification.
- Do not modify product code unless the fresh-install dry-run exposes a real bug.
- Do not duplicate the full docs catalog in root README.
