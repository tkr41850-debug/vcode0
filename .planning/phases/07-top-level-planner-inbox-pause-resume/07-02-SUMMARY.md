---
phase: 07-top-level-planner-inbox-pause-resume
plan: 02
subsystem: inbox
stags: [inbox, scheduler, tui, fanout, pause-resume]
requirements-completed: [REQ-INBOX-01, REQ-INBOX-04, REQ-TUI-02]
completed: 2026-04-27
---

# Phase 07 Plan 02: Inbox Domain Model, Unified Wait Routing, and Fan-Out Resolution Summary

**Turned `inbox_items` from an append-only escape hatch into the real Phase 7 inbox model: the Store can now list and resolve inbox rows, `request_help` and every approval wait materialize as durable inbox items, and one operator response can fan out to every equivalent live wait.**

## Performance

- **Completed:** 2026-04-27
- **Scope closed:** Store inbox query/resolve API, SQLite + in-memory parity, unified scheduler wait routing, inbox-first compose resolution, TUI compatibility shims, and end-to-end multi-task unblock coverage
- **Commits created in this slice:** none
- **Verification result:** `npm run check` green at completion (`91 passed | 2 skipped` files, `1707 passed | 3 skipped` tests)

## Accomplishments

- Added typed inbox query and resolution contracts to the Store boundary instead of letting compose/TUI bypass persistence.
- Reused the existing `inbox_items` table and nullable `resolution` column; unresolved semantics remain `resolution IS NULL`.
- Mirrored the widened inbox behavior in `SqliteStore` and the integration harness `InMemoryStore` so tests stay isomorphic.
- Routed `request_help` into durable `agent_help` inbox rows.
- Routed all approval waits into the unified inbox model while preserving legacy `destructive_action` queryability.
- Added inbox-first resolution helpers in `src/compose.ts` and kept existing task-selected reply/approve commands working through compatibility shims.
- Added an end-to-end proof that one inbox answer can unblock multiple equivalent live waits.

## Final Store Inbox API Shape

The final Store surface is:

```ts
export interface InboxItemResolution {
  kind: 'answered' | 'approved' | 'rejected' | 'dismissed';
  resolvedAt: number;
  note?: string;
  fanoutTaskIds?: string[];
}

export interface InboxItemRecord {
  id: string;
  ts: number;
  taskId?: string;
  agentRunId?: string;
  featureId?: string;
  kind: string;
  payload: unknown;
  resolution?: InboxItemResolution;
}

export interface InboxQuery {
  unresolvedOnly?: boolean;
  kind?: string;
  taskId?: string;
  agentRunId?: string;
  featureId?: string;
}

appendInboxItem(item: InboxItemAppend): void;
listInboxItems(query?: InboxQuery): InboxItemRecord[];
resolveInboxItem(id: string, resolution: InboxItemResolution): void;
```

Implementation details that matter:

- `src/persistence/sqlite-store.ts` reads `payload` and `resolution` by parsing JSON text from `inbox_items`.
- `listInboxItems({ unresolvedOnly: true })` maps directly to `resolution IS NULL`, so the existing unresolved index remains valid.
- `rowToInboxItem(...)` conditionally spreads optional fields instead of returning explicit `undefined`, which keeps the mapping valid under `exactOptionalPropertyTypes`.

## Exact Wait Kinds That Now Append Inbox Rows

The scheduler now writes inbox rows for every operator-facing wait:

- `request_help` -> `kind: 'agent_help'`
  - payload: `{ query: string }`
- `request_approval` with `payload.kind === 'custom'` -> `kind: 'agent_approval'`
  - payload: the original approval payload
- `request_approval` with `payload.kind === 'replan_proposal'` -> `kind: 'agent_approval'`
  - payload: the original approval payload
- `request_approval` with `payload.kind === 'destructive_action'` -> `kind: 'destructive_action'`
  - payload: `{ description, affectedPaths }`

This keeps the inbox unified without breaking legacy consumers that still query destructive approvals by the old kind.

Pre-existing system attention kinds remain visible through the same Store API, including `semantic_failure` and `merge_train_cap_reached`.

## Equivalence-Key Rule for Multi-Task Fan-Out

The inbox fan-out rule in `src/orchestrator/ports/index.ts` is:

```ts
buildInboxEquivalenceKey(kind, payload) =
  `${kind}:${stableSerialize(canonicalInboxPayload(kind, payload))}`
```

Resolution uses the following precedence:

1. If the payload already contains a string `equivalenceKey`, use it directly.
2. Otherwise compute the key from `kind + canonicalized payload`.

Canonicalization rules that landed:

- `agent_help`
  - normalize query text with trim + whitespace collapse + lowercase
- `agent_approval` / `custom`
  - normalize `label` and `detail` with the same text normalization
- `agent_approval` / `replan_proposal`
  - normalize `summary`
  - sort `proposedMutations`
- `destructive_action`
  - because the inbox row intentionally keeps the legacy `{ description, affectedPaths }` payload shape, equivalence falls back to stable serialization of that raw payload unless an explicit `equivalenceKey` is present

This means the fan-out logic is payload-structural, not task-id-based.

## Resolution Payload Shape

Every successfully delivered row now stores the same resolution record:

```ts
{
  kind: 'answered' | 'approved' | 'rejected' | 'dismissed';
  resolvedAt: number;
  note?: string;
  fanoutTaskIds: string[];
}
```

Important runtime semantics:

- `fanoutTaskIds` is sorted and records the exact delivered live task set.
- Rows are resolved only when delivery to the waiting runtime succeeds.
- Equivalent rows whose tasks are no longer live are left unresolved in 07-02.
- If the selected inbox item has no matching live waits, compose throws instead of silently marking rows resolved.

## Inbox-First Resolution Path

`src/compose.ts` now owns the operator-resolution flow:

- `respondToInboxHelp(...)`
- `decideInboxApproval(...)`

Both delegate through `resolveEquivalentInboxItems(...)`, which:

1. Loads the selected unresolved inbox row.
2. Computes its equivalence key.
3. Finds all unresolved equivalent rows.
4. Delivers the response through `runtime.respondToHelp(...)` or `runtime.decideApproval(...)`.
5. Writes a shared resolution payload onto every successfully delivered row.

Compatibility behavior is preserved:

- `respondToTaskHelp(taskId, ...)`
- `decideTaskApproval(taskId, ...)`

still exist and now look up the unresolved inbox row for that task before delegating through the inbox-first path.

## Files Created/Modified

Primary implementation files:

- `src/orchestrator/ports/index.ts`
- `src/persistence/queries/index.ts`
- `src/persistence/sqlite-store.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/compose.ts`
- `src/tui/app-deps.ts`
- `test/integration/harness/store-memory.ts`

Primary regression coverage files:

- `test/unit/persistence/sqlite-store.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/tui/commands.test.ts`
- `test/integration/worker-smoke.test.ts`

Mock/store shape widening was also required in several scheduler/recovery/integration tests so the widened Store contract compiled cleanly.

## Decisions Made

1. **No second inbox persistence path.**
   - Querying and resolution go through the same Store boundary that already owned append.

2. **Legacy destructive approval queryability stays intact.**
   - `destructive_action` remains its own inbox kind even though generic approvals now also land in the inbox.

3. **Fan-out is live-delivery-only in 07-02.**
   - Rows resolve only when the runtime actually accepts the response.
   - Checkpointed or otherwise non-live waits are intentionally deferred to 07-03.

4. **Task-oriented TUI commands stay stable.**
   - The public TUI contract gained inbox-oriented helpers, but `/reply`, `/approve`, and `/reject` continue to work from a selected task.

## Deviations from Plan

### Verification follow-up

The first full `npm run check` hit a transient full-suite failure in:

- `test/integration/feature-lifecycle-e2e.test.ts`

The failing repair-loop test passed immediately in isolation, and the subsequent full `npm run check` rerun was green. No 07-02 code changes were required beyond the final smoke-test lint cleanup.

## Verification

Focused verification during the slice:

- `npx vitest run test/unit/persistence/sqlite-store.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts test/unit/tui/commands.test.ts`
- `npx vitest run test/integration/worker-smoke.test.ts`
- `npm run typecheck`

Final repo-wide verification:

- `npm run check`
- result: `91 passed | 2 skipped (93)` test files
- result: `1707 passed | 3 skipped (1710)` tests

## Phase 07-03 Handoff

07-02 closes the live-wait inbox model, but it intentionally does **not** resolve waits that cannot be delivered immediately.

07-03 still needs to extend this path for:

- hot-window expiry from live worker -> checkpointed wait
- respawned worker replay after process release
- inbox replies/approvals against checkpointed or otherwise non-live waits
- durable mapping between unresolved inbox rows and resume-capable paused sessions

The key invariant to preserve in 07-03 is the one established here: **do not mark an inbox row resolved unless the response has actually been consumed by the waiting run or its replay/resume successor.**

## Outcome

Plan 07-02 is complete:

- the inbox is now queryable and resolvable through the Store
- all operator-facing help/approval waits materialize in durable inbox rows
- one operator action can unblock multiple equivalent live waits
- TUI compatibility is preserved through task-selected shims
- verification is green
