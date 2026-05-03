# Phase 6: Merge Train - Pattern Map

**Mapped:** 2026-04-25
**Files analyzed:** 9 change areas across 7 source files + 3 test files
**Analogs found:** 9 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/core/merge-train/index.ts` | service / pure-logic | CRUD + state-machine | self (extend existing) | exact |
| `src/orchestrator/features/index.ts` | service / coordinator | event-driven, CRUD | self (extend `failIntegration`) | exact |
| `src/orchestrator/scheduler/events.ts` | event-handler | event-driven | self (extend `feature_integration_failed` handler) | exact |
| `src/orchestrator/scheduler/warnings.ts` | utility / emitter | event-driven | self + `src/core/warnings/index.ts` | exact |
| `src/config/schema.ts` | config | transform | self (`reentryCap` already parsed, `WarningConfigSchema` pattern) | exact |
| `src/persistence/migrations/*.sql` | migration | CRUD | `0005_inbox_items.sql`, `0007_agent_runs_trailer_observed_at.sql` | exact |
| `test/unit/core/merge-train.test.ts` | test (unit, pure) | CRUD + state | self | exact |
| `test/unit/orchestrator/scheduler-loop.test.ts` | test (unit, event-driven) | event-driven | self — integration-event tests around lines 3620–5121 | exact |
| `test/integration/merge-train.test.ts` | test (integration, persistent graph) | CRUD + persistence | self + `merge-train-scenario.ts` harness | exact |

---

## Pattern Assignments

### `src/core/merge-train/index.ts` — re-entry cap enforcement

**Role:** Pure coordinator over `FeatureGraph`. Only safe place to add the hard cap check because it is called before any graph mutation commits.

**Closest analog:** The existing `ejectFromQueue` method (lines 139–154), which already increments `mergeTrainReentryCount` and clears queue-local fields.

**Where to add the cap check:** `enqueueFeatureMerge` (before line 36 `this._entrySeq++`) and optionally in a new `parkAtCap` helper called by `ejectFromQueue` when the post-increment count reaches the cap.

**Pattern to copy — cap guard inside `enqueueFeatureMerge`** (model after the existing legality checks, lines 20–43):

```typescript
// lines 20–33: existing validation pattern
if (feature.workControl !== 'awaiting_merge') {
  throw new GraphValidationError(`...`);
}

// NEW: insert cap check here, before seq increment
const currentReentryCount = feature.mergeTrainReentryCount ?? 0;
if (cap !== undefined && currentReentryCount >= cap) {
  // Caller (FeatureLifecycleCoordinator) must have already called ejectFromQueue;
  // this guard prevents re-enqueue beyond the cap. Throw so callers can route
  // to parking rather than silently swallowing the entry.
  throw new GraphValidationError(
    `Feature "${featureId}" has reached the merge-train re-entry cap (${currentReentryCount}/${cap})`,
  );
}
```

**Constructor injection pattern** (match `MergeTrainCoordinator` constructor — currently none, add):

```typescript
export class MergeTrainCoordinator {
  private _entrySeq = 0;

  constructor(private readonly reentryCap?: number) {}
  // cap is optional so existing call sites (new MergeTrainCoordinator())
  // remain valid; SchedulerLoop passes ports.config.reentryCap
}
```

**Eject + parking helper** (model after `ejectFromQueue` lines 139–154):

```typescript
ejectFromQueue(featureId: FeatureId, graph: FeatureGraph): 'ejected' | 'cap_reached' {
  const feature = graph.features.get(featureId);
  if (!feature) throw new GraphValidationError(...);

  const reentryCount = (feature.mergeTrainReentryCount ?? 0) + 1;
  graph.transitionFeature(featureId, { collabControl: 'branch_open' });
  graph.updateMergeTrainState(featureId, {
    mergeTrainManualPosition: undefined,
    mergeTrainEnteredAt: undefined,
    mergeTrainEntrySeq: undefined,
    mergeTrainReentryCount: reentryCount,
  });
  if (this.reentryCap !== undefined && reentryCount >= this.reentryCap) {
    return 'cap_reached';
  }
  return 'ejected';
}
```

---

### `src/orchestrator/features/index.ts` — cap-aware `failIntegration` + parking dispatch

**Role:** Bridges `MergeTrainCoordinator` state decisions with `FeatureGraph` mutations and inbox/event emission. Phase 6 extends `failIntegration` to check the cap result and call `appendInboxItem` instead of `enqueueRepairTask` when cap is reached.

**Closest analog:** `failIntegration` (lines 64–81) — the existing integration failure path that calls `ejectFromQueue`-equivalent logic and then `enqueueRepairTask`. The parking branch replaces the repair-task branch when cap is reached.

**Imports pattern** (lines 1–13, already present; no new imports needed beyond what `ports` provides via `OrchestratorPorts`):

```typescript
import { MAX_REPAIR_ATTEMPTS } from '@core/fsm/index';
import type { FeatureGraph } from '@core/graph/index';
import { MergeTrainCoordinator } from '@core/merge-train/index';
import type {
  AgentRunPhase, Feature, FeatureId, Task, TaskId,
  VerificationSummary, VerifyIssue,
} from '@core/types/index';
```

**Cap parking pattern** (model after `failIntegration` lines 64–81, plus `appendInboxItem` from `src/orchestrator/scheduler/events.ts` lines 220–232):

```typescript
failIntegration(
  featureId: FeatureId,
  ports: Pick<OrchestratorPorts, 'store'>,
  summary?: string,
): void {
  const feature = this.requireFeature(featureId);
  const ejected = this.mergeTrain.ejectFromQueue(featureId, this.graph);

  if (ejected === 'cap_reached') {
    // Park: do not requeue. Emit inbox item with diagnostics.
    const now = Date.now();
    ports.store.appendInboxItem({
      id: `inbox-merge-cap-${featureId}-${now}`,
      ts: now,
      featureId,
      kind: 'merge_train_cap_reached',
      payload: {
        reentryCount: feature.mergeTrainReentryCount ?? 0,
        reason: summary ?? 'merge-train re-entry cap reached',
      },
    });
    ports.store.appendEvent({
      eventType: 'merge_train_feature_parked',
      entityId: featureId,
      timestamp: now,
      payload: {
        reentryCount: feature.mergeTrainReentryCount ?? 0,
        ...(summary !== undefined ? { summary } : {}),
      },
    });
    return;
  }

  // Normal path: create repair task (existing code below, lines 75–80)
  this.enqueueRepairTask(featureId, 'integration', 'integration issues', summary);
}
```

**`createIntegrationRepair` pattern (lines 83–94) remains unchanged.** Phase 6 only extends `failIntegration`; `createIntegrationRepair` is called from the cross-feature release path in `events.ts` which is independent of the cap check.

---

### `src/orchestrator/scheduler/events.ts` — `feature_integration_failed` handler extension

**Role:** Scheduler event reducer. Phase 6 must thread `ports` into `features.failIntegration` so it can call `appendInboxItem` and `appendEvent`. The handler itself needs no new branches, only the delegation call gains an argument.

**Closest analog:** The existing `feature_integration_failed` handler (lines 565–568):

```typescript
// lines 565-568 (existing):
if (event.type === 'feature_integration_failed') {
  features.failIntegration(event.featureId, event.error);
  return;
}
```

**Extended call pattern** (pass `ports` so coordinator can emit inbox/event):

```typescript
if (event.type === 'feature_integration_failed') {
  features.failIntegration(event.featureId, ports, event.error);
  return;
}
```

**New event type in `SchedulerEvent` union** (extend lines 76–83 pattern, matching existing discriminated union shape):

```typescript
// Add alongside existing feature_integration_failed (lines 80-83):
| {
    type: 'feature_integration_failed';
    featureId: FeatureId;
    error: string;
    reason?: 'rebase_conflict' | 'post_rebase_block' | 'verify_failure';
  }
```

**Exhaustiveness guard (line 609)** — no change required if the new `reason` field is optional. If a separate event variant is introduced instead, the existing exhaustiveness pattern must be extended:

```typescript
// lines 607-610 (existing exhaustiveness gate — must stay in sync):
const _exhaustive: never = event;
void _exhaustive;
```

---

### `src/orchestrator/scheduler/warnings.ts` — re-entry warning suppression when parked

**Role:** Warning emission loop. When a feature is parked (cap reached), the `feature_churn` warning key must still be deduped to avoid spurious re-fires. No structural change is needed; the existing `activeWarningKeys` Set already handles key reuse.

**Closest analog:** `emitWarningSignals` lines 22–94 — the full warning loop showing the pattern of building `activeWarningKeys`, guard with `emittedWarnings.has(warningKey)`, and calling `store.appendEvent`.

**Pattern to reuse verbatim** (lines 43–55):

```typescript
store.appendEvent({
  eventType: 'warning_emitted',
  entityId: warning.entityId,
  timestamp: warning.occurredAt,
  payload: {
    category: warning.category,
    message: warning.message,
    ...(warning.payload !== undefined ? { extra: warning.payload } : {}),
  },
});
```

**No new warning category needed for cap parking.** The `feature_churn` category already covers repeated re-entry. Cap parking is an action (inbox item + event), not a new warning signal. This avoids conflating enforcement with advisory signals.

---

### `src/config/schema.ts` — `reentryCap` already parsed; no schema change needed

**Role:** Config schema. `reentryCap` is already at line 158:

```typescript
reentryCap: z.number().int().positive().default(10),
```

**Usage pattern** (model after how `featureChurnThreshold` is read in `src/orchestrator/scheduler/index.ts` lines 67–78):

```typescript
// SchedulerLoop constructor — existing pattern:
this.warnings = new WarningEvaluator({
  featureChurnThreshold: 3,   // hard-coded; reentryCap is separate
  ...
});

// NEW: pass reentryCap to MergeTrainCoordinator:
this.features = new FeatureLifecycleCoordinator(
  graph,
  ports.config.reentryCap,   // thread config into coordinator
);
```

**`FeatureLifecycleCoordinator` constructor** must forward the cap to `MergeTrainCoordinator`:

```typescript
// src/orchestrator/features/index.ts lines 14-17 (existing):
export class FeatureLifecycleCoordinator {
  private readonly mergeTrain = new MergeTrainCoordinator();

  constructor(private readonly graph: FeatureGraph) {}
```

Change to:

```typescript
  private readonly mergeTrain: MergeTrainCoordinator;

  constructor(
    private readonly graph: FeatureGraph,
    reentryCap?: number,
  ) {
    this.mergeTrain = new MergeTrainCoordinator(reentryCap);
  }
```

---

### `src/persistence/migrations/*.sql` — new migration for parked/parking state if needed

**Role:** Schema migration. Cap parking is surfaced via `inbox_items` (already exists from migration 0005) and an `appendEvent` call — no new column is needed unless a `merge_train_parked_at` audit field is desired on features.

**Existing inbox schema** (from `0005_inbox_items.sql`) already supports `featureId` and arbitrary `kind`:

```sql
-- 0005_inbox_items.sql (lines 14-23):
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NULL,
  agent_run_id TEXT NULL,
  feature_id TEXT NULL,         -- featureId goes here for merge-train parking
  kind TEXT NOT NULL,            -- 'merge_train_cap_reached'
  payload TEXT NOT NULL,         -- JSON: { reentryCount, reason }
  resolution TEXT NULL
);
```

**If a parking audit column is added** (optional), follow the `0007_agent_runs_trailer_observed_at.sql` pattern (additive nullable ALTER TABLE):

```sql
-- 000N_features_merge_train_parked_at.sql
-- Additive, nullable column — existing rows populate as NULL.
ALTER TABLE features ADD COLUMN merge_train_parked_at INTEGER NULL;
```

**Migration index file** (`src/persistence/migrations/index.ts`) must be updated if new `.sql` files are added — follow the existing runner pattern.

---

### `src/orchestrator/conflicts/cross-feature.ts` — no new patterns; verify coverage only

**Role:** Cross-feature release after integration. The existing `releaseCrossFeatureOverlap` and `resumeCrossFeatureTasks` functions already handle the success-path secondary release. Phase 6 adds no new code here — it only adds tests proving the failure path (`feature_integration_failed`) does not starve blocked secondaries.

**The key invariant to prove in tests** (from `events.ts` lines 539–562): after `feature_integration_failed`, the feature's `collabControl` moves to `conflict` via `failIntegration`. The existing cross-feature release loop in `feature_integration_complete` does NOT fire. Tests must confirm that secondaries blocked on the ejected feature are either released by a subsequent successful integration or are represented by their own repair tasks (which the `createIntegrationRepair` path already provides on the resumed-secondary path).

**Existing function signatures to reuse** (no changes):

```typescript
// src/orchestrator/conflicts/cross-feature.ts lines 70-137:
export async function releaseCrossFeatureOverlap(
  deps: CrossFeatureDeps,
  primaryFeatureId: FeatureId,
): Promise<CrossFeatureReleaseResult[]>

// Result shape (src/orchestrator/conflicts/types.ts):
type CrossFeatureReleaseResult =
  | { kind: 'resumed'; featureId: FeatureId; blockedByFeatureId: FeatureId }
  | { kind: 'blocked'; featureId: FeatureId; blockedByFeatureId: FeatureId; summary?: string }
  | { kind: 'repair_needed'; featureId: FeatureId; blockedByFeatureId: FeatureId; conflictedFiles?: string[]; summary?: string }
```

---

## Shared Patterns

### Inbox item emission
**Source:** `src/orchestrator/scheduler/events.ts` lines 220–232 (semantic failure) and 309–319 (destructive action)
**Apply to:** cap-parking call in `failIntegration`, reconciler startup parking

```typescript
ports.store.appendInboxItem({
  id: `inbox-${kind}-${entityId}-${now}`,
  ts: now,
  featureId,                       // set for feature-scoped items
  kind: 'merge_train_cap_reached', // new kind; must match inbox_items.kind constraint
  payload: {
    reentryCount,
    reason,
  },
});
```

### Event emission (append-only audit trail)
**Source:** `src/orchestrator/scheduler/events.ts` lines 412–422 (proposal_applied)
**Apply to:** every new merge-train diagnostic event

```typescript
ports.store.appendEvent({
  eventType: 'merge_train_feature_parked',  // new event type string
  entityId: featureId,
  timestamp: Date.now(),
  payload: {
    reentryCount,
    ...(summary !== undefined ? { summary } : {}),
  },
});
```

**Convention:** `payload` keys use optional spread (`...(x !== undefined ? { key: x } : {})`) to avoid setting `undefined` on strict-mode objects. See lines 498–503 in `events.ts`.

### Config-driven threshold injection
**Source:** `src/orchestrator/scheduler/index.ts` lines 67–79 (WarningEvaluator construction)
**Apply to:** `MergeTrainCoordinator` constructor, `FeatureLifecycleCoordinator` constructor

```typescript
// SchedulerLoop constructor — pass config value, let class default to undefined
this.features = new FeatureLifecycleCoordinator(
  graph,
  ports.config.reentryCap,   // GvcConfig.reentryCap: number, default 10
);
```

### GraphValidationError for illegal state transitions
**Source:** `src/core/merge-train/index.ts` lines 18–32, 96–103
**Apply to:** new cap guard in `enqueueFeatureMerge`

```typescript
import { GraphValidationError } from '@core/graph/index';

throw new GraphValidationError(
  `Feature "${featureId}" has reached the merge-train re-entry cap (${reentryCount}/${cap})`,
);
```

---

## Test Patterns

### Unit test: `test/unit/core/merge-train.test.ts` — extend existing test file

**Closest analog:** Lines 268–300 — "increments reentry count across eject and re-enqueue" test which exercises the full eject+re-enqueue cycle. Phase 6 adds a test proving the cap is enforced and the return value distinguishes parking from normal ejection.

**Pattern to copy** (fixture setup + coordinator method call + assertion shape):

```typescript
// From test/unit/core/merge-train.test.ts lines 269-300:
it('increments reentry count across eject and re-enqueue', () => {
  const coord = new MergeTrainCoordinator();
  const feat = createFeatureFixture({
    id: 'f-1',
    workControl: 'awaiting_merge',
    collabControl: 'branch_open',
    dependsOn: [],
  });
  const graph = buildGraph(feat);

  coord.enqueueFeatureMerge('f-1', graph);
  coord.ejectFromQueue('f-1', graph);
  coord.enqueueFeatureMerge('f-1', graph);

  const afterReenqueue = graph.features.get('f-1');
  expect(afterReenqueue?.mergeTrainReentryCount).toBe(1);
  expect(afterReenqueue?.collabControl).toBe('merge_queued');
});
```

**New cap tests to add** (same file, same `buildGraph` helper):

```typescript
it('returns cap_reached when eject pushes count to reentryCap', () => {
  const coord = new MergeTrainCoordinator(/* cap= */ 1);
  const feat = createFeatureFixture({
    id: 'f-1',
    workControl: 'awaiting_merge',
    collabControl: 'merge_queued',
    mergeTrainReentryCount: 0,
    mergeTrainEntrySeq: 1,
  });
  const graph = buildGraph(feat);

  const result = coord.ejectFromQueue('f-1', graph);
  expect(result).toBe('cap_reached');
  expect(graph.features.get('f-1')?.mergeTrainReentryCount).toBe(1);
  expect(graph.features.get('f-1')?.collabControl).toBe('branch_open');
});

it('throws on re-enqueue when cap is already at or above limit', () => {
  const coord = new MergeTrainCoordinator(/* cap= */ 1);
  const feat = createFeatureFixture({
    id: 'f-1',
    workControl: 'awaiting_merge',
    collabControl: 'branch_open',
    mergeTrainReentryCount: 1,   // already at cap
    dependsOn: [],
  });
  const graph = buildGraph(feat);

  expect(() => coord.enqueueFeatureMerge('f-1', graph)).toThrow(GraphValidationError);
});
```

---

### Unit test: `test/unit/orchestrator/scheduler-loop.test.ts` — extend integration-event section

**Closest analog (most directly useful):** The `feature_integration_failed` test at line 5043–5121, which seeds two features, enqueues the failure event, and asserts on `conflict/executing_repair` plus `mergeTrainReentryCount: 1`. The test also proves the next-in-queue feature advances to `integrating`.

**Pattern to copy for cap-parking test** (graph seed + loop.enqueue + loop.step + assertions):

```typescript
// Lines 5043-5121 — "ejects failed integration into conflict and starts next queued feature"
// Copy this setup verbatim; change only:
//   1. mergeTrainReentryCount on f-1 to (cap - 1) so one more eject reaches cap
//   2. createPorts with { reentryCap: N } to inject cap
//   3. Assert appendInboxItem was called with kind 'merge_train_cap_reached'
//   4. Assert f-1 does NOT get a repair task (workControl stays at awaiting_merge
//      or collabControl at branch_open without executing_repair transition)

const appendInboxItem = vi.spyOn(ports.store, 'appendInboxItem');
// ... (loop.enqueue and loop.step as before) ...
expect(appendInboxItem).toHaveBeenCalledWith(
  expect.objectContaining({
    kind: 'merge_train_cap_reached',
    featureId: 'f-1',
  }),
);
```

**Store mock** for tests that assert on inbox items: the existing `createStoreMock()` (lines 86–197) stubs `appendInboxItem` as a no-op. To assert on it, use `vi.spyOn(ports.store, 'appendInboxItem')` after construction.

---

### Integration test: `test/integration/merge-train.test.ts` — extend with cap enforcement

**Closest analog:** `createMergeTrainScenario()` harness in `test/integration/harness/merge-train-scenario.ts` — provides `db`, `graph`, `coord`, `clock`, and `seedFeatureAtAwaitingMerge`. Phase 6 should add a `seedFeatureAtReentryCap` helper or inline fixture that seeds a feature with `mergeTrainReentryCount` already at `cap - 1`.

**Harness extension pattern** (lines 58–96 of `merge-train-scenario.ts`):

```typescript
// New helper to add to the MergeTrainScenario interface / factory:
seedFeatureNearCap(opts: {
  id: FeatureId;
  reentryCount: number;   // typically cap - 1
}): void;
```

Implementation mirrors `seedFeatureAtAwaitingMerge` but sets `mergeTrainReentryCount` directly via `graph.updateMergeTrainState` after the phase walk (line 90 pattern).

**Persistent graph rehydration assertion pattern** (lines 159–177 of `merge-train.test.ts`):

```typescript
// After parking, create a second PersistentFeatureGraph over the same DB
// and confirm inbox_items count + feature collabControl are correct.
const rehydrated = new PersistentFeatureGraph(scenario.db, () => scenario.clock.now);
const feature = rehydrated.features.get('f-1');
expect(feature?.collabControl).toBe('branch_open');       // not re-queued
expect(feature?.mergeTrainReentryCount).toBe(cap);         // preserved
// ... query inbox_items via scenario.db directly for kind check ...
```

---

## No Analog Found

All Phase 6 change areas have strong analogs in the codebase. No files require building entirely new patterns.

| Area | Reason all analogs exist |
|------|--------------------------|
| Cap enforcement in `MergeTrainCoordinator` | `ejectFromQueue` + `enqueueFeatureMerge` guards are structurally identical; Phase 6 adds return value and cap argument |
| Parking via `appendInboxItem` | `semantic_failure` (events.ts:220) and `destructive_action` (events.ts:309) establish the exact call shape |
| Config injection of `reentryCap` | `reentryCap` is already parsed in `GvcConfigSchema`; injection follows the `warnAtPercent`/`featureChurnThreshold` pattern in `SchedulerLoop` constructor |
| Diagnostics via `appendEvent` | All existing event types in `events.ts` establish the `{ eventType, entityId, timestamp, payload }` shape |
| Cross-feature release tests | Scheduler-loop tests lines 4256–5041 cover both clean-rebase and conflict outcomes after `feature_integration_complete`; Phase 6 only needs the symmetric failure-side coverage |

---

## Metadata

**Analog search scope:** `src/core/merge-train/`, `src/orchestrator/features/`, `src/orchestrator/scheduler/`, `src/orchestrator/conflicts/`, `src/core/warnings/`, `src/config/`, `src/persistence/migrations/`, `test/unit/core/`, `test/unit/orchestrator/`, `test/integration/`
**Files scanned:** 22
**Pattern extraction date:** 2026-04-25
