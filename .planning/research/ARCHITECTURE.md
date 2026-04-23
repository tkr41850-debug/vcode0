# Architecture Research

**Domain:** Local single-user autonomous coding orchestrator (DAG-first, on pi-sdk)
**Researched:** 2026-04-23
**Confidence:** HIGH (existing docs + code already exercise the patterns below) / MEDIUM (for revision recommendations targeting clarity)

> Method note: research-agent runs exceeded the streaming timeout; report compiled from `ARCHITECTURE.md`, `docs/architecture/*`, `docs/operations/*`, `specs/`, and PROJECT.md decisions. The existing in-tree docs are unusually thorough — large parts of this report synthesize them rather than introducing new design.

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                              TUI (pi-tui)                            │
│  ┌────────────┐  ┌─────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │ Feature DAG│  │  Inbox  │  │ Merge Train  │  │ Task Transcript│   │
│  └─────┬──────┘  └────┬────┘  └──────┬───────┘  └────────┬───────┘   │
│        │              │              │                   │           │
│        └──── view-model derived from graph+runs+queue ───┘           │
├──────────────────────────────────────────────────────────────────────┤
│                          App / Compose                               │
│  wires Core <- Orchestrator <- Adapters; boots tick loop + TUI shell │
├──────────────────────────────────────────────────────────────────────┤
│                           Orchestrator                               │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │ Serial Event     │  │ Scheduler    │  │ Feature Lifecycle    │    │
│  │ Queue (single)   │──│ Tick Loop    │──│ (work/collab FSM)    │    │
│  └──────────────────┘  └──────┬───────┘  └──────────────────────┘    │
│                               │                                      │
│  ┌──────────────────┐  ┌──────┴───────┐  ┌──────────────────────┐    │
│  │ Merge Train      │  │ Conflict     │  │ Summaries /          │    │
│  │ Coordinator      │  │ Coordinator  │  │ Verification Router  │    │
│  └──────────────────┘  └──────────────┘  └──────────────────────┘    │
├──────────────────────────────────────────────────────────────────────┤
│                              Core                                    │
│  Pure contracts: graph types, FSM guards, scheduling, naming,        │
│  combined-graph metrics, warning rules. No I/O.                      │
├──────────────────────────────────────────────────────────────────────┤
│                            Agents                                    │
│  Prompts + graph-mutation tools for:                                 │
│  - Top-level planner (milestone/feature CRUD)                        │
│  - Feature-level planner (task CRUD)                                 │
│  - Verifier (pre-merge agent review)                                 │
│  - Summarizer (post-merge summary)                                   │
├──────────────────────────────────────────────────────────────────────┤
│                           Runtime                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────────────┐    │
│  │ Worker Pool │  │ IPC Bridge  │  │ Harness / Context Assembly │    │
│  │ (process    │  │ (NDJSON /   │  │ (build prompts, pass       │    │
│  │  per task)  │  │   stdio)    │  │  reserved-paths, etc.)     │    │
│  └──────┬──────┘  └──────┬──────┘  └──────────────┬─────────────┘    │
│         │                │                         │                 │
│         ▼                ▼                         ▼                 │
│   pi-sdk Agent      Write pre-hook        Git Worktree Manager       │
│   child process     (claim_lock)           (simple-git)              │
├──────────────────────────────────────────────────────────────────────┤
│                         Persistence                                  │
│  SQLite (WAL) via better-sqlite3 — features, tasks, edges,           │
│  agent_runs (run state), summaries, usage rollups, merge-train meta  │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| **Core** (`@core/*`) | Pure types, FSM guards, DAG invariants, combined-graph construction, graph metrics (max depth + longest predecessor), scheduling priority rules, naming utilities, warning definitions. No I/O. | TypeScript only; no dependencies on runtime/persistence/tui. |
| **Orchestrator** (`@orchestrator/*`) | Serial event queue, scheduler tick loop, feature lifecycle (work control + collab control transitions), merge-train coordination, conflict coordination, summary/verification routing. | Consumes ports; never talks to SQLite or git directly. |
| **Agents** (`@agents/*`) | Planner/verifier/summarizer prompts, graph-mutation tool schemas via `@sinclair/typebox`, agent invocation adapters. | Pi-sdk `Agent` instances for feature-phase work. |
| **Runtime** (`@runtime/*`) | Worker pool (process-per-task), IPC bridge (NDJSON stdio framing), harness (context assembly, reserved-path passing), worktree manager (add/remove/prune/stale-lock). | `child_process.spawn` + `simple-git`. |
| **Persistence** (`@persistence/*`) | SQLite schema + migrations, store port implementations, usage rollup updates. | `better-sqlite3` synchronous calls behind a `Store` port. |
| **TUI** (`@tui/*`) | Multi-surface shell (feature DAG, inbox, merge-train, task transcript), derived view-state from graph+runs+queue, keymap, config editor. | `@mariozechner/pi-tui`. |
| **App** (`@app/*`) | Lifecycle (boot, shutdown, crash recovery), composition root wiring concrete adapters into ports. | Small glue layer. |

## Recommended Project Structure

Matches the existing repo layout — keep it, do not rename:

```
src/
├── main.ts
├── compose.ts               # dependency wiring (ports → adapters)
├── config.ts                # typed config schema + watcher
├── app/                     # lifecycle, startup, shutdown, crash recovery glue
├── core/
│   ├── graph/               # FeatureGraph types, invariants
│   ├── fsm/                 # work-control + collab-control guards
│   ├── scheduling/          # combinedGraph, metrics, priority rules
│   ├── warnings/            # warning definitions
│   └── naming/              # typed prefixed IDs (m-/f-/t-)
├── orchestrator/
│   ├── scheduler-loop.ts    # serial event queue + tick
│   ├── feature-lifecycle.ts # advance work/collab states
│   ├── merge-train.ts       # queue, rebase+verify, re-entry cap
│   ├── conflict/            # reservation overlap + write-prehook handler
│   └── summaries.ts
├── agents/
│   ├── top-planner/         # feature CRUD prompts + tools
│   ├── feature-planner/     # task CRUD prompts + tools
│   ├── verifier/            # agent review prompts + tools
│   └── summarizer/
├── runtime/
│   ├── worker-pool.ts       # child process pool
│   ├── ipc/                 # NDJSON framing, message types, schema validation
│   ├── harness/             # context assembly, prompt composition
│   └── worktree/            # simple-git worktree manager
├── persistence/
│   ├── migrations/
│   ├── store.ts             # Store port impl (sync better-sqlite3)
│   └── usage-rollups.ts
└── tui/
    ├── shell.ts             # surface orchestration (4 primary surfaces + config menu)
    ├── surfaces/            # feature-dag, inbox, merge-train, task-transcript, config
    ├── view-models/         # derived state
    └── keymap.ts

test/
├── unit/                    # pure core tests (no LLM, no spawn)
│   ├── scheduling/
│   ├── fsm/
│   ├── graph/
│   └── ipc/
├── integration/             # pi-sdk fauxModel + real worker processes
│   ├── harness/
│   ├── merge-train/
│   ├── conflict/
│   ├── crash-recovery/
│   └── feature-lifecycle/
└── helpers/                 # fixtures, deterministic clocks
```

### Structure Rationale

- **Mirror architectural boundaries 1:1 with folders.** Any `@core/*` file importing `@runtime/*` is a boundary violation.
- **Keep scheduling/metrics pure in `core/`** so they can be unit-tested without spawning anything.
- **Agents own their own prompts and tool schemas** — don't scatter prompts across orchestrator code.
- **Runtime isolates all I/O:** if a test needs real processes, it lives in `test/integration/`.
- **TUI surfaces are independent** — each can be developed/tested alone before the shell orchestrates them.

## Architectural Patterns

### Pattern 1: Hybrid Serial Core + Async Feature-Phase Agents

**What:** All state-mutating coordination flows through a single serial FIFO event queue. Feature-phase agent work (planning, verifying, summarizing, replanning) runs asynchronously off the tick; results post back to the queue as events.

**When to use:** Local single-user orchestrators with O(100) graph nodes, where locking overhead and concurrency races are expensive in both correctness and comprehension.

**Trade-offs:**
- **Pro:** No locks, no CAS, no ambiguous ordering. One log of state transitions. Debuggable.
- **Pro:** Agent work does not block the tick — many features can be planning/verifying concurrently.
- **Con:** Serial queue is a throughput ceiling; fine for our scale, problematic at O(10k) mutations/sec.
- **Con:** Long-running agent phases complete "later" — requires event-driven mental model.

**Example:**
```typescript
type SchedulerEvent =
  | { type: 'worker_message'; message: WorkerToOrchestratorMessage }
  | { type: 'feature_phase_complete'; featureId: FeatureId; phase: AgentRunPhase; summary: string }
  | { type: 'feature_phase_error'; featureId: FeatureId; phase: AgentRunPhase; error: string }
  | { type: 'shutdown' };

async function tick(events: SchedulerEvent[], graph: FeatureGraph, ports: OrchestratorPorts) {
  while (events.length > 0) {
    const event = events.shift()!;
    switch (event.type) {
      case 'worker_message': handleWorkerMessage(graph, ports.store, event.message); break;
      case 'feature_phase_complete': advanceFeatureLifecycle(graph, ports.store, event); break;
      case 'feature_phase_error': handleFeaturePhaseError(graph, ports.store, event); break;
    }
  }
  detectReservationOverlaps(graph, ports);
  const combined = buildCombinedGraph(graph);
  const metrics = computeGraphMetrics(combined);
  const ready = prioritizeReadyWork(graph, runs, metrics, Date.now());
  dispatchReady(ready, ports);
}
```

### Pattern 2: Virtual Combined Graph for Critical-Path Scheduling

**What:** Compute critical-path weights over a **virtual graph** that spans feature and task DAG layers. Pre-execution features appear as single weighted nodes; executing features expand to their tasks; inter-feature edges route through terminal tasks of upstream into root tasks of downstream.

**When to use:** Multi-level DAGs where a task in feature A blocks downstream feature B; scheduling priorities need "how much work unblocks from this node."

**Trade-offs:**
- **Pro:** Scheduling decisions reflect real downstream weight, not just per-feature local weight.
- **Pro:** Two O(V+E) passes (reverse DP for maxDepth, forward DP for distance) — cheap.
- **Con:** Rebuild on every mutation (acceptable at our scale); invalidation lifecycle must be disciplined.
- **Con:** Harder to explain in two sentences than single-level DAG.

### Pattern 3: Work-Type Priority Tiers

**What:** Priority sort between milestone position and critical path weight: `verify > execute > plan > summarize`. Groups `AgentRunPhase` values into scheduling buckets so the scheduler prefers completing features over starting new ones.

**When to use:** Anytime the scheduler chooses between "finish a feature" and "start a new feature" work — prefer finishing.

**Trade-offs:**
- **Pro:** Cognitive; aligns scheduler with intuitive "land what's almost done."
- **Con:** Can starve plan work if verify/execute are always plentiful — usually self-correcting once features drain.

### Pattern 4: Strict-Main Merge Train with Re-Entry Cap

**What:** Feature branches enter a serialized queue; head rebases onto current `main` and runs merge-train verification; if either fails the feature is ejected (`integrating → branch_open`, `mergeTrainReentryCount++`). Re-entry cap (configurable, default 10) parks the feature in the inbox.

**When to use:** When `main` must never be red under autonomous fan-out.

**Trade-offs:**
- **Pro:** Strongest correctness guarantee without user babysitting.
- **Con:** Serial throughput ceiling; verification time dominates cycle. Known open concern (PROJECT.md).
- **Con:** Rebase-conflict cycles are possible; the cap prevents silent infinite loops.

### Pattern 5: Two-Layer Conflict Detection (Reservation Tick + Runtime Push)

**What:** Reservation overlaps (declared write paths) are checked each tick as a scheduling penalty; runtime overlaps (actual file writes) are caught by the worker's write pre-hook, which calls `claim_lock` against the orchestrator.

**When to use:** Process-per-task with shared git worktrees; tasks declare intent but also write for real.

**Trade-offs:**
- **Pro:** Cheap, deterministic scheduling-time penalty + accurate push-based runtime detection.
- **Con:** Non-write side effects (shell, HTTP, long reads of stale files) are not intercepted — documented limitation.

### Pattern 6: State Split (Work Control / Collab Control / Run State)

**What:** Three orthogonal state axes: **work control** = planning/execution progress on a feature; **collab control** = branch/merge/conflict lifecycle; **run state** = retry/backoff/help/approval waits on individual `agent_runs` rows.

**When to use:** When a single enum would need to encode orthogonal concerns, making invalid combinations silently possible.

**Trade-offs:**
- **Pro:** Each axis is small and reviewable.
- **Pro:** Derived display statuses (e.g., `partially_failed`) compose from the axes.
- **Con:** Readers must learn the model — the primary pain users flagged. Mitigation: a single canonical "state at a glance" diagram in docs + diagnostic CLI (`gvc0 explain feature <id>`).

### Pattern 7: Typed Prefixed IDs (m-* / f-* / t-*)

**What:** Milestone / feature / task IDs carry a typed prefix so edge kind is inferred from endpoints without object-shaped references.

**When to use:** Multi-kind graphs where encoding "feature-dep vs task-dep" at the edge is awkward.

**Trade-offs:**
- **Pro:** Scalar references; no schema bloat.
- **Con:** Tooling must respect the namespace — easy to accidentally pass a `f-*` into a task-only function.

## Data Flow

### Prompt-to-Merge Flow

```
 [User types prompt in TUI]
        │
        ▼
 [Top-level planner agent] ──(graph mutations: createMilestone/createFeature)──> [FeatureGraph]
        │
        ▼
 [Scheduler tick: feature has no tasks, is in planning state]
        │
        ▼
 [Feature-level planner agent spawned] ──(createTask, addDependency)──> [FeatureGraph]
        │
        ▼
 [Feature moves to executing; ready tasks enter the frontier]
        │
        ▼
 [Scheduler dispatches ready tasks to worker pool (respecting reservation overlap)]
        │
        ▼
 [Worker: pi-sdk Agent in child process, worktree branched from feature branch]
        │             ▲
        │             │ (await_response / request_help → Inbox)
        │             │ (write pre-hook → claim_lock → conflict coordination)
        ▼
 [Task completes → commit on feature branch; worktree cleaned; downstream tasks unblocked]
        │
        ▼
 [All tasks done → feature enters verify phase]
        │
        ▼
 [Verify agent reviews feature branch → pass or repair loop]
        │
        ▼
 [Verify passes → feature enters merge-queue]
        │
        ▼
 [Merge train head: rebase onto main + merge-train verification]
        │
        ├── [Pass → merge to main → summarizing → work_complete]
        └── [Fail → eject, reentry_count++, back to executing_repair]
```

### State Transitions (Feature)

```
Work Control:
  discussing → researching → planning → executing → ci_check → verifying → awaiting_merge
                                                            ↘
                                                             executing_repair ─→ ci_check
  awaiting_merge ──(collab reaches merged)──> summarizing ─→ work_complete
                                             \──(budget mode)─> work_complete

Collab Control:
  none → branch_open → merge_queued → integrating → merged
                                ↓
                              conflict
  branch_open / merge_queued / conflict → cancelled

Task Run Overlay (on agent_runs):
  ready ↔ running ↔ retry_await
                    ↘
                     await_response / await_approval / manual ownership
```

### Key Data Flows

1. **Prompt → Feature DAG:** TUI prompt box → top-level planner → graph mutations → feature DAG view-model refresh.
2. **Feature → Task DAG:** Feature lifecycle reaches planning → feature-level planner → task graph mutations → task view-model.
3. **Ready frontier → Worker:** Scheduler tick computes frontier → priority-sorts → dispatches to idle worker slot → pi-sdk Agent boots in worktree.
4. **Agent ask → Inbox:** Worker tool call (`await_response`/`request_help`) → IPC message → orchestrator event → inbox entry → user answers → worker resumes (possibly after checkpoint+respawn).
5. **Task commit → Feature branch:** Worker completes → squash-merge worktree → worktree cleaned → task marked `done`.
6. **Feature verify → Merge queue:** All tasks done → verify agent runs → pass routes to `merge_queued`, fail routes to `executing_repair`.
7. **Merge-queue head → main:** Merge-train coordinator rebases + verifies + merges head; on failure, ejects with incremented re-entry count.
8. **Write pre-hook → Conflict coordination:** Worker tries to write → pre-hook `claim_lock` round-trip → orchestrator either grants or routes to cross-feature pause/rebase.
9. **Crash recovery:** On orchestrator boot → SQLite state rehydrates graph + runs → orphan worktrees surfaced to inbox → in-flight workers re-spawned with transcript replay.

### Scheduling Priority (6 keys)

Ordered sort of ready work when workers are scarce:

1. Milestone queue position (lower first)
2. Work-type tier (verify > execute > plan > summarize)
3. Critical path weight (higher `maxDepth` first)
4. Partially-failed deprioritization (non-failed first)
5. Reservation overlap penalty (non-overlapping first)
6. Retry-eligible before fresh (`retry_await && retryAt <= now`)
7. Stable fallback: age when unit became ready (older first)

## Scaling Considerations

Gvc0 is intentionally local-single-user. Scale is **graph size and concurrent workers on one machine**, not users.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| ≤50 features × ≤50 tasks (baseline) | Current design handles without tuning. Warnings surface if exceeded (per ARCHITECTURE.md). |
| ~100 features × ~50 tasks (stretch) | Serial event queue still fine. Watch for: combined-graph rebuild cost on every mutation, TUI render budget for big DAGs, SQLite transaction frequency. |
| 10+ concurrent workers | IPC back-pressure; stdio buffer sizing; NDJSON framing correctness under load. |
| Long-running sessions (days) | WAL checkpointing; agent_runs table growth; feature summary storage growth. Periodic pruning job. |

### Scaling Priorities

1. **First bottleneck:** Verification time in the merge train under many parallel features. PROJECT.md acknowledges this; known-open concern. Mitigation when it bites: speculative parallel rebase+verify of top-K queued (feature candidate); batch merges when rebase is no-op.
2. **Second bottleneck:** TUI refresh load with many concurrently updating task transcripts. Pre-v1 mitigation: rate-limit per-task transcript updates to ~15 Hz; prioritize the "focused" task's stream.
3. **Third bottleneck:** Combined-graph rebuild on every mutation. Pre-v1: simple Map rebuild is fine. Mitigation when it bites: incremental update (invalidate only affected subgraph).

## Anti-Patterns

### Anti-Pattern 1: Concurrent Graph Mutations Outside the Event Queue

**What people do:** Call `graph.createTask(...)` directly from a worker-message handler or timer, bypassing the event queue.
**Why it's wrong:** Breaks the "no-locks" invariant; introduces race conditions the architecture was designed to eliminate.
**Do this instead:** Enqueue an event; let the tick handle the mutation.

### Anti-Pattern 2: Encoding Orthogonal State in One Enum

**What people do:** Collapse work control + collab control + run state into one big `featureStatus` enum with dozens of values.
**Why it's wrong:** Invalid combinations become representable; derived states collide; FSM guards become spaghetti.
**Do this instead:** Keep the three-axis split; derive display states (`partially_failed`, `blocked`, etc.).

### Anti-Pattern 3: Spawning Agents Without Going Through the Scheduler

**What people do:** Ad hoc `new Agent()` inside orchestrator code to "just run a quick check."
**Why it's wrong:** Bypasses the worker pool cap, budget tracking, FSM guards, and recovery guarantees.
**Do this instead:** Schedule a feature-phase unit; the scheduler dispatches it.

### Anti-Pattern 4: Direct Git Operations From Multiple Modules

**What people do:** Sprinkle `simple-git` calls across orchestrator, runtime, and app.
**Why it's wrong:** Worktree state becomes un-trackable; stale-lock recovery gets impossible.
**Do this instead:** All git ops go through `runtime/worktree/` manager; orchestrator only calls the manager's port.

### Anti-Pattern 5: Making the TUI a First-Class State Holder

**What people do:** Cache graph fragments inside TUI components, update them independently from the orchestrator.
**Why it's wrong:** Divergence between rendered state and actual state — the exact class of bug "execution flow opacity" is already causing.
**Do this instead:** TUI is a pure derivation of (graph + runs + queue). View-models are derived, not authoritative.

### Anti-Pattern 6: Letting Planner Prompts Live Anywhere But `agents/`

**What people do:** Inline planner prompts inside orchestrator code for "convenience."
**Why it's wrong:** Prompts drift across files, become un-versionable, and hide the interface between orchestrator and agent.
**Do this instead:** `agents/top-planner/prompt.ts` + `agents/top-planner/tools.ts`. Orchestrator imports the invocation function, nothing else.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Anthropic (or other LLM APIs) | Via pi-sdk `Agent` + model routing | Pi-sdk owns retry / usage / fallback. Keep the orchestrator unaware of the provider. |
| `git` CLI | Via `simple-git` through worktree manager | All worktree ops centralized. Watch for `.git/index.lock` contention. |
| User terminal | Via `@mariozechner/pi-tui` | Surface-based shell; avoid direct ANSI escape writing from business logic. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Orchestrator ↔ Runtime | Runtime port (`dispatchTask`, `cancelTask`, `idleWorkerCount`, etc.) | Orchestrator never imports worker-pool internals. |
| Orchestrator ↔ Persistence | Store port (`createAgentRun`, `updateAgentRun`, `listAgentRuns`, `updateFeature`, `replaceUsageRollups`, etc.) | Store port hides SQLite schema entirely. |
| Orchestrator ↔ TUI | Graph + runs + queue + events (read-only for TUI) | TUI subscribes to a derived view-model stream. |
| Runtime worker ↔ Orchestrator | NDJSON over stdio (`ipc/` messages) | Framed, schema-validated via `@sinclair/typebox`. |
| Worker ↔ pi-sdk Agent | Direct embedding | Worker is the host process for the Agent run loop. |
| Write pre-hook → Orchestrator | Synchronous IPC round-trip (`claim_lock`) | Request lock before write; orchestrator grants or routes to coordination. |

## Validation Against the Existing gvc0 Design

Based on the patterns above, the existing gvc0 architecture (as documented in `ARCHITECTURE.md` + `docs/architecture/*`) is **directionally correct**. Specific validation:

- ✅ Serial event queue + async feature-phase agents — keep.
- ✅ Feature-DAG over task-DAG with same-feature task dep constraint — keep.
- ✅ Combined virtual graph + critical path metrics — keep.
- ✅ Work-type priority tiers (verify > execute > plan > summarize) — keep.
- ✅ Strict-main merge train with re-entry count — keep.
- ✅ Milestones as steering, not dependency — keep.
- ✅ Typed prefixed IDs — keep.
- ✅ Three-axis state split — keep (this IS the design's strength, not its weakness).
- ✅ Port-based boundaries with adapter freedom — keep.
- ⚠️ **Documentation clarity is the gap, not the design.** Invest in: one canonical state diagram, a per-feature "explain" CLI/TUI command, decision tables for coordination rules, and a newcomer onboarding doc that narrates the flow end-to-end.
- ⚠️ **Re-entry cap threshold defaults to unset in current docs** — PROJECT.md fixes (default 10, configurable, parked to inbox on cap).
- ⚠️ **Verify-is-agent-review is implicit in docs** — make it explicit (PROJECT.md REQ-MERGE-04).
- ⚠️ **Inbox scope is under-defined as "agent ask only" in current docs** — PROJECT.md broadens to unified "things waiting on you".
- ⚠️ **Two-planner collision during live edits is not addressed in docs** — PROJECT.md REQ-PLAN-07 defines the rule.
- 🔍 **Spike target: pi-sdk resume/replay fidelity** for two-tier pause (REQ-INBOX-02/03). Outcome determines whether checkpoint+replay is viable or whether we need a fallback (persist tool-call outputs for deterministic replay).

## Suggested Build Order (Phase Hints for Roadmap)

1. **Phase 1 — Foundations & Clarity.** Consolidate the existing `core/` contracts; write the canonical state diagram + onboarding narrative; commit to the vocabulary (work/collab/run). Outcome: opacity pain is addressed for future phases.
2. **Phase 2 — Persistence + Runtime Port Contracts.** Lock down Store port + RuntimePort. Stabilize NDJSON schemas. Unit-test FSM guards and scheduling priority.
3. **Phase 3 — Worker Execution Loop.** Process-per-task, pi-sdk Agent host, IPC bridge with claim_lock round-trip, worktree manager. Spike: resume/replay fidelity.
4. **Phase 4 — Scheduler Tick + Event Queue.** Serial event queue, combined-graph metrics, frontier dispatch, reservation overlap penalty.
5. **Phase 5 — Feature Lifecycle + Feature-Level Planner.** Execute a feature end-to-end: plan tasks → run tasks → verify → merge-ready.
6. **Phase 6 — Merge Train.** Rebase + verification + re-entry cap + parking on cap.
7. **Phase 7 — Top-Level Planner + Inbox.** Prompt-to-feature-DAG; agent asks routed into unified inbox; pause/resume two-tier.
8. **Phase 8 — TUI surfaces.** Feature DAG, inbox, merge-train, task transcript — in that order (DAG first because it's the spine). Config menu lands here.
9. **Phase 9 — Crash Recovery UX.** Seamless auto-resume; orphan worktree triage; inbox integration.
10. **Phase 10 — Re-plan flows + manual edits.** Additive planner re-invocation; user-edit-always-wins; proposal-view of two-planner collision cancellation.
11. **Phase 11 — Documentation + diagnostic tooling.** `gvc0 explain` CLI, canonical diagrams, decision tables for coordination.
12. **Phase 12 — Integration + polish.** End-to-end scenarios, TUI e2e tests, verify agent prompt tuning.

(Actual roadmap phase count + boundaries left to `gsd-roadmapper`. This is a hint, not a contract.)

## Sources

- `/home/alpine/vcode0/.planning/PROJECT.md` — scope, decisions, pain points
- `/home/alpine/vcode0/ARCHITECTURE.md` — existing design thesis
- `/home/alpine/vcode0/docs/architecture/graph-operations.md` — graph mutations + scheduler pseudocode (reproduced pattern source)
- `/home/alpine/vcode0/docs/architecture/data-model.md` — state axes
- `/home/alpine/vcode0/docs/architecture/worker-model.md` — IPC + worker lifecycle
- `/home/alpine/vcode0/docs/architecture/planner.md` — planner/agent contracts
- `/home/alpine/vcode0/docs/architecture/persistence.md` — SQLite schema
- `/home/alpine/vcode0/docs/operations/verification-and-recovery.md`, `conflict-coordination.md`, `warnings.md`
- `/home/alpine/vcode0/specs/README.md` + scenario specs
- Comparative general knowledge of DAG workflow engines (Airflow, Dagster, Temporal), merge queues (Bors, Aviator, GitHub Merge Queue), and agent runtimes

---
*Architecture research for: DAG-first autonomous coding orchestrator on pi-sdk*
*Researched: 2026-04-23*
