# Knowledge Files

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for high-level architecture overview.

This page covers `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md` — the append-only files worker tools write to, and how planner / feature-phase agents embed them into their own prompts.

Task workers do **not** receive knowledge/decisions sections from runtime anymore. The task worker system prompt is rendered from the planner-baked `TaskPayload` only (objective, scope, expectedFiles, references, outcomeVerification, featureObjective, featureDoD, planSummary, dependencyOutputs). Knowledge and decisions, when they matter, enter the task prompt through `references` — the planner picks which files are relevant for each task.

Feature-phase agents (discuss / research / plan / verify / summarize) may still load knowledge and decisions directly as part of phase-specific context composition.

## `.gvc0/KNOWLEDGE.md`

Worker tool `append_knowledge` appends Markdown entries to `.gvc0/KNOWLEDGE.md`:

```typescript
const KNOWLEDGE_REL = path.join('.gvc0', 'KNOWLEDGE.md');

export function createAppendKnowledgeTool(projectRoot: string): AgentTool {
  return {
    name: 'append_knowledge',
    description:
      'Append a lesson or pattern to the project-wide knowledge file (.gvc0/KNOWLEDGE.md).',
  };
}
```

This file path is real and append-only. Task worker prompts do not auto-inject it; when knowledge entries are relevant to a specific task, the planner lists them under that task's `references`.

## `.gvc0/DECISIONS.md`

Worker tool `record_decision` appends architectural decisions and rationale to `.gvc0/DECISIONS.md`:

```typescript
const DECISIONS_REL = path.join('.gvc0', 'DECISIONS.md');

export function createRecordDecisionTool(projectRoot: string): AgentTool {
  return {
    name: 'record_decision',
    description:
      'Append an architectural decision and its rationale to the project decisions log (.gvc0/DECISIONS.md).',
  };
}
```

As with knowledge, this is real filesystem state. Task worker prompts do not auto-inject `DECISIONS.md`; the planner lists relevant decisions under a task's `references`. Feature-phase agents may load decisions directly as part of phase-specific context composition.

## Current Mental Model

- `.gvc0/KNOWLEDGE.md` — real append-only convention file; worker tool `append_knowledge` writes, planner cites via task `references`.
- `.gvc0/DECISIONS.md` — real append-only convention file; worker tool `record_decision` writes, planner cites via task `references`.

See [Worker Model](../worker-model.md) for the `TaskPayload` shape and [Codebase Map](./codebase-map.md) for source-area README pointers.
