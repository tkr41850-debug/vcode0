# Phase 12-02: TUI E2E Smoke Tests - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning
**Mode:** Derived from Phase 12 roadmap split, Phase 12 context, and 12-01 completion state

<domain>
## Phase Boundary

Phase 12-02 covers the TUI e2e smoke-test success criterion only:

3. TUI e2e smoke tests using `@microsoft/tui-test` cover the golden path.

12-01 already covered the deterministic non-TUI prompt-to-main lifecycle and verify-agent flake-rate audit. 12-03 remains responsible for source-install README/runbook verification and final v1 requirement traceability green-out.

The goal for 12-02 is not to duplicate 12-01's full orchestration proof inside a PTY. It is to make sure the real TUI entrypoint can be launched in the terminal e2e lane and that the operator-visible golden path is smoke-covered at the surface level.

</domain>

<decisions>
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

</decisions>

<canonical_refs>
## Canonical References

Downstream agents MUST read these before planning or implementing.

### Roadmap and state
- `.planning/ROADMAP.md` — Phase 12 success criteria and plan split.
- `.planning/STATE.md` — current project status, known blockers, and Phase 12 handoff.
- `.planning/phases/12-integration-polish/12-CONTEXT.md` — original Phase 12 boundary and split.
- `.planning/phases/12-integration-polish/12-01-SUMMARY.md` — completed backend integration proof and handoff.

### TUI/testing references
- `docs/operations/testing.md` — TUI lane split and current `@microsoft/tui-test` guidance.
- `docs/reference/tui.md` — current TUI entrypoints, commands, overlays, and diagnostics.
- `docs/foundations/newcomer.md` — prompt-to-main operator narrative for the golden-path target.
- `test/integration/tui/` — existing TUI e2e smoke tests and fixtures.
- `src/main.ts` — TUI entrypoint launched by the e2e lane.
- `src/tui/` — TUI command, composer, overlay, and component implementation.

</canonical_refs>

<specifics>
## Specific Ideas

- Inventory existing `test/integration/tui/**` tests before deciding whether to extend one smoke test or add a dedicated golden-path spec.
- Keep test names grep-friendly for 12-03, e.g. include `golden path` and `tui e2e smoke`.
- If the historical `SIGSEGV` is still reproducible, the plan should include a narrow stabilization task before adding coverage.
- Prefer asserting durable visible strings from command/help/overlay output rather than brittle cursor coordinates.

</specifics>

<deferred>
## Deferred Ideas

- README/source-install dry-run belongs to 12-03.
- Final v1 REQ traceability green-out belongs to 12-03.
- Deep full-run PTY orchestration with live agents remains out of scope unless current deterministic local seams make it reliable as a smoke test.

</deferred>

---

*Phase: 12-integration-polish*
*Plan: 12-02*
*Context gathered: 2026-05-02 via autonomous roadmap synthesis*
