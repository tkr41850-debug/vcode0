import type { PlannerAgent } from '@agents/planner';
import type { ProposalAgent, ProposalPhaseResult } from '@agents/proposal';
import type { ReplannerAgent } from '@agents/replanner';

export type { PlannerAgent } from '@agents/planner';
export type { ProposalAgent, ProposalPhaseResult } from '@agents/proposal';
export type {
  PromptLibrary,
  PromptTemplate,
  PromptTemplateName,
} from '@agents/prompts';
export type { ReplannerAgent } from '@agents/replanner';
export type {
  AddFeatureOptions,
  AddTaskOptions,
  AgentToolName,
  DependencyOptions,
  EditFeatureOptions,
  EditTaskOptions,
  FeatureEditPatch,
  PlannerToolArgs,
  PlannerToolArgsMap,
  PlannerToolDefinition,
  PlannerToolName,
  PlannerToolResult,
  PlannerToolResultMap,
  PlannerToolset,
  ProposalToolName,
  RemoveFeatureOptions,
  RemoveTaskOptions,
  ReplannerToolName,
  SubmitProposalOptions,
  TaskEditPatch,
} from '@agents/tools';

export interface AgentPort extends PlannerAgent, ReplannerAgent {}
