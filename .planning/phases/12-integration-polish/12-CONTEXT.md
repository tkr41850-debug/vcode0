# Phase 12: Integration & Polish - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning
**Mode:** Auto-generated from ROADMAP phase goal and shipped Phase 11 state

<domain>
## Phase Boundary

Phase 12 proves the v1 loop end-to-end and closes final operator polish. It should not add broad new product surfaces unless a Phase 12 success criterion cannot be verified without a small supporting harness or runbook change.

The roadmap success criteria are:

1. Scripted end-to-end scenario runs green: "type a prompt → draft features → execute → answer one inbox item → merge-train drains → main contains expected commits".
2. Verify agent flake-rate audit: at least 90% consistency on known-good-branch runs across 5 repeats.
3. TUI e2e smoke tests using `@microsoft/tui-test` cover the golden path.
4. Source-install runbook in README is verified by a fresh-clone dry-run: `npm install && npm run tui` leads to a running TUI.
5. All v1 REQ-ids either complete with traceability green, or have an explicit v1.x follow-up.

Plan 12-01 should focus on the first two criteria: the scripted end-to-end scenario and verify-agent flake-rate audit.

</domain>

<decisions>
## Implementation Decisions

### 12-01 scope
- 12-01 covers the non-TUI integration proof: scripted prompt-to-main-style lifecycle coverage and verify-agent flake-rate audit.
- 12-02 remains responsible for `@microsoft/tui-test` golden-path smoke coverage.
- 12-03 remains responsible for README/source-install runbook and final v1 traceability green-out.

### End-to-end proof shape
- Prefer deterministic executable tests over manual scripts for 12-01.
- Use the existing Vitest integration harness and faux-provider patterns rather than live model calls.
- The scenario should exercise a realistic lifecycle chain through planner/approval/inbox/worker/verify/merge-train semantics as far as current test harness boundaries support.
- If a literal human-typed prompt through the TUI is only feasible in 12-02, 12-01 should document the boundary and cover the underlying orchestrator/runtime flow in Vitest.

### Verify-agent flake audit
- The flake audit should be deterministic and repeatable in CI or an explicit npm script.
- It should run the known-good verification path 5 times and fail if consistency is below 90%.
- Because 5 repeats makes pass thresholds awkward, use 5/5 pass consistency unless the implementation records a richer numerator/denominator that can represent 90% exactly.
- Do not call live LLM providers; use faux provider or existing deterministic verify-agent harness seams.

### Existing blockers to respect
- `@microsoft/tui-test` is pre-1.0 and has a known workerpool `SIGSEGV` history; keep 12-01 out of the TUI e2e lane.
- Existing parallel-vitest flakes are known from earlier phases; avoid adding a new parallel-load-sensitive test if the same behavior can be checked deterministically.
- Phase 12 should prove integration, not rewrite architecture.

</decisions>

<canonical_refs>
## Canonical References

Downstream agents MUST read these before planning or implementing.

### Roadmap and state
- `.planning/ROADMAP.md` — Phase 12 goal, success criteria, and plan split.
- `.planning/STATE.md` — current project status, known blockers, and Phase 12 handoff.
- `.planning/REQUIREMENTS.md` — full v1 requirement inventory for later traceability.

### Recent phase handoffs
- `.planning/phases/11-documentation-diagnostic-tooling/11-03-SUMMARY.md` — Phase 11 closure and Phase 12 handoff.
- `.planning/phases/11-documentation-diagnostic-tooling/11-02-SUMMARY.md` — docs drift test patterns and latest full-check baseline.

### Existing docs and test references
- `docs/operations/testing.md` — current integration targets, faux provider harness notes, TUI lane split, and concerns traceability.
- `docs/foundations/newcomer.md` — current prompt-to-`main` narrative to use as the behavioral target.
- `docs/reference/tui.md` — current TUI entrypoints and `gvc0 explain` diagnostics.
- `test/integration/harness/` — existing deterministic integration scaffolding.
- `test/integration/feature-lifecycle-e2e.test.ts` — existing lifecycle/repair-loop integration coverage.
- `test/integration/merge-train.test.ts` — merge-train integration coverage.
- `test/integration/worker-smoke.test.ts` — worker runtime smoke and wait/resume coverage.
- `test/integration/feature-phase-agent-flow.test.ts` — feature-phase dispatch/proposal/verify/summarize coverage.

</canonical_refs>

<specifics>
## Specific Ideas

- Consider adding a dedicated `test/integration/prompt-to-main-e2e.test.ts` or extending an existing integration test if that avoids duplicate harness setup.
- Consider adding a focused verify flake audit test or script that repeats deterministic verify-agent review 5 times and reports pass consistency.
- Keep test names and output grep-friendly so 12-03 can cite them in final traceability.
- If `npm run check` would become too slow, prefer a focused test in default Vitest plus an explicit npm script only if the runtime cost justifies it.

</specifics>

<deferred>
## Deferred Ideas

- TUI golden-path smoke belongs to 12-02.
- README/source-install dry-run and v1 traceability green-out belong to 12-03.
- Full live-provider verify flake auditing remains out of scope for v1 unless a deterministic harness cannot satisfy the roadmap criterion.

</deferred>

---

*Phase: 12-integration-polish*
*Context gathered: 2026-05-02 via autonomous roadmap synthesis*
