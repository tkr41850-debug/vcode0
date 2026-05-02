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
- build proposal with proposal tools, not free-text plan prose alone
- use proposal tools such as \`addMilestone(...)\`, \`addFeature(...)\`, \`addTask(...)\`, and dependency edits to shape draft graph
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
- express feature restructuring by composing proposal tools (\`addFeature\`, \`removeFeature\`, \`editFeature\`, \`addDependency\`, \`removeDependency\`); there is no split/merge primitive

Output should call \`submit(...)\` after building draft proposal with available tools and include:
- summary
- chosen approach
- key constraints shaping plan
- decomposition rationale
- ordering rationale
- verification expectations
- risks, trade-offs, and assumptions that still matter downstream
- concise rationale after tool use so downstream summary text stays readable

\`submit(...)\` is checkpoint-style: call it once when initial proposal is ready; if you receive follow-up input (chat, request_help response, replan reason) and need to revise, mutate the proposal further and call \`submit(...)\` again with updated details. Each submit replaces the prior pending proposal payload.

Topology escalation (rare):
- topology issues should be caught in discuss; if one surfaces here, proceed only if it can be resolved within this feature's scope
- if it cannot (feature should split, duplicates another feature, missing prerequisite blocks planning), call \`request_help\` with a query prefixed \`[topology]\` describing the proposed restructure
- the project planner reviews \`[topology]\` escalations and decides whether to restructure the project graph; resume planning with the operator's response
- do not use \`[topology]\` for routine clarifications; reserve it for cross-feature restructuring this plan cannot resolve alone

Do not:
- present many equivalent options without recommendation
- over-decompose simple work
- claim proof level higher than evidence supports
- treat replanning as ad hoc patching with no coherent model
- skip proposal tools and jump straight to free-text plan
- end with free-text plan instead of \`submit(...)\``;

const REPLAN_INPUT_GUIDANCE = `Replan input — \`VerifyIssue[]\`:
- each issue carries a \`source\` discriminator; branch decisions by source
- \`source: 'verify'\` — agent-raised semantic issues; address with smallest coherent change tied to feature spec
- \`source: 'ci_check'\` — shell check failed (\`phase: 'feature'\` pre-verify, \`phase: 'post_rebase'\` during integration); propose fix tasks keyed off \`checkName\` + \`command\`; treat truncated \`output\` (4KB cap) as evidence, not prescription
- \`source: 'rebase'\` — integration-time rebase conflict; propose reconciliation on \`conflictedFiles\`; prefer merging upstream changes over discarding them
- total \`VerifyIssue[]\` payload capped at 32KB with severity-ranked retention (blocking > concern > nit, most-recent first within severity); missing lower-severity items are expected, not bugs`;

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

  const replanInputBlock =
    name === 'replan'
      ? renderSection('Replan Input', REPLAN_INPUT_GUIDANCE)
      : undefined;

  return joinSections(
    PLANNING_DOCTRINE,
    renderSection('Planning Mode', planningMode),
    replanInputBlock,
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
