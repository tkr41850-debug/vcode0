---
milestone: v1
audited: 2026-05-03
status: gaps_found
scores:
  requirements: 36/37
  phases: 12/12
  integration: 6/7
  flows: 6/7
gaps:
  requirements:
    - id: "REQ-PLAN-01"
      status: "partial"
      phase: "12-integration-polish"
      claimed_by_plans:
        - ".planning/phases/12-integration-polish/12-01-SUMMARY.md"
        - ".planning/REQUIREMENTS.md"
      completed_by_plans:
        - ".planning/phases/12-integration-polish/12-01-SUMMARY.md"
        - ".planning/phases/12-integration-polish/12-03-SUMMARY.md"
      verification_status: "partial"
      evidence: "The claimed prompt-to-main E2E starts from fixture.seedFeature('f-p2m') instead of a user prompt/top_planner_requested event; top-level planner coverage is separate and stops after proposal application."
  integration:
    - flow: "prompt/top-planner to main"
      status: "partial"
      affected_requirements:
        - "REQ-PLAN-01"
        - "REQ-PLAN-02"
        - "REQ-EXEC-01"
        - "REQ-INBOX-01"
        - "REQ-MERGE-01"
        - "REQ-MERGE-02"
        - "REQ-MERGE-04"
      evidence: "test/integration/prompt-to-main-e2e.test.ts:81 seeds a feature directly; test/integration/feature-phase-agent-flow.test.ts:770 covers top-level planner proposal application separately."
  flows:
    - name: "one prompt to merged main"
      breaks_at: "handoff between top-level planner proposal approval and feature-level planning/execution in a single E2E run"
      evidence: "No single test starts with a top-level user prompt, accepts the created feature proposal, runs feature planning, executes a worker, answers inbox help, verifies, and drains the merge train to merged."
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

**Status:** gaps_found
**Audited:** 2026-05-03

The v1 roadmap is implementation-complete, but the milestone audit found one integration-evidence gap in the core value claim: the strongest claimed prompt-to-main proof does not start from an actual top-level prompt/top-planner event in the same E2E chain.

## Scores

| Area | Score | Status |
|------|-------|--------|
| Requirements | 36/37 | Gap: REQ-PLAN-01 is integration-partial |
| Phases | 12/12 | Complete |
| Integration | 6/7 | One prompt-to-main handoff gap |
| Flows | 6/7 | One prompt-to-main proof gap |

## Requirement Coverage

`.planning/REQUIREMENTS.md` marks all 37 v1 requirements complete and all traceability rows cite shipped evidence. The audit accepts those rows as phase-level completion evidence except for the cross-phase proof of `REQ-PLAN-01` in the full prompt-to-main lifecycle.

| Requirement | Audit Status | Evidence |
|-------------|--------------|----------|
| REQ-PLAN-01 | Partial | Top-level planner is wired and covered separately, but the Phase 12 prompt-to-main E2E seeds a feature directly instead of starting from top-planner prompt/proposal approval. |
| Remaining 36 v1 requirements | Satisfied | Requirements traceability table, phase summaries, focused integration tests, TUI smoke, and source-install dry-run evidence. |

## Critical Gap

### GAP-01: Full “one prompt to merged main” E2E is not proven in one chain

**Affected requirements:** REQ-PLAN-01, REQ-PLAN-02, REQ-EXEC-01, REQ-INBOX-01, REQ-MERGE-01, REQ-MERGE-02, REQ-MERGE-04

**Finding:** The Phase 12 backend E2E test is named and summarized as prompt-to-main proof, but it begins from a seeded feature:

- `test/integration/prompt-to-main-e2e.test.ts:81` — test title claims planner proposal, approval, inbox help, verify, and merge.
- `test/integration/prompt-to-main-e2e.test.ts:88` — `fixture.seedFeature('f-p2m', ...)` creates the feature directly.

Top-level planner coverage exists, but separately:

- `test/integration/feature-phase-agent-flow.test.ts:770` — dispatches a top-level planner proposal into `await_approval` and applies it.
- That test validates proposal application and task creation, but it does not continue into worker execution, inbox response, verification, and merge train drain.

**Why this blocks audit pass:** The milestone core value is “from one prompt, orchestrate parallel autonomous coding that lands on main.” The shipped pieces appear wired, but no single E2E proof covers the handoff from top-level prompt/proposal approval into the feature-level planning/execution/merge chain.

**Recommended gap closure:** Add one true E2E test that starts with a top-level user prompt or `top_planner_requested`, accepts the top-level proposal that creates/edits a feature, lets that feature enter feature-level planning, executes at least one task with an inbox answer, verifies, drains the merge train, and asserts the feature reaches `collabControl === 'merged'`.

## Integration Flow Review

| Flow | Status | Evidence |
|------|--------|----------|
| TUI/plain prompt to top planner | Wired | Composer/command routing and top planner proposal application tests. |
| Top planner to feature planner to merged main | Partial | Covered only as separated tests; no single-chain proof. |
| Feature planner to worker/worktree/IPC/inbox/verify/merge train | Satisfied | `test/integration/prompt-to-main-e2e.test.ts` covers this after direct feature seeding. |
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

This is discovery-only and does not change the primary blocker: the prompt-to-main E2E proof gap.

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

The milestone is functionally close, and most cross-phase wiring appears connected, but the audit cannot mark v1 as fully passed while the main “one prompt to merged main” proof skips the top-level prompt/top-planner handoff.

**Next action:** plan and execute one gap-closure slice for the true top-planner-to-main E2E proof.
