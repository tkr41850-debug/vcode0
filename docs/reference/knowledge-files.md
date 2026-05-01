# Knowledge Files

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for high-level architecture overview.

This page covers `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md` — the append-only files worker tools write to, and how those files reach later prompts.

Task workers do **not** receive knowledge/decisions sections from runtime. The task worker system prompt is rendered from the planner-baked `TaskPayload` only (objective, scope, expectedFiles, references, outcomeVerification, featureObjective, featureDoD, planSummary, dependencyOutputs). Knowledge and decisions reach a task only when the planner cites a specific file under that task's `references`.

Feature-phase prompts (discuss / research / plan / verify / summarize / replan) are assembled from feature/event summaries plus a minimal `codebaseMap` string and do **not** auto-load `.gvc0/KNOWLEDGE.md` or `.gvc0/DECISIONS.md`. Operators or planner-baked references are the only path either file takes into a downstream prompt.

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

As with knowledge, this is real filesystem state. Task worker prompts do not auto-inject `DECISIONS.md`; the planner lists relevant decisions under a task's `references`. Feature-phase prompts also do not auto-load `DECISIONS.md` — its contribution to a phase prompt only happens through planner-baked references or operator-supplied context.

## Current Mental Model

- `.gvc0/KNOWLEDGE.md` — real append-only convention file; worker tool `append_knowledge` writes, planner cites via task `references`.
- `.gvc0/DECISIONS.md` — real append-only convention file; worker tool `record_decision` writes, planner cites via task `references`.

See [Worker Model](../architecture/worker-model.md) for the `TaskPayload` shape and [Codebase Map](./codebase-map.md) for source-area README pointers.
