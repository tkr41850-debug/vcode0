---
phase: 05
plan: 03
subsystem: feature-lifecycle
tags:
  - verify-agent
  - git-diff
  - prompt-contract
  - verification-summary
  - payload-persistence
requires:
  - 05-02 (feature-lifecycle fixture + real worktree conventions)
provides:
  - git-backed `getChangedFiles({ featureId?, baseRef? })` backed by `git diff --name-only ${baseRef}...HEAD`
  - verify prompt `Changed Files` block plus empty-diff instruction
  - direct `submitVerify` contract tests and verify payload persistence coverage
  - persisted `VerificationSummary` on both direct runtime and scheduler-driven completion paths
affects:
  - 05-04 (repair-loop routing now receives persisted verify payloads/issues)
  - 06 (merge-train can reuse `getChangedFiles(baseRef)` against non-`main` refs)
tech-stack-added:
  - simple-git-backed feature diff inspection in the feature-phase host
patterns:
  - derive feature worktree path from `path.resolve(projectRoot, worktreePath(feature.featureBranch))`; there is no stored `feature.worktreeDir`
  - make `renderPrompt(...)` async when prompt inputs depend on git state
  - persist `VerificationSummary` into `AgentRun.payloadJson` in both runtime and scheduler paths
  - use temp git repos in verify/summarize tests whenever a phase tool calls git
key-files:
  created:
    - test/unit/agents/verify-contract.test.ts
  modified:
    - src/agents/tools/types.ts
    - src/agents/tools/schemas.ts
    - src/agents/tools/feature-phase-host.ts
    - src/agents/tools/agent-toolset.ts
    - src/agents/runtime.ts
    - src/agents/prompts/verify.ts
    - src/orchestrator/scheduler/events.ts
    - test/unit/agents/runtime.test.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/integration/feature-phase-agent-flow.test.ts
decisions:
  - The feature worktree location is derived, not stored: `path.resolve(projectRoot, worktreePath(feature.featureBranch))`.
  - The verify prompt renders `Changed Files` between `Plan Summary` and `Execution Evidence` to keep diff context adjacent to planning intent.
  - `renderPrompt` is async and all three callers (`runTextPhase`, `runProposalPhase`, `runVerifyPhase`) now `await` it.
  - The verify prompt surface is ref-agnostic; `baseRef` defaults to `main` now but is reusable by Phase 6 merge-train flows.
metrics:
  duration: ~2h including validation/debug fixes
  completed: 2026-04-24
---

# Phase 5 Plan 03: Verify-Agent Hardening Summary

Hardened the verify phase so it reviews the real feature-branch diff instead of task-result unions, renders diff context explicitly in the prompt, and persists the structured `VerificationSummary` all the way through `AgentRun.payloadJson`.

## What landed

### 1. Git-backed `getChangedFiles`

`src/agents/tools/feature-phase-host.ts` now resolves the current feature, derives its worktree as:

- `path.resolve(projectRoot, worktreePath(feature.featureBranch))`

and runs:

- `simpleGit(worktreeDir).raw(['diff', '--name-only', `${baseRef}...HEAD`])`

The tool now returns parsed git diff output instead of unioning `task.result.filesChanged`. `baseRef` is optional and defaults to `'main'`.

Supporting surface changes:

- `src/agents/tools/types.ts` adds `baseRef?: string` to `GetChangedFilesOptions`
- `src/agents/tools/schemas.ts` adds `baseRef: Type.Optional(Type.String())`
- `src/agents/tools/agent-toolset.ts` now `await`s `host.getChangedFiles(...)`

### 2. Verify prompt diff context

`src/agents/runtime.ts` now computes changed files during verify prompt rendering and threads a `changedFiles` string into the template.

`renderPrompt(...)` is now async, and all three call sites were updated to await it:

- `runTextPhase(...)`
- `runProposalPhase(...)`
- `runVerifyPhase(...)`

`src/agents/prompts/verify.ts` now renders:

1. `Success Criteria`
2. `Plan Summary`
3. `Changed Files`
4. `Execution Evidence`
5. `Verification Results`
6. `Prior Decisions`

When the git diff is empty, runtime renders the exact sentinel text:

- `No changes on feature branch vs base.`

and the static verify doctrine now explicitly instructs the agent to raise a blocking issue and submit `repair_needed` in that situation.

### 3. Verify payload persistence

The original plan assumption that verify output already round-tripped to `AgentRun.payloadJson` was false for direct runtime calls.

That gap is now closed in both paths:

- `src/agents/runtime.ts` writes `payloadJson: JSON.stringify(verification)` immediately after `host.getVerificationSummary()` in `runVerifyPhase(...)`
- `src/orchestrator/scheduler/events.ts` writes the same payload when handling `feature_phase_complete` for `phase === 'verify'`

Result: both direct `runtime.verifyFeature(...)` calls and scheduler-driven feature-phase completion now persist the structured verify verdict.

## Test coverage added/updated

### New unit coverage

`test/unit/agents/verify-contract.test.ts` pins four submit-contract cases:

1. pass verdict records a passing `VerificationSummary`
2. blocking issue + `repair_needed` verdict records issues
3. missing `submitVerify` throws from verify completion
4. blocking issue + claimed `pass` auto-downgrades to `repair_needed`

### Updated unit coverage

`test/unit/agents/runtime.test.ts` now uses temp git repos for verify/summarize cases that call `getChangedFiles`, and the verify prompt-capture assertion now checks for:

- `### Changed Files`
- `- src/feature.ts`

A test-local timeout was raised for the summarize inspection case after it began using a real git repo instead of the old `/repo` placeholder.

`test/unit/orchestrator/scheduler-loop.test.ts` was updated to expect the new verify payload persistence on run completion.

### Updated integration coverage

`test/integration/feature-phase-agent-flow.test.ts` now:

- accepts a real `projectRoot` in the fixture
- derives feature worktree paths from `projectRoot + worktreePath(feature.featureBranch)`
- initializes real temp git repos for verify scenarios
- covers the empty-diff verify path
- asserts `VerificationSummary` persistence by parsing `AgentRun.payloadJson`

## Validation results

Validated with scoped 05-03 checks:

- `npm run typecheck` ✅
- `npx vitest run test/unit/agents/runtime.test.ts test/unit/agents/verify-contract.test.ts` ✅
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "moves verify success through merge_queued into integrating"` ✅
- `npx vitest run test/integration/feature-phase-agent-flow.test.ts` ✅ (13/13)

## Deviations and fixes

### 1. Verify prompt parser break from raw backticks

The new empty-diff doctrine line initially embedded raw backticks inside the `VERIFY_PROMPT` template literal:

- ``submit verdict `repair_needed` ...``

That broke parsing in `src/agents/prompts/verify.ts`. Fixed by escaping the inner backticks.

### 2. Scheduler verify test expectation drift

Once verify payload persistence was added in `events.ts`, `test/unit/orchestrator/scheduler-loop.test.ts` still expected only `{ runStatus, owner }`. The test was updated to expect the persisted payload JSON as well.

### 3. JSON-string-order brittleness in integration assertions

One integration assertion compared the raw `payloadJson` string and failed on key-order differences. Fixed by parsing the JSON and using `toMatchObject(...)` instead.

### 4. Real-git test cost exposed a timeout

After summarize/verify tests began using real temp repos, the summarize inspection unit case became tight against Vitest's default 5s timeout. Fixed with a test-local `20_000` ms timeout.

## Non-obvious decisions

1. **Worktree path derivation:** the feature record does not carry a worktree-dir field, so the canonical source of truth is `projectRoot + worktreePath(feature.featureBranch)`. This matches existing production usage in verification/worktree code.
2. **Prompt block ordering:** `Changed Files` sits between `Plan Summary` and `Execution Evidence`, not after all evidence blocks, so the verifier can compare planned intent against the actual diff before reading execution narration.
3. **No empty-diff short-circuit:** runtime still runs the verify agent on empty diff; the agent is instructed to emit the repair verdict rather than the orchestrator bypassing the phase.
4. **Phase 6 handoff:** `getChangedFiles(baseRef)` is intentionally ref-agnostic and ready for merge-train verification against refs other than `main`.

## Commits

None yet. The plan is implemented and validated in the working tree; commit slicing was not requested in this session.

## Self-check: PASSED

- [x] `getChangedFiles` is git-backed and accepts optional `baseRef`
- [x] verify prompt renders `Changed Files` between `Plan Summary` and `Execution Evidence`
- [x] empty-diff prompt renders `No changes on feature branch vs base.` and instructs `repair_needed`
- [x] `renderPrompt` is async and all three callers await it
- [x] `submitVerify` pass / repair_needed / missing-submit / auto-downgrade cases are pinned in unit tests
- [x] `VerificationSummary` persists to `AgentRun.payloadJson` on both runtime and scheduler completion paths
- [x] scoped typecheck + unit + integration validation passed
