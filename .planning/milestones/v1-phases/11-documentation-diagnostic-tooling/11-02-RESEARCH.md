# Phase 11 Plan 11-02: Documentation Drift Check + Canonical State/Flow Docs - Research

**Researched:** 2026-05-02
**Domain:** documentation/code drift checking, canonical state/execution-flow docs, coordination decision tables
**Confidence:** HIGH for codebase findings; MEDIUM for implementation estimates

## User Constraints

### Locked Decisions
- Phase 11 is Documentation & Diagnostic Tooling. [VERIFIED: user prompt]
- Plan 11-02 goal is doc-vs-code drift check + state diagram update + coordination/execution-flow decision-table consolidation. [VERIFIED: user prompt]
- 11-01 already shipped a read-only `gvc0 explain feature|task|run <id>` CLI using `src/main.ts`, `src/compose.ts`, `src/persistence/db.ts`, and `src/tui/view-model/index.ts`. [VERIFIED: user prompt][VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md][VERIFIED: src/main.ts][VERIFIED: src/compose.ts]
- Remaining Phase 11 success criteria: docs must match shipped behavior, doc-vs-code drift check in CI, and canonical state/execution-flow/coordination docs must align with the shipped work/collab/run model. [VERIFIED: user prompt]

### Claude's Discretion
- Choose the drift-check implementation approach, exact files to update, and verification strategy, as long as they satisfy the locked 11-02 goal. [VERIFIED: user prompt]

### Deferred Ideas (OUT OF SCOPE)
- No deferred ideas were provided for 11-02. [VERIFIED: user prompt]

## Project Constraints (from CLAUDE.md)

- The repo is a single root TypeScript package, not a monorepo. [VERIFIED: CLAUDE.md]
- Boundaries under `src/` use TypeScript path aliases: `@app/*`, `@core/*`, `@orchestrator/*`, `@agents/*`, `@runtime/*`, `@persistence/*`, and `@tui/*`. [VERIFIED: CLAUDE.md][VERIFIED: tsconfig.json]
- `@core/*` owns pure domain logic and must not depend on runtime, persistence, TUI, orchestrator, agents, or app layers. [VERIFIED: CLAUDE.md][VERIFIED: biome.json][VERIFIED: test/unit/core/boundary.test.ts]
- Work progress is tracked through feature work control; branch/merge/conflict coordination is tracked separately through collaboration control; transient retry/help/approval/manual details live on `agent_runs`, not task enums. [VERIFIED: CLAUDE.md][VERIFIED: ARCHITECTURE.md]
- Documentation work should use the landing pages and canonical topic structure rather than turning one root file into a full catalog. [VERIFIED: CLAUDE.md][VERIFIED: docs/README.md][VERIFIED: docs/foundations/README.md]
- Read `ARCHITECTURE.md` first for big picture, then `docs/README.md` and relevant section README/topic pages. [VERIFIED: CLAUDE.md]
- Tests use Vitest under `test/unit/**` and `test/integration/**`; TUI E2E uses a separate `@microsoft/tui-test` lane excluded from Vitest. [VERIFIED: CLAUDE.md][VERIFIED: vitest.config.ts][VERIFIED: docs/operations/testing.md]
- Before committing implementation work, run `npm run check:fix`, then `npm run check`; use conventional commits. [VERIFIED: CLAUDE.md]

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-DOC-01 | Execution flow is documented end-to-end with one canonical flow diagram. [VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-RESEARCH.md][VERIFIED: docs/foundations/execution-flow.md] | 11-02 should update `docs/foundations/execution-flow.md` and cross-reference `docs/architecture/worker-model.md` / `docs/operations/verification-and-recovery.md` so queue, feature-phase, task-run, merge-train, and explain diagnostics align with shipped behavior. [VERIFIED: docs/foundations/execution-flow.md][VERIFIED: docs/architecture/worker-model.md][VERIFIED: docs/operations/verification-and-recovery.md][VERIFIED: src/main.ts][VERIFIED: src/compose.ts] |
| REQ-DOC-02 | State shape is documented with one canonical three-axis diagram. [VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-RESEARCH.md][VERIFIED: docs/foundations/state-axes.md] | The current state doc omits checkpointed wait states from the run diagram/matrix summary even though code and tests include them, so 11-02 should regenerate/check state docs from `src/core/fsm/index.ts` constants and `test/unit/core/fsm/*` expectations. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: src/core/fsm/index.ts][VERIFIED: src/core/types/runs.ts][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts][VERIFIED: test/unit/core/fsm/run-state-axis.test.ts] |
| REQ-DOC-03 | Coordination semantics are documented with decision tables, not prose. [VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-RESEARCH.md][VERIFIED: docs/foundations/coordination-rules.md] | `docs/foundations/coordination-rules.md` already has tables, but several rows/source-of-truth pointers should be reconciled against current merge-train, verification-config, and cross-feature blocking code before CI drift checks lock them in. [VERIFIED: docs/foundations/coordination-rules.md][VERIFIED: src/core/merge-train/index.ts][VERIFIED: src/config/verification-layer.ts][VERIFIED: src/orchestrator/conflicts/cross-feature.ts] |
| REQ-DOC-04 | Doc-vs-code drift check runs in CI / standard verification. [VERIFIED: user prompt] | There is no existing docs drift test file; add a Vitest unit test that reads canonical docs and compares protected blocks / literals against exported code constants or source-derived values, so it runs under `npm run test` and therefore `npm run check`. [VERIFIED: package.json][VERIFIED: vitest.config.ts][VERIFIED: test/unit/core/warnings/rule-shapes.test.ts][VERIFIED: test/unit/core/boundary.test.ts] |

</phase_requirements>

## Summary

Plan 11-02 should be treated as a code-backed documentation hardening slice, not a pure prose cleanup. [VERIFIED: user prompt][VERIFIED: package.json] The repo already has a `docs/foundations/` layer that declares `state-axes.md`, `execution-flow.md`, and `coordination-rules.md` canonical, and it already states that foundation tables win over prose when they disagree. [VERIFIED: docs/foundations/README.md] The gap is that the canonical docs are not currently enforced by tests, while 11-01 added a shipped explain CLI that makes work/collab/run state visible to users. [VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md][VERIFIED: src/main.ts][VERIFIED: src/compose.ts]

The highest-value implementation is a small doc-drift test suite under Vitest plus targeted documentation edits. [ASSUMED] The test should not parse all Markdown semantically; it should protect the load-bearing claims most likely to drift: axis value lists, run-state transitions, composite-matrix count/header, explain CLI command list, verification-layer behavior, and coordination decision-table source anchors. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: docs/foundations/execution-flow.md][VERIFIED: docs/foundations/coordination-rules.md][VERIFIED: docs/reference/tui.md][VERIFIED: src/core/fsm/index.ts][VERIFIED: src/core/types/runs.ts][VERIFIED: src/config/verification-layer.ts]

**Primary recommendation:** add `test/unit/docs/drift.test.ts` that checks canonical docs against code-derived constants and protected Markdown markers, then update `docs/foundations/state-axes.md`, `docs/foundations/execution-flow.md`, `docs/foundations/coordination-rules.md`, `docs/operations/verification-and-recovery.md`, `docs/architecture/data-model.md`, and `docs/reference/tui.md` until the drift test and full `npm run check` pass. [VERIFIED: package.json][VERIFIED: vitest.config.ts][VERIFIED: docs/foundations/README.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Doc-vs-code drift guard | `test/unit/docs/` | `src/core/*`, `src/config/*`, `src/main.ts`, `src/compose.ts` | Vitest unit tests already run in `npm run test` and `npm run check`; docs checks can import code constants and read Markdown without adding a new runner. [VERIFIED: package.json][VERIFIED: vitest.config.ts] |
| Canonical state diagram/matrix | `docs/foundations/state-axes.md` | `src/core/fsm/index.ts`, `src/core/types/runs.ts`, `test/unit/core/fsm/*` | The foundation README makes `state-axes.md` canonical, while `compositeGuard` and FSM tests are the executable source of truth. [VERIFIED: docs/foundations/README.md][VERIFIED: docs/foundations/state-axes.md][VERIFIED: src/core/fsm/index.ts][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts] |
| End-to-end execution-flow summary | `docs/foundations/execution-flow.md` | `docs/architecture/worker-model.md`, `docs/operations/verification-and-recovery.md`, `src/orchestrator/scheduler/*` | The foundation flow doc is the canonical summary; detail references should remain in architecture/operations docs. [VERIFIED: docs/foundations/README.md][VERIFIED: docs/foundations/execution-flow.md] |
| Coordination decision tables | `docs/foundations/coordination-rules.md` | `docs/operations/conflict-coordination.md`, `src/core/merge-train/index.ts`, `src/orchestrator/conflicts/cross-feature.ts` | Foundation decision tables are declared authoritative, and the operations page is narrative reference that must match the tables. [VERIFIED: docs/foundations/coordination-rules.md][VERIFIED: docs/operations/conflict-coordination.md] |
| User-facing diagnostic CLI docs | `docs/reference/tui.md` or new reference subsection | `src/main.ts`, `src/compose.ts`, `.planning/.../11-01-SUMMARY.md` | `gvc0 explain` is a non-TUI command shipped in 11-01; current reference docs list only `gvc0`, `gvc0 --auto`, and `gvc0 --cwd`. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts][VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md] |
| CI integration | existing `npm run check` path | package scripts only if needed | `npm run check` already runs formatting, lint, typecheck, and Vitest; a Vitest doc test joins CI without script changes. [VERIFIED: package.json][VERIFIED: vitest.config.ts] |

## Current Drift Risks

### Risk 1: `state-axes.md` undercounts the run axis and omits checkpointed waits

`src/core/types/runs.ts` defines `AgentRunStatus` values `checkpointed_await_response` and `checkpointed_await_approval`. [VERIFIED: src/core/types/runs.ts] `src/core/fsm/index.ts` allows transitions from live waits to checkpointed waits and back to `ready` / `running` / `cancelled`. [VERIFIED: src/core/fsm/index.ts] `test/unit/core/fsm/run-state-axis.test.ts` covers those transitions. [VERIFIED: test/unit/core/fsm/run-state-axis.test.ts]

`docs/foundations/state-axes.md` currently shows the run diagram with only `ready`, `running`, `retry_await`, `await_response`, `await_approval`, `completed`, `failed`, and `cancelled`, omitting the checkpointed wait statuses. [VERIFIED: docs/foundations/state-axes.md] The same doc says the composite matrix domains are 10 work values × 7 collab values × 6 run values = 420 combinations, while `test/unit/core/fsm/composite-invariants.test.ts` enumerates 10 × 7 × 8 = 560 combinations including checkpointed waits and `completed`. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts]

**Impact:** readers and future planners may treat checkpointed waits as implementation detail rather than part of the shipped run model. [ASSUMED]

### Risk 2: coordination rebase table conflicts with current failure routing

`docs/foundations/coordination-rules.md` says an `integrating` rebase conflict moves collab to `conflict` and injects conflict steering on the feature branch. [VERIFIED: docs/foundations/coordination-rules.md] The same table says clean rebase plus `ci_check` or `verify` fail moves collab to `branch_open` and work to `replanning`. [VERIFIED: docs/foundations/coordination-rules.md] Elsewhere, `docs/operations/verification-and-recovery.md` says integration rebase failure ejects from the merge queue and moves work control to `replanning` with `VerifyIssue[] source: 'rebase'`. [VERIFIED: docs/operations/verification-and-recovery.md]

Current code has `MergeTrainCoordinator.ejectFromQueue(...)` transition collab to `branch_open` and increment `mergeTrainReentryCount`; it does not transition to `conflict`. [VERIFIED: src/core/merge-train/index.ts] Current verification config code also supports a `mergeTrain` verification layer alias/fallback, which conflicts with operations prose that says there is no separate `verification.mergeTrain` layer. [VERIFIED: src/config/verification-layer.ts][VERIFIED: src/config/schema.ts][VERIFIED: docs/operations/verification-and-recovery.md]

**Impact:** the docs currently mix older conflict-steering language with the shipped replanning/ejection path, making implementation of the drift test likely to expose failing rows until the table is consolidated. [VERIFIED: docs/foundations/coordination-rules.md][VERIFIED: docs/operations/verification-and-recovery.md][VERIFIED: src/core/merge-train/index.ts]

### Risk 3: architecture data model includes fields/types that do not match shipped TypeScript

`docs/architecture/data-model.md` documents `Feature.mainMergeSha`, `Feature.branchHeadSha`, and `Task.branchHeadSha`. [VERIFIED: docs/architecture/data-model.md] The shipped `Feature` and `Task` interfaces in `src/core/types/domain.ts` do not include those fields. [VERIFIED: src/core/types/domain.ts]

`docs/architecture/data-model.md` documents `VerifyIssue` as a discriminated union with `source: 'verify' | 'ci_check' | 'rebase'`. [VERIFIED: docs/architecture/data-model.md] The shipped `VerifyIssue` interface in `src/core/types/verification.ts` currently has `id`, `severity`, `description`, optional `location`, and optional `suggestedFix`, without a `source` discriminator. [VERIFIED: src/core/types/verification.ts]

**Impact:** users consulting data-model docs for repair/reroute semantics will see a richer schema than the code currently enforces. [ASSUMED]

### Risk 4: TUI/reference docs lag shipped UI and CLI surfaces

`docs/reference/tui.md` lists current app surfaces as milestone/feature/task DAG tree, status bar, composer status strip, composer input, help overlay, dependency-detail overlay, and agent-monitor overlay. [VERIFIED: docs/reference/tui.md] Code includes merge-train overlay wiring and view-models. [VERIFIED: src/tui/app.ts][VERIFIED: src/tui/app-overlays.ts][VERIFIED: src/tui/view-model/index.ts] The reference entry-point list omits `gvc0 explain feature|task|run <id>`, shipped in 11-01. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts][VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md]

**Impact:** the reference page is no longer safe as a user-facing command inventory. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts]

### Risk 5: docs do not currently fail CI when canonical state literals drift

`package.json` runs `vitest run` through `npm run test`, and `npm run check` runs `npm run test`. [VERIFIED: package.json] `vitest.config.ts` includes unit and integration tests but excludes TUI E2E. [VERIFIED: vitest.config.ts] No existing `test/unit/docs/*` or docs drift test was found. [VERIFIED: repository search]

**Impact:** future changes to `AgentRunStatus`, `FeatureWorkControl`, `FeatureCollabControl`, verification-layer config, or explain CLI usage can drift from docs without breaking CI. [ASSUMED]

## Standard Stack

### Core

| Library / Tool | Project Version | Current Registry Version | Purpose | Why Standard |
|----------------|-----------------|--------------------------|---------|--------------|
| Vitest | 4.1.4 [VERIFIED: package.json][VERIFIED: local `npx vitest --version`] | 4.1.5, modified 2026-04-23 [VERIFIED: npm registry] | Unit-level doc drift checks | Already configured, included in `npm run test`, and can import TS modules plus read Markdown files. [VERIFIED: vitest.config.ts][VERIFIED: package.json] |
| TypeScript | 5.9.3 [VERIFIED: package.json][VERIFIED: local `npx tsc --version`] | 6.0.3, modified 2026-04-16 [VERIFIED: npm registry] | Typed imports for code-derived expected values | Existing strict TS config and path aliases support doc tests without new build tooling. [VERIFIED: tsconfig.json] |
| Node.js `fs` / `path` | Node 24.13.0 local [VERIFIED: local `node --version`] | Built-in [VERIFIED: Node runtime] | Read Markdown and source files in tests | Existing tests already use `readFileSync`, `readdirSync`, and `statSync` for structural checks. [VERIFIED: test/unit/core/warnings/rule-shapes.test.ts][VERIFIED: test/unit/core/boundary.test.ts] |
| Biome | 2.4.10 [VERIFIED: package.json][VERIFIED: biome.json] | 2.4.14, modified 2026-05-01 [VERIFIED: npm registry] | Formatting/lint gate for test/docs edits | Already used by `npm run check:fix`, `format:check`, and `lint`. [VERIFIED: package.json][VERIFIED: biome.json] |

### Supporting

| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `markdown-table` | 3.0.4 current, modified 2024-10-22 [VERIFIED: npm registry] | Generate Markdown tables | Do **not** add for 11-02 unless table generation becomes complex; simple string generation is enough for small protected blocks. [ASSUMED] |
| `mdast-util-from-markdown` | 2.0.3 current, modified 2026-02-21 [VERIFIED: npm registry] | Parse Markdown AST | Avoid for 11-02 unless semantic Markdown parsing is required; regex/protected-block extraction is lower dependency cost for canonical blocks. [ASSUMED] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Vitest doc tests | A standalone `scripts/check-doc-drift.ts` invoked from a new npm script | A standalone script is fine but adds a new CI command and duplicate assertion/reporting behavior; Vitest already runs in `npm run check`. [VERIFIED: package.json][VERIFIED: vitest.config.ts] |
| Direct Markdown protected-block checks | Full Markdown AST parsing | AST parsing reduces regex fragility but adds a dependency and still needs custom semantic assertions. [ASSUMED] |
| Code-generated docs committed wholesale | Targeted docs plus drift assertions | Full generation keeps docs exact but can make diagrams/tables less readable and larger; targeted generation protects only load-bearing snippets. [ASSUMED] |

**Installation:** no new package installation is recommended. [VERIFIED: package.json]

**Version verification:** package versions were checked via `npm view vitest version time.modified`, `npm view typescript version time.modified`, `npm view @biomejs/biome version time.modified`, `npm view markdown-table version time.modified`, and `npm view mdast-util-from-markdown version time.modified`. [VERIFIED: npm registry]

## Architecture Patterns

### System Architecture Diagram

```text
Source constants and shipped behavior
  ├─ src/core/types/runs.ts (AgentRunStatus)
  ├─ src/core/fsm/index.ts (transition guards + compositeGuard)
  ├─ src/core/merge-train/index.ts (queue/eject/reentry behavior)
  ├─ src/config/verification-layer.ts (verification layer fallback)
  ├─ src/main.ts + src/compose.ts (explain CLI)
  └─ src/tui/view-model/index.ts (shared human-readable summaries)
        │
        ▼
Vitest doc drift tests (test/unit/docs/drift.test.ts)
  ├─ import or source-read code truth
  ├─ read canonical Markdown files
  ├─ extract protected snippets / assert required literals
  └─ fail with actionable message naming stale doc and expected value
        │
        ▼
Documentation updates
  ├─ docs/foundations/state-axes.md
  ├─ docs/foundations/execution-flow.md
  ├─ docs/foundations/coordination-rules.md
  ├─ docs/architecture/data-model.md
  ├─ docs/operations/verification-and-recovery.md
  └─ docs/reference/tui.md
        │
        ▼
CI gate
  npm run check → format/lint/typecheck/test → doc drift test green
```

### Recommended Project Structure

```text
test/unit/docs/
└── drift.test.ts          # code-backed docs drift assertions

docs/foundations/
├── state-axes.md          # canonical work/collab/run diagrams + matrix summary
├── execution-flow.md      # canonical flow diagram/sequence summary
└── coordination-rules.md  # canonical coordination decision tables
```

### Pattern 1: Protected Markdown Blocks for Generated/Checked Tables

**What:** Use comments such as `<!-- BEGIN RUN STATE TRANSITIONS -->` / `<!-- END RUN STATE TRANSITIONS -->` around the few snippets the test owns, then assert the exact block contents or exact required rows. [ASSUMED]

**When to use:** Use for state-axis transition tables, composite-matrix summary counts, and command inventory blocks where code-derived literals should stay exact. [ASSUMED]

**Example:**

```typescript
// Source pattern: existing source-file structural tests read project files directly.
// [VERIFIED: test/unit/core/warnings/rule-shapes.test.ts]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string): string {
  return readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8');
}

describe('documentation drift', () => {
  it('documents checkpointed run wait states', () => {
    const doc = readRepoFile('docs/foundations/state-axes.md');
    expect(doc).toContain('checkpointed_await_response');
    expect(doc).toContain('checkpointed_await_approval');
  });
});
```

### Pattern 2: Import Types/Constants Where Exported, Source-Read Where Not Exported

**What:** Prefer importing exported functions/types for behavior checks; use source text checks only for non-exported constants or Markdown content. [VERIFIED: test/unit/core/boundary.test.ts][VERIFIED: test/unit/core/warnings/rule-shapes.test.ts]

**When to use:** `validateRunStateTransition(...)` and `compositeGuard(...)` are exported and can be called directly; private transition maps inside `src/core/fsm/index.ts` are not exported and should not be exported only for docs. [VERIFIED: src/core/fsm/index.ts]

### Pattern 3: Drift Tests Should Fail with the Doc File Name and Missing Literal

**What:** Assertion messages should name the stale doc path and expected literal/row. [ASSUMED]

**When to use:** All doc drift assertions; otherwise failures become hard to interpret when many Markdown files are read. [ASSUMED]

### Anti-Patterns to Avoid

- **Parsing every Markdown table generically:** Generic table parsers are more work than the phase needs and can make tests brittle to formatting. Protect only load-bearing snippets. [ASSUMED]
- **Duplicating FSM truth in docs tests:** Tests should derive expected legality from `compositeGuard(...)` or import known code values where possible, not copy a second independent FSM. [VERIFIED: src/core/fsm/index.ts]
- **Adding a new docs-only dependency prematurely:** Built-in Node file reads and Vitest assertions are enough for the target drift checks. [VERIFIED: package.json][ASSUMED]
- **Updating docs to match aspirational architecture instead of shipped code:** The user explicitly asked for docs to match shipped behavior. [VERIFIED: user prompt]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CI integration for doc checks | Custom shell runner or bespoke test harness | Vitest unit test under `test/unit/docs/` | Already included in `npm run test` / `npm run check`, with TS path aliases configured. [VERIFIED: package.json][VERIFIED: vitest.config.ts] |
| State legality truth | Hand-written doc-only matrix logic | `compositeGuard(...)` and existing FSM tests | The executable guard is the code truth and already has exhaustive unit coverage. [VERIFIED: src/core/fsm/index.ts][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts] |
| Explain command inventory | Manual prose only | Assertions against `src/main.ts` behavior and docs containing `gvc0 explain feature|task|run <id>` | 11-01 shipped parser behavior and unit tests for explain dispatch. [VERIFIED: src/main.ts][VERIFIED: test/unit/tui/main.test.ts] |
| Verification-layer documentation | A new config resolver | Existing `resolveVerificationLayerConfig(...)` | Current code already documents and implements `mergeTrain → feature → empty defaults`. [VERIFIED: src/config/verification-layer.ts] |

**Key insight:** 11-02 should make docs drift mechanically visible, not just manually corrected once. [VERIFIED: user prompt][ASSUMED]

## Common Pitfalls

### Pitfall 1: freezing outdated doc claims with tests

**What goes wrong:** The new drift test asserts stale documentation, making wrong behavior harder to fix later. [ASSUMED]
**Why it happens:** Tests are written before reconciling docs against current code. [ASSUMED]
**How to avoid:** First enumerate drift risks, update docs to shipped behavior, then add tests around corrected canonical snippets. [VERIFIED: current research]
**Warning signs:** Tests expect `420` composite combinations or omit checkpointed wait states. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts]

### Pitfall 2: over-testing prose wording

**What goes wrong:** Minor copy edits break CI even when semantics are unchanged. [ASSUMED]
**Why it happens:** Tests compare whole Markdown files or long paragraphs. [ASSUMED]
**How to avoid:** Assert required headings, command literals, table rows, protected block contents, and code-derived counts only. [ASSUMED]
**Warning signs:** A test snapshots all of `docs/foundations/execution-flow.md`. [ASSUMED]

### Pitfall 3: documenting an aspirational merge-train model

**What goes wrong:** Docs continue to say integration failures enter `conflict` or that `verification.mergeTrain` does not exist, while current code ejects to `branch_open` / replan paths and supports `mergeTrain` config fallback. [VERIFIED: docs/foundations/coordination-rules.md][VERIFIED: docs/operations/verification-and-recovery.md][VERIFIED: src/core/merge-train/index.ts][VERIFIED: src/config/verification-layer.ts]
**Why it happens:** Older design docs and newer code evolved separately. [ASSUMED]
**How to avoid:** Treat `src/core/merge-train/index.ts`, `src/config/verification-layer.ts`, scheduler event code, and 11-01 explain output as shipped truth. [VERIFIED: src/core/merge-train/index.ts][VERIFIED: src/config/verification-layer.ts][VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/compose.ts]
**Warning signs:** A decision table row says `integrating -> conflict` for the main integration failure path without matching code support. [VERIFIED: docs/foundations/coordination-rules.md]

### Pitfall 4: adding drift checks outside the standard verification path

**What goes wrong:** CI does not actually run the drift check. [ASSUMED]
**Why it happens:** A custom script is added but not wired into `npm run check`. [ASSUMED]
**How to avoid:** Put drift checks in Vitest under the existing include globs. [VERIFIED: vitest.config.ts][VERIFIED: package.json]
**Warning signs:** New script exists in `package.json`, but `npm run check` does not call it. [VERIFIED: package.json]

## Recommended Implementation Approach

### Step 1: Add a focused doc drift test

Create `test/unit/docs/drift.test.ts`. [ASSUMED]

Recommended assertions:

1. `docs/foundations/state-axes.md` contains every current `AgentRunStatus` literal, including `checkpointed_await_response` and `checkpointed_await_approval`. [VERIFIED: src/core/types/runs.ts][VERIFIED: docs/foundations/state-axes.md]
2. `docs/foundations/state-axes.md` composite matrix summary states the same domain sizes as `test/unit/core/fsm/composite-invariants.test.ts`: 10 work values × 7 collab values × 8 run values = 560 combinations. [VERIFIED: test/unit/core/fsm/composite-invariants.test.ts]
3. Run-state transition documentation includes live-wait → checkpointed-wait and checkpointed-wait → ready/running/cancelled rows. [VERIFIED: src/core/fsm/index.ts][VERIFIED: test/unit/core/fsm/run-state-axis.test.ts]
4. `docs/reference/tui.md` or a linked reference page lists `gvc0 explain feature <id>`, `gvc0 explain task <id>`, and `gvc0 explain run <id>`. [VERIFIED: src/main.ts][VERIFIED: docs/reference/tui.md]
5. Verification docs mention the shipped `mergeTrain` config fallback or remove the contradictory “no separate `verification.mergeTrain` layer” claim. [VERIFIED: src/config/verification-layer.ts][VERIFIED: docs/operations/verification-and-recovery.md]
6. Coordination docs mention `runtimeBlockedByFeatureId` as the feature-level authority and keep task-level `blockedByFeatureId` as reconstruction/UI metadata. [VERIFIED: docs/operations/conflict-coordination.md][VERIFIED: src/core/types/domain.ts][VERIFIED: src/orchestrator/conflicts/cross-feature.ts]

### Step 2: Update canonical foundation docs

- Update `docs/foundations/state-axes.md` run-state diagram to include checkpointed wait states. [VERIFIED: src/core/types/runs.ts][VERIFIED: src/core/fsm/index.ts]
- Update `docs/foundations/state-axes.md` composite matrix summary/count from 420 to 560 and include checkpointed waits in the listed run domain. [VERIFIED: test/unit/core/fsm/composite-invariants.test.ts]
- Consider replacing the full embedded 560-row matrix with a protected generated summary plus a link to the exhaustive test, if line count becomes unwieldy. [ASSUMED]
- Update `docs/foundations/execution-flow.md` to include `gvc0 explain` as a read-only pre-TUI diagnostic branch, separate from app/TUI startup. [VERIFIED: src/main.ts][VERIFIED: src/compose.ts]
- Update `docs/foundations/coordination-rules.md` rebase/integration rows to match shipped merge-train ejection/reentry/replanning behavior. [VERIFIED: src/core/merge-train/index.ts][VERIFIED: docs/operations/verification-and-recovery.md]

### Step 3: Update detail/reference docs to match foundations

- Update `docs/architecture/data-model.md` to remove or explicitly mark unshipped fields (`mainMergeSha`, `branchHeadSha`) and reconcile `VerifyIssue` shape with `src/core/types/verification.ts`. [VERIFIED: docs/architecture/data-model.md][VERIFIED: src/core/types/domain.ts][VERIFIED: src/core/types/verification.ts]
- Update `docs/operations/verification-and-recovery.md` to match the shipped `verification.mergeTrain` alias/fallback behavior in `resolveVerificationLayerConfig(...)`. [VERIFIED: src/config/verification-layer.ts][VERIFIED: docs/operations/verification-and-recovery.md]
- Update `docs/reference/tui.md` to include merge-train overlay if still shipped and add a CLI diagnostics section for `gvc0 explain`. [VERIFIED: src/tui/app-overlays.ts][VERIFIED: src/main.ts]
- Keep `docs/foundations/README.md` as the landing page; it is already accurate about canonical doc roles. [VERIFIED: docs/foundations/README.md]

### Step 4: Run focused and full verification

Recommended focused checks:

```bash
npm run typecheck
npx vitest run test/unit/docs/drift.test.ts test/unit/core/fsm/run-state-axis.test.ts test/unit/core/fsm/composite-invariants.test.ts test/unit/tui/main.test.ts
```

Recommended full check:

```bash
npm run check
```

These commands align with project instructions and package scripts. [VERIFIED: CLAUDE.md][VERIFIED: package.json]

## Files Likely to Modify

| File | Modification | Rationale |
|------|--------------|-----------|
| `test/unit/docs/drift.test.ts` | Create focused doc-vs-code drift assertions | No existing docs drift tests were found; Vitest unit tests run in `npm run check`. [VERIFIED: repository search][VERIFIED: package.json][VERIFIED: vitest.config.ts] |
| `docs/foundations/state-axes.md` | Update run-state diagram, run domain list, composite count, and matrix/protected summary | Current doc omits checkpointed waits and states 420 combinations while tests enumerate 560. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts] |
| `docs/foundations/execution-flow.md` | Add read-only explain branch and clarify async feature-phase/task-run completion vs TUI startup | 11-01 explain dispatch bypasses TUI startup. [VERIFIED: src/main.ts][VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md] |
| `docs/foundations/coordination-rules.md` | Consolidate rebase/ejection/reentry and source-of-truth rows | Current table conflicts with operations docs/code around integration failures. [VERIFIED: docs/foundations/coordination-rules.md][VERIFIED: docs/operations/verification-and-recovery.md][VERIFIED: src/core/merge-train/index.ts] |
| `docs/operations/verification-and-recovery.md` | Reconcile `verification.mergeTrain` wording with config fallback | Code supports `mergeTrain → feature → empty defaults`. [VERIFIED: src/config/verification-layer.ts][VERIFIED: src/config/schema.ts] |
| `docs/architecture/data-model.md` | Reconcile entity fields and `VerifyIssue` shape | Current doc includes fields/type variants not in shipped TypeScript. [VERIFIED: docs/architecture/data-model.md][VERIFIED: src/core/types/domain.ts][VERIFIED: src/core/types/verification.ts] |
| `docs/reference/tui.md` | Add explain CLI diagnostics and update shipped overlay inventory | Current entry points omit `gvc0 explain`; overlay inventory omits merge train overlay code paths. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts][VERIFIED: src/tui/app-overlays.ts] |
| `docs/README.md` / `docs/reference/README.md` | Optional link updates only if a new diagnostics reference page is created | Existing landing-page model should be preserved. [VERIFIED: CLAUDE.md][VERIFIED: docs/reference/README.md] |

## Code Examples

### Drift test for required shipped command literals

```typescript
// Source: existing Vitest + Node fs structural-test pattern.
// [VERIFIED: test/unit/core/boundary.test.ts]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readDoc(relativePath: string): string {
  return readFileSync(resolve(import.meta.dirname, '../../..', relativePath), 'utf8');
}

describe('docs drift', () => {
  it('documents the shipped explain CLI commands', () => {
    const doc = readDoc('docs/reference/tui.md');
    for (const command of [
      'gvc0 explain feature <id>',
      'gvc0 explain task <id>',
      'gvc0 explain run <id>',
    ]) {
      expect(doc, `docs/reference/tui.md missing ${command}`).toContain(command);
    }
  });
});
```

### Drift test using the executable run-state guard

```typescript
// Source: validateRunStateTransition is exported by src/core/fsm/index.ts.
// [VERIFIED: src/core/fsm/index.ts]
import { validateRunStateTransition } from '@core/fsm/index';
import { describe, expect, it } from 'vitest';

describe('run-state docs drift', () => {
  it('keeps checkpointed wait transitions legal in code and documented', () => {
    expect(
      validateRunStateTransition('await_response', 'checkpointed_await_response')
        .valid,
    ).toBe(true);
    expect(
      validateRunStateTransition('checkpointed_await_response', 'ready').valid,
    ).toBe(true);
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual docs review only | Code-backed drift tests in Vitest | Recommended for 11-02 [ASSUMED] | Docs drift fails `npm run check` instead of relying on reviewer memory. [VERIFIED: package.json][ASSUMED] |
| Run-state docs with only live waits | Run-state docs include checkpointed waits | Code already changed before 11-02 [VERIFIED: src/core/fsm/index.ts][VERIFIED: src/core/types/runs.ts] | Canonical docs must include hot-window expiry/checkpoint semantics. [VERIFIED: src/orchestrator/services/recovery-service.ts][VERIFIED: src/runtime/worker-pool.ts] |
| TUI-only diagnostic docs | TUI plus read-only `gvc0 explain` diagnostics | 11-01 [VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md] | Reference docs need a CLI diagnostics section. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts] |
| Prose coordination narratives | Decision-table-first foundation docs | Already present before 11-02 [VERIFIED: docs/foundations/README.md][VERIFIED: docs/foundations/coordination-rules.md] | 11-02 should consolidate table rows against shipped code and make tests protect key rows. [ASSUMED] |

**Deprecated/outdated:**
- `docs/foundations/state-axes.md` claim of 420 composite combinations is outdated relative to the current exhaustive test's 560 combinations. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts]
- `docs/operations/verification-and-recovery.md` claim that there is no separate `verification.mergeTrain` layer is outdated or at least incomplete relative to `resolveVerificationLayerConfig(...)` and config schema support for `mergeTrain`. [VERIFIED: docs/operations/verification-and-recovery.md][VERIFIED: src/config/verification-layer.ts][VERIFIED: src/config/schema.ts]
- `docs/reference/tui.md` command inventory is outdated because it omits `gvc0 explain feature|task|run <id>`. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts]

## Runtime State Inventory

> This is a documentation/test consolidation phase, not a rename/refactor/migration phase. [VERIFIED: user prompt]

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None — no persisted data key/string migration is in scope. [VERIFIED: user prompt] | None |
| Live service config | None — no external UI/database-backed service config is in scope. [VERIFIED: user prompt] | None |
| OS-registered state | None — no OS registrations are modified by docs/tests. [VERIFIED: user prompt] | None |
| Secrets/env vars | None — no secret/env var names are modified by docs/tests. [VERIFIED: user prompt] | None |
| Build artifacts | None expected — docs/tests do not create installed package artifacts. [ASSUMED] | None |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | TypeScript/Vitest checks | yes [VERIFIED: local command] | v24.13.0 [VERIFIED: local `node --version`] | Blocking if absent; project requires Node >=24. [VERIFIED: package.json] |
| npm | Package scripts | yes [VERIFIED: local command] | 11.9.0 [VERIFIED: local `npm --version`] | Blocking if absent. [VERIFIED: package.json] |
| Vitest | Focused doc drift test | yes [VERIFIED: local command] | 4.1.4 [VERIFIED: local `npx vitest --version`] | Use existing `npm run test`; no separate runner needed. [VERIFIED: package.json] |
| TypeScript compiler | Typecheck | yes [VERIFIED: local command] | 5.9.3 [VERIFIED: local `npx tsc --version`] | Blocking if absent. [VERIFIED: package.json] |

**Missing dependencies with no fallback:** none found. [VERIFIED: environment audit]

**Missing dependencies with fallback:** none found. [VERIFIED: environment audit]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 local [VERIFIED: local `npx vitest --version`] |
| Config file | `vitest.config.ts` [VERIFIED: vitest.config.ts] |
| Quick run command | `npx vitest run test/unit/docs/drift.test.ts` [VERIFIED: vitest.config.ts] |
| Full suite command | `npm run check` [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| REQ-DOC-01 | Execution-flow docs include read-only explain branch and shipped async event-loop boundaries | unit docs drift | `npx vitest run test/unit/docs/drift.test.ts -t execution` | No — Wave 0 create [VERIFIED: repository search] |
| REQ-DOC-02 | State-axis docs include current run statuses, transitions, and matrix count | unit docs drift + existing FSM tests | `npx vitest run test/unit/docs/drift.test.ts test/unit/core/fsm/run-state-axis.test.ts test/unit/core/fsm/composite-invariants.test.ts` | Partial — FSM tests exist; docs test missing [VERIFIED: test/unit/core/fsm/run-state-axis.test.ts][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts][VERIFIED: repository search] |
| REQ-DOC-03 | Coordination tables match shipped merge-train/reentry/runtime-blocking semantics | unit docs drift + existing core tests | `npx vitest run test/unit/docs/drift.test.ts test/unit/core/merge-train.test.ts` | Docs test missing; merge-train tests likely exist under unit/integration. [VERIFIED: src/core/merge-train/index.ts][VERIFIED: docs/operations/testing.md] |
| REQ-DOC-04 | Doc-vs-code drift check runs in standard verification | package-script integration | `npm run check` | No — Wave 0 create docs test [VERIFIED: package.json][VERIFIED: vitest.config.ts] |

### Sampling Rate

- **Per task commit:** `npx vitest run test/unit/docs/drift.test.ts` plus any focused FSM/merge-train tests touched. [ASSUMED]
- **Per wave merge:** `npm run check`. [VERIFIED: CLAUDE.md][VERIFIED: package.json]
- **Phase gate:** Full `npm run check` green before verification. [VERIFIED: CLAUDE.md]

### Wave 0 Gaps

- [ ] `test/unit/docs/drift.test.ts` — covers REQ-DOC-01 through REQ-DOC-04. [VERIFIED: repository search]
- [ ] Protected snippets or stable headings in `docs/foundations/state-axes.md` for code-backed run-state/matrix assertions. [VERIFIED: docs/foundations/state-axes.md]
- [ ] Updated reference docs for `gvc0 explain feature|task|run <id>`. [VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | No auth/session feature is changed. [VERIFIED: user prompt] |
| V3 Session Management | no | Existing `agent_runs` / session docs are documentation-only for this phase. [VERIFIED: user prompt][VERIFIED: src/core/types/runs.ts] |
| V4 Access Control | no | No permission boundary changes are planned. [VERIFIED: user prompt] |
| V5 Input Validation | yes | Drift tests should treat docs/source paths as fixed repo-local paths, not user input. [ASSUMED] |
| V6 Cryptography | no | No cryptographic behavior is changed. [VERIFIED: user prompt] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Accidental broad filesystem reads in tests | Information Disclosure | Read only fixed repo-relative docs/source paths in `test/unit/docs/drift.test.ts`. [ASSUMED] |
| Docs test executing shell commands | Elevation of Privilege / Tampering | Do not execute shell commands from docs; use Node `fs` and imported functions only. [ASSUMED] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The highest-value implementation is a small doc-drift test suite under Vitest plus targeted documentation edits. | Summary | If the project expects generated docs instead, a Vitest assertion approach may be considered too manual. |
| A2 | Protected Markdown blocks are preferable for 11-02 over full Markdown AST parsing. | Architecture Patterns | If docs require complex table semantics, regex/protected-block tests may be too weak. |
| A3 | Whole-file Markdown snapshots should be avoided because they over-test prose wording. | Common Pitfalls | If the team wants exact docs snapshots, this recommendation under-tests formatting drift. |
| A4 | Documentation/test edits will not create build artifacts needing cleanup. | Runtime State Inventory | If a generator script is added later, artifacts may need explicit validation. |
| A5 | Per-task validation should run the focused docs test and touched state/merge-train tests. | Validation Architecture | If CI time is very constrained or task scope is broader, sampling may need adjustment. |

## Open Questions (RESOLVED)

1. **Should 11-02 generate the full composite matrix or only test a summary/protected subset?**
   - Resolution: keep docs concise, update counts/domains/diagrams, and let `test/unit/core/fsm/composite-invariants.test.ts` remain the exhaustive matrix authority. The 11-02 drift test should protect load-bearing literals/counts and selected transition rows, not require a committed 560-row generated table unless execution discovers a strong need. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts][ASSUMED]

2. **Should `docs/reference/tui.md` remain the place for non-TUI `gvc0 explain` docs?**
   - Resolution: document `gvc0 explain feature <id>`, `gvc0 explain task <id>`, and `gvc0 explain run <id>` in `docs/reference/tui.md` for 11-02 because that page currently owns app entry points and operator UI/reference commands. A broader CLI reference page is deferred unless later Phase 11 work expands the CLI inventory beyond this focused diagnostic slice. [VERIFIED: docs/reference/README.md][VERIFIED: docs/reference/tui.md][VERIFIED: src/main.ts]

3. **Should code or docs change for `VerifyIssue` source discrimination?**
   - Resolution: update docs to the shipped `VerifyIssue` TypeScript shape in `src/core/types/verification.ts`; do not change production code in 11-02. If richer source-discriminated verify issues are still desirable, they belong in a future implementation phase rather than this docs-alignment slice. [VERIFIED: docs/architecture/data-model.md][VERIFIED: src/core/types/verification.ts][VERIFIED: user prompt]

## Sources

### Primary (HIGH confidence)

- `/home/alpine/vcode0/CLAUDE.md` — project architecture, testing, documentation, and commit constraints. [VERIFIED: CLAUDE.md]
- `/home/alpine/vcode0/ARCHITECTURE.md` — top-level work/collab/run model and documentation entry points. [VERIFIED: ARCHITECTURE.md]
- `/home/alpine/vcode0/.planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md` — shipped 11-01 explain CLI behavior and handoff. [VERIFIED: .planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md]
- `/home/alpine/vcode0/docs/foundations/README.md` — canonical docs layer contract. [VERIFIED: docs/foundations/README.md]
- `/home/alpine/vcode0/docs/foundations/state-axes.md` — current state-axis docs and matrix. [VERIFIED: docs/foundations/state-axes.md]
- `/home/alpine/vcode0/docs/foundations/execution-flow.md` — current execution-flow docs. [VERIFIED: docs/foundations/execution-flow.md]
- `/home/alpine/vcode0/docs/foundations/coordination-rules.md` — current coordination decision tables. [VERIFIED: docs/foundations/coordination-rules.md]
- `/home/alpine/vcode0/docs/architecture/data-model.md` — current data model docs. [VERIFIED: docs/architecture/data-model.md]
- `/home/alpine/vcode0/docs/operations/verification-and-recovery.md` — verification and merge-train behavior docs. [VERIFIED: docs/operations/verification-and-recovery.md]
- `/home/alpine/vcode0/docs/operations/conflict-coordination.md` — narrative coordination reference. [VERIFIED: docs/operations/conflict-coordination.md]
- `/home/alpine/vcode0/docs/reference/tui.md` — current user-facing TUI/entrypoint reference. [VERIFIED: docs/reference/tui.md]
- `/home/alpine/vcode0/src/main.ts` — shipped explain CLI dispatch. [VERIFIED: src/main.ts]
- `/home/alpine/vcode0/src/compose.ts` — read-only explain rendering helpers and shared summary reuse. [VERIFIED: src/compose.ts]
- `/home/alpine/vcode0/src/core/fsm/index.ts` — executable FSM transitions and composite guard. [VERIFIED: src/core/fsm/index.ts]
- `/home/alpine/vcode0/src/core/types/runs.ts` — shipped `AgentRunStatus` values. [VERIFIED: src/core/types/runs.ts]
- `/home/alpine/vcode0/src/core/types/domain.ts` — shipped Feature/Task interface fields. [VERIFIED: src/core/types/domain.ts]
- `/home/alpine/vcode0/src/core/types/verification.ts` — shipped `VerifyIssue` shape. [VERIFIED: src/core/types/verification.ts]
- `/home/alpine/vcode0/src/core/merge-train/index.ts` — shipped merge-train priority/ejection/reentry behavior. [VERIFIED: src/core/merge-train/index.ts]
- `/home/alpine/vcode0/src/config/verification-layer.ts` and `/home/alpine/vcode0/src/config/schema.ts` — shipped verification-layer config behavior. [VERIFIED: src/config/verification-layer.ts][VERIFIED: src/config/schema.ts]
- `/home/alpine/vcode0/package.json`, `/home/alpine/vcode0/vitest.config.ts`, `/home/alpine/vcode0/tsconfig.json`, `/home/alpine/vcode0/biome.json` — validation stack and scripts. [VERIFIED: package.json][VERIFIED: vitest.config.ts][VERIFIED: tsconfig.json][VERIFIED: biome.json]

### Secondary (MEDIUM confidence)

- npm registry checks for `vitest`, `typescript`, `@biomejs/biome`, `markdown-table`, and `mdast-util-from-markdown` package versions. [VERIFIED: npm registry]
- Local environment version checks for Node, npm, Vitest, and TypeScript. [VERIFIED: local command]

### Tertiary (LOW confidence)

- Implementation preference for protected Markdown snippets over AST parsing is based on codebase fit and scope judgment. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions were verified from project files, local commands, and npm registry. [VERIFIED: package.json][VERIFIED: npm registry]
- Architecture: HIGH — recommendations are based on current repo docs, code, and tests. [VERIFIED: docs/foundations/README.md][VERIFIED: src/core/fsm/index.ts][VERIFIED: package.json]
- Drift risks: HIGH — each listed drift has both doc and code/test evidence. [VERIFIED: docs/foundations/state-axes.md][VERIFIED: test/unit/core/fsm/composite-invariants.test.ts][VERIFIED: src/config/verification-layer.ts]
- Implementation approach: MEDIUM — the approach is conventional for this repo, but exact protected-block granularity is a planner/executor decision. [ASSUMED]

**Research date:** 2026-05-02
**Valid until:** 2026-06-01 for repo-internal findings, or until any state/coordination code changes land. [ASSUMED]
