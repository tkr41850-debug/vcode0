# Budget and Model Routing

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for high-level architecture overview.

## Budget

Configurable per-task and global USD ceilings. Workers report normalized runtime usage on terminal result/error messages, and orchestrator can accumulate lifetime totals per task and feature from real provider spend.

Normalized usage fields:

- `provider`, `model`
- `inputTokens`, `outputTokens`
- `cacheReadTokens`, `cacheWriteTokens`
- `reasoningTokens` when provider exposes them separately
- `audioInputTokens`, `audioOutputTokens` when applicable
- `totalTokens`, `usd`
- `rawUsage` for provider-specific passthrough / future fields

Provider notes:

- Claude exposes input/output/cache usage but not separate thinking-token counts today
- OpenAI may expose separate `reasoningTokens` and modality-specific fields
- Gemini prompt/candidate/cache usage should be normalized into same shared fields

```jsonc
{
  "budget": {
    "globalUsd": 50.0,
    "perTaskUsd": 2.0,
    "warnAtPercent": 80
  }
}
```

```typescript
function checkBudget(state: BudgetState, config: BudgetConfig): BudgetAction {
  if (state.totalUsd >= config.globalUsd) return 'halt';
  if (state.totalUsd >= (config.globalUsd * config.warnAtPercent) / 100) {
    return 'warn';
  }
  return 'ok';
}
```

Budget state is refreshed by `BudgetService.refresh()` (`src/orchestrator/services/budget-service.ts:17`), which accumulates per-task and per-feature usage from `agent_runs` records and updates the feature graph via `replaceUsageRollups()` (`src/core/graph/usage-mutations.ts:7`). The rollup flow recomputes totals from provider-reported usage, enabling real-time budget checks against ceiling limits.

When global budget is hit: pause workers, emit warning/event, and wait for operator to raise ceiling or resume.

## Dynamic Model Routing

Routing uses three tiers:

| Tier | Current users | Default intent |
|---|---|---|
| **heavy** | feature `plan`, `replan` phases | highest-reasoning planning work |
| **standard** | task execution, feature `discuss`, `research` phases | normal implementation/recon work |
| **light** | feature `verify`, `summarize` phases | cheap verification/summarization work |

Current routing behavior:

- if routing disabled, use ceiling model directly
- if `budgetPressure` is enabled and budget is warned, downgrade to `light`
- if `escalateOnFailure` is enabled and failures are present, bump `light → standard` and everything else → `heavy`

```typescript
class ModelRouter {
  routeModel(tier: RoutingTier, config: ModelRoutingConfig, options = {}) {
    if (!config.enabled) {
      return { model: config.ceiling, tier };
    }

    const effectiveTier = this.resolveTier(tier, config, options);
    return {
      model: config.tiers[effectiveTier] ?? config.ceiling,
      tier: effectiveTier,
    };
  }
}
```

Routing is implemented by `ModelRouter` and `routingConfigOrDefault()` (`src/runtime/routing/index.ts:40` and `src/runtime/routing/index.ts:22`). The router resolves the effective tier based on budget pressure and escalation signals, then maps it to a concrete model string from the config tier table or ceiling model.

Config in `.gvc0/config.json`:

```jsonc
{
  "modelRouting": {
    "enabled": true,
    "ceiling": "claude-opus-4-6",
    "tiers": {
      "heavy": "claude-opus-4-6",
      "standard": "claude-sonnet-4-6",
      "light": "claude-haiku-4-5"
    },
    "escalateOnFailure": true,
    "budgetPressure": true
  }
}
```

## Token Profiles

Config accepts three token profiles:

- `budget`
- `balanced` (default)
- `quality`

Current implementation is narrower than older design notes.

| Profile | Current concrete behavior |
|---|---|
| **budget** | after merge, skip `summarizing` and move directly to `work_complete` |
| **balanced** | default label; no phase skipping today |
| **quality** | no phase skipping today |

Current feature lifecycle still runs `discussing → researching → planning` regardless of `budget` vs `balanced` vs `quality`.

Context compression is controlled concretely by `context.defaults` / `context.stages[...]` in `.gvc0/config.json`, not by token profile alone. Token profile is currently used mainly for high-level policy, with budget-mode summary skipping as implemented special behavior.
