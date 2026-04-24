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

/**
 * Input Contract — `plan` / `replan` prompt templates.
 *
 * `renderPrompt` in src/agents/runtime.ts (lines 271-324) threads the
 * following fields into `template.render({...})`. The planner prompt
 * consumes a subset via `getString(input, '<key>')` below; the rest are
 * wired for other templates and are NOT read by the planner.
 *
 * Consumed by `renderPlanningPrompt`:
 *
 * | Field                      | Source (runtime.ts)                                   | First plan? | Replan? | Rendered as                        |
 * | -------------------------- | ----------------------------------------------------- | ----------- | ------- | ---------------------------------- |
 * | `feature`                  | live `Feature` record                                 | yes         | yes     | Feature section (shared renderer)  |
 * | `run`                      | live `FeaturePhaseRunContext`                         | yes         | yes     | Run section (shared renderer)      |
 * | `discussionSummary`        | latest `feature_phase_completed{phase:discuss}` event | yes*        | yes     | "Discussion Summary" block         |
 * | `researchSummary`          | latest `feature_phase_completed{phase:research}`      | yes*        | yes     | "Research Summary" block           |
 * | `proposalSummary`          | latest `feature_phase_completed{phase:plan/replan}`   | no          | yes     | "Current Proposal State" block     |
 * | `blockerSummary`           | events of type `proposal_apply_failed`                | no          | usually | "Blockers or Discoveries" block    |
 * | `verificationExpectations` | `config.verification.feature.checks[].description`    | yes         | yes     | "Verification Expectations" block  |
 * | `constraints`              | latest discuss `extra.constraints` + conflict flag    | yes*        | yes     | "Constraints" block                |
 * | `externalIntegrations`     | latest discuss `extra.externalIntegrations`           | yes*        | yes     | "External Integrations" block      |
 * | `antiGoals`                | latest discuss `extra.antiGoals`                      | yes*        | yes     | "Anti-Goals" block                 |
 * | `decisions`                | events of type `proposal_applied`                     | no          | yes     | "Decisions" block                  |
 * | `replanReason` / `reason`  | `runProposalPhase(reason)` argument                   | no          | yes     | Inline in "Planning Mode" section  |
 *
 * * "yes*" = populated on first plan only when a prior discuss/research
 *   phase has completed for the feature. If discuss was skipped, the
 *   field is undefined and the labeled block is omitted by
 *   `renderLabeledBlock`.
 *
 * Mode switch: `renderPlanningPrompt('plan', ...)` vs
 * `renderPlanningPrompt('replan', ...)` differs only in the
 * "Planning Mode" preamble — authority and toolset are identical per
 * CONTEXT § A / doctrine block below.
 *
 * NOT consumed by planner (threaded for other templates):
 *   requestedOutcome, featureContext, successCriteria, executionEvidence,
 *   verificationResults, integratedOutcome, verificationSummary,
 *   executionSummary, followUpNotes, importantFiles, codebaseMap.
 *
 * Maintenance note: when `renderPrompt` adds a new input relevant to the
 * planner, add the corresponding `renderLabeledBlock(...)` call below
 * AND update this table. When the planner stops reading a field,
 * remove both.
 */
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

Output should use \`submit(...)\` exactly once after building draft proposal with available tools and include:
- summary
- chosen approach
- key constraints shaping plan
- decomposition rationale
- ordering rationale
- verification expectations
- risks, trade-offs, and assumptions that still matter downstream
- concise rationale after tool use so downstream summary text stays readable

Do not:
- present many equivalent options without recommendation
- over-decompose simple work
- claim proof level higher than evidence supports
- treat replanning as ad hoc patching with no coherent model
- skip proposal tools and jump straight to free-text plan
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
