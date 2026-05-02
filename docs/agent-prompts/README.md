# Agent Prompts

Prompt references for gvc0 agent phases.
Canonical live prompt source lives under `src/agents/prompts/` for feature phases and `src/runtime/worker/system-prompt.ts` for task execution.
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
- `Summarize Feature` is live post-merge prompt source; budget profile may skip invoking it.
- `Discuss Feature`, `Research Feature`, and `Summarize Feature` end with structured `submitDiscuss(...)`, `submitResearch(...)`, and `submitSummarize(...)` outputs.
- `Verify Feature` verifies real feature outcome, not generic style, and ends with structured `submitVerify(...)` output.

## Topology escalation

Feature-phase agents that uncover project-graph topology issues (a feature that should split, two features that duplicate each other, a missing prerequisite, or wrong dependency edges) escalate via `request_help` with a query prefixed `[topology]`. Discuss is the primary capture point; plan/replan only escalate when the issue cannot be resolved within the current feature's scope. The project planner reviews `[topology]` escalations and decides whether to restructure the project graph; the help query surfaces from the run row (`agent_runs.payload_json`) while the run sits at `await_response`.

## Main source families

- GSD-2 prompts under `gsd-2/src/resources/extensions/gsd/prompts/`
- Claude Code plugin agents and commands under `anthropics/claude-code/plugins/`
- Local gvc0 live prompt source under `src/agents/prompts/` and `src/runtime/worker/system-prompt.ts`
- Local gvc0 implementation seams under `src/agents/`, `src/runtime/`, `src/orchestrator/`, and `docs/`
