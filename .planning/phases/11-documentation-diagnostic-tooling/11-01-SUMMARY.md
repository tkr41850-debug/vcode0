---
phase: 11-documentation-diagnostic-tooling
plan: 01
subsystem: explain-cli-and-shared-diagnostic-summaries
requirements-completed: [REQ-DOC-01, REQ-DOC-02, REQ-DOC-03]
completed: 2026-05-02
---

# Phase 11 Plan 01: `gvc0 explain` CLI + Shared Diagnostic Summary Reuse

**Phase 11 plan 11-01 adds the first non-TUI diagnostic surface: a read-only `gvc0 explain` CLI that branches before app startup, opens project state read-only, and reuses shipped state and summary derivations for feature, task, and run diagnostics.**

## Performance

- **Completed:** 2026-05-02
- **Scope closed:** pre-TUI explain dispatch, read-only compose/store query helpers, shared summary-helper reuse, truthful recorded-activity rendering, and phase-sync artifacts
- **Verification result:** focused green on `npm run typecheck` and `npx vitest run test/unit/tui/main.test.ts test/unit/compose.test.ts test/unit/tui/view-model.test.ts`

## Accomplishments

- Added an explicit `gvc0 explain` CLI path in `src/main.ts` that resolves before `writeStartupNotice()`, `composeApplication()`, and `app.start(...)`.
- Added read-only explain helpers in `src/compose.ts` for `feature`, `task`, and `run` targets.
- Added `openReadOnlyDatabase(...)` in `src/persistence/db.ts` so diagnostics can query `.gvc0/state.db` without migrations or runtime side effects.
- Reused the existing milestone-tree and DAG-node derivation path instead of inventing a second CLI-only state model.
- Exported shared text helpers from `src/tui/view-model/index.ts` so planner-audit and wait-state wording stay aligned between TUI and CLI surfaces.
- Added focused unit coverage that proves explain bypasses TUI startup, keeps `--cwd` semantics, and stays truthful to persisted run/event state.

## Final Command Shapes and Dispatch Behavior

The landed commands are:

- `gvc0 explain feature <id>`
- `gvc0 explain task <id>`
- `gvc0 explain run <id>`

Dispatch behavior:

1. global options are stripped first (`--cwd`, `--auto`)
2. `--cwd` is applied before explain resolution
3. explain dispatch runs before `loading...`, before application composition, and before any TUI/runtime startup
4. invalid or unsupported explain invocations fail with a concise error and non-zero exit code

Examples of guarded failures:

- `Usage: gvc0 explain <feature|task|run> <id>`
- `Unsupported explain target "milestone". Usage: gvc0 explain <feature|task|run> <id>`

## State Sections Shown Per Explain Target

### `gvc0 explain feature <id>`

The feature output is organized as:

1. **Feature header**
   - `Feature <id>: <name>`
2. **State**
   - display status
   - work axis
   - collab axis
   - current feature-phase run state when present
   - shared DAG meta such as `work: ...`, `collab: ...`, and summary availability
3. **Frontier**
   - unresolved child task rows derived from the shared DAG tree
   - each row now includes child meta so blocked/wait context appears with the same wording the TUI uses
4. **Planner provenance**
   - rows from `listPlannerAuditEntries(...)` rendered through the shared planner-audit summarizer

### `gvc0 explain task <id>`

The task output is organized as:

1. **Task header**
2. **Parent feature**
3. **State**
   - display status from the canonical task presentation derivation
   - task work status
   - collab axis
   - current task run state when present
4. **Context**
   - dependencies
   - blocking feature when present
   - shared wait/approval wording
   - shared DAG meta

### `gvc0 explain run <id>`

The run output is organized as:

1. **Run header**
2. **Scope**
   - `scopeType`, `scopeId`, `phase`
   - related feature/task identity when resolvable from the current snapshot
3. **State**
   - current run status
   - owner
   - attention
   - restart count / retry cap
   - session id and retry timestamp when present
4. **Context**
   - wait/approval wording for task runs
   - related shared DAG meta when available
5. **Recorded activity**
   - persisted related events only

## Shared Text Helpers Reused from the TUI View-Model Layer

The CLI now reuses these exported helpers from `src/tui/view-model/index.ts`:

- `summarizeTaskWaitPayload(...)`
- `summarizePlannerAuditEntry(...)`

The explain helpers also reuse:

- `TuiViewModelBuilder.buildMilestoneTree(...)`
- `flattenDagNodes(...)`

This keeps status derivation and wording aligned without printing TUI overlay chrome or box titles.

## Recorded-Activity Truthfulness Rule

Run output is intentionally framed as **Recorded activity**, not as a full historical timeline.

The rule is:

- only render persisted evidence from the current run row plus related emitted events
- filter phase-scoped events so a run only shows phase-relevant entries
- when no persisted evidence exists, print `No persisted related activity for this run.`
- never invent missing transitions or infer a complete run lifecycle from sparse rows

This keeps the CLI honest about the difference between current state and recorded history.

## Files Created/Modified

Primary implementation files:
- `src/main.ts`
- `src/compose.ts`
- `src/persistence/db.ts`
- `src/tui/view-model/index.ts`

Coverage files:
- `test/unit/tui/main.test.ts`
- `test/unit/compose.test.ts`
- `test/unit/tui/view-model.test.ts`

Phase artifact files:
- `.planning/phases/11-documentation-diagnostic-tooling/11-01-SUMMARY.md`
- `.planning/STATE.md`
- `.planning/ROADMAP.md`

## Verification

Focused slice verification completed successfully:

- `npm run typecheck`
- `npx vitest run test/unit/tui/main.test.ts test/unit/compose.test.ts test/unit/tui/view-model.test.ts`

## Phase 11 Handoff

11-02 should build on the now-shipped explain surface by reconciling docs against the real code paths it exposes:

- add doc-vs-code drift checks against the shipped explain/state derivation seams
- update the canonical state and execution-flow diagrams to match the actual work/collab/run output surfaced by `gvc0 explain`
- consolidate decision-table docs around the same coordination semantics already reflected in the shared TUI/CLI summaries

## Outcome

Plan 11-01 is complete:

- `gvc0 explain feature|task|run <id>` now exists as a read-only pre-TUI diagnostic entrypoint
- feature/task/run output stays grounded in shipped state derivations rather than ad-hoc CLI rules
- planner provenance and wait/approval wording are shared with the existing TUI summary layer
- run history is explicitly bounded to recorded activity backed by persisted evidence only
- focused typecheck and explain-related unit coverage are green
