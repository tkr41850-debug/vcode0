# Phase 5: Feature Lifecycle & Feature-Level Planner — Pattern Map

**Mapped:** 2026-04-24
**Files analyzed:** 7 new/modified responsibilities
**Analogs found:** 7 / 7

## File Classification

| New/Modified File/Responsibility | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `OrchestratorFeatures.enqueueVerifyRepairs(featureId, issues[])` | orchestrator helper | event-driven (graph mutation) | `enqueueRepairTask` @ `src/orchestrator/features/index.ts:200-237` | exact (same coordinator, adjacent method) |
| `AgentRun.trailerObservedAt` field + Store read API | model field + persistence port | request-response (read) | `last_commit_sha` column + `setLastCommitSha` @ `src/persistence/migrations/0006_*.sql`, `src/persistence/sqlite-store.ts:124,195,384` | exact (same table, same column-class write path; new read side) |
| Hallucinated-progress gate in `task_complete` handler | scheduler event handler | event-driven | `commit_done` branch @ `src/orchestrator/scheduler/events.ts:266-280` + `result` branch @ lines 171-204 | exact (same handler file, symmetric to existing `commit_trailer_missing` path) |
| Git-backed `getChangedFiles` tool impl | host tool implementation | file-I/O (git CLI) | `rebaseGitDir` @ `src/orchestrator/conflicts/git.ts:25-63` + `createGitDiffTool` @ `src/agents/worker/tools/git-diff.ts:26-54` | good (same simple-git + `git diff --name-only` pattern) |
| `test/integration/feature-lifecycle-e2e.test.ts` | integration test | event-driven (loop-driven) | `test/integration/worker-retry-commit.test.ts` (real-git + LocalWorkerPool) and `test/integration/feature-phase-agent-flow.test.ts` (faux phase-agent + loop) | good (two complementary precedents; combine) |
| Unit-test helpers for raiseIssue → repair-task mapping | unit test | pure function | `test/unit/orchestrator/scheduler-loop.test.ts:2820-2865` (ci_check → repair task assertion) | good (same assertion shape on `graph.tasks`) |
| Verify-empty-diff handling in verify prompt rendering | prompt-render branch | transform | `renderPrompt` @ `src/agents/runtime.ts:271-324` + `VERIFY_PROMPT` @ `src/agents/prompts/verify.ts:52-77` | exact (extend existing block wiring) |

## Pattern Assignments

### 1. `OrchestratorFeatures.enqueueVerifyRepairs(featureId, issues[])` — orchestrator helper

**Analog:** `src/orchestrator/features/index.ts` — `enqueueRepairTask` (lines 200-237)

**Imports pattern (same file, top of index.ts lines 1-11):**

```typescript
import { MAX_REPAIR_ATTEMPTS } from '@core/fsm/index';
import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRunPhase, Feature, FeatureId, Task, TaskId,
  VerificationSummary, VerifyIssue,
} from '@core/types/index';
```

**Core pattern to copy (lines 200-237):** single-summary repair-task enqueue with:
- `countRepairTasks(featureId)` cap check,
- `MAX_REPAIR_ATTEMPTS` branch → `markPhaseFailed` + `advancePhase('replanning')`,
- first-time: `markPhaseFailed` + `advancePhase('executing_repair')`,
- `graph.addTask({ featureId, description, repairSource })` + `graph.transitionTask(id, { status: 'ready' })`.

**Extension shape for Phase 5:**
- New method `enqueueVerifyRepairs(featureId, issues: VerifyIssue[])`, filter `severity !== 'nit'`, map each → call internal shared core (extract `addOneRepairTask` helper from current `enqueueRepairTask`).
- Cap semantics per CONTEXT § D / RESEARCH O4: one verify verdict counts as ONE attempt regardless of `issues.length` (do not loop the cap-check; run it once for the batch).
- `description` = `${issue.description}${location ? ' @ ' + location : ''}${suggestedFix ? '\n\nSuggested: ' + suggestedFix : ''}`; `weight = 'small'`; `reservedWritePaths = [location]` when location looks like a path.

**Call-site rewire:** `completePhase('verify')` @ `src/orchestrator/features/index.ts:124-136` currently calls `markPhaseFailed` + `advancePhase('replanning')` directly when `verification.ok === false`. Replace with `enqueueVerifyRepairs(featureId, verification.issues ?? [])`.

---

### 2. `AgentRun.trailerObservedAt` field + Store read API

**Analog:** `last_commit_sha` column + `setLastCommitSha` write path.

**Migration pattern — copy from `src/persistence/migrations/0006_agent_runs_last_commit_sha.sql`:**

```sql
-- 0007_agent_runs_trailer_observed_at.sql
-- Plan 05-04: mark the first commit_done frame where trailerOk===true
-- so the task_complete hallucination gate can check O(1).
ALTER TABLE agent_runs ADD COLUMN trailer_observed_at INTEGER NULL;
```

**Store port pattern (`src/orchestrator/ports/index.ts:99-102` for write; need READ sibling):**

```typescript
// existing write:
setLastCommitSha(agentRunId: string, sha: string): void;
// new symmetric pair:
setTrailerObservedAt(agentRunId: string, ts: number): void;
getTrailerObservedAt(agentRunId: string): number | undefined; // NEW — read method
```

**SqliteStore impl pattern — copy from `src/persistence/sqlite-store.ts:124,195-197,384-386`:**

```typescript
// declared in ctor properties:
private readonly setLastCommitShaStmt;
// prepared in ctor body:
this.setLastCommitShaStmt = db.prepare<[string, string]>(
  'UPDATE agent_runs SET last_commit_sha = ? WHERE id = ?',
);
// method:
setLastCommitSha(agentRunId: string, sha: string): void {
  this.setLastCommitShaStmt.run(sha, agentRunId);
}
```

Mirror this shape: add `setTrailerObservedAtStmt` prepared statement, method setter, and a new `getTrailerObservedAtStmt = db.prepare('SELECT trailer_observed_at FROM agent_runs WHERE id = ?')` for the read.

**AgentRun type — add optional field in `src/core/types/runs.ts:28-40` (`BaseAgentRun`):**

```typescript
interface BaseAgentRun {
  // ...existing fields...
  trailerObservedAt?: number; // unix ms of first commit_done with trailerOk===true
}
```

**Codec update — copy pattern from `src/persistence/codecs.ts:267-314`:**

- `agentRunToRow`: add `trailer_observed_at: nullish(r.trailerObservedAt)`.
- `rowToAgentRun`: add `...optional('trailerObservedAt', row.trailer_observed_at)`.
- Row interface `BaseAgentRunRow` in `src/persistence/queries/index.ts:88-102`: add `trailer_observed_at: number | null`.

---

### 3. Hallucinated-progress gate in `task_complete` handler

**Analog:** `src/orchestrator/scheduler/events.ts` — `commit_done` branch (lines 266-280) + `result` branch (lines 171-204).

**Existing `commit_done` pattern (lines 266-280) to extend:**

```typescript
if (message.type === 'commit_done') {
  ports.store.setLastCommitSha(run.id, message.sha);
  if (!message.trailerOk) {
    ports.store.appendEvent({
      eventType: 'commit_trailer_missing',
      entityId: run.scopeId,
      timestamp: Date.now(),
      payload: { agentRunId: run.id, sha: message.sha },
    });
  }
  return;
}
```

**Extension for Phase 5:** when `message.trailerOk === true`, also call the new `ports.store.setTrailerObservedAt(run.id, Date.now())` (once; call is idempotent — UPDATE is no-op when already set because write path is fire-and-forget, or guard on read). Keep the existing `commit_trailer_missing` event emission as-is (symmetry with SC5-G4).

**Gate pattern on `result` handler (extend lines 171-204):** before the `taskLanded` branch runs `features.onTaskLanded(run.scopeId)`:

```typescript
if (message.type === 'result') {
  const taskLanded = message.completionKind === 'submitted';
  if (taskLanded) {
    const trailerAt = ports.store.getTrailerObservedAt(run.id);
    if (trailerAt === undefined) {
      activeLocks.releaseByRun(message.agentRunId);
      ports.store.appendEvent({
        eventType: 'task_completion_rejected_no_commit',
        entityId: run.scopeId,
        timestamp: Date.now(),
        payload: { agentRunId: run.id, reason: 'no_trailer_ok_commit_observed' },
      });
      graph.transitionTask(run.scopeId, { status: 'failed' });
      ports.store.updateAgentRun(run.id, {
        runStatus: 'failed',
        owner: 'system',
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      return;
    }
  }
  // ... existing accept path (lines 171-204) ...
}
```

**Event emission pattern — copy from `commit_trailer_missing` (events.ts:269-278):** same shape (`eventType`, `entityId`, `timestamp`, `payload.agentRunId`).

**Retry feed per RESEARCH O3:** emit a new failure kind that `RetryPolicy.decideRetry` at `src/runtime/retry-policy.ts:57-86` treats as retriable up to `maxAttempts`, then escalates. Extension point: add `no_commit` to `transientErrorPatterns` or (preferred) thread through `LocalWorkerPool.handleErrorFrame` as a synthetic error.

---

### 4. Git-backed `getChangedFiles` tool implementation

**Analog A (primary — orchestrator-layer git CLI):** `src/orchestrator/conflicts/git.ts:25-89`

**Imports + setup pattern (lines 1-37):**

```typescript
import * as fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';

export async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.stat(filePath); return true; } catch { return false; }
}

// inside diff helper:
const git = simpleGit(gitDir);
```

**`git diff --name-only` raw pattern (line 78):**

```typescript
const diff = await git.raw(['diff', '--name-only', '--diff-filter=U']);
const files = diff
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);
```

**Analog B (secondary — existing worker-side `git_diff` tool):** `src/agents/worker/tools/git-diff.ts:26-54`. Typebox parameter schema and `AgentTool<typeof parameters, Details>` return shape match the existing host/tool contract.

**Extension for Phase 5:** replace `DefaultFeaturePhaseToolHost.getChangedFiles` @ `src/agents/tools/feature-phase-host.ts:97-111` (currently unions `task.result.filesChanged`). New impl:
- Accept `{ featureId?, baseRef? }`; default `baseRef` = `'main'` (the repo main branch — Phase 6 will pass merge-train base).
- Look up feature's `featureBranch` via `this.graph.features.get(featureId).featureBranch`.
- Resolve feature worktree path via a host-side helper (follow `WorktreeProvisioner` pattern in `OrchestratorPorts`) or make the host take `projectRoot` in its constructor (needs a new injected dep).
- Run `simpleGit(worktreeDir).raw(['diff', '--name-only', `${baseRef}...HEAD`])`.
- Return `string[]` (empty array when no diff — verify branch consumes the empty-array signal).

**Cross-phase hook per RESEARCH § "Cross-Phase Coordination":** accept `baseRef` as an arg so Phase 6 can re-use with merge-train base. Do not hard-code `'main'`.

---

### 5. E2E test `test/integration/feature-lifecycle-e2e.test.ts`

**Analog A (LocalWorkerPool + real-git):** `test/integration/worker-retry-commit.test.ts`

**Imports + beforeEach pattern (lines 1-92) — copy wholesale:**

```typescript
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { InProcessHarness } from './harness/in-process-harness.js';
import { createFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

// beforeEach: spawnSync('git', ['init', '-q'], { cwd: tmpDir })
// + git config user.email/name + commit.gpgsign false + seed commit
```

**Analog B (faux phase-agent + SchedulerLoop):** `test/integration/feature-phase-agent-flow.test.ts`

**Fixture-builder pattern (lines 247-294) — copy `createFixture` helper:** wires `PiFeatureAgentRuntime`, `InMemoryStore`, `InMemorySessionStore`, `OrchestratorPorts`, and `SchedulerLoop`. For E2E, swap the runtime stub for a real `LocalWorkerPool` (borrowed from Analog A).

**Faux transcript scripting pattern (lines 299-331):**

```typescript
faux.setResponses([
  fauxAssistantMessage(
    [ fauxToolCall('addTask', { ... }), fauxToolCall('submit', {}) ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Planning complete.')]),
]);
```

**Assertion pattern for graph state (lines 341-355, 673-697):**

```typescript
expect(graph.features.get('f-1')).toEqual(
  expect.objectContaining({
    workControl: 'awaiting_merge',
    status: 'pending',
    collabControl: 'branch_open',
  }),
);
expect([...graph.tasks.values()].filter(t => t.repairSource === 'verify')).toHaveLength(1);
```

**CRITICAL (RESEARCH SC4-G4):** the existing `feature-phase-agent-flow.test.ts:642-697` case `dispatches verify with structured repair-needed verdict into replanning` asserts `.toHaveLength(0)` for verify-source repair tasks. Phase 5 FLIPS this: update assertion to `.toHaveLength(1)` and change expected `workControl` from `'replanning'` to `'executing_repair'`. Rename test case to `dispatches verify with structured repair-needed verdict into executing_repair`.

---

### 6. Unit-test helpers for raiseIssue → repair-task mapping

**Analog:** `test/unit/orchestrator/scheduler-loop.test.ts:2820-2865` — the ci_check → repair task assertion case.

**Assertion pattern to copy (lines 2846-2865):**

```typescript
loop.enqueue({
  type: 'feature_phase_complete',
  featureId: 'f-1',
  phase: 'ci_check', // for new test: 'verify'
  summary: 'tests failed',
  verification: { ok: false, summary: 'tests failed' }, // for new: include issues[]
});
await loop.step(100);

expect(graph.features.get('f-1')).toEqual(
  expect.objectContaining({
    workControl: 'executing_repair',
    status: 'pending',
    collabControl: 'branch_open',
  }),
);
const repairTasks = [...graph.tasks.values()].filter(
  (task) => task.featureId === 'f-1' && task.id !== 't-1',
);
expect(repairTasks).toHaveLength(1);
expect(repairTasks[0]).toMatchObject({
  status: 'ready',
  collabControl: 'none',
  repairSource: 'ci_check', // new: 'verify'
});
```

**New unit test file (Wave 0):** `test/unit/orchestrator/verify-repairs.test.ts`.

Cases to cover:
1. `blocking` issue → 1 repair task created
2. `concern` issue → 1 repair task created
3. `nit` issue → 0 repair tasks
4. Mixed `[blocking, concern, nit]` → 2 repair tasks
5. Empty `issues` + `ok=false` → 0 repair tasks (but phase still failed → `executing_repair` transition? verify contract)
6. `location` that matches file-path regex → `reservedWritePaths: [location]` set
7. `location` that is a symbol (no `/`) → no `reservedWritePaths`
8. Cap hit: verdict fires after `countRepairTasks === MAX_REPAIR_ATTEMPTS` → `replanning`

**Separate SC5 gate unit test (Wave 0):** `test/unit/orchestrator/commit-gate.test.ts`. Uses `handleSchedulerEvent` directly with stubbed `OrchestratorPorts` (precedent: `events-release-locks.test.ts` line 63 — `{} as unknown as FeatureLifecycleCoordinator` stub shape). Cases:
1. `task_complete(submitted)` + no prior `commit_done` → `task_completion_rejected_no_commit` event, task status → `failed`
2. `task_complete(submitted)` + prior `commit_done(trailerOk:true)` → normal accept path
3. `task_complete(submitted)` + prior `commit_done(trailerOk:false)` only → rejected (symmetric with `commit_trailer_missing`)

---

### 7. Verify-empty-diff handling in verify prompt rendering

**Analog A:** `renderPrompt` @ `src/agents/runtime.ts:271-324` — the central prompt-input threader.

**Existing verify template input shape (verify.ts:52-77 labeled blocks):**

```typescript
renderBlockSection('Verification Inputs', [
  renderLabeledBlock('Success Criteria', getString(input, 'successCriteria')),
  renderLabeledBlock('Plan Summary', getString(input, 'planSummary')),
  renderLabeledBlock('Execution Evidence', getString(input, 'executionEvidence')),
  renderLabeledBlock('Verification Results', getString(input, 'verificationResults')),
  renderLabeledBlock('Prior Decisions', getString(input, 'decisions')),
]);
```

**Extension for Phase 5 (SC3-G1, SC3-G4):**

1. **Add `Changed Files` block** between `Plan Summary` and `Execution Evidence` (per RESEARCH O5 recommendation): new labeled block in `verify.ts` consuming `input.changedFiles`.
2. **Thread `changedFiles` in `renderPrompt`** (`runtime.ts:285-323`): before the `template.render({...})` call, compute:

```typescript
const changedFiles = phase === 'verify'
  ? await getChangedFilesForPrompt(feature, this.deps /* projectRoot + git */)
  : undefined;
const changedFilesText = changedFiles === undefined
  ? undefined
  : changedFiles.length === 0
    ? 'No changes on feature branch vs base.'
    : changedFiles.map(f => `- ${f}`).join('\n');
```

Pass `changedFiles: changedFilesText` into `template.render({...})`.

3. **`renderPrompt` signature change:** currently synchronous. Adding git access makes it async. Either (a) make `renderPrompt` async (preferred — matches `runVerifyPhase` which is already async at line 225) or (b) compute `changedFiles` in `runVerifyPhase` and pass as an extra arg. Recommended: (a), update callers in `runTextPhase` / `runProposalPhase` / `runVerifyPhase` (all already async).

**Empty-diff instruction pattern — extend the `VERIFY_PROMPT` static text (`verify.ts:12-50`):** add a bullet under `Issue raising`:

```text
- if "Changed Files" shows "No changes on feature branch vs base.", submit verdict `repair_needed` with a blocking raiseIssue naming the missing implementation
```

Per CONTEXT § G, the agent still runs (no short-circuit); the prompt simply anchors the correct verdict.

---

## Shared Patterns

### Event emission
**Source:** `src/orchestrator/scheduler/events.ts:269-278` (`commit_trailer_missing`)
**Apply to:** New `task_completion_rejected_no_commit` event (SC5) + any new verify-repair fan-out events.

```typescript
ports.store.appendEvent({
  eventType: '<event_type>',
  entityId: run.scopeId, // or featureId
  timestamp: Date.now(),
  payload: { agentRunId: run.id, /* ...extra... */ },
});
```

### Graph mutation via orchestrator
**Source:** `src/orchestrator/features/index.ts:227-236` (`graph.addTask` + `graph.transitionTask`)
**Apply to:** `enqueueVerifyRepairs` fan-out — use the exact same two-call pattern per issue.

```typescript
const repairTask = this.graph.addTask({
  featureId,
  description,
  repairSource: 'verify',
  ...(reservedWritePaths !== undefined ? { reservedWritePaths } : {}),
});
this.graph.transitionTask(repairTask.id, { status: 'ready' });
```

### Typebox tool schema
**Source:** `src/agents/tools/schemas.ts:166-189`
**Apply to:** Extending `getChangedFiles` parameters (add optional `baseRef`). Keep additive — existing callers pass only `featureId`.

```typescript
getChangedFiles: Type.Object({
  featureId: Type.Optional(Type.String()),
  baseRef: Type.Optional(Type.String()), // NEW
}),
```

### SqliteStore prepared-statement + port method
**Source:** `src/persistence/sqlite-store.ts:124,195-197,384-386` + `src/orchestrator/ports/index.ts:99-102`
**Apply to:** Both the `trailerObservedAt` write AND read methods. Write mirrors `setLastCommitSha`; read needs a new `prepare<[string], {trailer_observed_at: number|null}>(...)` statement returning `row?.trailer_observed_at ?? undefined`.

### Faux phase-agent integration test fixture
**Source:** `test/integration/feature-phase-agent-flow.test.ts:247-309` (`createFixture` + `beforeEach` faux registration)
**Apply to:** `feature-lifecycle-e2e.test.ts` plan- and verify-phase segments (for phases that don't need a real LocalWorkerPool).

### LocalWorkerPool + real-git integration test
**Source:** `test/integration/worker-retry-commit.test.ts:63-125`
**Apply to:** `feature-lifecycle-e2e.test.ts` execute-phase segment where real commits + trailer observation need to round-trip.

## No Analog Found

None — every Phase 5 surface has a close analog.

## Metadata

**Analog search scope:**
- `src/orchestrator/features/`, `src/orchestrator/scheduler/`, `src/orchestrator/ports/`
- `src/agents/runtime.ts`, `src/agents/prompts/verify.ts`, `src/agents/tools/`
- `src/agents/worker/tools/git-diff.ts`, `src/orchestrator/conflicts/git.ts`
- `src/core/types/runs.ts`, `src/core/types/verification.ts`
- `src/persistence/sqlite-store.ts`, `src/persistence/codecs.ts`, `src/persistence/queries/index.ts`, `src/persistence/migrations/0006_*`
- `src/runtime/retry-policy.ts`
- `test/integration/feature-phase-agent-flow.test.ts`, `test/integration/worker-retry-commit.test.ts`, `test/integration/scheduler-phase4-e2e.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`, `test/unit/orchestrator/events-release-locks.test.ts`, `test/unit/agents/commit-trailer.test.ts`
- `test/unit/core/fsm/`

**Files scanned:** 22 source + 7 test files, targeted read strategy (non-overlapping ranges).

**Pattern extraction date:** 2026-04-24
