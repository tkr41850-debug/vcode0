# 02-project-planner — Top-level project planner & feature-planner scope split

Implementation track to introduce a project-scope planner agent that owns graph topology mutation (milestones, features, inter-feature dependencies, feature specs), restrict the existing per-feature planner to feature-local task graph and spec work, and replace the synthetic-feature bootstrap path with a real first-run project-planner session. Adds explicit TUI mode for project-planner chat with persistent sessions.

This track assumes [01-baseline](../01-baseline/README.md) has merged. It is intentionally separate: the changes touch agent surface, persistence, TUI, and bootstrap composition, which would blur the local-MVP plan if folded in as more "phases".

The architecture is captured in this README; phase docs detail the steps. Open design questions and the concurrent-session policy live in [docs/concerns/concurrent-project-planner-sessions.md](../../concerns/concurrent-project-planner-sessions.md).

## Architectural non-negotiables

These are the **end-state** invariants — the system after the whole track lands.

- **Topology mutation is project-scoped only.** After the track lands, no feature-scoped agent can mutate milestones, features, or cross-feature dependencies. Today only `plan` and `replan` reach the proposal-graph host; `discuss`, `research`, `verify`, `summarize`, and `execute-task` are already topology-clean. Topology tools (`addMilestone`, `addFeature`, `removeFeature`, `editFeature` rename/milestone-reassign, cross-feature `addDependency`/`removeDependency`) are constructed only into the project-planner agent's toolset. Feature plan/replan agents that detect a topology issue escalate via existing `request_help`; the operator resolves by running the project planner.
- **Project-planner sessions are first-class persistent runs.** A session is one `agent_runs` row with `scope_type='project'`. Conversation/checkpoint persistence reuses the existing per-session file path (`.gvc0/sessions/<sessionId>.json` via `src/runtime/sessions/index.ts`) with `agent_runs.session_id` linking to the file — same shape as feature-phase sessions today. Sessions are resumable, listable, and individually cancellable.
- **Bootstrap is agent-driven, not synthetic.** `initializeProjectGraph` no longer fabricates a stub `m-1`/`f-1` and forces it into `planning`. On a greenfield project, the compose layer creates empty project state and spawns a project-planner first-run; the TUI auto-enters that session.
- **No project-scope merge train.** Concurrent project-planner sessions are allowed. Apply-time CAS validation rebases the second proposal against the first's applied result. Hard serialization is out of scope; see concern doc.
- **Tool subsets are constructed at agent-creation time, not enforced at runtime in `proposalToolHost`.** The host stays scope-agnostic; the runtime decides which subset to expose per agent role. This keeps the host invariant simple and pushes scope discipline to the call site.

## Agent types and topology authority

Eight agent roles in the end-state. Only the project planner and feature plan/replan agents mutate any graph; the rest are scope-clean by construction (structured submits, no proposal-graph host). Today on `main`, 5 of 7 existing roles already lack proposal-graph tools — Phase 3 only needs to narrow plan/replan, not all feature-scoped agents.

| Agent | Scope | Mutation surface | Submit shape | Construction site (today) | Phase 3 impact |
|-------|-------|------------------|--------------|---------------------------|----------------|
| **Project planner** *(new in Phase 4)* | Project | `addMilestone`, `addFeature`, `removeFeature`, `editFeature` (full incl. milestone reassign), cross-feature `addDependency`/`removeDependency`, `submit`, `request_help` | `submit` (proposal graph) | n/a — added in Phase 4 | adds new agent |
| Feature discuss | Feature (read-only) | none — inspection only | `submitDiscuss` (structured) | `runtime.ts:359-371` via `DefaultFeaturePhaseToolHost` | already clean |
| Feature research | Feature (read-only) | none — inspection + repo read tools | `submitResearch` (structured) | `runtime.ts:359-371` via `DefaultFeaturePhaseToolHost` | already clean |
| Feature plan | Feature | `addTask`, `editTask`, `removeTask`, `setFeatureObjective`, `setFeatureDoD`, intra-feature `addDependency`/`removeDependency`, `submit`, `request_help` | `submit` (proposal graph) | `runtime.ts:417-434` via `proposalToolHost` (full set today) | **narrow toolset** |
| Feature replan | Feature | same as plan | `submit` (proposal graph) | `runtime.ts:417-434` via `proposalToolHost` (full set today) | **narrow toolset** |
| Feature verify | Feature (read-only) | none — `raiseIssue` records typed issues | `submitVerify` (structured) | `runtime.ts:491-504` via `DefaultFeaturePhaseToolHost` | already clean |
| Feature summarize | Feature (read-only) | none — inspection only | `submitSummarize` (structured) | `runtime.ts:359-371` via `DefaultFeaturePhaseToolHost` | already clean |
| Execute task | Task (worker) | repo edits + verification commands; no graph tools | structured execution report | worker process via `runtime/worker/system-prompt.ts` | already clean |

Topology authority (project-scope) is held only by the new project-planner agent. `editFeature` patches that touch milestone reassignment or rename live in project scope; an `editFeatureSpec` subset (description / objective / DoD only) covers safe spec refinement — usable by the project planner and by orchestrator-level spec updates derived from `submitDiscuss` output.

Note: today's `PlannerFeatureEditPatch` (`src/core/graph/types.ts:65-75`) does not actually expose a `milestoneId` field, so milestone reassignment is not reachable through `editFeature` on `main`. Phase 4 must add it (or a sibling `moveFeatureToMilestone` tool) when the project-planner agent ships, since milestone reassignment is part of project-scope authority.

## Bootstrap flow (greenfield)

1. `/init` (or app start with empty project) creates an empty project state. No synthetic milestone or feature.
2. Compose layer auto-spawns a project-planner session (`agent_runs` row with `scope_type='project'`).
3. TUI auto-enters project-planner mode. Composer is focused; focus indicator shows "composer · project planner".
4. User chats with the planner. Planner uses topology tools to build proposal graph (milestones, features, deps).
5. Planner calls `submit`. Run enters `await_approval`. TUI shows proposal review surface.
6. User approves. Proposal applies to authoritative graph. Project-planner session completes. Feature workControl FSMs take over (each feature starts at `discussing` per existing data-model rules).
7. With `--auto`, scheduler then dispatches feature `discussing` phases per existing flow.

If the user dismisses the project-planner mode without submitting, the session persists in `running` state and is resumable.

## Bootstrap flow (existing project)

1. App starts with non-empty project. No auto-enter.
2. User can invoke project planner via TUI mode switch (slash command). Available actions: start new session, resume existing session.
3. Same submit/approve cycle.
4. If the proposal touches features that have running tasks, the approval surface highlights the impact. Cancellation of running work is a separate explicit step the operator must approve before the topology change applies.

## Scope

Eight phases. Phase 1 is a scheduler-hygiene unblock that makes the rest visible during interactive testing; phases 2–6 build the architecture; Phase 7 is escalation polish (depends on Phase 3 for toolset architecture) and Phase 8 is submit-compliance hardening (depends on Phases 1, 3, 4, and 7). Phases 2 and 3 are independent of each other and can ship in either order before Phase 4. Phases 4 and 5 serialize through Phase 4. Phase 6 depends on Phases 4 and 5. Phase 8 must ship last.

| Phase | Theme | Outcome | Risk |
|-------|-------|---------|------|
| [Phase 1](./phase-1-scheduler-hygiene.md) | **Scheduler hygiene unblock** — ships first | Filter `runStatus='failed'` from feature-phase re-dispatch; surface `failed` in TUI feature view | Low — narrow filter + TUI mapping; gives visibility before architectural work |
| [Phase 2](./phase-2-agent-runs-scope.md) | **`scope_type='project'` discriminator** | Extend existing `scope_type` union with `'project'`; type & codec updates; query helpers | Low — additive on existing column |
| [Phase 3](./phase-3-toolset-split.md) | **Toolset split per scope** | Narrow plan/replan toolset to task-only (topology tools removed); define `projectPlannerTools` subset for Phase 4; introduce `editFeatureSpec`. Discuss/research/verify/summarize/execute-task already clean — untouched. | Low — wiring change on plan/replan only, no new agent yet; reduces blast radius of submit-compliance issues |
| [Phase 4](./phase-4-project-planner-agent.md) | **Project-planner agent + dispatch** | New agent role with topology toolset; project-run dispatch path; session lifecycle; persistence + resume | Medium — new dispatch type, new agent run shape |
| [Phase 5](./phase-5-bootstrap-rewrite.md) | **Bootstrap rewrite** | `initializeProjectGraph` no longer creates synthetic `m-1`/`f-1`; compose layer spawns project-planner first-run on empty project | Medium — touches startup ordering and existing test fixtures that assume synthetic feature |
| [Phase 6](./phase-6-tui-mode.md) | **TUI mode + focus indicator** | Project-planner chat mode; auto-enter on greenfield; composer focus indicator chrome; session list view | Medium — TUI surface change, multiple compose-time wires |
| [Phase 7](./phase-7-escalation-prompt.md) | **Escalation prompt + UX** | Prompt guidance for feature planners to escalate topology concerns via `request_help`; optional structured `topology_request` inbox kind | Low — prompt + optional inbox kind |
| [Phase 8](./phase-8-submit-compliance.md) | **Submit-compliance hardening** | Tool_choice forcing at SDK call site; prompt hardening for both planner scopes; deterministic-LLM regression test | Medium — touches every planner run; depends on Phases 1, 3, 4, and 7 |

After Phase 6 merges, the [docs update sweep](./docs-update-sweep.md) lists every documentation file that needs updates. Bundle those into 4–5 doc-only commits at the end of the milestone.

## Cross-cutting concerns

- **Existing `scope_type` column.** `agent_runs.scope_type` already exists in `001_init.ts` with `'task'` and `'feature_phase'` values. Phase 2 extends the union with `'project'`; no schema migration is needed — the column is `TEXT NOT NULL` with no CHECK constraint. `scope_id` is interpreted by `scope_type`: task id, feature id, or (for project) a stable singleton id like `'project'` (the row's own `id` is the session uid).
- **Apply-time CAS for concurrent sessions.** No project-scope merge train. When a project-planner proposal applies, the apply path validates each recorded mutation against current authoritative state. Mismatches reject the apply with a structured rebase reason; the session re-opens against the new baseline. Tracked in [docs/concerns/concurrent-project-planner-sessions.md](../../concerns/concurrent-project-planner-sessions.md).
- **Escalation routes through `request_help`.** Feature planners detecting a topology issue use the existing `request_help` tool. Run goes to `await_response`; the operator resolves by running the project planner and replying to the help request. No new wait state, no new escalation infrastructure.
- **Project planner has no feature worktree.** Phase 4 dispatch path must not provision a feature worktree for project-scope runs. The existing `featurePhaseRequiresFeatureWorktree` predicate already gates pre-execution feature phases; the new project-scope dispatch path follows the same convention by construction.
- **Event-driven project dispatch.** Project sessions are not graph-driven and are not collected by `prioritizeReadyWork`. Phase 4's `dispatchProjectRunUnit` is invoked from the coordinator (at session create / resume) and from the recovery service (at orchestrator boot, for `runStatus='running'` rows). `SchedulableUnit` stays `task | feature_phase` only. This keeps the architecture boundary clean — `core/scheduling/` does not need to import `Store` or query persistence.
- **Bug-context interaction.** The runaway re-dispatch loop and TUI invisibility documented in the prior investigation are addressed directly by Phase 1 (scheduler hygiene + TUI surface). The submit-compliance failure mode is addressed by Phase 8 (prompt + tool_choice). Phases 2–6 build the architecture; the bugs are independent and shipped first.

## Working agreement

Same as [01-baseline](../01-baseline/README.md#working-agreement): each phase doc breaks into numbered steps; per step, implement, run `npm run check:fix` then `npm run check`, run a review subagent, address findings, commit with the conventional-commit subject given in the step.

Phases that fit one logical change ship as one commit. Phases with several independent steps ship as multiple commits, one per step. No squashing across phases.

## Cross-phase conventions

- New persistence work uses the existing TS migration system (`src/persistence/migrations/NNN_*.ts`). Phase 2's `scope_type='project'` extension does not need a migration; if a CHECK constraint is added later for type safety, that is a separate migration outside this track.
- New IPC frame variants extend the schemas added in 01-baseline phase 1; the validation gate from that phase covers them automatically.
- New ports (project-run dispatch, session resume) extend `src/orchestrator/ports/index.ts` first, then concrete implementations.
- Architecture boundary still holds: `core/` does not import `runtime/` or `persistence/`. Project-planner agent code lives in `agents/`, dispatch in `orchestrator/scheduler/`, persistence in `persistence/`.
- Inbox-row invariant preserved: any new escalation path appends an `inbox_items` row.
- Per-step review subagents: each phase document includes a review prompt to run after implementation, before commit. Convention from `01-baseline/README.md` working agreement.

## Out of scope

- Project-scope merge train or topology serialization queue (deferred; concurrency handled by apply-time CAS rebase per concern doc).
- Auto-spawning project planner from feature planner without operator mediation.
- Reworking feature workControl FSM. Discuss/research/plan/replan stay as-is.
- Removing or restructuring the existing `proposalToolHost`. It stays scope-agnostic; the runtime decides toolset subsets per agent.
- TUI live-planner third dataMode rework. Stays as-is per `01-baseline` non-goal.
- Cross-region / multi-orchestrator coordination. Single orchestrator authority remains.

## Related

- [docs/architecture/planner.md](../../architecture/planner.md) — current planner toolset model.
- [docs/architecture/data-model.md](../../architecture/data-model.md) — feature workControl/collabControl, ID conventions.
- [docs/architecture/persistence.md](../../architecture/persistence.md) — `agent_runs` schema (existing `scope_type`).
- [docs/architecture/worker-model.md](../../architecture/worker-model.md) — run lifecycle, IPC.
- [docs/architecture/graph-operations.md](../../architecture/graph-operations.md) — DAG mutation rules.
- [docs/concerns/concurrent-project-planner-sessions.md](../../concerns/concurrent-project-planner-sessions.md) — concurrent session rebase policy.
- [docs/implementation/01-baseline/README.md](../01-baseline/README.md) — phase doc format and ship-order rationale.
- [docs/implementation/01-baseline/phase-7-composer-focus-and-autocomplete.md](../01-baseline/phase-7-composer-focus-and-autocomplete.md) — prior composer focus work; Phase 6 here extends with focus indicator.
- [docs/implementation/01-baseline/phase-8-planning-branch-bootstrap.md](../01-baseline/phase-8-planning-branch-bootstrap.md) — current bootstrap path; Phase 5 here supersedes the synthetic-feature half.
