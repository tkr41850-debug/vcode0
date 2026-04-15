import type { PromptTemplate } from './index.js';
import {
  getString,
  getStringArray,
  joinSections,
  type PromptRenderInput,
  renderBlockSection,
  renderFeatureSection,
  renderLabeledBlock,
  renderListSection,
  renderRunSection,
} from './shared.js';

const SUMMARIZE_PROMPT = `You are gvc0's feature summarization agent.

Your job is to compress merged feature outcome into durable downstream context.
Your audience is future planners, researchers, verifiers, and operators working in fresh context.
Write what shipped, not what was merely attempted.

Summarization stance:
- describe integrated capability, not implementation theater
- ground claims in merged code and verification evidence
- capture important patterns, seams, and constraints future work should reuse
- include follow-up notes only when they materially change downstream decisions
- keep summary dense and durable

Check:
- inspect persisted feature state, task results, changed files, and prior phase events with available tools before drafting summary
- what user-visible or system-visible capability now exists
- which files or subsystems became important integration seams
- what verification created strongest confidence
- what limitations, debts, or follow-up work still matter
- what future work should know before building on this feature

Output should use \`submitSummarize(...)\` exactly once and include:
- concise outcome summary
- capability delivered
- important files or subsystems touched
- verification confidence
- constraints or follow-up notes worth carrying forward

Do not:
- restate whole execution log
- include low-signal trivia
- claim unmerged or unverified work as delivered
- turn summary into roadmap planning
- end with free-text summary instead of \`submitSummarize(...)\``;

export const summarizePromptTemplate: PromptTemplate = {
  name: 'summarize',
  render(input: PromptRenderInput): string {
    return joinSections(
      SUMMARIZE_PROMPT,
      renderFeatureSection(input),
      renderRunSection(input),
      renderBlockSection('Summary Inputs', [
        renderLabeledBlock(
          'Discussion Context',
          getString(input, 'discussionSummary'),
        ),
        renderLabeledBlock(
          'Research Context',
          getString(input, 'researchSummary'),
        ),
        renderLabeledBlock(
          'Integrated Outcome',
          getString(input, 'integratedOutcome'),
        ),
        renderLabeledBlock(
          'Verification Confidence',
          getString(input, 'verificationSummary'),
        ),
        renderLabeledBlock(
          'Execution Highlights',
          getString(input, 'executionSummary'),
        ),
        renderLabeledBlock(
          'Important Decisions',
          getString(input, 'decisions'),
        ),
        renderLabeledBlock(
          'Follow-up Notes',
          getString(input, 'followUpNotes'),
        ),
      ]),
      renderListSection(
        'Important Files',
        getStringArray(input, 'importantFiles'),
      ),
    );
  },
};
