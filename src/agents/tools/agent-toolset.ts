import { createGitDiffTool } from '@agents/worker/tools/git-diff';
import { createGitStatusTool } from '@agents/worker/tools/git-status';
import { createListFilesTool } from '@agents/worker/tools/list-files';
import { createReadFileTool } from '@agents/worker/tools/read-file';
import { createSearchFilesTool } from '@agents/worker/tools/search-files';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { TSchema } from '@sinclair/typebox';

import type { DefaultFeaturePhaseToolHost } from './feature-phase-host.js';
import { createPlannerToolset, formatToolText } from './planner-toolset.js';
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
      execute: async (_toolCallId: string, args: unknown) => {
        const result = await host.getChangedFiles(
          args as GetChangedFilesOptions,
        );
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

export function buildProposalAgentToolset(
  host: GraphProposalToolHost,
  inspectionHost?: DefaultFeaturePhaseToolHost,
): ProposalAgentTool[] {
  const toolset = createPlannerToolset(host);
  const inspectionTools =
    inspectionHost !== undefined
      ? buildFeatureInspectionTools(inspectionHost)
      : [];

  return [
    ...inspectionTools,
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
): FeaturePhaseAgentTool[] {
  const tools: FeaturePhaseAgentTool[] = buildFeatureInspectionTools(host);

  if (phase === 'research' && projectRoot !== undefined) {
    tools.push(...buildRepoInspectionTools(projectRoot));
  }

  switch (phase) {
    case 'discuss':
      tools.push({
        name: 'submitDiscuss',
        label: 'Submit Discuss Summary',
        description:
          'Finalize feature discussion with structured planning input. Call exactly once before discuss phase completes.',
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
          'Finalize feature research with structured codebase findings. Call exactly once before research phase completes.',
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
          'Finalize merged feature summary with durable downstream context. Call exactly once before summarize phase completes.',
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
          'Record a blocking, concern, or nit issue that the replanner should address. Call once per distinct issue before submitting the verdict.',
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
          'Finalize semantic feature verification with a structured pass or repair-needed verdict. Call exactly once before verify phase completes.',
        parameters: featurePhaseToolParameters.submitVerify,
        execute: (_toolCallId: string, args: unknown) => {
          const result = host.submitVerify(args as SubmitVerifyOptions);
          return buildToolResult(
            `Submitted verify verdict: ${result.outcome ?? (result.ok ? 'pass' : 'repair_needed')}.`,
            result,
          );
        },
      });
      break;
  }

  return tools;
}
