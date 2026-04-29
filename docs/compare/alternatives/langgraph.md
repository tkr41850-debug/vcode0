# Comparison with LangGraph

Snapshot taken on 2026-04-28 from public LangGraph materials only ([github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)). This is a high-level evaluation of LangGraph as a *potential migration substrate* for gvc0's scheduler core, not a deep code audit. Worth revisiting if either project shifts substantially.

## Why this comparison matters

In the 2026-04 frameworks survey (AutoGen, CrewAI, MetaGPT, smolagents, Pydantic-AI / deepagents, Magentic-One, LangGraph), **LangGraph was the only framework with a real DAG-as-state model**. Everyone else does either conversation-style coordination (AutoGen, CrewAI) or single-agent execution (smolagents). If gvc0 ever wants to swap out its hand-rolled scheduler core for a framework, LangGraph is the only realistic candidate.

The headline finding of this evaluation: **LangGraph would replace the scheduler core, not the merge train.** It's worth borrowing the interrupt-and-resume protocol pattern; it's probably not worth a migration.

## Summary

LangGraph and gvc0 share the *graph-as-state* intuition but differ on what the graph represents:

- **LangGraph** uses a graph to model the *control flow of a single agent run*: nodes are LLM/tool/decision steps, edges are conditional transitions, state is checkpointed at each node. The graph is per-run, even when checkpointing makes runs resumable.
- **gvc0** uses a graph to model the *long-lived structure of a software-delivery project*: nodes are milestones / features / tasks, edges are dependency relationships, state is persistent across runs.

These are different shapes of "DAG." LangGraph's DAG is a workflow definition; gvc0's DAG is the project itself.

Conceptual mapping (approximate, with caveats):

- LangGraph **node** ≈ a step in our **scheduler tick** or a phase in our **task lifecycle**.
- LangGraph **state** ≈ our **agent_run** row + transient run-state.
- LangGraph **interrupt** ≈ our **proposal-graph human-approval gate**.
- LangGraph **checkpoint** ≈ our **SQLite persistence + startup reconciler**.
- LangGraph has no clear analogue to our **milestone / feature / task graph** as long-lived project state.
- LangGraph has no analogue to our **merge train**.

## Feature mapping

| LangGraph capability | Our architecture | Notes |
|---|---|---|
| Graph definition (nodes + edges + conditional routing) | Scheduler tick + FSM transitions | Both express conditional flow as a graph. Ours is implemented in TypeScript without a framework abstraction. |
| State checkpointing | SQLite persistence | LangGraph offers thread-level checkpointing with multiple backends; we use better-sqlite3 directly. |
| Interrupts (HITL pause / resume) | Proposal-graph approval gate, plus help/approval waits on agent_runs | LangGraph's interrupt-and-resume protocol is the cleanest pattern in the framework. Worth borrowing the *shape* even if not the implementation. |
| Subgraphs | Feature task-graph nested inside feature graph | LangGraph composes graphs; we compose graphs by domain (feature / task). |
| Streaming and time-travel | Partial — we stream IPC events but don't time-travel | LangGraph supports replay; gvc0 does not. |
| Multi-agent coordination | Planner / replanner / task worker / verify agents | Both support multi-agent. LangGraph is general-purpose; ours is hard-coded to the lifecycle. |
| Persistent project DAG | Yes (milestone / feature / task) | gvc0's distinguishing axis. LangGraph runs are checkpointed but per-run. |
| Programmatic merge train | Yes | gvc0's distinguishing axis. LangGraph has no equivalent. |
| Split state model | Yes (work / collaboration / run) | gvc0's distinguishing axis. LangGraph uses a single state graph per thread. |
| Typed verification routing | Yes (`VerifyIssue` discriminated union) | gvc0's distinguishing axis. LangGraph would model this as edge conditions; we model it as a typed payload. |
| Budget routing tiers | Yes (heavy / standard / light) | gvc0-specific; not a LangGraph concern. |
| Process-per-task workers in worktrees | Yes | gvc0-specific runtime model; LangGraph is process-internal by default (would need orchestration outside the graph). |

## What gvc0 could borrow from LangGraph

In rough order of value:

1. **Interrupt-and-resume protocol shape.** LangGraph's interrupt API is the cleanest published pattern for HITL-pause-with-resume. Even without adopting LangGraph, the protocol shape (interrupt at a typed checkpoint; resume with operator input as part of the next state) is worth modeling our proposal-graph approval against. Today our HITL gate is implemented inline in the planner; making it a more uniform interrupt-with-resume primitive across `agent_runs` (`help_wait`, `approval_wait`, `proposal_pending`) would simplify state code.
2. **Time-travel / replay.** LangGraph supports stepping back to an earlier checkpoint and re-running. gvc0's startup reconciler already handles crash recovery, but time-travel for *intentional* re-execution (re-run a feature from a particular state) is not a current capability. Could be useful for replanner debugging.
3. **Streaming as a first-class graph concern.** LangGraph models event streaming uniformly; we have NDJSON IPC for tasks but ad-hoc streaming for the rest of the system. Worth examining whether a uniform event-stream contract on `agent_runs` would help.

## What gvc0 should not adopt

1. **LangGraph as scheduler substrate.** Adopting LangGraph would mean (a) absorbing Python or relying on JS bindings of varying maturity, (b) giving up the typed `FeatureGraph` / `TaskGraph` schema gvc0 maintains in `core/graph`, and (c) losing the `core/` (pure) → `orchestrator/` (service) boundary discipline because LangGraph's model doesn't naturally separate domain logic from execution flow. Cost is high; benefit is unclear because gvc0's scheduler isn't the bottleneck.
2. **LangGraph state graph as project state.** LangGraph's state is per-thread; trying to encode a long-lived project DAG as a LangGraph state would be working against the grain. Project state belongs in our domain types and SQLite, not in a workflow framework's state graph.

## Migration cost estimate (if we ever did this)

If a migration to LangGraph as scheduler substrate were forced (e.g., by a hypothetical future requirement for a managed cloud version), the rough scope:

| Replaceable by LangGraph | Stays in gvc0 |
|---|---|
| Scheduler tick / ready-work dispatch | Domain types (milestone / feature / task) |
| Per-run state checkpointing | DAG mutations and dependency-shape constraints |
| HITL interrupt-and-resume | Merge train (rebase / CI / SHA validation / `merge --no-ff`) |
| Streaming events to the TUI | Conflict coordination policy (same-feature locks + primary/secondary) |
| Verify failure → replanner routing | Typed `VerifyIssue` + replanner agent |
| | Worker process management + IPC |
| | Budget routing |
| | Crash recovery against git refs |

So even in a maximalist migration, **the merge train, the conflict policy, the typed verification routing, and the dependency-shape constraints all stay in gvc0**. LangGraph would be a substrate for the workflow part, not a replacement for the architecture.

This makes the migration math unattractive: high cost (Python interop or JS-binding fragility, framework lock-in, rewriting `core/` boundaries), modest benefit (LangGraph's strongest features — checkpointing and interrupts — we can adopt as patterns without adopting the framework).

## Where we still differ in goals

1. **General-purpose vs. specialized.** LangGraph is a general-purpose agent framework; gvc0 is specifically a software-delivery orchestrator. Specialization is gvc0's leverage — the DAG dependency constraints, the merge train, and the typed verification routing only make sense in the software-delivery domain.
2. **Framework vs. system.** LangGraph is a framework you compose into; gvc0 is a system you run. Different positioning, different audiences.
3. **Persistence model.** LangGraph checkpoints per-thread; gvc0 persists project state. Different scopes.

## Recommended action

- **Borrow:** the interrupt-and-resume protocol shape for unifying our `agent_runs` wait states.
- **Consider:** adopting a uniform streaming-event contract similar to LangGraph's.
- **Skip:** wholesale migration; the cost/benefit is poor and the architectural fit is mismatched.
- **Watch:** if LangGraph ships a long-lived multi-thread project-state primitive, re-evaluate. Currently their state model is per-thread.

## Public references

- <https://github.com/langchain-ai/langgraph>
- <https://langchain-ai.github.io/langgraph/>

## Revisit notes

This comparison is worth revisiting after:

- LangGraph publishes a long-lived multi-thread / project-level state primitive.
- gvc0 ships a uniform interrupt-and-resume primitive on `agent_runs` — to confirm whether the protocol shape ended up resembling LangGraph's.
- A first-party TypeScript port of LangGraph reaches feature parity (would lower the migration cost significantly).

## Adoption status

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| Borrow interrupt-and-resume protocol shape for unifying `agent_runs` wait states (`help_wait`, `approval_wait`, `proposal_pending`) | open | — | Approval gate exists (planner proposal flow via `e51a528`) but the interrupt-with-resume shape is not yet a uniform primitive across all `agent_runs` wait states. |
| Consider uniform streaming-event contract on `agent_runs` similar to LangGraph's | open | — | gvc0 has NDJSON IPC for tasks; rest of the system is ad-hoc. No feature-candidate filed yet. |
| Migrate to LangGraph as scheduler substrate | rejected | — | Cost is high (Python interop or JS-binding fragility, framework lock-in, rewriting `core/` boundaries); benefit is modest since LangGraph's strongest features (checkpointing, interrupts) can be adopted as patterns without adopting the framework. Merge train, conflict policy, typed verification routing, and dependency-shape constraints all stay in gvc0 regardless. |
| Watch LangGraph for a long-lived multi-thread project-state primitive | deferred | — | Currently LangGraph state is per-thread. Re-evaluate if a project-level state model ships — would change the migration math. |
