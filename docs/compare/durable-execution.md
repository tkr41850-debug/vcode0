# Durable Execution Landscape

Snapshot taken on 2026-04-29. Survey of durable-workflow-execution platforms relevant to autonomous coding agents, with a focus on whether and how gvc0 should integrate with this category.

## Why this page matters

A common architectural critique of gvc0 is "you're rebuilding what Temporal already does." This page documents the landscape, the actual gap between dedicated durable-execution engines and gvc0's git-refs-authoritative state model, and the specific evaluation question for Earendil's `absurd`.

## The category in 2026-04

| Platform | Funding / Status | Primitive | State substrate |
|---|---|---|---|
| **Temporal** | $300M Series E at $5B (2026-02) | Workflow + activity, deterministic replay | Cassandra / Postgres / MySQL |
| **Restate** | Independent OSS + commercial | Virtual objects + invocations | Embedded RocksDB |
| **Inngest** | Series B | Functions + steps, event-driven | Postgres |
| **DBOS** | Series A | Decorators on Postgres transactions | Postgres-native |
| **Earendil `absurd`** | Pre-1.0, public preview | Workflow + step, agent-native | Postgres-native |
| **LangGraph** | Part of LangChain stack | Graph nodes with checkpointing | Pluggable (Postgres / SQLite / memory) |

## What "durable execution" actually means

The shared promise: a workflow can resume from any step boundary after a crash, without replaying side effects, with deterministic guarantees. The shared mechanism: persist the inputs and outputs of each step boundary to a durable store, plus a journal of which step is next.

The category divides on **where the durability boundary sits**:

- **Coarse-grained (LangGraph)**: durability between graph nodes. Within a node, behavior is non-durable; if a long-running tool call crashes mid-call, the node restarts.
- **Step-grained (Temporal, Restate, Inngest, DBOS, `absurd`)**: durability around every recorded step (typically a tool call or activity). Crash mid-step means the step replays but the prior steps do not.

## Where gvc0 sits

gvc0 deliberately chose **git refs as authoritative state**, with SQLite for derived bookkeeping. This is outside the durable-execution category by design:

- **Recovery semantics**: on crash, `git status` + the persisted task table reconstruct the state-of-the-world. There is no journal replay because there is no journal — the file tree itself is the state.
- **Step boundaries**: a "step" in gvc0 is a worker tool call or a merge-train operation. Tool calls inside the worker are durable iff git records them; merge-train operations are durable because they update refs atomically.
- **What gvc0 lacks**: deterministic replay of agent decisions. If the orchestrator crashes mid-task, the task worker resumes from the worktree state, but the LLM call that was in flight is lost (the agent re-decides from the resumed context).

The gap is real but bounded. Re-deciding from resumed context is acceptable in coding agents (the agent re-reads files anyway) but unacceptable in financial workflows (you can't re-charge a card "deterministically").

## What dedicated engines would buy gvc0

If gvc0 adopted Temporal / Restate / `absurd` for orchestrator scheduling state:

- **Won**: deterministic replay of orchestrator decisions; cleaner crash semantics for the scheduler itself; fewer reconciler edge cases at startup.
- **Lost**: the git-refs-authoritative property if naively applied. The graph state would split between the durable engine and git refs, creating a two-source-of-truth problem worse than the current single-source-of-truth (git) model.
- **Unclear**: whether a hybrid where git stays authoritative for graph mutations but the engine handles in-flight scheduling is a net win or a new failure surface.

## What dedicated engines would not buy gvc0

- **Crash recovery for task workers.** This already works via worktree state + `agent_runs` rows. A durable engine would not improve it.
- **Merge train integrity.** Already invariant-protected. Durable execution adds nothing.
- **Replanner correctness.** This is an LLM-correctness problem, not a workflow-durability problem.

## Why `absurd` is worth a sprint of evaluation

`absurd` is interesting specifically because it's:

1. **Postgres-native.** The substrate is well-understood; no new operational surface.
2. **Built by Earendil for Pi agents.** The semantics are designed around the same execution shape gvc0 uses (tool-calling agents with long-running steps), so impedance mismatch is lower than with Temporal.
3. **Not aimed at being a state monolith.** Public materials suggest `absurd` expects to coexist with other state stores rather than subsume them.

The evaluation question for gvc0: **does `absurd` improve orchestrator-internal scheduling state without compromising git-refs-authoritative graph state?** See [absurd-evaluation.md](../feature-candidates/absurd-evaluation.md).

## LangGraph's specific gap

LangGraph's checkpointing is between-node, not within-node. For coding agents this matters because:

- A worker tool call (e.g., a long `npm test` invocation) is a single node-internal activity in LangGraph terms.
- If the orchestrator crashes during that call, LangGraph restarts the node from scratch.
- gvc0's persistence + worktree model resumes from where the call was, because the worktree is the state.

This is one of several reasons LangGraph remains a "migration substrate candidate" rather than a "migration substrate recommendation" in [OVERVIEW.md](./OVERVIEW.md).

## Public references

- Temporal funding: <https://temporal.io/blog/series-e>
- Restate: <https://restate.dev/>
- Inngest: <https://www.inngest.com/>
- DBOS: <https://www.dbos.dev/>
- Earendil `absurd`: <https://earendil.dev/absurd/>
- LangGraph checkpointing: <https://langchain-ai.github.io/langgraph/concepts/persistence/>

## Revisit notes

Worth revisiting after:

- `absurd` reaches v1 with public API stability commitments.
- Temporal publishes opinionated patterns for LLM-agent workflows (Q3 2026 expected).
- A documented case study emerges of a coding agent migrating from custom state to a durable engine and reporting net win or loss.
