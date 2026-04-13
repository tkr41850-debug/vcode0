# Agent Prompts

Draft prompt references for gvc0 agent phases.
These docs capture recommended prompt shape, intended purpose, and upstream influences used during analysis.
They are guidance docs, not live runtime source yet.

## Index

- [Discuss Feature](./discuss-feature.md) — interactive clarification prompt for feature intent, constraints, and success criteria
- [Research Feature](./research-feature.md) — planner-facing code map and risk/verification reconnaissance prompt
- [Plan Feature](./plan-feature.md) — shared planning/replanning doctrine prompt
- [Execute Task](./execute-task.md) — runtime worker execution contract prompt
- [Verify Feature](./verify-feature.md) — feature-level semantic verification gate prompt

## Notes

- `Plan Feature` covers both initial planning and replanning. Same prompt family; context changes.
- `Execute Task` is runtime-owned because worker prompt is assembled from runtime context.
- `Verify Feature` should verify real feature outcome, not devolve into generic style review.

## Main source families

- GSD-2 prompts under `gsd-2/src/resources/extensions/gsd/prompts/`
- Claude Code plugin agents and commands under `anthropics/claude-code/plugins/`
- Local gvc0 architecture and memory under `src/agents/`, `src/runtime/`, and `memory/`
