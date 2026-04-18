# prompts

Prompt templates for feature-phase agents.

This directory owns the live prompt library for `discuss`, `research`, `plan`, `replan`, `verify`, and `summarize`, plus shared prompt-render helpers.
It does not own worker task execution prompts or tool implementations.

## Layout

- `index.ts` — prompt library registration and template lookup/override surface.
- `shared.ts` — common section renderers and formatting helpers reused across phases.
- `discuss.ts`, `research.ts`, `plan.ts`, `verify.ts`, `summarize.ts` — phase-specific doctrine and output instructions.
- `plan.ts` exports both plan and replan templates; replanning is a context change, not a separate prompt family.

## Boundary reminders

- The execute-task worker prompt lives in [runtime/worker/system-prompt.ts](../../runtime/worker/system-prompt.ts) because runtime renders it from the planner-baked `TaskPayload`.
- Phase prompts and phase tools are a contract: each prompt must line up with the submit tool surface exposed by [tools](../tools/README.md).
- `docs/agent-prompts/**` is the browsable reference/provenance layer. This directory is the live source.

## See also

- [Agent Prompts docs](../../../docs/agent-prompts/README.md)
- [agents](../README.md)
- [tools](../tools/README.md)
