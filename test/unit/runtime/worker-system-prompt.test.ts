import type { WorkerContext } from '@runtime/context';
import { buildSystemPrompt } from '@runtime/worker/system-prompt';
import { describe, expect, it } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';

describe('buildSystemPrompt', () => {
  it('renders execute doctrine with dynamic runtime context sections', () => {
    const task = createTaskFixture({
      id: 't-prompt',
      featureId: 'f-live-prompts',
      description: 'Make prompt docs live',
      status: 'running',
      collabControl: 'branch_open',
      weight: 'medium',
      taskTestPolicy: 'strict',
      reservedWritePaths: ['src/agents/prompts/index.ts'],
    });

    const context: WorkerContext = {
      strategy: 'fresh',
      planSummary: 'Implement prompt registry and runtime execute doctrine.',
      dependencyOutputs: [
        {
          taskId: 't-setup',
          featureName: 'Prompt groundwork',
          summary: 'Added docs and source references.',
          filesChanged: ['docs/agent-prompts/README.md'],
        },
      ],
      codebaseMap: 'src/agents/prompts owns feature-phase prompts.',
      knowledge: 'Prompt docs now map to live source.',
      decisions: 'Execute prompt remains runtime-owned.',
    };

    const prompt = buildSystemPrompt(task, context);

    expect(prompt).toContain('You are gvc0 task execution agent.');
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('- ID: t-prompt');
    expect(prompt).toContain(
      '- Reserved write paths: src/agents/prompts/index.ts',
    );
    expect(prompt).toContain('## Plan');
    expect(prompt).toContain('## Dependency Outputs');
    expect(prompt).toContain(
      '- t-setup (Prompt groundwork): Added docs and source references.',
    );
    expect(prompt).toContain('Files: docs/agent-prompts/README.md');
    expect(prompt).toContain('## Codebase');
    expect(prompt).toContain('## Knowledge');
    expect(prompt).toContain('## Decisions');
  });

  it('omits empty optional sections', () => {
    const task = createTaskFixture({
      id: 't-minimal',
      description: 'Minimal task',
      status: 'ready',
      collabControl: 'none',
    });

    const prompt = buildSystemPrompt(task, {
      strategy: 'shared-summary',
    });

    expect(prompt).toContain('You are gvc0 task execution agent.');
    expect(prompt).toContain('## Task');
    expect(prompt).not.toContain('## Plan');
    expect(prompt).not.toContain('## Dependency Outputs');
    expect(prompt).not.toContain('## Codebase');
    expect(prompt).not.toContain('undefined');
  });
});
