# tools

Planner and feature-phase tool surfaces for non-worker agents.

This directory owns typed tool args/results, proposal and feature-phase tool hosts, TypeBox schemas, and the pi-agent toolsets built on top of them.
It does not own task-worker execution tools; those live under [Worker Agent](../worker/README.md).

## Current surface

- `index.ts` is barrel only; concrete pieces live in `types.ts`, `proposal-host.ts`, `feature-phase-host.ts`, `schemas.ts`, `planner-toolset.ts`, and `agent-toolset.ts`.
- Proposal tools operate on a cloned draft graph: `addFeature`, `removeFeature`, `editFeature`, `addTask`, `removeTask`, `editTask`, `addDependency`, `removeDependency`, `submit`.
- Feature-phase tools inspect authoritative state and return structured phase outputs: `getFeatureState`, `listFeatureTasks`, `getTaskResult`, `listFeatureEvents`, `listFeatureRuns`, `getChangedFiles`, `submitDiscuss`, `submitResearch`, `submitSummarize`, `submitVerify`.
- `GraphProposalToolHost` mutates only an `InMemoryFeatureGraph` draft until `submit()` builds a proposal.
- `DefaultFeaturePhaseToolHost` reads live graph/store state and caches the structured result each phase must submit.

## Sharp edges

- Planner `submit` here finalizes a proposal draft. It is not the same as the worker `submit` tool that finishes task execution.
- Proposal tools are draft-only until orchestrator approval applies the resulting `GraphProposal`.
- Prompt changes and tool-surface changes usually need to move together. Keep this file aligned with [prompts](../prompts/README.md).

## See also

- [agents](../README.md)
- [prompts](../prompts/README.md)
- [Worker Agent](../worker/README.md)
