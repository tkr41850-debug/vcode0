import { createGitDiffTool } from '@agents/worker/tools/git-diff';
import { createGitStatusTool } from '@agents/worker/tools/git-status';
import { createListFilesTool } from '@agents/worker/tools/list-files';
import { createReadFileTool } from '@agents/worker/tools/read-file';
import { createSearchFilesTool } from '@agents/worker/tools/search-files';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { type TSchema, Type } from '@sinclair/typebox';

import type { DefaultFeaturePhaseToolHost } from './feature-phase-host.js';
import {
  createFeaturePlanToolset,
  createProjectPlannerToolset,
  formatToolText,
} from './planner-toolset.js';
import type { GraphProposalToolHost } from './proposal-host.js';
import {
  featurePhaseToolParameters,
  proposalToolParameters,
} from './schemas.js';
import type {
  GetChangedFilesOptions,
  GetFeatureStateOptions,
  GetTaskResultOptions,
  ListFeatureEventsOptions,
  ListFeatureRunsOptions,
  ListFeatureTasksOptions,
  RaiseIssueOptions,
  SubmitDiscussOptions,
  SubmitResearchOptions,
  SubmitSummarizeOptions,
  SubmitVerifyOptions,
} from './types.js';

export type ProposalAgentTool = AgentTool<TSchema, unknown>;
export type FeaturePhaseAgentTool = AgentTool<TSchema, unknown>;

function buildTextContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function buildToolResult<T>(
  text: string,
  details: T,
): Promise<AgentToolResult<T>> {
  return Promise.resolve({
    content: buildTextContent(text),
    details,
  });
}

function buildFeatureInspectionTools(
  host: DefaultFeaturePhaseToolHost,
): FeaturePhaseAgentTool[] {
  return [
    {
      name: 'getFeatureState',
      label: 'Get Feature State',
      description:
        'Inspect persisted state for the current feature or another feature by id.',
      parameters: featurePhaseToolParameters.getFeatureState,
      execute: (_toolCallId: string, args: unknown) => {
        const result = host.getFeatureState(args as GetFeatureStateOptions);
        return buildToolResult(
          `Loaded feature ${result.id} in ${result.workControl} / ${result.collabControl}.`,
          result,
        );
      },
    },
    {
      name: 'listFeatureTasks',
      label: 'List Feature Tasks',
      description:
        'List persisted tasks for the current feature or another feature by id.',
      parameters: featurePhaseToolParameters.listFeatureTasks,
      execute: (_toolCallId: string, args: unknown) => {
        const result = host.listFeatureTasks(args as ListFeatureTasksOptions);
        return buildToolResult(`Listed ${result.length} tasks.`, result);
      },
    },
    {
      name: 'getTaskResult',
      label: 'Get Task Result',
      description:
        'Inspect persisted completion result for a task that already landed.',
      parameters: featurePhaseToolParameters.getTaskResult,
      execute: (_toolCallId: string, args: unknown) => {
        const result = host.getTaskResult(args as GetTaskResultOptions);
        return buildToolResult(
          `Loaded result for task ${result.taskId}.`,
          result,
        );
      },
    },
    {
      name: 'listFeatureEvents',
      label: 'List Feature Events',
      description:
        'Inspect persisted feature events, optionally filtered by phase and limited to recent entries.',
      parameters: featurePhaseToolParameters.listFeatureEvents,
      execute: (_toolCallId: string, args: unknown) => {
        const result = host.listFeatureEvents(args as ListFeatureEventsOptions);
        return buildToolResult(
          `Listed ${result.length} feature events.`,
          result,
        );
      },
    },
    {
      name: 'listFeatureRuns',
      label: 'List Feature Runs',
      description:
        'Inspect stored feature-phase runs for current feature, optionally filtered by phase.',
      parameters: featurePhaseToolParameters.listFeatureRuns,
      execute: (_toolCallId: string, args: unknown) => {
        const result = host.listFeatureRuns(args as ListFeatureRunsOptions);
        return buildToolResult(
          `Listed ${result.length} feature-phase runs.`,
          result,
        );
      },
    },
    {
      name: 'getChangedFiles',
      label: 'Get Changed Files',
      description:
        'Collect deduplicated files changed by landed tasks for current feature.',
      parameters: featurePhaseToolParameters.getChangedFiles,
      execute: (_toolCallId: string, args: unknown) => {
        const result = host.getChangedFiles(args as GetChangedFilesOptions);
        return buildToolResult(
          `Collected ${result.length} changed files.`,
          result,
        );
      },
    },
  ];
}

function buildRepoInspectionTools(workdir: string): FeaturePhaseAgentTool[] {
  return [
    createReadFileTool(workdir),
    createListFilesTool(workdir),
    createSearchFilesTool(workdir),
    createGitStatusTool(workdir),
    createGitDiffTool(workdir),
  ] as unknown as FeaturePhaseAgentTool[];
}

export type ProposalRequestHelpFn = (
  toolCallId: string,
  query: string,
) => Promise<{ kind: 'answer'; text: string } | { kind: 'discuss' }>;

const requestHelpParameters = Type.Object({
  query: Type.String({
    description:
      'Question or request for the human operator. Be specific — this blocks the planner run until a response arrives.',
  }),
});

function createProposalRequestHelpTool(
  requestHelp: ProposalRequestHelpFn,
): ProposalAgentTool {
  return {
    name: 'request_help',
    label: 'Request Help',
    description:
      'Ask the human operator for guidance during planning. Blocks the planner run until the orchestrator delivers a help response. Use sparingly when the proposal cannot proceed without operator input (e.g. ambiguous scope, missing decision).',
    parameters: requestHelpParameters,
    execute: async (toolCallId, args) => {
      const { query } = args as { query: string };
      const response = await requestHelp(toolCallId, query);
      const text =
        response.kind === 'answer'
          ? response.text
          : '[operator chose to discuss — expect follow-up steering]';
      return {
        content: buildTextContent(text),
        details: { query, responseKind: response.kind },
      };
    },
  };
}

export type ProposalAgentScope = 'feature' | 'project';

export interface BuildProposalAgentToolsetOptions {
  kind?: ProposalAgentScope;
}

export function buildProposalAgentToolset(
  host: GraphProposalToolHost,
  inspectionHost?: DefaultFeaturePhaseToolHost,
  requestHelp?: ProposalRequestHelpFn,
  options: BuildProposalAgentToolsetOptions = {},
): ProposalAgentTool[] {
  const kind: ProposalAgentScope = options.kind ?? 'feature';
  const toolset =
    kind === 'project'
      ? createProjectPlannerToolset(host)
      : createFeaturePlanToolset(host);
  const inspectionTools =
    inspectionHost !== undefined
      ? buildFeatureInspectionTools(inspectionHost)
      : [];
  const helpTool =
    requestHelp !== undefined
      ? [createProposalRequestHelpTool(requestHelp)]
      : [];

  return [
    ...inspectionTools,
    ...helpTool,
    ...toolset.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: proposalToolParameters[tool.name],
      execute: (_toolCallId: string, args: unknown) =>
        tool.execute(args as never).then((result) => ({
          content: buildTextContent(formatToolText(tool.name, result)),
          details: result,
        })),
    })),
  ];
}

export function buildFeaturePhaseAgentToolset(
  host: DefaultFeaturePhaseToolHost,
  phase: 'discuss' | 'research' | 'summarize' | 'verify',
  projectRoot?: string,
  requestHelp?: ProposalRequestHelpFn,
): FeaturePhaseAgentTool[] {
  const tools: FeaturePhaseAgentTool[] = buildFeatureInspectionTools(host);

  if (phase === 'research' && projectRoot !== undefined) {
    tools.push(...buildRepoInspectionTools(projectRoot));
  }

  if (requestHelp !== undefined) {
    tools.push(createProposalRequestHelpTool(requestHelp));
  }

  switch (phase) {
    case 'discuss':
      tools.push({
        name: 'submitDiscuss',
        label: 'Submit Discuss Summary',
        description:
          'Finalize the discuss phase with structured planning input (intent, success criteria, constraints, risks, anti-goals, open questions). Call exactly once when those fields are concrete enough for downstream agents to act on; this is the phase-completion signal, not a progress checkpoint. Output is read by the research agent and the planner in fresh context — fields not captured here are lost.',
        parameters: featurePhaseToolParameters.submitDiscuss,
        execute: (_toolCallId: string, args: unknown) => {
          const result = host.submitDiscuss(args as SubmitDiscussOptions);
          return buildToolResult(
            `Submitted discuss summary: ${result.summary}.`,
            result,
          );
        },
      });
      break;
    case 'research':
      tools.push({
        name: 'submitResearch',
        label: 'Submit Research Summary',
        description:
          'Finalize the research phase with structured codebase findings (essential files, reuse patterns, risky boundaries, proofs needed, verification surfaces, planning notes). Call exactly once when the planner has enough to choose an approach without re-reading the same code; this is the phase-completion signal, not a progress checkpoint. Output is read by the planner in fresh context.',
        parameters: featurePhaseToolParameters.submitResearch,
        execute: (_toolCallId: string, args: unknown) => {
          const result = host.submitResearch(args as SubmitResearchOptions);
          return buildToolResult(
            `Submitted research summary: ${result.summary}.`,
            result,
          );
        },
      });
      break;
    case 'summarize':
      tools.push({
        name: 'submitSummarize',
        label: 'Submit Durable Summary',
        description:
          'Finalize the summarize phase with durable downstream context (capability delivered, important files, verification confidence, carry-forward notes). Call exactly once after the feature is merged; describe what shipped, not what was attempted. Output is read by future feature-phase agents working in fresh context — anything omitted here is not available downstream.',
        parameters: featurePhaseToolParameters.submitSummarize,
        execute: (_toolCallId: string, args: unknown) => {
          const result = host.submitSummarize(args as SubmitSummarizeOptions);
          return buildToolResult(
            `Submitted durable summary: ${result.summary}.`,
            result,
          );
        },
      });
      break;
    case 'verify':
      tools.push({
        name: 'raiseIssue',
        label: 'Raise Verify Issue',
        description:
          'Record a verification finding. Severity controls verdict: any "blocking" or "concern" issue forces the verdict to replan_needed regardless of submitVerify outcome; "nit" issues surface in the summary but do not force replanning. Call once per distinct problem; do not bundle multiple problems into one issue. Raise before calling submitVerify.',
        parameters: featurePhaseToolParameters.raiseIssue,
        execute: (_toolCallId: string, args: unknown) => {
          const issue = host.raiseIssue(args as RaiseIssueOptions);
          return buildToolResult(
            `Raised ${issue.severity} issue ${issue.id}.`,
            issue,
          );
        },
      });
      tools.push({
        name: 'submitVerify',
        label: 'Submit Verify Verdict',
        description:
          "Finalize the verify phase with a 'pass' or 'replan_needed' verdict and per-criterion evidence. Call exactly once after raising every issue that should change the verdict — raising any 'blocking' or 'concern' issue overrides 'pass' to 'replan_needed' regardless of the verdict submitted here. A 'pass' gates the feature for the merge train; 'replan_needed' routes back to plan with replanFocus.",
        parameters: featurePhaseToolParameters.submitVerify,
        execute: (_toolCallId: string, args: unknown) => {
          const result = host.submitVerify(args as SubmitVerifyOptions);
          return buildToolResult(
            `Submitted verify verdict: ${result.outcome ?? (result.ok ? 'pass' : 'replan_needed')}.`,
            result,
          );
        },
      });
      break;
  }

  return tools;
}
