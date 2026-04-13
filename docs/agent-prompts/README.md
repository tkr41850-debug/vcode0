# Agent Prompts

Prompt references for gvc0 agent phases.
Canonical live prompt source now lives under `src/agents/prompts/` and `src/runtime/worker/system-prompt.ts`.
These docs keep purpose, prompt text, and upstream provenance in one browsable place.

## Index

- [Discuss Feature](./discuss-feature.md) — interactive clarification prompt for feature intent, constraints, and success criteria
- [Research Feature](./research-feature.md) — planner-facing code map and risk/verification reconnaissance prompt
- [Plan Feature](./plan-feature.md) — shared planning/replanning doctrine prompt
- [Execute Task](./execute-task.md) — runtime worker execution contract prompt
- [Verify Feature](./verify-feature.md) — feature-level semantic verification gate prompt
- [Summarize Feature](./summarize-feature.md) — post-merge delivered-capability summary prompt
- [Upstream References](./upstream/README.md) — copied upstream prompts and system prompts used as references

## Notes

- `Plan Feature` covers both initial planning and replanning. Same prompt family; context changes.
- `Execute Task` stays runtime-owned because worker prompt is assembled from runtime context.
- `Summarize Feature` is feature-phase prompt source even though current scheduler summary implementation is still minimal.
- `Verify Feature` should verify real feature outcome, not devolve into generic style review.

## Main source families

- GSD-2 prompts under `gsd-2/src/resources/extensions/gsd/prompts/`
- Claude Code plugin agents and commands under `anthropics/claude-code/plugins/`
- Local gvc0 live prompt source under `src/agents/prompts/` and `src/runtime/worker/system-prompt.ts`
- Local gvc0 architecture and memory under `src/agents/`, `src/runtime/`, and `memory/`
