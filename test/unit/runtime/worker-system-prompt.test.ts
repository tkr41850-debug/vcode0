import type { TaskPayload } from '@runtime/context';
import { buildSystemPrompt } from '@runtime/worker/system-prompt';
import { describe, expect, it } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';

describe('buildSystemPrompt', () => {
  it('renders execute doctrine with planner-baked payload sections', () => {
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

    const payload: TaskPayload = {
      objective: 'Wire live prompt docs to source files.',
      scope: 'prompts module only',
      expectedFiles: ['src/agents/prompts/index.ts'],
      references: ['docs/agent-prompts/README.md'],
      outcomeVerification: 'prompt docs render from source',
      featureObjective: 'Live prompt registry.',
      featureDoD: ['all phase prompts load from source'],
      planSummary: 'Implement prompt registry and runtime execute doctrine.',
      dependencyOutputs: [
        {
          taskId: 't-setup',
          featureName: 'Prompt groundwork',
          summary: 'Added docs and source references.',
          filesChanged: ['docs/agent-prompts/README.md'],
        },
      ],
    };

    const prompt = buildSystemPrompt(task, payload);

    expect(prompt).toContain('You are gvc0 task execution agent.');
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('- ID: t-prompt');
    expect(prompt).toContain(
      '- Reserved write paths: src/agents/prompts/index.ts',
    );
    expect(prompt).toContain('## Task Objective');
    expect(prompt).toContain('## Scope');
    expect(prompt).toContain('## Expected Files');
    expect(prompt).toContain('- src/agents/prompts/index.ts');
    expect(prompt).toContain('## References');
    expect(prompt).toContain('## Outcome Verification');
    expect(prompt).toContain('## Feature Objective');
    expect(prompt).toContain('## Feature Definition of Done');
    expect(prompt).toContain('## Plan');
    expect(prompt).toContain('## Dependency Outputs');
    expect(prompt).toContain(
      '- t-setup (Prompt groundwork): Added docs and source references.',
    );
    expect(prompt).toContain('Files: docs/agent-prompts/README.md');
  });

  it('omits empty optional sections', () => {
    const task = createTaskFixture({
      id: 't-minimal',
      description: 'Minimal task',
      status: 'ready',
      collabControl: 'none',
    });

    const prompt = buildSystemPrompt(task, {});

    expect(prompt).toContain('You are gvc0 task execution agent.');
    expect(prompt).toContain('## Task');
    expect(prompt).not.toContain('## Task Objective');
    expect(prompt).not.toContain('## Plan');
    expect(prompt).not.toContain('## Dependency Outputs');
    expect(prompt).not.toContain('## Feature Objective');
    expect(prompt).not.toContain('undefined');
  });
});
