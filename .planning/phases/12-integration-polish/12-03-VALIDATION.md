# Phase 12-03 Validation Architecture: Source Install + v1 Traceability

## Scope

This validation architecture applies only to Phase 12 plan 12-03: README/source-install runbook verification and final v1 requirement traceability closeout.

Out of scope:

- Adding new runtime surfaces.
- Replacing 12-01 backend lifecycle proof.
- Replacing 12-02 `@microsoft/tui-test` golden-path smoke.
- Public npm/global/binary distribution.

## Validation Goal

A fresh source checkout can follow the root README to install dependencies and start the TUI, and the project has an explicit final traceability status for every v1 requirement.

## Phase Requirements to Validation Map

| ID | Required behavior | Validation artifact | Automated/manual command |
|---|---|---|---|
| SC12-4A | Root README contains source-install runbook. | `README.md` | `grep -n "npm install\|npm run tui" README.md` |
| SC12-4B | Fresh clone/copy runs `npm install`. | `12-03-SUMMARY.md` evidence | fresh clone dry-run command |
| SC12-4C | Fresh clone/copy starts TUI and reaches startup state. | `12-03-SUMMARY.md` evidence; optional dry-run log | PTY startup assertion for `gvc0 progress` and init guidance |
| SC12-5A | All 37 v1 requirement rows are no longer pending. | `.planning/REQUIREMENTS.md` | grep/no-pending check |
| SC12-5B | Every v1 requirement is either complete or has explicit follow-up. | `.planning/REQUIREMENTS.md` | traceability table review |
| SC12-5C | Final phase state/roadmap reflects Phase 12 closure. | `.planning/ROADMAP.md`, `.planning/STATE.md` | file review after execution |

## Source-Install Dry-Run Protocol

The dry-run should use a local fresh clone or source copy outside `/home/alpine/vcode0`.

Minimum protocol:

1. Create a fresh temp directory.
2. Clone or copy the repository source into it.
3. Run `npm install` inside the fresh checkout.
4. Create a separate temp workspace containing `.gvc0/` and `gvc0.config.json`.
5. Launch `npm run tui -- --cwd <workspace>` from the fresh checkout.
6. Assert startup text:
   - `gvc0 progress`
   - `Run /init to create first milestone and planning feature.`
7. Terminate the TUI after startup proof.
8. Record command, environment, and observed text in `12-03-SUMMARY.md`.

If the dry-run must use a source copy including uncommitted README/planning changes before they are committed, record that explicitly in the summary. Prefer committing planning artifacts first, then dry-running from a clean local clone for final evidence.

## Traceability Validation Rules

For `.planning/REQUIREMENTS.md`:

- No v1 requirement checkbox may remain unchecked unless its status is an explicit `v1.x follow-up` or `v2 follow-up` row.
- No traceability table status may remain `Pending`.
- Each complete row must include a concise evidence pointer: phase, doc, test, or code surface.
- Each follow-up row must name the follow-up bucket and reason.

Recommended checks:

```bash
grep -n "| REQ-.*Pending" .planning/REQUIREMENTS.md
```

Expected: no matches.

```bash
grep -n "- \[ \] \*\*REQ-" .planning/REQUIREMENTS.md
```

Expected: no matches for v1 rows unless a deliberate follow-up convention is chosen and documented.

## Final Verification Commands

Run after implementation:

```bash
npm run check
npm run test:tui:e2e
```

Final gate:

```bash
npm run check && npm run test:tui:e2e
```

## Pass Criteria

12-03 validation passes when:

- Root `README.md` exists and documents source install, minimal config, running the TUI, and verification commands.
- The source-install dry-run evidence proves `npm install` and TUI startup from a fresh checkout/copy.
- `.planning/REQUIREMENTS.md` has all v1 rows marked complete or explicit follow-up, with no `Pending` traceability statuses.
- `.planning/ROADMAP.md` marks Phase 12 plan 12-03 complete and Phase 12 complete.
- `.planning/STATE.md` records final Phase 12/milestone closure state.
- `npm run check && npm run test:tui:e2e` passes.
