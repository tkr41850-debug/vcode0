# Phase 6: Merge Train — Research

**Researched:** 2026-04-25
**Domain:** Merge-train integration executor, re-entry cap enforcement, agent-review verify, cross-feature release
**Confidence:** HIGH (all findings verified from codebase; no external library research required)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- Keep `src/core/merge-train/index.ts` as the queue-ordering source of truth. Ordering contract is locked: `mergeTrainManualPosition` first, then `mergeTrainReentryCount` descending, then `mergeTrainEntrySeq` FIFO.
- Keep the scheduler-owned integration start point in `src/orchestrator/scheduler/index.ts`. `beginNextIntegration()` is already called every tick.
- `collabControl='integrating'` is the single active merge-train slot. No parallel integration or speculative verification.
- Preserve the current split of responsibilities: core decides queue legality and ordering; orchestrator decides failure routing, repairs, inbox escalation, and cross-feature release.
- Merge-train verification must reuse the Phase 5 verify-agent contract (`VerificationSummary`/`VerifyIssue`).
- Strict-main sequence: rebase onto latest `main`, run agent review, then either emit `feature_integration_complete` or `feature_integration_failed` without advancing `main` on failure.
- Integration failures continue routing through `repairSource='integration'` with richer diagnostics.
- Feature exit on integration failure: `integrating → conflict` + repair/re-entry, with failure payload distinguishing why (rebase conflict, coordination block, merge-train verify failure).
- Cap enforcement: default 10, configurable (`config.reentryCap`), enforced on enqueue/re-entry, not merely warned.
- `mergeTrainReentryCount` is the canonical persisted counter.
- Preserve biasing: higher re-entry counts sort earlier; Phase 6 adds a hard stop at cap instead of removing priority bias.
- At cap: park via inbox item with diagnostics rather than requeue.
- Treat `> cap` as anomaly: startup/reconciliation must park the feature.
- Manual override stays `mergeTrainManualPosition` only; does not bypass cap rules or verification.
- Reuse `src/orchestrator/conflicts/cross-feature.ts` for blocked-secondary release.
- If integration exits on conflict or verify failure, blocked secondaries must not be silently starved — symmetric release path required.
- Re-entry-cap parking must produce a real inbox payload via `appendInboxItem`, not just a warning event.
- Integration failures that become repair work should preserve actionable summaries.

### Claude's Discretion

- Exact event names and payload shapes for new merge-train diagnostics (must remain consistent with existing append-only event patterns and inbox-item contracts).
- Whether merge-train verification is triggered via feature-phase agent reuse path or a dedicated integration runner, provided REQ-MERGE-04 is satisfied and `main` stays strict.

### Deferred Ideas (OUT OF SCOPE)

- Speculative parallel rebase+verify or batch merges (REQ-MERGE-V2-01/02).
- Richer arbitrary persistent manual ordering (v2).
- TUI-level queue control and inbox presentation polish (Phase 8+).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-MERGE-01 | Merge train serializes feature-branch integration into `main`; `main` never in a bad state | Serial slot already enforced by `collabControl='integrating'`; integration runner must emit `feature_integration_complete` only after confirmed merge, and `feature_integration_failed` on any failure without advancing `main` |
| REQ-MERGE-02 | Queue head rebases onto latest `main`, runs merge-train verification, then merges — or is ejected for repair | Rebase infrastructure exists in `conflicts/git.ts`; verification reuses Phase 5 `VerificationService.verifyFeature` or `agents.verifyFeature`; the integration runner is the missing producer of the integration events |
| REQ-MERGE-03 | Re-entry count is capped (configurable, default 10); on cap, feature is parked in inbox with diagnostics | `config.reentryCap` field exists in schema with default 10; `mergeTrainReentryCount` persisted in DB; cap never read or checked anywhere in production paths today — enforcement is the gap |
| REQ-MERGE-04 | Verification before merge is an agent review, not tests/type-check; verify agent reads diff against feature goal | `agents.verifyFeature()` already runs a pi-sdk agent; `getChangedFiles(baseRef)` already accepts non-`main` refs; need to wire this at integration time using the rebased feature-branch ref |
</phase_requirements>

---

## Summary

Phase 6 completes the merge-train integration loop by filling three implementation gaps that remain after Phase 5:

**Gap 1 — Integration executor (REQ-MERGE-01/02/04):** The scheduler's event bus already consumes `feature_integration_complete` and `feature_integration_failed`, and the event reducers are already coded. However, no production code today produces these events. The integration runner — the code that actually performs the rebase-onto-main, runs the merge-train agent review, and either fast-forward merges or ejects — does not yet exist in the scheduler dispatch path. The `integration_state` table (migration 0002) and `VerificationService.verifyFeature` are ready; they just have no caller in the integration context.

**Gap 2 — Re-entry cap enforcement (REQ-MERGE-03):** `config.reentryCap` is parsed and defaulted to 10 (verified in `src/config/schema.ts`). `mergeTrainReentryCount` is persisted in SQLite and already incremented on every ejection. However, no code in any production path ever reads `reentryCap` or compares it against the feature's count. The enforcement gating point — `FeatureLifecycleCoordinator.failIntegration` and `MergeTrainCoordinator.enqueueFeatureMerge` — are both uncapped today. An over-cap feature can cycle indefinitely.

**Gap 3 — Symmetric cross-feature release on integration failure (partial):** `feature_integration_complete` already calls `releaseCrossFeatureOverlap`, which unblocks and rebases secondaries. `feature_integration_failed` today only calls `features.failIntegration` and returns; it does not release blocked secondaries. A feature blocked by an `integrating` primary would be silently starved if the primary fails rather than completes.

**Primary recommendation:** Implement in three plans: (1) cap enforcement + inbox parking as a pure orchestrator/coordinator change with no new git work, (2) integration executor that wires rebase + agent-review verify + event emission, (3) symmetric failure-path cross-feature release.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Queue ordering and slot legality | `core/merge-train` | — | Pure domain logic; no git, no IO |
| Re-entry cap check on enqueue/fail | `orchestrator/features` | `core/merge-train` | Reads `config.reentryCap`; mutates graph; parks via store |
| Inbox parking payload construction | `orchestrator/features` or `orchestrator/scheduler/events` | — | Must call `ports.store.appendInboxItem()`; stays inside tick |
| Integration executor (rebase + verify + merge) | `orchestrator/scheduler/dispatch` or new integration module | `conflicts/git`, `agents` | Needs worktree access, git ops, agent runtime; produces SchedulerEvent |
| Integration event consumption (complete/failed) | `orchestrator/scheduler/events` | `orchestrator/features`, `orchestrator/conflicts` | Already exists; will be extended for symmetric failure-path release |
| Cross-feature overlap release on integration exit | `orchestrator/conflicts/cross-feature` | `orchestrator/features` | Existing `releaseCrossFeatureOverlap` function covers success; failure path needs symmetric call |
| Merge-train agent review | `orchestrator/scheduler/dispatch` (via `ports.agents.verifyFeature`) | `orchestrator/services/verification-service` | Agent review satisfies REQ-MERGE-04; shell-check layer satisfies REQ-MERGE-02 pre-merge gate |
| SHA anchoring / crash recovery marker | `persistence/sqlite-store` + `integration_state` table | — | Already migrated (0002); not yet read by production code |

---

## Standard Stack

No new libraries required. Phase 6 is entirely within the existing stack.

| Component | Location | Version/API | Purpose |
|-----------|----------|-------------|---------|
| `MergeTrainCoordinator` | `src/core/merge-train/index.ts` | Existing | Queue ordering, `beginIntegration`, `completeIntegration`, `ejectFromQueue` |
| `FeatureLifecycleCoordinator` | `src/orchestrator/features/index.ts` | Existing | `failIntegration`, `createIntegrationRepair`, `beginNextIntegration` |
| `SchedulerEvent` union | `src/orchestrator/scheduler/events.ts` | Existing | `feature_integration_complete`, `feature_integration_failed` already typed |
| `OrchestratorPorts.store.appendInboxItem` | `src/orchestrator/ports/index.ts` | Existing | Append inbox rows for cap-park payloads |
| `OrchestratorPorts.agents.verifyFeature` | `src/agents/runtime.ts` | Existing | Agent review path; returns `VerificationSummary` |
| `VerificationService.verifyFeature` | `src/orchestrator/services/verification-service.ts` | Existing | Shell-check layer; returns `VerificationSummary` |
| `releaseCrossFeatureOverlap` | `src/orchestrator/conflicts/cross-feature.ts` | Existing | Release blocked secondaries after integration exits |
| `rebaseGitDir` | `src/orchestrator/conflicts/git.ts` | Existing | `rebaseGitDir(featureDir, 'main')` returns `{kind: 'clean' | 'blocked' | 'conflict'}` |
| `worktreePath` | `src/core/naming/index.ts` | Existing | Derive worktree directory from branch name |
| `integration_state` table | migration 0002 | SQLite | Crash-recovery marker (present in DB but not wired to production code yet) |
| `config.reentryCap` | `src/config/schema.ts` line 158 | `z.number().int().positive().default(10)` | Cap value; already in `GvcConfig` |

---

## Architecture Patterns

### System Architecture Diagram

```
[Scheduler tick] ─► [events drain] ─► [summaries.reconcilePostMerge()]
                                              │
                                    [features.beginNextIntegration()]
                                              │
                              merge_queued feature ──► collabControl='integrating'
                                              │
                         [NEW: IntegrationRunner.runIntegration(feature)]
                                         /         \
                                    [rebase]    [cap check on re-entry]
                                    onto main        │
                                       │         over cap ──► appendInboxItem
                                  conflict?             (park, no re-enqueue)
                                   /    \
                              yes          no
                               │           │
                     feature_integration  [shell verify via VerificationService]
                     _failed               │
                     (eject + release     fail? ──► feature_integration_failed
                      secondaries)         │         (eject + release secondaries)
                                          pass
                                           │
                               [agent review via agents.verifyFeature]
                                      (REQ-MERGE-04)
                                           │
                                    issues? ──► feature_integration_failed
                                     │         (eject + release secondaries)
                                    pass
                                     │
                               [git fast-forward merge onto main]
                                     │
                               feature_integration_complete
                                     │
                           [events.ts consumer]
                          /                    \
                  completeIntegration    releaseCrossFeatureOverlap
                  (collabControl=merged)   (resume/repair blocked secondaries)
```

### Integration Runner Placement

**Option A: Inline in `dispatchReadyWork`** — Add an `integrating` feature unit type to `prioritizeReadyWork` / `dispatchReadyWork`. Rejected: `integrating` features are deliberately excluded from `readyFeatures()` (line 39 of `queries.ts`), and the scheduler runs integration immediately in the same tick as `beginNextIntegration`, so this is not a dispatch-style unit.

**Option B: Dedicated async call from scheduler tick** — Add `await this.runPendingIntegration(now)` to the `tick()` method in `SchedulerLoop`, after `features.beginNextIntegration()`. The integration scan looks for any feature with `collabControl='integrating'` and runs the executor if one exists and no integration run row is `running`. This is the recommended pattern. [VERIFIED: codebase structure]

The tick order would become:
```
events drain → summaries.reconcilePostMerge() → features.beginNextIntegration()
→ this.runPendingIntegration(now)   ← NEW
→ coordinateSameFeatureRuntimeOverlaps → coordinateCrossFeatureRuntimeOverlaps
→ emitWarningSignals → dispatchReadyWork
```

**Crash recovery:** When the orchestrator restarts, a feature with `collabControl='integrating'` and an active `integration_state` row signals an in-progress integration that died. The reconciler must check whether `main` already has the feature's commits (by checking `main_merge_sha` against `git log`) and emit the appropriate event. This reconciler belongs in the startup path (not in Phase 6 scope per CONTEXT deferred list, but the `integration_state` table already supports it when Phase 6 writes the marker row).

### Recommended File Touchpoints

```
src/orchestrator/scheduler/
├── index.ts                    (MODIFY — add runPendingIntegration call in tick)
├── events.ts                   (MODIFY — feature_integration_failed must also release cross-feature overlap)
├── integration-runner.ts       (NEW — rebase + verify + merge + event emission)
└── dispatch.ts                 (no change needed)

src/orchestrator/features/
└── index.ts                    (MODIFY — cap enforcement in failIntegration + enqueueFeatureMerge path)

src/core/merge-train/
└── index.ts                    (MODIFY or leave — cap can live in features/index.ts reading config; coordinator stays pure)

src/core/warnings/index.ts      (MODIFY — add merge_train_reentry_cap_reached WarningCategory if desired, or leave warnings as advisory only and rely on inbox)
```

### Pattern: Cap Enforcement on Re-entry

The cap check must happen at two enforcement points:

1. **Enqueue guard (`enqueueFeatureMerge` or its caller):** Before transitioning `collabControl` to `merge_queued`, check `feature.mergeTrainReentryCount >= config.reentryCap`. If at or over cap, park the feature instead of enqueueing.

2. **Post-ejection check (`failIntegration`):** After incrementing `reentryCount` (which happens before this function returns), the resulting count must be compared to `reentryCap`. If the new count equals the cap, park immediately.

Because `MergeTrainCoordinator` is a pure coordinator (no access to config or ports), the cap enforcement must live in `FeatureLifecycleCoordinator` which already holds graph access and delegates to the merge train coordinator. The config must be threaded in.

**Pattern: existing `appendInboxItem` shape:**
```typescript
// Source: src/orchestrator/scheduler/events.ts (existing semantic_failure example)
ports.store.appendInboxItem({
  id: `inbox-${featureId}-mt-cap-${now}`,
  ts: now,
  featureId,
  kind: 'merge_train_cap_reached',
  payload: {
    reentryCount,
    cap: reentryCap,
    lastEjectionReason: summary,
    featureId,
  },
});
```
[VERIFIED: `InboxItemAppend.kind` is `string`, not a union — any string is valid]
[VERIFIED: `InboxItemAppend.featureId` exists as optional field — `src/orchestrator/ports/index.ts` line 54]

### Pattern: Integration Runner Skeleton

```typescript
// src/orchestrator/scheduler/integration-runner.ts
export async function runIntegrationIfPending(params: {
  graph: FeatureGraph;
  ports: OrchestratorPorts;
  handleEvent: (event: SchedulerEvent) => Promise<void>;
  now: number;
}): Promise<void> {
  // Find integrating feature
  let integratingFeature: Feature | undefined;
  for (const feature of params.graph.features.values()) {
    if (feature.collabControl === 'integrating') {
      integratingFeature = feature;
      break;
    }
  }
  if (integratingFeature === undefined) return;

  // Guard: already running (by checking integration_state or a run row)
  // ... (idempotency check)

  const feature = integratingFeature;
  const featureDir = resolveFeatureWorktreePath(feature, params.ports);

  // Step 1: Rebase onto main
  const rebase = await rebaseGitDir(featureDir, 'main');
  if (rebase.kind !== 'clean') {
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error: rebase.kind === 'blocked'
        ? 'worktree missing during integration rebase'
        : `rebase conflict: ${rebase.conflictedFiles?.join(', ') ?? 'unknown files'}`,
    });
    return;
  }

  // Step 2: Shell verification layer (ci_check equivalent for merge-train)
  const shellVerify = await params.ports.verification.verifyFeature(feature);
  if (!shellVerify.ok) {
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error: shellVerify.summary ?? 'merge-train shell verification failed',
    });
    return;
  }

  // Step 3: Agent review (REQ-MERGE-04)
  const agentVerify = await params.ports.agents.verifyFeature(
    feature,
    { agentRunId: `run-integration:${feature.id}` },
  );
  if (!agentVerify.ok) {
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error: agentVerify.summary ?? 'merge-train agent review failed',
    });
    return;
  }

  // Step 4: Fast-forward merge onto main
  await mergeFeatureBranchOntoMain(featureDir, feature);

  await params.handleEvent({
    type: 'feature_integration_complete',
    featureId: feature.id,
  });
}
```

[ASSUMED: `agents.verifyFeature` can accept a custom `agentRunId` that doesn't conflict with the feature-phase convention `run-feature:${id}:verify`. The run-ID format should be `run-integration:${featureId}` to avoid collision.]

### Anti-Patterns to Avoid

- **Producing integration events outside the tick boundary:** `handleEvent` must be called within the graph tick's enter/leave pair. The integration runner is async but must ensure all emitted events are processed via `handleEvent`, which is serialized within the tick boundary.
- **Reading integration_state in the hot path:** The `integration_state` table is for crash recovery. In the non-crash path, use the in-memory graph state (`collabControl='integrating'`) as the authority.
- **Capping at enqueue only:** The cap must also be checked in `failIntegration` because a feature that was at `cap - 1` when it last entered the queue will only cross the threshold after the ejection increments the counter.
- **Symmetric-failure omission:** `feature_integration_failed` must call `releaseCrossFeatureOverlap` before returning. Without it, any secondary blocked by the (now-failed) integrating feature would be stranded with `runtimeBlockedByFeatureId` pointing to a feature that is now in `conflict` state.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Rebase onto main | Custom git subprocess | `rebaseGitDir(featureDir, 'main')` in `src/orchestrator/conflicts/git.ts` | Already handles conflict detection, `conflictedFiles` extraction, `blocked` (missing worktree) case |
| Agent review | New agent type | `ports.agents.verifyFeature(feature, run)` | Phase 5 already implements full verify-agent with `VerificationSummary` and `VerifyIssue` fan-out |
| Shell verification | Separate runner | `ports.verification.verifyFeature(feature)` — `VerificationService` | Handles `verification.mergeTrain` config layer with fallback to `verification.feature` |
| Inbox parking | Custom table row | `ports.store.appendInboxItem(item)` | Already persisted in `inbox_items` table; Phase 7 adds resolution UI |
| Re-entry count persistence | Direct SQL | `graph.updateMergeTrainState(featureId, { mergeTrainReentryCount })` | Persists through the graph mutation path to SQLite atomically |
| Cross-feature release | New release logic | `conflicts.releaseCrossFeatureOverlap(featureId)` | Already handles rebase, task resume, `repair_needed` fan-out |

---

## Common Pitfalls

### Pitfall 1: Integration Runner Idempotency
**What goes wrong:** If the scheduler tick fires twice while an integration is already in progress (e.g., the async integration runner hasn't returned yet), a second integration run starts on the same feature.
**Why it happens:** `beginNextIntegration` sets `collabControl='integrating'` but the integration runner is async. A second tick would see `collabControl='integrating'` and could start another runner.
**How to avoid:** Guard the integration runner with an in-memory flag or check whether an `AgentRun` with id `run-integration:${featureId}` already exists and is `running`. The tick loop is itself serial (one tick at a time per `loop()` implementation), so the guard is only needed against the case where the same tick is re-entered, which the tick boundary's enter/leave pattern already prevents.
**Warning signs:** Two `feature_integration_complete` events for the same feature in the same tick window.

### Pitfall 2: Cap Enforcement Double-Increment
**What goes wrong:** `MergeTrainCoordinator.ejectFromQueue` already increments `mergeTrainReentryCount`. `FeatureLifecycleCoordinator.failIntegration` also increments it independently. If Phase 6 adds a third increment for the cap path, the count will be off by one.
**Why it happens:** `failIntegration` (line 66-74 of `features/index.ts`) increments the count manually using `graph.updateMergeTrainState`, bypassing `ejectFromQueue`. The integration executor then should call `failIntegration`, not `ejectFromQueue` directly.
**How to avoid:** Verify the increment chain: `failIntegration` increments once, sets `collabControl='conflict'`, and creates a repair task. `ejectFromQueue` increments once and sets `collabControl='branch_open'`. These are different failure paths; do not mix them. The cap check must happen after the single increment, not create a second one.

### Pitfall 3: Missing Cross-Feature Release on Integration Failure
**What goes wrong:** A secondary feature blocked by `runtimeBlockedByFeatureId` stays blocked forever after the primary integration fails.
**Why it happens:** `feature_integration_failed` handler today (events.ts line 565-567) only calls `features.failIntegration`. `releaseCrossFeatureOverlap` is only called on `feature_integration_complete`. A failing integration leaves secondaries stranded.
**How to avoid:** In the `feature_integration_failed` handler, after `features.failIntegration`, also call `await conflicts.releaseCrossFeatureOverlap(event.featureId)`. Process the results the same way as the success path — `repair_needed` outcomes create integration repairs on the secondary feature.

### Pitfall 4: Agent Run ID Collision
**What goes wrong:** Merge-train agent review uses the same `agentRunId` format as the feature-phase verify (`run-feature:${featureId}:verify`). The scheduler then sees a `completed` verify run and skips dispatching the real feature-phase verify when the feature eventually re-enters that phase.
**Why it happens:** `ensureFeaturePhaseRun` looks up runs by `run-feature:${featureId}:${phase}`. If the integration runner uses the same ID, the store will return the integration's run row.
**How to avoid:** Use a distinct ID prefix: `run-integration:${featureId}`. Create the run row in the store only if logging is needed; otherwise, the integration runner can call `agents.verifyFeature` without creating an agent run row (the runtime itself records token usage internally).

### Pitfall 5: Cap Check at Wrong Boundary
**What goes wrong:** Cap is only checked at enqueue time. A feature that was at count `cap - 1` when it entered the queue will fail integration, have its count incremented to `cap` by `failIntegration`, then re-enqueue successfully because the enqueue check sees a fresh start (after repair lands, the feature re-enters via `markAwaitingMerge` → `enqueueFeatureMerge`).
**Why it happens:** The enqueue check sees count `cap - 1` at enqueue time (before the ejection), so it passes. The post-ejection count reaches `cap`, but nothing checks at that moment.
**How to avoid:** Check the cap in both places: (1) in `failIntegration` immediately after incrementing the count, and (2) in `enqueueFeatureMerge` or its caller before transitioning to `merge_queued`. This ensures a feature that hits cap on ejection is immediately parked without waiting for a repair to land and re-try the enqueue path.

---

## Code Examples

### Verified: `feature_integration_failed` handler (current, incomplete)
```typescript
// Source: src/orchestrator/scheduler/events.ts line 565
if (event.type === 'feature_integration_failed') {
  features.failIntegration(event.featureId, event.error);
  return;  // <-- missing: releaseCrossFeatureOverlap
}
```

### Verified: `feature_integration_complete` handler (current, correct)
```typescript
// Source: src/orchestrator/scheduler/events.ts line 539
if (event.type === 'feature_integration_complete') {
  features.completeIntegration(event.featureId);
  const releases = await conflicts.releaseCrossFeatureOverlap(event.featureId);
  for (const release of releases) {
    if (release.kind === 'repair_needed') {
      features.createIntegrationRepair(release.featureId, ...);
    }
    if (release.kind === 'blocked') {
      features.createIntegrationRepair(release.featureId, ...);
    }
  }
  return;
}
```
The `feature_integration_failed` handler needs the same release loop added after `features.failIntegration`.

### Verified: `failIntegration` (current, missing cap check)
```typescript
// Source: src/orchestrator/features/index.ts line 64
failIntegration(featureId: FeatureId, summary?: string): void {
  const feature = this.requireFeature(featureId);
  const reentryCount = (feature.mergeTrainReentryCount ?? 0) + 1;
  // <-- missing: if (reentryCount >= reentryCap) { park + return; }
  this.graph.transitionFeature(featureId, { collabControl: 'conflict' });
  this.graph.updateMergeTrainState(featureId, {
    mergeTrainReentryCount: reentryCount,
    ...
  });
  this.enqueueRepairTask(featureId, 'integration', 'integration issues', summary);
}
```

### Verified: `rebaseGitDir` return shape
```typescript
// Source: src/orchestrator/conflicts/git.ts (inferred from cross-feature.ts usage)
// Returns: { kind: 'clean' } | { kind: 'blocked'; summary?: string }
//        | { kind: 'conflict'; conflictedFiles: string[]; summary?: string }
```

### Verified: `appendInboxItem` call shape
```typescript
// Source: src/orchestrator/ports/index.ts line 49-57
// InboxItemAppend interface
{
  id: string;
  ts: number;
  taskId?: string;
  agentRunId?: string;
  featureId?: string;  // <-- already in interface
  kind: string;        // <-- not an enum; any string is valid
  payload: unknown;
}
```

### Verified: Config reentryCap field
```typescript
// Source: src/config/schema.ts line 158
reentryCap: z.number().int().positive().default(10),
// Accessible on GvcConfig as config.reentryCap
// Currently NEVER read in production code (only in test fixtures and schema tests)
```

---

## Gap Analysis Against Requirements

### REQ-MERGE-01 (Serialization, `main` stays clean)

**What exists:** `collabControl='integrating'` enforced as a singleton by `MergeTrainCoordinator.beginIntegration`. `readyFeatures()` explicitly excludes `integrating` features. Serialization is structurally enforced.

**What is missing:** The integration executor that actually does the git operations and emits events. Without it, `main` cannot advance because nothing ever emits `feature_integration_complete`. REQ-MERGE-01 is structurally sound but functionally incomplete.

**Gap:** Integration executor that emits events only after confirmed merge success.

### REQ-MERGE-02 (Rebase + verify + merge-or-eject)

**What exists:** `rebaseGitDir` in `conflicts/git.ts`. `VerificationService.verifyFeature` with `mergeTrain` layer config. `agents.verifyFeature` with `VerificationSummary` result. `feature_integration_complete`/`feature_integration_failed` event consumers.

**What is missing:** The integration runner that sequences these operations and emits events. The caller side of the entire rebase→verify→merge pipeline.

**Gap:** Integration runner module wiring existing components.

### REQ-MERGE-03 (Cap + inbox parking)

**What exists:** `config.reentryCap` parsed and defaulted. `mergeTrainReentryCount` persisted. `appendInboxItem` available. `feature_churn` warning emitted at threshold 3 (advisory only).

**What is missing:** Any read of `config.reentryCap` in production paths. Any comparison of `mergeTrainReentryCount` against the cap. Any parking logic. Any cap-reached inbox item.

**Gap:** Cap enforcement in `FeatureLifecycleCoordinator` (requires threading config through) and inbox parking call.

### REQ-MERGE-04 (Agent review, not tests)

**What exists:** `agents.verifyFeature(feature, run)` runs a full pi-sdk agent review. `getChangedFiles(baseRef)` accepts non-`main` refs (Phase 5-03 summary confirms this explicitly as a "Phase 6 handoff"). `VerificationSummary` carries `issues: VerifyIssue[]` for fan-out to repair tasks.

**What is missing:** A call to `agents.verifyFeature` from the integration context, using a `baseRef` pointing to the pre-integration main SHA (to diff the rebased feature branch against main) rather than the default.

**Gap:** Integration runner calling `agents.verifyFeature` with appropriate context, and wiring its failure result into `feature_integration_failed` with enough detail for repair task creation.

---

## Proposed 3-Plan Slice

### Plan 06-01: Cap Enforcement and Inbox Parking

**Scope:** Pure orchestrator/coordinator changes. No git operations. No integration runner. No new agent calls.

**Files touched:**
- `src/orchestrator/features/index.ts` — thread `reentryCap` into `FeatureLifecycleCoordinator`; add cap check in `failIntegration` and optionally in `markAwaitingMerge`
- `src/orchestrator/scheduler/index.ts` — pass `config.reentryCap` when constructing `FeatureLifecycleCoordinator` (or pass via `ports.config` which is already available)
- `src/orchestrator/ports/index.ts` — no change needed (config is already on `OrchestratorPorts`)

**Test targets:**
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: feature at cap gets inbox item instead of repair task after integration failure
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: feature at `> cap` on startup gets parked (startup reconciler test or a direct `failIntegration` unit test)
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: feature at `cap - 1` still gets repair task (boundary below cap)
- New unit test for `FeatureLifecycleCoordinator.failIntegration` cap logic in isolation

**Dependency:** None — can land first. Does not require the integration runner.

### Plan 06-02: Integration Runner (Rebase + Agent Review + Merge)

**Scope:** New `integration-runner.ts` module. Wire into `SchedulerLoop.tick()`. Emit `feature_integration_complete` or `feature_integration_failed` based on rebase + verify outcomes.

**Files touched:**
- `src/orchestrator/scheduler/integration-runner.ts` — NEW
- `src/orchestrator/scheduler/index.ts` — add `await this.runPendingIntegration(now)` in `tick()`
- `src/orchestrator/scheduler/events.ts` — add `feature_integration_failed` cross-feature release (see Gap 3 below, can land in this plan or 06-03)

**Test targets:**
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: rebase clean + agent review pass → `feature_integration_complete` emitted
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: rebase conflict → `feature_integration_failed` with conflict reason
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: rebase clean + agent review fail → `feature_integration_failed` with verify reason
- `test/integration/merge-train.test.ts` — add: full happy-path integration (may require faux worktree)

**Dependency:** 06-01 (cap enforcement should land first so the integration runner's ejection path is already capped).

### Plan 06-03: Symmetric Failure-Path Cross-Feature Release

**Scope:** One-line change to `feature_integration_failed` handler in `events.ts`, plus tests proving secondaries are released on integration failure.

**Files touched:**
- `src/orchestrator/scheduler/events.ts` — add `releaseCrossFeatureOverlap` call in `feature_integration_failed` handler

**Test targets:**
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: secondary blocked by integrating primary; primary fails; secondary is released (resumed or repair created)
- `test/unit/orchestrator/scheduler-loop.test.ts` — add: secondary blocked by integrating primary; primary fails due to rebase conflict; secondary gets integration repair

**Dependency:** 06-02 (the integration runner must exist to produce the `feature_integration_failed` events that the test exercises, though this can be unit-tested by directly enqueuing `feature_integration_failed` events as existing tests do).

**Note:** 06-03 can land in the same plan as 06-02 if the change is small enough (it is a 10-15 line addition to an existing handler). Splitting it out gives cleaner test attribution.

---

## Runtime State Inventory

This is not a rename/refactor phase. No runtime state inventory required.

---

## Environment Availability Audit

This phase is purely code changes within the existing repo. All dependencies (SQLite, better-sqlite3, simple-git, pi-sdk) are already installed and used. No new external tools are required.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `simple-git` | `getChangedFiles`, `rebaseGitDir` | Already in use | Existing | — |
| `better-sqlite3` | `integration_state` table writes | Already in use | Existing | — |
| `@mariozechner/pi-agent-core` | Integration agent review | Already in use | Existing | — |
| Git CLI | Rebase and merge operations | Already in use by tests | System git | — |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npm run test:unit` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-MERGE-01 | Integration runner emits complete only after confirmed merge | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "integration complete"` | ✅ (extend) |
| REQ-MERGE-01 | `main` not advanced on rebase conflict | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "rebase conflict"` | ❌ Wave 0 |
| REQ-MERGE-02 | Rebase → shell verify → agent review → merge sequence | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "integration runner"` | ❌ Wave 0 |
| REQ-MERGE-02 | Eject on any verify failure (shell or agent) | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "integration failed"` | ✅ (extend) |
| REQ-MERGE-03 | Feature at cap gets inbox item, not repair task | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "reentry cap"` | ❌ Wave 0 |
| REQ-MERGE-03 | Feature below cap still gets repair task | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "below cap"` | ❌ Wave 0 |
| REQ-MERGE-04 | Agent review called during integration (not just shell checks) | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "agent review"` | ❌ Wave 0 |
| REQ-MERGE-04 | Agent review failure ejects and creates repair tasks with issue summaries | unit | `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts -t "agent review fail"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test:unit`
- **Per wave merge:** `npm run test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] New test cases in `test/unit/orchestrator/scheduler-loop.test.ts` — cap enforcement (REQ-MERGE-03)
- [ ] New test cases in `test/unit/orchestrator/scheduler-loop.test.ts` — integration runner sequences (REQ-MERGE-01/02/04)
- [ ] New test cases in `test/unit/orchestrator/scheduler-loop.test.ts` — symmetric failure-path release (cross-feature)
- [ ] `src/orchestrator/scheduler/integration-runner.ts` — new module (Plan 06-02)
- [ ] Extend `test/integration/merge-train.test.ts` with full rebase + verify + merge happy-path scenario

---

## Security Domain

No new security surface is introduced. Integration operations are performed by the orchestrator process on local git worktrees. The agent review uses the existing `verifyFeature` path with identical security posture to Phase 5. No new network calls, no new input parsing surfaces.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes — `feature_integration_failed.error` string | Existing event payload serialization |
| V5 Input Validation | yes — inbox item `payload` | JSON-serialized blob, no injection surface |
| All others | no | Not applicable to orchestrator-internal git operations |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `agents.verifyFeature` can accept a custom `agentRunId` prefix (`run-integration:${featureId}`) without conflicting with feature-phase runs | Integration Runner Pattern | If the runtime uses the run ID for session lookup, a collision with an existing verify run row would fail; solution is to use `run-integration:` prefix and verify no existing runs share it |
| A2 | The integration runner calling `agents.verifyFeature` with no session ID (fresh start each time) is correct behavior — there is no integration verification session to resume | Integration Runner Pattern | If integration verify needs to be resumable (e.g., agent times out mid-review), a session would need to be persisted and the integration run row would need to be recoverable; Phase 6 can defer this as crash recovery is already deferred |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed. (The above are the only two unverified claims.)

---

## Open Questions

1. **Integration verify `baseRef` for agent diff:**
   - What we know: `agents.verifyFeature` calls `getChangedFiles(baseRef)` which defaults to `main`. After rebasing the feature branch onto latest `main`, the rebased feature branch HEAD is the appropriate base. The changed files relative to `main` is the correct diff for the agent to review.
   - What's unclear: Should the agent review diff against the pre-rebase `main` HEAD or the current `main` HEAD (they are the same after a successful rebase)?
   - Recommendation: Use `'main'` as `baseRef` (the default) since after a clean rebase onto `main`, the feature branch HEAD is ahead of `main` by exactly the feature's commits. This is the correct diff.

2. **Integration run row: create or skip?**
   - What we know: Other feature phases create `AgentRun` rows for tracking (token usage, session state). The integration runner is different — it is not a long-lived agent session but a short orchestrator-side operation (rebase + verify + merge).
   - What's unclear: Should the integration runner create an `AgentRun` row for the agent review step? (The shell verify step does not use agent runs currently.)
   - Recommendation: Create a run row with a distinct ID format (`run-integration:${featureId}`) only for the agent review step, matching the token usage tracking pattern of other feature phases. This makes the integration review visible in `listAgentRuns` output for the TUI. Alternatively, skip the run row and rely on the event log for observability.

---

## Sources

### Primary (HIGH confidence — verified from codebase)
- `src/core/merge-train/index.ts` — full implementation verified
- `src/orchestrator/features/index.ts` — full implementation verified
- `src/orchestrator/scheduler/events.ts` — full implementation verified
- `src/orchestrator/scheduler/index.ts` — tick order and `beginNextIntegration` call verified
- `src/orchestrator/scheduler/dispatch.ts` — dispatch pattern verified
- `src/orchestrator/conflicts/cross-feature.ts` — release API verified
- `src/core/graph/queries.ts` — `integrating` exclusion from `readyFeatures` verified
- `src/config/schema.ts` line 158 — `reentryCap` field with default 10 verified
- `src/orchestrator/ports/index.ts` — `InboxItemAppend` interface verified
- `src/persistence/migrations/0002_merge_train_executor_state.sql` — `integration_state` table schema verified
- `src/core/warnings/index.ts` — advisory-only warning behavior verified
- `docs/foundations/coordination-rules.md` — canonical re-entry cap specification verified
- `docs/concerns/merge-train-reentry-cap.md` — explicit statement that code is uncapped verified
- `.planning/phases/05-feature-lifecycle/05-03-SUMMARY.md` — Phase 6 handoff note for `getChangedFiles(baseRef)` verified

### Secondary (MEDIUM confidence)
- `src/core/scheduling/index.ts` — `featurePhaseCategory` mapping verified; `awaiting_merge` not in `POST_EXECUTION_PHASES` confirmed

### Tertiary (LOW confidence)
- A1, A2 in assumptions log — behavioral claims about agent runtime that were not traced through to the actual session/run lookup code

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all components verified from source
- Architecture: HIGH — all patterns traced from existing implementations
- Pitfalls: HIGH — all pitfalls derived from reading actual code paths, not general knowledge
- Gap analysis: HIGH — current behavior vs documented behavior compared directly in code

**Research date:** 2026-04-25
**Valid until:** 2026-05-25 (stable domain — no external dependencies; expires if core types or scheduler contract changes)
