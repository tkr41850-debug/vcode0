import type { PromptTemplate } from './index.js';
import {
  getString,
  joinSections,
  type PromptRenderInput,
  renderBlockSection,
  renderFeatureSection,
  renderLabeledBlock,
  renderRunSection,
  renderSection,
} from './shared.js';

const PLANNING_DOCTRINE = `You are gvc0's feature planning agent.

You convert discussed intent and researched code reality into concrete proposed work.
Use same planning doctrine for both initial planning and replanning.
Difference is context, not authority.

Planning stance:
- choose one coherent approach
- ground decisions in current codebase and established patterns
- sequence by proof value and risk reduction
- make completion imply real capability, not placeholder progress
- prefer truthful, testable decomposition over elegant fiction

When planning:
- inspect current persisted feature state, events, tasks, and prior runs with available tools before mutating draft graph
- identify what must be proven first
- preserve useful existing patterns and stable boundaries
- create work units that establish clear downstream surfaces
- state why order matters
- keep dependencies explicit and minimal
- avoid speculative abstraction and foundation-only work unless infrastructure itself is product surface
- make verification expectations concrete early, not as afterthought

When replanning:
- treat existing work, failures, and discoveries as signal
- preserve started work when still useful
- if removing or substantially rewriting started work, explain why
- prefer smallest change that restores coherent path to success
- keep capability set same as planning; this is not weaker or separate mode

Output should use \`submit(...)\` exactly once after building draft proposal with available tools and include:
- summary
- chosen approach
- key constraints shaping plan
- decomposition rationale
- ordering rationale
- verification expectations
- risks, trade-offs, and assumptions that still matter downstream

Do not:
- present many equivalent options without recommendation
- over-decompose simple work
- claim proof level higher than evidence supports
- treat replanning as ad hoc patching with no coherent model
- end with free-text plan instead of \`submit(...)\``;

function renderPlanningPrompt(
  name: 'plan' | 'replan',
  input: PromptRenderInput,
): string {
  const replanReason =
    getString(input, 'replanReason') ?? getString(input, 'reason');

  const planningMode =
    name === 'plan'
      ? 'Initial planning mode. Choose first coherent approach from current code and feature context.'
      : [
          'Replanning mode. Existing work, failures, and discoveries are signal.',
          replanReason !== undefined ? `Reason: ${replanReason}` : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n');

  return joinSections(
    PLANNING_DOCTRINE,
    renderSection('Planning Mode', planningMode),
    renderFeatureSection(input),
    renderRunSection(input),
    renderBlockSection('Planning Inputs', [
      renderLabeledBlock(
        'Discussion Summary',
        getString(input, 'discussionSummary'),
      ),
      renderLabeledBlock(
        'Research Summary',
        getString(input, 'researchSummary'),
      ),
      renderLabeledBlock(
        'Current Proposal State',
        getString(input, 'proposalSummary'),
      ),
      renderLabeledBlock(
        'Blockers or Discoveries',
        getString(input, 'blockerSummary'),
      ),
      renderLabeledBlock(
        'Verification Expectations',
        getString(input, 'verificationExpectations'),
      ),
      renderLabeledBlock('Constraints', getString(input, 'constraints')),
      renderLabeledBlock(
        'External Integrations',
        getString(input, 'externalIntegrations'),
      ),
      renderLabeledBlock('Anti-Goals', getString(input, 'antiGoals')),
      renderLabeledBlock('Decisions', getString(input, 'decisions')),
    ]),
  );
}

export const planPromptTemplate: PromptTemplate = {
  name: 'plan',
  render(input: PromptRenderInput): string {
    return renderPlanningPrompt('plan', input);
  },
};

export const replanPromptTemplate: PromptTemplate = {
  name: 'replan',
  render(input: PromptRenderInput): string {
    return renderPlanningPrompt('replan', input);
  },
};
