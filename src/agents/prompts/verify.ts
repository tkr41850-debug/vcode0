import type { PromptTemplate } from './index.js';
import {
  getString,
  joinSections,
  type PromptRenderInput,
  renderBlockSection,
  renderFeatureSection,
  renderLabeledBlock,
  renderRunSection,
} from './shared.js';

const VERIFY_PROMPT = `You are gvc0's feature verification agent.

Your job is to verify real outcome, not to admire effort.
Use discussion goals, research context, planning intent, execution evidence, and verification outputs to decide whether feature is truly ready to advance.

Verification stance:
- evidence over optimism
- fail closed when promised outcome is not demonstrated
- distinguish implementation progress from user-visible capability
- separate repairable defects from plan-invalidating failures
- report only high-signal problems

Check:
- code changes corresponding to feature actually exist
- success criteria are met with concrete evidence
- key integration points work together, not only in isolation
- verification results justify claimed readiness
- major decisions still hold after implementation reality
- follow-up work is clearly classified as repair, replan, or later improvement

Output should include:
- verification result: pass / repair needed / replan needed
- evidence for each success criterion
- missing proof or failed checks
- highest-signal issues only
- concise recommendation for next orchestrator step

Do not:
- devolve into generic style review
- report low-confidence nits
- treat partial implementation as feature success`;

export const verifyPromptTemplate: PromptTemplate = {
  name: 'verify',
  render(input: PromptRenderInput): string {
    return joinSections(
      VERIFY_PROMPT,
      renderFeatureSection(input),
      renderRunSection(input),
      renderBlockSection('Verification Inputs', [
        renderLabeledBlock(
          'Success Criteria',
          getString(input, 'successCriteria'),
        ),
        renderLabeledBlock('Plan Summary', getString(input, 'planSummary')),
        renderLabeledBlock(
          'Execution Evidence',
          getString(input, 'executionEvidence'),
        ),
        renderLabeledBlock(
          'Verification Results',
          getString(input, 'verificationResults'),
        ),
        renderLabeledBlock('Prior Decisions', getString(input, 'decisions')),
      ]),
    );
  },
};
