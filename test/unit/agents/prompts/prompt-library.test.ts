import {
  createPromptLibrary,
  type PromptTemplateName,
  promptLibrary,
  promptTemplates,
} from '@agents/prompts';
import { describe, expect, it } from 'vitest';

import { createFeatureFixture } from '../../../helpers/graph-builders.js';

function buildInput() {
  return {
    feature: createFeatureFixture({
      id: 'f-live-prompts',
      name: 'Live prompts',
      description: 'Convert docs into canonical prompt source',
      status: 'in_progress',
      workControl: 'planning',
      collabControl: 'branch_open',
      featureBranch: 'feat-live-prompts-f-live-prompts',
      dependsOn: ['f-foundation'],
    }),
    run: {
      agentRunId: 'run-123',
      sessionId: 'sess-456',
    },
    requestedOutcome: 'Turn prompt docs into live source',
    discussionSummary: 'Need live prompts, not doc-only references.',
    researchSummary:
      'Prompt seam exists under src/agents/prompts and runtime worker prompt.',
    proposalSummary: 'Shared planning doctrine; execute stays runtime-owned.',
    blockerSummary: 'Planner host still incomplete, so keep scope prompt-only.',
    verificationExpectations:
      'Run prompt unit tests, runtime prompt tests, and typecheck.',
    constraints: 'Do not build full planner host in same change.',
    decisions: 'Keep execute-task prompt under @runtime.',
    successCriteria: 'Canonical prompt source exists for every phase.',
    executionEvidence: 'Prompt modules added and docs updated.',
    verificationResults: 'Targeted prompt tests pass.',
    integratedOutcome:
      'Feature-phase prompt library now renders live source text.',
    verificationSummary:
      'Prompt rendering and runtime prompt assembly verified.',
    executionSummary:
      'Added prompt modules, runtime doctrine, and prompt tests.',
    followUpNotes: 'Upstream references stay docs-only.',
    importantFiles: [
      'src/agents/prompts/index.ts',
      'src/runtime/worker/system-prompt.ts',
    ],
    codebaseMap:
      'src/agents/prompts for feature phases; src/runtime/worker for execute.',
    externalIntegrations: 'None.',
    antiGoals: 'Do not redesign task execution.',
    replanReason: 'Dependency seam changed after execution evidence.',
  } satisfies Record<string, unknown>;
}

describe('promptLibrary', () => {
  it('returns prompt template for every prompt name', () => {
    const input = buildInput();
    const names: PromptTemplateName[] = [
      'discuss',
      'research',
      'plan',
      'verify',
      'summarize',
      'replan',
    ];

    for (const name of names) {
      const template = promptLibrary.get(name);
      expect(template.name).toBe(name);
      expect(template.render(input)).toContain('## Feature');
    }
  });

  it('supports prompt template overrides', () => {
    const custom = createPromptLibrary({
      plan: {
        name: 'plan',
        render: () => 'custom plan prompt',
      },
    });

    expect(custom.get('plan').render({})).toBe('custom plan prompt');
    expect(custom.get('verify')).toBe(promptTemplates.verify);
  });

  it('renders shared planning doctrine with plan and replan specific framing', () => {
    const input = buildInput();

    const planPrompt = promptTemplates.plan.render(input);
    const replanPrompt = promptTemplates.replan.render(input);

    expect(planPrompt).toContain("You are gvc0's feature planning agent.");
    expect(replanPrompt).toContain("You are gvc0's feature planning agent.");
    expect(planPrompt).toContain('## Planning Mode');
    expect(planPrompt).toContain('Initial planning mode.');
    expect(planPrompt).toContain('inspect current persisted feature state');
    expect(planPrompt).toContain('proposal tools');
    expect(planPrompt).toContain('`addMilestone(...)`');
    expect(planPrompt).toContain('`submit(...)` exactly once');
    expect(planPrompt).toContain('concise rationale after tool use');
    expect(planPrompt).toContain('chosen approach');
    expect(planPrompt).toContain('verification expectations');
    expect(planPrompt).toContain('### External Integrations');
    expect(planPrompt).toContain('### Anti-Goals');
    expect(planPrompt).not.toContain(
      'Reason: Dependency seam changed after execution evidence.',
    );
    expect(replanPrompt).toContain('Replanning mode.');
    expect(replanPrompt).toContain('proposal tools');
    expect(replanPrompt).toContain('`addMilestone(...)`');
    expect(replanPrompt).toContain('`submit(...)` exactly once');
    expect(replanPrompt).toContain('concise rationale after tool use');
    expect(replanPrompt).toContain(
      'Reason: Dependency seam changed after execution evidence.',
    );
    expect(replanPrompt).toContain('### Blockers or Discoveries');
  });

  it('renders discuss, research, and summarize prompts with structured submit instructions', () => {
    const discussPrompt = promptTemplates.discuss.render(buildInput());
    const researchPrompt = promptTemplates.research.render(buildInput());
    const summarizePrompt = promptTemplates.summarize.render(buildInput());

    expect(discussPrompt).toContain('`submitDiscuss(...)` exactly once');
    expect(researchPrompt).toContain('`submitResearch(...)` exactly once');
    expect(researchPrompt).toContain('repo state with available tools');
    expect(researchPrompt).toContain(
      'read real code with repo inspection tools',
    );
    expect(researchPrompt).toContain('### External Integrations');
    expect(researchPrompt).toContain('### Anti-Goals');
    expect(summarizePrompt).toContain('`submitSummarize(...)` exactly once');
    expect(summarizePrompt).toContain(
      "You are gvc0's feature summarization agent.",
    );
    expect(summarizePrompt).toContain('## Summary Inputs');
    expect(summarizePrompt).toContain('### Integrated Outcome');
    expect(summarizePrompt).toContain('## Important Files');
    expect(summarizePrompt).toContain('src/runtime/worker/system-prompt.ts');
    expect(summarizePrompt).toContain('inspect persisted feature state');
  });

  it('renders verify prompt with structured repair-only verdict instructions', () => {
    const prompt = promptTemplates.verify.render(buildInput());

    expect(prompt).toContain("You are gvc0's feature verification agent.");
    expect(prompt).toContain('`submitVerify(...)` exactly once');
    expect(prompt).toContain('pass or repair needed');
    expect(prompt).not.toContain('replan needed');
  });
});
