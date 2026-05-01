# Phase 2 — `scope_type='project'` discriminator

## Goal

Extend the existing `agent_runs.scope_type` discriminator to recognize `'project'` alongside the current `'task'` and `'feature_phase'` values. Update the typed `AgentRun` union, codecs, and query helpers so the persistence layer can store and retrieve project-scope runs. No new dispatch path or agent code in this phase — that lands in Phase 4.

## Scope

**In:** extend the `AgentRun` discriminated union in `src/core/types/runs.ts` with a third arm for `scope_type='project'`; update codec encode/decode paths in `src/persistence/codecs.ts` and the query helper in `src/persistence/queries/index.ts`; extend `Store` query methods with project-scope filters; add a stable singleton `scope_id` convention for project runs.

**Out:** new dispatch path or scheduler integration (Phase 4); new agent role or prompts (Phase 4); TUI rendering (Phase 6); migration with CHECK constraint (deferred — column is `TEXT NOT NULL` with no constraint today, the union extension is type-only at the application level).

## Background

Verified state on `main`:

- `agent_runs` table created in `src/persistence/migrations/001_init.ts:61-76` with `scope_type TEXT NOT NULL` and `scope_id TEXT NOT NULL`. No CHECK constraint on `scope_type`.
- Two values in current code: `'task'` and `'feature_phase'`. References at:
  - `src/core/types/runs.ts:49,54` — discriminated `AgentRun` union arms.
  - `src/persistence/queries/index.ts:124,129` — row-shape literal types.
  - `src/persistence/codecs.ts:290,317` — encode/decode discriminator branches.
  - `src/persistence/sqlite-store.ts:36,71,148,281` — column list, row shape, INSERT, query filter.
  - `src/core/scheduling/index.ts:61,468` — `SchedulableUnit.kind` (separate from scope_type but related vocabulary).
- `scope_id` is interpreted per `scope_type`: task id (`t-...`) or feature id (`f-...`) today.
- For project scope, only one project exists per orchestrator instance. The scope_id can be a stable singleton (e.g. `'project'`) — multiple sessions are distinguished by the `id` column (the run uid). Session resume queries by `id`, session list queries by `scope_type='project'`.

## Steps

Ships as **3 commits**, in order. Step 2.3 sweeps non-persistence call sites that pattern-match on `scopeType` so the new arm is handled exhaustively before any code path actually creates project runs.

---

### Step 2.1 — Extend `AgentRun` union and codecs

**What:** add a third arm to the `AgentRun` discriminated union for `scope_type='project'`. Update encode/decode paths to handle it. The arm should require `scopeId: 'project'` (or a typed singleton const) so the type system enforces the convention.

**Files:**

- `src/core/types/runs.ts` — add `ProjectAgentRun` arm with `scopeType: 'project'` and `scopeId: ProjectScopeId`. Define and export `ProjectScopeId = 'project'` as a typed singleton const so Phase 4 (and any future consumer) imports the same name. Phase 4's coordinator uses this const when creating the `agent_runs` row.
- `src/persistence/queries/index.ts` — add `scope_type: 'project'` row-shape arm.
- `src/persistence/codecs.ts` — extend `agentRunToRow` and `rowToAgentRun` discriminator branches to handle the project arm. Today's `rowToAgentRun` only special-cases `'task'` and falls through to `'feature_phase'` for anything else (no throw). **Decision:** add explicit `'task' | 'feature_phase' | 'project'` branches and **throw** on truly unknown values. The fallthrough was tolerable when the union had two arms and the rare edge case was a typo; it is unsafe with three arms because a corrupted `'project'` row could decode as `'feature_phase'` and miscategorize. Throwing forces every future scope_type addition to land an explicit branch here.
- `src/persistence/sqlite-store.ts` — verify `scope_type` filter passes through. The Store API is `listAgentRuns(...)` (not `listRuns`); `listAgentRuns({ scopeType: 'project' })` should return project rows.
- `test/unit/persistence/codecs.test.ts` — add roundtrip coverage for a project-scope run.
- `test/unit/persistence/sqlite-store.test.ts` — add insert + list-by-scope coverage for project runs.

**Tests:**

- Codec roundtrip: encode `{ scopeType: 'project', scopeId: 'project', id: 'proj-...', phase: 'plan', runStatus: 'running' }` → row → decode produces equal value.
- SqliteStore insert + `listAgentRuns({ scopeType: 'project' })` returns the inserted row.
- Decoding a row with an unknown `scope_type` value throws (per the policy decision above).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the union extension: (1) `src/core/types/runs.ts` has a third `AgentRun` arm with `scopeType: 'project'`; (2) codecs roundtrip the new arm without data loss; (3) `listAgentRuns` can filter by `scopeType: 'project'`; (4) decoder branches on `'task'` / `'feature_phase'` / `'project'` explicitly; (5) existing task and feature_phase paths are byte-for-byte unchanged in serialized form; (6) every other call site that pattern-matches on `scopeType` (see Step 2.3) handles the new arm. Under 300 words.

**Commit:** `feat(persistence): extend agent_runs scope_type with project arm`

---

### Step 2.2 — Project-run query helpers and Store port

**What:** add typed query helpers for project-scope runs to the `Store` port and its SQLite implementation. The helpers serve two consumers: (a) the recovery service's boot-time rehydrate sweep (Phase 4 Step 4.3) which queries `running` rows; (b) the TUI session-list view (Phase 6) which queries any combination of statuses for resume / history. The helpers are **not** consumed by `prioritizeReadyWork` — project-run dispatch is event-driven from the coordinator and recovery service (see Phase 4 Background "Dispatch model").

**Files:**

- `src/orchestrator/ports/index.ts` — extend `Store` with `listProjectSessions(filter?: { status?: AgentRunStatus[] })` and `getProjectSession(id: string): AgentRun | undefined`. The `status` filter accepts any subset of the existing `AgentRunStatus` union (no new statuses are introduced by this track). Reuse existing run-query plumbing rather than introducing new infrastructure.
- `src/persistence/sqlite-store.ts` — implement the new methods on `SqliteStore`. Match the existing convention where read methods return `undefined` (not `null`) when the row is missing, e.g. `getAgentRun(id): AgentRun | undefined`.
- `test/unit/persistence/sqlite-store.test.ts` — add implementation coverage. (No dedicated `test/unit/orchestrator/ports.test.ts` exists today; either extend `sqlite-store.test.ts` or add a new contract-test file alongside it — pick whichever matches the convention used for `getAgentRun` coverage.)

**Tests:**

- `listProjectSessions` with no filter returns all rows where `scope_type='project'`.
- `listProjectSessions({ status: ['running', 'await_response'] })` returns only active sessions (using existing union members — no new statuses).
- `getProjectSession` returns the row or `undefined`.
- Existing run-query tests stay green.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the Store extension: (1) `Store` port has `listProjectSessions` and `getProjectSession` typed against the new union arm; (2) SqliteStore implementation filters correctly by `scope_type='project'` and optional status; (3) existing run queries are unchanged; (4) no leakage of project-scope concepts into task or feature_phase code paths. Under 250 words.

**Commit:** `feat(orchestrator): add project-session query helpers to Store port`

---

### Step 2.3 — Exhaust `scopeType` switches across the codebase

**What:** every non-persistence call site that today pattern-matches on `scopeType` assumes a 2-arm union. Each must either handle the project arm explicitly or document an intentional ignore. No production path creates project runs yet (Phase 4), but this step prevents type errors and silent miscategorization the moment Phase 4 lands.

**Files (verified call sites on `main`):**

- `src/orchestrator/scheduler/dispatch.ts` — `createRunReader` and any sibling that branches on `scopeType`. Project runs are dispatched in Phase 4; the Phase 2 change is an exhaustive branch (with a "Phase 4 wires this" placeholder if it cannot be fully implemented yet) rather than a silent fallthrough.
- `src/orchestrator/services/recovery-service.ts` — `recoverOrphanedRuns` currently sweeps task and feature_phase runs only. Add explicit project-arm handling (recovery semantics defined in Phase 4; here, at minimum, no silent crash and no miscategorization).
- `src/runtime/error-log/index.ts` — non-task runs are currently labeled `"feature"`. Add a `"project"` label so logs disambiguate.
- `src/tui/view-model/index.ts` — non-task runs are currently bucketed as feature-phase. Add a project bucket (rendering may be a no-op until Phase 6, but the bucket must exist so view-model invariants are exhaustive).
- `src/orchestrator/services/budget-service.ts` — confirm how project-scope `token_usage` rolls up. If the answer is "counts toward global spend, no per-feature attribution," document that explicitly in code (a comment + an exhaustive branch is enough).
- `test/unit/...` — extend the existing tests for each touched file with a project-arm fixture; assertion is "does not throw, does not miscategorize," nothing semantic yet.

**Tests:**

- Each touched call site has a project-arm fixture and a deterministic assertion that it is handled explicitly.
- No regression in existing task / feature_phase coverage.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify exhaustiveness sweep: (1) every site that branches on `scopeType` outside `persistence/` and `core/types/` has a project arm; (2) project arms either implement the right behavior or carry an explicit "Phase 4 wires this" marker — never a silent fallthrough; (3) error-log labels distinguish project from feature; (4) view-model buckets are exhaustive; (5) tests cover at least one project-arm fixture per touched site. Under 300 words.

**Commit:** `refactor(orchestrator): exhaust scopeType switches across orchestrator/runtime/tui`

---

## Phase exit criteria

- All three commits land in order.
- `npm run verify` passes.
- A project-scope `AgentRun` can be inserted and round-tripped through SqliteStore.
- `listProjectSessions` returns the session list a future TUI session view will consume (Phase 6).
- Every `scopeType` branch in orchestrator/runtime/tui handles the project arm explicitly (no silent fallthrough); production code paths still do not *create* project runs — that lands in Phase 4.
- Run a final review subagent across the three commits to confirm the union extension is sound, the Store surface is minimal, no migration is needed, and exhaustiveness holds.

## Notes

- **No migration.** `scope_type` is `TEXT NOT NULL` with no CHECK; existing rows continue to deserialize cleanly. If a CHECK constraint is wanted later for type-safety, that is a separate `NNN_*.ts` migration outside this track.
- **Scope id convention.** Project scope_id is the singleton string `'project'` (typed const). The `id` column carries the per-session uid. This matches the existing pattern where `scope_id` identifies the *target* of the scope (a task, a feature, or the project itself) and `id` identifies the *run instance*.
- **Forward compatibility.** If a future change introduces multiple projects per orchestrator instance, scope_id widens to include a project uid; the typed union absorbs the change cleanly.
