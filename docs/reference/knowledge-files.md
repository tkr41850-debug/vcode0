# Knowledge Files

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for high-level architecture overview.

This page covers two related surfaces:

1. optional `WorkerContext` inputs (`codebaseMap`, `knowledge`, `decisions`)
2. concrete `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md` files managed by worker tools

## WorkerContext Inputs

`WorkerContext` supports optional context sections:

```typescript
interface WorkerContext {
  strategy: 'shared-summary' | 'fresh' | 'inherit';
  planSummary?: string;
  dependencyOutputs?: DependencyOutputSummary[];
  codebaseMap?: string;
  knowledge?: string;
  decisions?: string;
}
```

`WorkerContextBuilder` only includes these fields when both conditions hold:

- stage/default config enables `includeCodebaseMap`, `includeKnowledge`, or `includeDecisions`
- caller actually supplies corresponding input text

Current implementation truth:

- task worker system prompt renders `Codebase`, `Knowledge`, and `Decisions` sections only when those fields are present
- feature-phase runtime already synthesizes a small `codebaseMap` string from feature branch / phase / summary
- feature-phase runtime can also synthesize `decisions` text from proposal-application events
- current repo does **not** implement generated `.gvc0/CODEBASE.md` artifact or TUI command to regenerate it

So `codebaseMap` is currently prompt text field, not filesystem contract.

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

This file path is real and append-only. However, current orchestration code does not automatically read `.gvc0/KNOWLEDGE.md` into every task session by itself; it only appears in prompts when some caller supplies `WorkerContext.knowledge`.

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

As with knowledge, this is real filesystem state, but prompt injection of decisions still depends on whoever builds `WorkerContext`.

## Current Mental Model

- `.gvc0/KNOWLEDGE.md` — real append-only convention file
- `.gvc0/DECISIONS.md` — real append-only convention file
- `codebaseMap` — prompt field, currently synthesized where needed rather than loaded from `.gvc0/CODEBASE.md`

See [Worker Model](../worker-model.md) for context strategy and [Codebase Map](./codebase-map.md) for source-area README pointers.
