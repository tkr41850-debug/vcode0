# Phase 7: Top-Level Planner + Inbox + Pause/Resume - Pattern Map

**Mapped:** 2026-04-25
**Files analyzed:** planner runtime, proposal flow, inbox persistence, worker resume/recovery, TUI proposal control
**Analogs found:** strong analogs for every major Phase 7 surface; no greenfield subsystem required

---

## File Classification

| New/Modified Area | Role | Closest analog | Match quality |
|-------------------|------|----------------|---------------|
| top-level planner runtime | agent/orchestrator runtime | `src/agents/runtime.ts`, `src/orchestrator/scheduler/dispatch.ts` | strong |
| top-level planner tool host usage | draft graph mutation | `src/agents/tools/proposal-host.ts`, `src/tui/proposal-controller.ts` | exact |
| additive-only planner enforcement | proposal apply / approval guard | `src/core/proposals/index.ts`, `src/orchestrator/scheduler/events.ts` | strong |
| planner session registry | run/session lifecycle | `src/orchestrator/scheduler/dispatch.ts`, `src/runtime/sessions/index.ts` | strong |
| planner audit log | append-only event trail | `src/agents/runtime.ts::recordPhaseCompletion`, proposal events in `scheduler/events.ts` | strong |
| inbox query + resolve APIs | persistence port/store | `src/orchestrator/ports/index.ts`, `src/persistence/sqlite-store.ts` | exact shape extension |
| help/approval inbox routing | scheduler event reducer | `request_approval` in `src/orchestrator/scheduler/events.ts` | exact |
| multi-task unblock | operator response delivery | `compose.ts` help/approval handlers | partial |
| hot-window pause controller | run lifecycle / recovery | `RecoveryService`, `PiSdkHarness.resume(...)` | partial |
| transcript checkpoint save cadence | worker agent event handling | `src/runtime/worker/index.ts::handleAgentEvent` | exact insertion point |
| tool-output persistence | runtime resume infra | `src/runtime/resume/tool-output-store.ts` | exact backend, missing wiring |
| collision detection | proposal review + run lookup | proposal approval flow + `listAgentRuns(...)` | strong |

---

## Pattern Assignments

### 1. Top-level planner runtime

**Use:** `src/agents/runtime.ts` + `src/orchestrator/scheduler/dispatch.ts`

**Why:** The feature-phase runtime already knows how to:
- load `sessionId`
- render a prompt
- run an Agent
- persist messages
- append completion events

The scheduler dispatch already knows how to:
- ensure a run row exists
- choose reuse vs fresh session
- mark run status transitions
- route completion and approval events

**Pattern to copy:** `dispatchFeaturePhaseUnit(...)` session handling

```ts
const rerunCompletedPhase = run.runStatus === 'completed';
const reusedSessionId = rerunCompletedPhase ? undefined : run.sessionId;

ports.store.updateAgentRun(run.id, {
  runStatus: 'running',
  owner: 'system',
  ...(rerunCompletedPhase ? { sessionId: undefined } : {}),
});
```

**How to apply in Phase 7:**
- create a top-level planner run type/ID space
- preserve the same session reuse semantics for continue vs fresh
- route proposal results through the same explicit approval path used for feature proposals

---

### 2. Draft graph mutation surface for top-level planner

**Use:** `src/agents/tools/proposal-host.ts` and `src/agents/tools/planner-toolset.ts`

**Why:** Milestone + feature draft operations already exist; this is exactly what REQ-PLAN-01 and REQ-STATE-04 need.

**Pattern to copy:**
- `GraphProposalToolHost` mutates an `InMemoryFeatureGraph`
- `submit()` finalizes but does not mutate authoritative state
- aliases are resolved later by `applyGraphProposal(...)`

**Best existing UI analog:** `src/tui/proposal-controller.ts`

```ts
const host = createProposalToolHost(buildGraphFromSnapshot(snapshot), phase);
const toolset = createPlannerToolset(host);
// ... execute tools against draft ...
host.submit(TUI_SUBMIT_DETAILS);
const proposal = host.buildProposal();
```

**How to apply in Phase 7:**
- top-level planner should use the same host/toolset
- do not introduce a second top-level graph-edit DSL or direct graph mutation API

---

### 3. Additive-only enforcement

**Use:** `src/core/proposals/index.ts` warning/skip model + orchestrator approval layer in `src/orchestrator/scheduler/events.ts`

**Why:** `applyGraphProposal(...)` already has the right enforcement style: apply what is valid, skip stale/illegal ops, record warnings.

**Relevant analogs:**
- `remove_started_feature`
- `remove_started_task`
- stale-op skip reasons

**Pattern to copy:**

```ts
const warnings = collectProposalWarnings(graph, proposal);
const staleReason = staleReasonForOp(graph, op);
if (staleReason !== undefined) {
  skipped.push({ opIndex, op, reason: staleReason });
  continue;
}
```

**How to apply in Phase 7:**
- elevate this from passive warning support to a top-level planner contract
- proposal review should explicitly flag edits against running/completed work
- accepted proposals must not silently mutate started work

---

### 4. Planner session registry

**Use:** existing `sessionId` patterns in:
- `src/orchestrator/scheduler/dispatch.ts`
- `src/runtime/sessions/index.ts`
- `src/agents/runtime.ts`

**Why:** session persistence already exists and is used consistently for feature-phase runs.

**Pattern to copy:**

```ts
const sessionId = run.sessionId ?? run.agentRunId;
await sessionStore.save(sessionId, messages);
store.updateAgentRun(run.agentRunId, { sessionId });
```

**How to apply in Phase 7:**
- store top-level planner sessions explicitly
- offer continue vs fresh by choosing whether to reuse or clear `sessionId`
- do not invent a parallel transcript-persistence mechanism

---

### 5. Planner audit log

**Use:** append-only event patterns in:
- `src/agents/runtime.ts::recordPhaseCompletion`
- `src/orchestrator/scheduler/events.ts` proposal events

**Pattern to copy:**

```ts
store.appendEvent({
  eventType: 'feature_phase_completed',
  entityId: featureId,
  timestamp: Date.now(),
  payload: {
    phase,
    summary,
    sessionId,
    ...(extra !== undefined ? { extra } : {}),
  },
});
```

and

```ts
store.appendEvent({
  eventType: 'proposal_applied',
  entityId: featureId,
  timestamp: Date.now(),
  payload: {
    phase,
    summary: outcome.result.summary,
    ...summarizeProposalApply(outcome.result),
  },
});
```

**How to apply in Phase 7:**
- planner prompt provenance should be appended as event records tied to the created/edited milestones/features
- keep audit data append-only and session-linked

---

### 6. Inbox port expansion

**Use:** current Store pattern in `src/orchestrator/ports/index.ts` + `SqliteStore` implementation in `src/persistence/sqlite-store.ts`

**Why:** the inbox table already exists; the missing part is the read/update port surface.

**Current pattern:** insert-only statement

```ts
appendInboxItem(item: InboxItemAppend): void {
  this.appendInboxItemStmt.run({ ... });
}
```

**How to apply in Phase 7:**
- extend the port with query + resolution methods rather than bypassing the Store
- mirror the existing `listAgentRuns(...)` / `listEvents(...)` style for query methods
- resolution should update the existing `resolution` column, not add a second side table unless necessary

---

### 7. Help/approval inbox routing

**Use:** `request_approval` handler in `src/orchestrator/scheduler/events.ts`

**Why:** it already shows the pattern for run-state transition + conditional inbox append.

**Pattern to copy:**

```ts
ports.store.updateAgentRun(run.id, {
  runStatus: 'await_approval',
  owner: 'manual',
  payloadJson: JSON.stringify(message.payload),
});

ports.store.appendInboxItem({
  id: `inbox-${message.agentRunId}-${Date.now()}`,
  ts: Date.now(),
  taskId: run.scopeId,
  agentRunId: run.id,
  kind: 'destructive_action',
  payload: { ... },
});
```

**How to apply in Phase 7:**
- `request_help` should follow the same two-part pattern
- generic approvals can follow the same shape even when not destructive
- keep payloads structured; do not rely solely on `payloadJson` inside the run row

---

### 8. Multi-task single-answer unblock

**Use:** `compose.ts` response handlers as the baseline to extend

**Why:** the current code already knows how to deliver help/approval back to one live run.

**Current baseline:**

```ts
const result = await runtime.respondToHelp(taskId, response);
store.updateAgentRun(run.id, {
  runStatus: 'running',
  owner: 'manual',
});
```

**How to apply in Phase 7:**
- group inbox items by equivalence key or canonical question payload
- fan out a single operator response to all matching waiting tasks
- keep the actual runtime-delivery call per task, but drive it from inbox resolution instead of direct task-only actions

---

### 9. Hot-window pause and respawn baseline

**Use:** `RecoveryService` + `PiSdkHarness.resume(...)`

**Why:** production already has resumable-run handling when a `sessionId` exists.

**Pattern to copy:**

```ts
if (shouldResumeTaskRun(run)) {
  const resumed = await this.resumeTaskRun(task, run);
  if (resumed) continue;
}
```

and

```ts
const result = await this.ports.runtime.dispatchTask(task, dispatch, payload);
if (result.kind === 'not_resumable') return false;
```

**How to apply in Phase 7:**
- model checkpointed tasks as resumable runs with explicit pause metadata
- on hot-window expiry, transition into the checkpointed state and later reuse the same respawn path instead of inventing a separate recovery engine

---

### 10. Transcript checkpoint save cadence

**Use:** `src/runtime/worker/index.ts::handleAgentEvent`

**Why:** `message_end` and `turn_end` are already the natural save points named in the spike doc.

**Current code:**

```ts
case 'message_end': {
  // emits assistant output only
  break;
}
case 'turn_end': {
  // emits progress only
  break;
}
```

**How to apply in Phase 7:**
- add `sessionStore.save(sessionId, this.agent.state.messages)` at these hooks
- reuse the same `sessionId` chosen for the run
- do not wait until run completion if the process may be released during pause

---

### 11. Tool-output persistence wiring

**Use:** `src/runtime/resume/tool-output-store.ts`

**Why:** the storage backend already exists; only runtime wiring is missing.

**Pattern to reuse:**

```ts
const store = createFileToolOutputStore(dir);
await store.record({
  toolCallId,
  toolName,
  content,
  details,
  isError,
  timestamp,
});
```

**How to apply in Phase 7:**
- wire an `afterToolCall` hook into the worker Agent constructor
- persist outputs per run/session
- clear after successful respawn when the outputs are now represented in the transcript

---

### 12. Collision detection and proposal-view flagging

**Use:** proposal approval flow in `src/orchestrator/scheduler/events.ts` + run lookup via `listAgentRuns(...)`

**Why:** the proposal layer already centralizes apply/reject/rerun decisions, which is where collision visibility belongs.

**Pattern to reuse:**
- inspect active runs before approval
- append a proposal/audit event on accept/reject/rerun
- reset the conflicting planner's `sessionId` and run state through the same rerun path used today

**How to apply in Phase 7:**
- detect active feature planner runs when a top-level proposal edits those features
- flag the collision before apply
- on accept, cancel/reset the conflicting planner via the existing rerun/reset mechanics

---

## Test Patterns

### Proposal / planner analogs
- `test/unit/core/proposals.test.ts` — alias resolution, stale-op skips, remove-started warnings
- `test/unit/orchestrator/proposals.test.ts` — orchestrator-level proposal apply semantics
- `test/integration/feature-phase-agent-flow.test.ts` — proposal run -> await_approval -> apply events
- `test/unit/tui/proposal-controller.test.ts` — draft lifecycle, submit, auto-execution pause/restore

### Inbox / wait-state analogs
- `test/unit/orchestrator/scheduler-loop.test.ts` — `request_help` and `request_approval` transition runs into wait states
- `test/integration/worker-smoke.test.ts` — real help/approval round-trip behavior
- `test/integration/destructive-op-approval.test.ts` — inbox item append for destructive approvals
- `test/integration/merge-train.test.ts` — inbox item append for merge-train cap parking

### Resume / recovery analogs
- `test/integration/spike/pi-sdk-resume.test.ts` — canonical replay decision evidence and facade smoke test
- `test/unit/runtime/resume/tool-output-store.test.ts` — durable tool-output persistence behavior
- `test/unit/orchestrator/recovery.test.ts` — resumable run recovery patterns
- `test/unit/runtime/pi-sdk-harness.test.ts` — start/resume harness behavior

---

## No Analog Found

No major Phase 7 area is completely greenfield.

The weakest analog is **multi-task single-answer unblock**, where the repo currently only provides single-task response delivery. Even there, the constituent parts already exist:
- inbox persistence
- task wait states
- operator delivery methods
- run queries

So the phase still extends existing architecture rather than requiring a novel subsystem.

---

## Metadata

**Analog search scope:** `src/agents/**`, `src/core/proposals/**`, `src/orchestrator/**`, `src/runtime/**`, `src/persistence/**`, `src/tui/**`, `test/unit/**`, `test/integration/**`
**Files scanned:** 30+ source/test touchpoints
**Pattern extraction date:** 2026-04-25
