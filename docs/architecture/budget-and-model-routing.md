# Budget and Model Routing

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Budget

Configurable per-task and global USD ceilings. Workers report token usage via IPC after each LLM call; the orchestrator normalizes provider-specific usage into a shared shape, accumulates lifetime totals per task and feature, and enforces limits from real USD spend. Production provider calls should stay behind pi-sdk's model/stream interface, and gvc0 should consume pi-sdk's cost/usage reporting rather than inventing a second accounting path.

Normalized usage fields:
- `provider`, `model`
- `inputTokens`, `outputTokens`
- `cacheReadTokens`, `cacheWriteTokens`
- `reasoningTokens` when the provider exposes them separately
- `audioInputTokens`, `audioOutputTokens` when applicable
- `totalTokens`, `usd`
- `rawUsage` for provider-specific passthrough / future fields

Provider notes:
- Claude exposes input/output/cache usage but does not currently expose separate thinking tokens.
- OpenAI may expose separate `reasoningTokens` and modality-specific fields.
- Gemini prompt/candidate/cache usage should be normalized into the same shared fields.

```jsonc
// .gvc0/config.json
{
  "budget": {
    "globalUsd": 50.00,      // halt all workers when exceeded
    "perTaskUsd": 2.00,      // abort individual task when exceeded
    "warnAtPercent": 80      // emit warning event at 80% of global budget
  }
}
```

```typescript
// Orchestrator checks after each cost IPC message
function checkBudget(state: BudgetState, config: BudgetConfig): BudgetAction {
  if (state.totalUsd >= config.globalUsd) return "halt";
  if (state.totalUsd >= config.globalUsd * config.warnAtPercent / 100) return "warn";
  return "ok";
}
```

When global budget is hit: pause all workers, emit `budget_exceeded` event, show in TUI. User can raise the ceiling and resume. Budget pressure warnings are part of the broader warning system described in [Warnings](../operations/warnings.md).

## Dynamic Model Routing

Each task type is assigned a complexity tier. The router selects the best-fit model within that tier, never exceeding the user's configured ceiling model.

| Tier | Task Types | Default Model |
|---|---|---|
| **heavy** | planning, replanning, roadmap reassessment | Opus-class |
| **standard** | task execution, research, feature CI | Sonnet-class |
| **light** | spec verification, completion summaries, codebase map generation | Haiku-class |

```typescript
type RoutingTier = "heavy" | "standard" | "light";

function routeModel(tier: RoutingTier, config: ModelRoutingConfig): Model {
  // Never exceed user's ceiling model
  // Escalate tier on repeated task failure (escalate_on_failure)
  // Downgrade toward light when approaching budget ceiling (budget_pressure)
}
```

Config in `.gvc0/config.json`:
```jsonc
{
  "modelRouting": {
    "enabled": true,
    "ceiling": "claude-opus-4-6",
    "tiers": {
      "heavy":    "claude-opus-4-6",
      "standard": "claude-sonnet-4-6",
      "light":    "claude-haiku-4-5"
    },
    "escalateOnFailure": true,
    "budgetPressure": true
  }
}
```

## Token Profiles

A single config knob that coordinates model selection, context compression, and phase skipping. Adapted from GSD-2.

| Profile | Models | Context | Phases | Savings |
|---|---|---|---|---|
| **budget** | Sonnet/Haiku | minimal | skip `discussing` + `researching`; after merge, skip `summarizing` and leave summary text empty | 40-60% |
| **balanced** (default) | user default | standard | skip `discussing` + `researching` | ~20% |
| **quality** | user default | full | all phases run | 0% |

```jsonc
{ "tokenProfile": "balanced" }
```

Context inline levels per profile:
- **minimal** — task description + essential prior summaries only
- **standard** — task plan + prior summaries + slice plan + roadmap excerpt
- **full** — everything: plans, summaries, decisions register, KNOWLEDGE.md, codebase map

Token profiles set default context posture, but explicit worker-context assembly lives under the `context` section in `.gvc0/config.json` (see [Worker Model](../worker-model.md)). In other words: token profile picks the default compression level, while `context.defaults` and `context.stages[...]` control the actual inclusion/strategy knobs.
