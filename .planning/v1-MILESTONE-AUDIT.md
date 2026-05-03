---
milestone: v1
audited: 2026-05-03
status: passed
scores:
  requirements: 37/37
  phases: 12/12
  integration: 7/7
  flows: 7/7
resolved_gaps:
  - id: "GAP-01"
    requirement: "REQ-PLAN-01"
    phase: "12-integration-polish"
    resolved_by:
      - "test/integration/prompt-to-main-e2e.test.ts"
    evidence: "The prompt-to-main E2E now starts from top_planner_requested, approves the top-level proposal, runs discuss/research, feature planning, worker execution with inbox help, verify, integration review, and merge-train drain to merged."
tech_debt:
  - phase: "04-scheduler-tick-event-queue"
    items:
      - "Perf smoke default tier remains gated behind LOAD_TEST=1."
      - "AST boundary walker remains narrowed to compose.ts + agents/runtime.ts."
      - "GVC_ASSERT_TICK_BOUNDARY remains off by default in CI."
  - phase: "12-integration-polish"
    items:
      - "TUI E2E smoke is operator-visible and intentionally shallow; backend execution/merge is validated in separate non-TUI integration tests."
      - "Verify-agent flake audit uses deterministic faux-provider responses, not live-provider variability."
nyquist:
  compliant_phases: []
  partial_phases:
    - "11-02"
    - "12-01"
    - "12-02"
    - "12-03"
  missing_phases:
    - "01-foundations-clarity"
    - "02-persistence-port-contracts"
    - "03-worker-execution-loop"
    - "04-scheduler-tick-event-queue"
    - "05-feature-lifecycle"
    - "06-merge-train"
    - "07-top-level-planner-inbox-pause-resume"
    - "08-tui-surfaces"
    - "09-crash-recovery-ux"
    - "10-re-plan-flows-and-manual-edits-polish"
  overall: "partial"
---

# v1 Milestone Audit

**Status:** passed
**Audited:** 2026-05-03

The v1 roadmap is implementation-complete and the milestone audit now passes. The original audit found one integration-evidence gap in the core value claim; that gap has been closed by upgrading the non-TUI prompt-to-main proof so a single deterministic E2E chain starts from a top-level prompt and drains to a merged feature.

## Scores

| Area | Score | Status |
|------|-------|--------|
| Requirements | 37/37 | Passed |
| Phases | 12/12 | Complete |
| Integration | 7/7 | Passed |
| Flows | 7/7 | Passed |

## Requirement Coverage

`.planning/REQUIREMENTS.md` marks all 37 v1 requirements complete and all traceability rows cite shipped evidence. The audit accepts those rows as phase-level completion evidence, and `REQ-PLAN-01` is now also covered in the full prompt-to-main E2E chain.

| Requirement | Audit Status | Evidence |
|-------------|--------------|----------|
| REQ-PLAN-01 | Satisfied | `test/integration/prompt-to-main-e2e.test.ts` starts from `top_planner_requested`, approves the top-level proposal, creates feature `f-1`, runs discuss/research and feature planning, executes a worker with inbox help, verifies, and drains the merge train to `collabControl === 'merged'`. |
| Remaining 36 v1 requirements | Satisfied | Requirements traceability table, phase summaries, focused integration tests, TUI smoke, and source-install dry-run evidence. |

## Resolved Gap

### GAP-01: Full “one prompt to merged main” E2E is proven in one chain

**Affected requirements:** REQ-PLAN-01, REQ-PLAN-02, REQ-EXEC-01, REQ-INBOX-01, REQ-MERGE-01, REQ-MERGE-02, REQ-MERGE-04

**Original finding:** The Phase 12 backend E2E test was named and summarized as prompt-to-main proof, but began from a seeded feature. Top-level planner coverage existed separately, but no single E2E proof covered the handoff from top-level prompt/proposal approval into feature-level planning, worker execution, inbox response, verification, and merge train drain.

**Resolution:** `test/integration/prompt-to-main-e2e.test.ts` now drives the full chain in one run:

1. enqueues `top_planner_requested` with a user prompt;
2. scripts the top-level planner to create a milestone and feature proposal;
3. asserts `run-top-planner` reaches `await_approval`;
4. approves the top-level proposal and asserts feature `f-1` exists;
5. runs discuss and research before feature planning;
6. approves the feature-level task plan;
7. executes a worker, answers one `request_help` inbox item, and verifies commit trailer evidence;
8. verifies the feature and runs integration review via `run-integration:${feature.id}`;
9. drains the merge train and asserts `collabControl === 'merged'`.

Focused verification passed:

```bash
npx vitest run test/integration/prompt-to-main-e2e.test.ts --reporter=verbose
```

Result: 1 test passed, 0 failed.

## Integration Flow Review

| Flow | Status | Evidence |
|------|--------|----------|
| TUI/plain prompt to top planner | Wired | Composer/command routing and top planner proposal application tests. |
| Top planner to feature planner to merged main | Satisfied | `test/integration/prompt-to-main-e2e.test.ts` now proves prompt → top planner approval → feature planning → worker/inbox → verify → merge train → merged in one chain. |
| Feature planner to worker/worktree/IPC/inbox/verify/merge train | Satisfied | `test/integration/prompt-to-main-e2e.test.ts` covers this after the top-planner-created feature enters the feature lifecycle. |
| Merge train serialization and verify-before-main | Satisfied | Merge-train integration tests and integration runner behavior. |
| TUI operator-visible golden path | Satisfied | `npm run test:tui:e2e` passes 9/9; golden path covers startup, `/init`, graph, overlay, draft, submit, quit. |
| Crash recovery and orphan worktree UX | Satisfied | Phase 9 recovery summaries and tests cover recovery/orphan inbox behavior. |
| Docs/explain/source install | Satisfied | Phase 11 explain/docs work and Phase 12 fresh-clone source-install dry-run evidence. |

## Phase Verification Inputs

The current planning tree contains 42 `*-SUMMARY.md` files and 0 standalone `*-VERIFICATION.md` files. Earlier phase execution recorded verification results inside summaries rather than separate verification artifacts. This audit therefore uses:

1. `.planning/REQUIREMENTS.md` traceability status.
2. Phase `*-SUMMARY.md` frontmatter and verification sections.
3. Integration checker review of cross-phase wiring and key tests.
4. Phase `*-VALIDATION.md` files where present.
5. The post-audit focused prompt-to-main E2E proof update.

This artifact-shape mismatch is not treated as a blocker because the roadmap and state files consistently record all phases complete, but future milestone audits should prefer standalone verification reports for every phase.

## Nyquist Coverage

Nyquist validation is enabled in `.planning/config.json`. Validation files exist for late audit/planning slices only:

| Phase/Slice | VALIDATION.md | Audit classification |
|-------------|---------------|----------------------|
| 11-02 | Present | Partial |
| 12-01 | Present | Partial |
| 12-02 | Present | Partial |
| 12-03 | Present | Partial |
| Earlier phases | Missing | Missing |

This is discovery-only and does not change the primary milestone verdict because the core prompt-to-main proof gap is now closed.

## Tech Debt and Deferred Items

Non-blocking items already recorded in `.planning/STATE.md`:

- Phase 4 perf smoke default tier remains gated behind `LOAD_TEST=1`.
- Phase 4 AST boundary walker remains narrowed to `compose.ts + agents/runtime.ts`.
- `GVC_ASSERT_TICK_BOUNDARY` remains off by default in CI.
- Merge-train throughput optimizations are deferred to v2.
- Release packaging/global distribution is deferred to v2.

Additional audit concerns:

- TUI E2E smoke is intentionally shallow and does not run backend execution/merge.
- Verify-agent flake audit uses deterministic faux-provider responses rather than live-provider variability.

## Conclusion

The milestone passes. v1 has phase-level completion evidence, requirement traceability, source-install/TUI smoke evidence, and a single deterministic non-TUI proof for the core “one prompt to merged main” flow.
