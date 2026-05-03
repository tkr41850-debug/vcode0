# Phase 12-03 Context: README Runbook + v1 Traceability Green-Out

**Gathered:** 2026-05-02
**Status:** Ready for planning
**Mode:** Final Phase 12 slice context

<domain>
## Phase Boundary

Phase 12-03 closes the remaining Phase 12 success criteria after 12-01 and 12-02:

1. Source-install runbook in root README verified by a fresh-clone dry-run: `npm install && npm run tui` leads to a running TUI.
2. All v1 REQ-ids either complete with traceability green, or have an explicit v1.x follow-up.

This slice is documentation and validation polish. It should not add new runtime behavior unless the source-install dry-run exposes a real startup/install defect.

</domain>

<decisions>
## Implementation Decisions

### README scope
- The repository currently has no root `README.md`; 12-03 should create one.
- Keep root README focused on source checkout usage, quickstart, core commands, and links into the existing docs landing pages.
- Do not turn root README into the full docs catalog; `docs/README.md` remains the catalog.

### Source-install dry-run shape
- Use a local fresh clone or clean source copy outside the working tree.
- Run `npm install` in that clone so the normal postinstall path is exercised, including the node-pty Alpine/musl fallback from 12-02.
- Launch `npm run tui -- --cwd <fresh temp workspace>` from the clone in a PTY-capable wrapper or equivalent terminal runner, then assert durable startup text such as `gvc0 progress` and `Run /init to create first milestone and planning feature.`
- Because `npm run tui` is intentionally interactive, the dry-run should terminate it after startup is proven rather than requiring a human quit.

### Traceability closeout
- `.planning/REQUIREMENTS.md` is the canonical flat v1 list and currently has all v1 items unchecked with `Pending` traceability statuses.
- 12-03 should update each v1 requirement status from pending to either:
  - `Complete` with concise evidence pointers to shipped phases, docs, tests, or code surfaces; or
  - `v1.x follow-up` with an explicit follow-up pointer if the requirement is intentionally incomplete.
- Prefer honest traceability over blanket checkmarks. If code evidence is weak, record the follow-up instead of marking green.

### Prior evidence available
- 12-01 proves backend prompt-to-main lifecycle and verify-agent flake audit.
- 12-02 proves operator-visible TUI golden path through `@microsoft/tui-test`.
- Phase 11 docs provide final execution-flow, state-shape, coordination-semantics, and concern-to-test references.

</decisions>

<canonical_refs>
## Canonical References

### Roadmap and state
- `.planning/ROADMAP.md` — Phase 12 success criteria and plan split.
- `.planning/STATE.md` — latest Phase 12 handoff and known blockers.
- `.planning/REQUIREMENTS.md` — v1 requirement inventory and final traceability table.

### Phase 12 handoffs
- `.planning/phases/12-integration-polish/12-01-SUMMARY.md` — SC12-1 and SC12-2 evidence.
- `.planning/phases/12-integration-polish/12-02-SUMMARY.md` — SC12-3 and TUI source-install-relevant node-pty evidence.

### Docs and command references
- `package.json` — `node >=24`, `npm run tui`, `npm run check`, `npm run test:tui:e2e`, and postinstall hook.
- `ARCHITECTURE.md` — overview and docs entrypoints.
- `docs/README.md` — docs landing page.
- `docs/operations/testing.md` — verification lanes and TUI E2E lane split.
- `docs/foundations/newcomer.md` — prompt-to-main narrative.
- `docs/foundations/execution-flow.md` — execution-flow documentation evidence for REQ-DOC-01.
- `docs/foundations/state-axes.md` — state-shape documentation evidence for REQ-DOC-02.
- `docs/foundations/coordination-rules.md` — coordination decision-table evidence for REQ-DOC-03.

</canonical_refs>

<specifics>
## Specific Implementation Notes

- Root README should include:
  - what gvc0 is;
  - prerequisites: Node.js 24+, npm, git, and native build tools when node-pty must rebuild;
  - source install: `npm install`;
  - minimal `gvc0.config.json` example with the four model roles;
  - run command: `npm run tui` or `npm run tui -- --cwd <workspace>`;
  - verification commands: `npm run check` and `npm run test:tui:e2e`;
  - links to docs entrypoints.
- The dry-run evidence should be recorded in `12-03-SUMMARY.md` after execution.
- `.planning/REQUIREMENTS.md` should keep the flat inventory readable; use concise evidence rather than large prose blocks per requirement.

</specifics>

<deferred>
## Deferred Ideas

- Public npm package/global install remains v2 (`REQ-DIST-V2-*`).
- Rich packaging/binary distribution remains v2.
- Any traceability gaps discovered in v1 should be recorded as explicit v1.x/v2 follow-ups rather than quietly hidden.

</deferred>

---

*Phase: 12-integration-polish*
*Context gathered: 2026-05-02*
