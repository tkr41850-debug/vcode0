import type {
  DependencyOptions,
  FeatureEditPatch,
  FeatureGraph,
  TaskEditPatch,
} from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  type GraphProposal,
  GraphProposalBuilder,
  type GraphProposalMode,
} from '@core/proposals/index';
import type {
  AgentRun,
  DiscussPhaseDetails,
  DiscussPhaseResult,
  EventRecord,
  Feature,
  FeatureId,
  MilestoneId,
  ResearchPhaseDetails,
  ResearchPhaseResult,
  SummarizePhaseDetails,
  SummarizePhaseResult,
  Task,
  TaskResult,
  VerificationCriterionEvidence,
  VerificationSummary,
} from '@core/types/index';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Store } from '@orchestrator/ports/index';
import { Type } from '@sinclair/typebox';

export type { DependencyOptions, FeatureEditPatch, TaskEditPatch };

export interface AddFeatureOptions {
  milestoneId: MilestoneId;
  name: string;
  description: string;
}

export interface RemoveFeatureOptions {
  featureId: FeatureId;
}

export interface EditFeatureOptions {
  featureId: FeatureId;
  patch: FeatureEditPatch;
}

export interface AddTaskOptions {
  featureId: FeatureId;
  description: string;
  weight?: Task['weight'];
  reservedWritePaths?: string[];
}

export interface RemoveTaskOptions {
  taskId: Task['id'];
}

export interface EditTaskOptions {
  taskId: Task['id'];
  patch: TaskEditPatch;
}

export type SubmitProposalOptions = Record<string, never>;

export interface GetFeatureStateOptions {
  featureId?: FeatureId;
}

export interface ListFeatureTasksOptions {
  featureId?: FeatureId;
}

export interface GetTaskResultOptions {
  taskId: Task['id'];
}

export interface ListFeatureEventsOptions {
  featureId?: FeatureId;
  phase?: AgentRun['phase'];
  limit?: number;
}

export interface ListFeatureRunsOptions {
  featureId?: FeatureId;
  phase?: AgentRun['phase'];
}

export interface GetChangedFilesOptions {
  featureId?: FeatureId;
}

export interface SubmitDiscussOptions extends DiscussPhaseDetails {
  summary: string;
}

export interface SubmitResearchOptions extends ResearchPhaseDetails {
  summary: string;
}

export interface SubmitSummarizeOptions extends SummarizePhaseDetails {
  summary: string;
}

export interface SubmitVerifyOptions {
  outcome: 'pass' | 'repair_needed';
  summary: string;
  failedChecks?: string[];
  criteriaEvidence?: VerificationCriterionEvidence[];
  repairFocus?: string[];
}

export interface TaskResultLookup {
  taskId: Task['id'];
  featureId: FeatureId;
  result: TaskResult;
}

export type ProposalToolName =
  | 'addFeature'
  | 'removeFeature'
  | 'editFeature'
  | 'addTask'
  | 'removeTask'
  | 'editTask'
  | 'addDependency'
  | 'removeDependency'
  | 'submit';

export type PlannerToolName = ProposalToolName;
export type ReplannerToolName = ProposalToolName;
export type AgentToolName = ProposalToolName;

export type FeatureInspectionToolName =
  | 'getFeatureState'
  | 'listFeatureTasks'
  | 'getTaskResult'
  | 'listFeatureEvents'
  | 'listFeatureRuns'
  | 'getChangedFiles';

export type FeaturePhaseToolName =
  | FeatureInspectionToolName
  | 'submitDiscuss'
  | 'submitResearch'
  | 'submitSummarize'
  | 'submitVerify';

export interface PlannerToolArgsMap {
  addFeature: AddFeatureOptions;
  removeFeature: RemoveFeatureOptions;
  editFeature: EditFeatureOptions;
  addTask: AddTaskOptions;
  removeTask: RemoveTaskOptions;
  editTask: EditTaskOptions;
  addDependency: DependencyOptions;
  removeDependency: DependencyOptions;
  submit: SubmitProposalOptions;
}

export interface PlannerToolResultMap {
  addFeature: Feature;
  removeFeature: undefined;
  editFeature: Feature;
  addTask: Task;
  removeTask: undefined;
  editTask: Task;
  addDependency: undefined;
  removeDependency: undefined;
  submit: undefined;
}

export interface FeaturePhaseToolArgsMap {
  getFeatureState: GetFeatureStateOptions;
  listFeatureTasks: ListFeatureTasksOptions;
  getTaskResult: GetTaskResultOptions;
  listFeatureEvents: ListFeatureEventsOptions;
  listFeatureRuns: ListFeatureRunsOptions;
  getChangedFiles: GetChangedFilesOptions;
  submitDiscuss: SubmitDiscussOptions;
  submitResearch: SubmitResearchOptions;
  submitSummarize: SubmitSummarizeOptions;
  submitVerify: SubmitVerifyOptions;
}

export interface FeaturePhaseToolResultMap {
  getFeatureState: Feature;
  listFeatureTasks: Task[];
  getTaskResult: TaskResultLookup;
  listFeatureEvents: EventRecord[];
  listFeatureRuns: AgentRun[];
  getChangedFiles: string[];
  submitDiscuss: DiscussPhaseResult;
  submitResearch: ResearchPhaseResult;
  submitSummarize: SummarizePhaseResult;
  submitVerify: VerificationSummary;
}

export type PlannerToolArgs<Name extends AgentToolName = AgentToolName> =
  PlannerToolArgsMap[Name];

export type PlannerToolResult<Name extends AgentToolName = AgentToolName> =
  PlannerToolResultMap[Name];

export type FeaturePhaseToolArgs<
  Name extends FeaturePhaseToolName = FeaturePhaseToolName,
> = FeaturePhaseToolArgsMap[Name];

export type FeaturePhaseToolResult<
  Name extends FeaturePhaseToolName = FeaturePhaseToolName,
> = FeaturePhaseToolResultMap[Name];

export interface PlannerToolDefinition<
  Name extends AgentToolName = AgentToolName,
> {
  name: Name;
  description: string;
  execute(args: PlannerToolArgs<Name>): Promise<PlannerToolResult<Name>>;
}

export interface FeaturePhaseToolDefinition<
  Name extends FeaturePhaseToolName = FeaturePhaseToolName,
> {
  name: Name;
  description: string;
  execute(
    args: FeaturePhaseToolArgs<Name>,
  ): Promise<FeaturePhaseToolResult<Name>>;
}

export interface PlannerToolset {
  readonly tools: readonly PlannerToolDefinition[];
}

export interface ProposalToolHost {
  readonly draft: FeatureGraph;
  readonly mode: GraphProposalMode;
  addFeature(args: AddFeatureOptions): Feature;
  removeFeature(args: RemoveFeatureOptions): void;
  editFeature(args: EditFeatureOptions): Feature;
  addTask(args: AddTaskOptions): Task;
  removeTask(args: RemoveTaskOptions): void;
  editTask(args: EditTaskOptions): Task;
  addDependency(args: DependencyOptions): void;
  removeDependency(args: DependencyOptions): void;
  submit(): void;
  wasSubmitted(): boolean;
  buildProposal(): GraphProposal;
}

export interface FeaturePhaseToolHost {
  getFeatureState(args: GetFeatureStateOptions): Feature;
  listFeatureTasks(args: ListFeatureTasksOptions): Task[];
  getTaskResult(args: GetTaskResultOptions): TaskResultLookup;
  listFeatureEvents(args: ListFeatureEventsOptions): EventRecord[];
  listFeatureRuns(args: ListFeatureRunsOptions): AgentRun[];
  getChangedFiles(args: GetChangedFilesOptions): string[];
  submitDiscuss(args: SubmitDiscussOptions): DiscussPhaseResult;
  submitResearch(args: SubmitResearchOptions): ResearchPhaseResult;
  submitSummarize(args: SubmitSummarizeOptions): SummarizePhaseResult;
  submitVerify(args: SubmitVerifyOptions): VerificationSummary;
  wasDiscussSubmitted(): boolean;
  wasResearchSubmitted(): boolean;
  wasSummarizeSubmitted(): boolean;
  wasVerifySubmitted(): boolean;
  getDiscussSummary(): DiscussPhaseResult;
  getResearchSummary(): ResearchPhaseResult;
  getSummarizeSummary(): SummarizePhaseResult;
  getVerificationSummary(): VerificationSummary;
}

export class GraphProposalToolHost implements ProposalToolHost {
  readonly draft: InMemoryFeatureGraph;
  private readonly builder: GraphProposalBuilder;
  private submitted = false;

  constructor(
    graph: FeatureGraph,
    readonly mode: GraphProposalMode,
  ) {
    this.draft = new InMemoryFeatureGraph(graph.snapshot());
    this.builder = new GraphProposalBuilder(mode);
  }

  addFeature(args: AddFeatureOptions): Feature {
    const featureId = this.nextFeatureId();
    const feature = this.draft.createFeature({
      id: featureId,
      milestoneId: args.milestoneId,
      name: args.name,
      description: args.description,
    });
    this.builder.allocateFeatureId(feature.id);
    this.builder.addOp({
      kind: 'add_feature',
      featureId: feature.id,
      milestoneId: args.milestoneId,
      name: args.name,
      description: args.description,
    });
    return feature;
  }

  removeFeature(args: RemoveFeatureOptions): void {
    this.draft.removeFeature(args.featureId);
    this.builder.addOp({
      kind: 'remove_feature',
      featureId: args.featureId,
    });
  }

  editFeature(args: EditFeatureOptions): Feature {
    const feature = this.draft.editFeature(args.featureId, args.patch);
    this.builder.addOp({
      kind: 'edit_feature',
      featureId: args.featureId,
      patch: args.patch,
    });
    return feature;
  }

  addTask(args: AddTaskOptions): Task {
    const task = this.draft.addTask({
      featureId: args.featureId,
      description: args.description,
      ...(args.weight !== undefined ? { weight: args.weight } : {}),
      ...(args.reservedWritePaths !== undefined
        ? { reservedWritePaths: args.reservedWritePaths }
        : {}),
    });
    this.builder.allocateTaskId(task.id);
    this.builder.addOp({
      kind: 'add_task',
      taskId: task.id,
      featureId: args.featureId,
      description: args.description,
      ...(args.weight !== undefined ? { weight: args.weight } : {}),
      ...(args.reservedWritePaths !== undefined
        ? { reservedWritePaths: args.reservedWritePaths }
        : {}),
    });
    return task;
  }

  removeTask(args: RemoveTaskOptions): void {
    this.draft.removeTask(args.taskId);
    this.builder.addOp({
      kind: 'remove_task',
      taskId: args.taskId,
    });
  }

  editTask(args: EditTaskOptions): Task {
    const task = this.draft.editTask(args.taskId, args.patch);
    this.builder.addOp({
      kind: 'edit_task',
      taskId: args.taskId,
      patch: args.patch,
    });
    return task;
  }

  addDependency(args: DependencyOptions): void {
    this.draft.addDependency(args);
    this.builder.addOp({
      kind: 'add_dependency',
      fromId: args.from,
      toId: args.to,
    });
  }

  removeDependency(args: DependencyOptions): void {
    this.draft.removeDependency(args);
    this.builder.addOp({
      kind: 'remove_dependency',
      fromId: args.from,
      toId: args.to,
    });
  }

  submit(): void {
    this.submitted = true;
  }

  wasSubmitted(): boolean {
    return this.submitted;
  }

  buildProposal(): GraphProposal {
    if (!this.submitted) {
      throw new Error('proposal not submitted');
    }
    return this.builder.build();
  }

  private nextFeatureId(): FeatureId {
    let max = 0;
    for (const featureId of this.draft.features.keys()) {
      const numeric = Number.parseInt(featureId.slice(2), 10);
      if (!Number.isNaN(numeric) && numeric > max) {
        max = numeric;
      }
    }
    return `f-${max + 1}`;
  }
}

class DefaultFeaturePhaseToolHost implements FeaturePhaseToolHost {
  private discuss: DiscussPhaseResult | undefined;
  private research: ResearchPhaseResult | undefined;
  private summarize: SummarizePhaseResult | undefined;
  private verification: VerificationSummary | undefined;

  constructor(
    private readonly featureId: FeatureId,
    private readonly graph: FeatureGraph,
    private readonly store: Pick<Store, 'listAgentRuns' | 'listEvents'>,
  ) {}

  getFeatureState(args: GetFeatureStateOptions): Feature {
    return this.requireFeature(this.resolveFeatureId(args.featureId));
  }

  listFeatureTasks(args: ListFeatureTasksOptions): Task[] {
    const featureId = this.resolveFeatureId(args.featureId);
    return [...this.graph.tasks.values()]
      .filter((task) => task.featureId === featureId)
      .sort((a, b) => a.orderInFeature - b.orderInFeature);
  }

  getTaskResult(args: GetTaskResultOptions): TaskResultLookup {
    const task = this.graph.tasks.get(args.taskId);
    if (task === undefined) {
      throw new Error(`task "${args.taskId}" does not exist`);
    }
    if (task.result === undefined) {
      throw new Error(`task "${args.taskId}" has no recorded result`);
    }
    return {
      taskId: task.id,
      featureId: task.featureId,
      result: task.result,
    };
  }

  listFeatureEvents(args: ListFeatureEventsOptions): EventRecord[] {
    const featureId = this.resolveFeatureId(args.featureId);
    const events = this.store
      .listEvents({ entityId: featureId })
      .filter((event) =>
        args.phase === undefined ? true : readEventPhase(event) === args.phase,
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    if (args.limit === undefined) {
      return events;
    }
    return events.slice(-args.limit);
  }

  listFeatureRuns(args: ListFeatureRunsOptions): AgentRun[] {
    const featureId = this.resolveFeatureId(args.featureId);
    return this.store
      .listAgentRuns({
        scopeType: 'feature_phase',
        scopeId: featureId,
        ...(args.phase !== undefined ? { phase: args.phase } : {}),
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getChangedFiles(args: GetChangedFilesOptions): string[] {
    const tasks = this.listFeatureTasks(
      args.featureId !== undefined ? { featureId: args.featureId } : {},
    );
    const files = new Set<string>();
    for (const task of tasks) {
      for (const file of task.result?.filesChanged ?? []) {
        const trimmed = file.trim();
        if (trimmed.length > 0) {
          files.add(trimmed);
        }
      }
    }
    return [...files];
  }

  submitDiscuss(args: SubmitDiscussOptions): DiscussPhaseResult {
    const { summary, ...extra } = args;
    const result: DiscussPhaseResult = {
      summary,
      extra,
    };
    this.discuss = result;
    return result;
  }

  submitResearch(args: SubmitResearchOptions): ResearchPhaseResult {
    const { summary, ...extra } = args;
    const result: ResearchPhaseResult = {
      summary,
      extra,
    };
    this.research = result;
    return result;
  }

  submitSummarize(args: SubmitSummarizeOptions): SummarizePhaseResult {
    const { summary, ...extra } = args;
    const result: SummarizePhaseResult = {
      summary,
      extra,
    };
    this.summarize = result;
    return result;
  }

  submitVerify(args: SubmitVerifyOptions): VerificationSummary {
    const fallbackFailedChecks =
      args.outcome === 'repair_needed'
        ? args.failedChecks && args.failedChecks.length > 0
          ? args.failedChecks
          : args.repairFocus && args.repairFocus.length > 0
            ? args.repairFocus
            : [args.summary]
        : undefined;
    const verification: VerificationSummary = {
      ok: args.outcome === 'pass',
      summary: args.summary,
      outcome: args.outcome,
      ...(fallbackFailedChecks !== undefined
        ? { failedChecks: fallbackFailedChecks }
        : {}),
      ...(args.criteriaEvidence !== undefined &&
      args.criteriaEvidence.length > 0
        ? { criteriaEvidence: args.criteriaEvidence }
        : {}),
      ...(args.repairFocus !== undefined && args.repairFocus.length > 0
        ? { repairFocus: args.repairFocus }
        : {}),
    };
    this.verification = verification;
    return verification;
  }

  wasDiscussSubmitted(): boolean {
    return this.discuss !== undefined;
  }

  wasResearchSubmitted(): boolean {
    return this.research !== undefined;
  }

  wasSummarizeSubmitted(): boolean {
    return this.summarize !== undefined;
  }

  wasVerifySubmitted(): boolean {
    return this.verification !== undefined;
  }

  getDiscussSummary(): DiscussPhaseResult {
    if (this.discuss === undefined) {
      throw new Error(
        'discuss phase must call submitDiscuss before completion',
      );
    }
    return this.discuss;
  }

  getResearchSummary(): ResearchPhaseResult {
    if (this.research === undefined) {
      throw new Error(
        'research phase must call submitResearch before completion',
      );
    }
    return this.research;
  }

  getSummarizeSummary(): SummarizePhaseResult {
    if (this.summarize === undefined) {
      throw new Error(
        'summarize phase must call submitSummarize before completion',
      );
    }
    return this.summarize;
  }

  getVerificationSummary(): VerificationSummary {
    if (this.verification === undefined) {
      throw new Error('verify phase must call submitVerify before completion');
    }
    return this.verification;
  }

  private resolveFeatureId(featureId: FeatureId | undefined): FeatureId {
    return featureId ?? this.featureId;
  }

  private requireFeature(featureId: FeatureId): Feature {
    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      throw new Error(`feature "${featureId}" does not exist`);
    }
    return feature;
  }
}

export function createProposalToolHost(
  graph: FeatureGraph,
  mode: GraphProposalMode,
): ProposalToolHost {
  return new GraphProposalToolHost(graph, mode);
}

export function createFeaturePhaseToolHost(
  featureId: FeatureId,
  graph: FeatureGraph,
  store: Pick<Store, 'listAgentRuns' | 'listEvents'>,
): FeaturePhaseToolHost {
  return new DefaultFeaturePhaseToolHost(featureId, graph, store);
}

export function createPlannerToolset(host: ProposalToolHost): PlannerToolset {
  return {
    tools: [
      {
        name: 'addFeature',
        description:
          'Add a new feature under an existing milestone to the proposal graph.',
        execute: async (args: AddFeatureOptions) => host.addFeature(args),
      },
      {
        name: 'removeFeature',
        description: 'Remove a feature from the proposal graph.',
        execute: async (args: RemoveFeatureOptions) => {
          host.removeFeature(args);
          return undefined;
        },
      },
      {
        name: 'editFeature',
        description:
          'Edit an existing feature in the proposal graph without changing authoritative state.',
        execute: async (args: EditFeatureOptions) => host.editFeature(args),
      },
      {
        name: 'addTask',
        description: 'Add a task to an existing feature in the proposal graph.',
        execute: async (args: AddTaskOptions) => host.addTask(args),
      },
      {
        name: 'removeTask',
        description: 'Remove a task from the proposal graph.',
        execute: async (args: RemoveTaskOptions) => {
          host.removeTask(args);
          return undefined;
        },
      },
      {
        name: 'editTask',
        description: 'Edit an existing task in the proposal graph.',
        execute: async (args: EditTaskOptions) => host.editTask(args),
      },
      {
        name: 'addDependency',
        description:
          'Add a feature or task dependency in the proposal graph and validate it immediately.',
        execute: async (args: DependencyOptions) => {
          host.addDependency(args);
          return undefined;
        },
      },
      {
        name: 'removeDependency',
        description:
          'Remove a feature or task dependency from the proposal graph.',
        execute: async (args: DependencyOptions) => {
          host.removeDependency(args);
          return undefined;
        },
      },
      {
        name: 'submit',
        description: 'Finalize the proposal graph for approval.',
        execute: async (_args: SubmitProposalOptions) => {
          host.submit();
          return undefined;
        },
      },
    ] as readonly PlannerToolDefinition[],
  };
}

const featurePatchSchema = Type.Object({
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});

const taskPatchSchema = Type.Object({
  description: Type.Optional(Type.String()),
  weight: Type.Optional(
    Type.Union([
      Type.Literal('trivial'),
      Type.Literal('small'),
      Type.Literal('medium'),
      Type.Literal('heavy'),
    ]),
  ),
  reservedWritePaths: Type.Optional(Type.Array(Type.String())),
});

const dependencySchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
});

const verificationCriterionSchema = Type.Object({
  criterion: Type.String(),
  status: Type.Union([
    Type.Literal('met'),
    Type.Literal('missing'),
    Type.Literal('failed'),
  ]),
  evidence: Type.String(),
});

const discussSubmitSchema = Type.Object({
  summary: Type.String(),
  intent: Type.String(),
  successCriteria: Type.Array(Type.String()),
  constraints: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  externalIntegrations: Type.Array(Type.String()),
  antiGoals: Type.Array(Type.String()),
  openQuestions: Type.Array(Type.String()),
});

const researchFileSchema = Type.Object({
  path: Type.String(),
  responsibility: Type.String(),
});

const researchSubmitSchema = Type.Object({
  summary: Type.String(),
  existingBehavior: Type.String(),
  essentialFiles: Type.Array(researchFileSchema),
  reusePatterns: Type.Array(Type.String()),
  riskyBoundaries: Type.Array(Type.String()),
  proofsNeeded: Type.Array(Type.String()),
  verificationSurfaces: Type.Array(Type.String()),
  planningNotes: Type.Array(Type.String()),
});

const summarizeSubmitSchema = Type.Object({
  summary: Type.String(),
  outcome: Type.String(),
  deliveredCapabilities: Type.Array(Type.String()),
  importantFiles: Type.Array(Type.String()),
  verificationConfidence: Type.Array(Type.String()),
  carryForwardNotes: Type.Array(Type.String()),
});

const proposalToolParameters = {
  addFeature: Type.Object({
    milestoneId: Type.String(),
    name: Type.String(),
    description: Type.String(),
  }),
  removeFeature: Type.Object({
    featureId: Type.String(),
  }),
  editFeature: Type.Object({
    featureId: Type.String(),
    patch: featurePatchSchema,
  }),
  addTask: Type.Object({
    featureId: Type.String(),
    description: Type.String(),
    weight: Type.Optional(
      Type.Union([
        Type.Literal('trivial'),
        Type.Literal('small'),
        Type.Literal('medium'),
        Type.Literal('heavy'),
      ]),
    ),
    reservedWritePaths: Type.Optional(Type.Array(Type.String())),
  }),
  removeTask: Type.Object({
    taskId: Type.String(),
  }),
  editTask: Type.Object({
    taskId: Type.String(),
    patch: taskPatchSchema,
  }),
  addDependency: dependencySchema,
  removeDependency: dependencySchema,
  submit: Type.Object({}),
} as const;

const featurePhaseToolParameters = {
  getFeatureState: Type.Object({
    featureId: Type.Optional(Type.String()),
  }),
  listFeatureTasks: Type.Object({
    featureId: Type.Optional(Type.String()),
  }),
  getTaskResult: Type.Object({
    taskId: Type.String(),
  }),
  listFeatureEvents: Type.Object({
    featureId: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }),
  listFeatureRuns: Type.Object({
    featureId: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
  }),
  getChangedFiles: Type.Object({
    featureId: Type.Optional(Type.String()),
  }),
  submitDiscuss: discussSubmitSchema,
  submitResearch: researchSubmitSchema,
  submitSummarize: summarizeSubmitSchema,
  submitVerify: Type.Object({
    outcome: Type.Union([Type.Literal('pass'), Type.Literal('repair_needed')]),
    summary: Type.String(),
    failedChecks: Type.Optional(Type.Array(Type.String())),
    criteriaEvidence: Type.Optional(Type.Array(verificationCriterionSchema)),
    repairFocus: Type.Optional(Type.Array(Type.String())),
  }),
} as const;

// biome-ignore lint/suspicious/noExplicitAny: matches pi-sdk AgentTool<any>[] surface
export type ProposalAgentTool = AgentTool<any>;
// biome-ignore lint/suspicious/noExplicitAny: matches pi-sdk AgentTool<any>[] surface
export type FeaturePhaseAgentTool = AgentTool<any>;

export function buildProposalAgentToolset(
  host: ProposalToolHost,
): ProposalAgentTool[] {
  const toolset = createPlannerToolset(host);

  return toolset.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: proposalToolParameters[tool.name],
    execute: async (_toolCallId, args) => {
      const result = await tool.execute(args as never);
      return {
        content: [{ type: 'text', text: formatToolText(tool.name, result) }],
        details: result,
      };
    },
  })) as ProposalAgentTool[];
}

export function buildFeaturePhaseAgentToolset(
  host: FeaturePhaseToolHost,
  phase: 'discuss' | 'research' | 'summarize' | 'verify',
): FeaturePhaseAgentTool[] {
  const tools: FeaturePhaseAgentTool[] = [
    {
      name: 'getFeatureState',
      label: 'Get Feature State',
      description:
        'Inspect persisted state for the current feature or another feature by id.',
      parameters: featurePhaseToolParameters.getFeatureState,
      execute: async (_toolCallId, args) => {
        const result = host.getFeatureState(args as GetFeatureStateOptions);
        return {
          content: [
            {
              type: 'text',
              text: `Loaded feature ${result.id} in ${result.workControl} / ${result.collabControl}.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: 'listFeatureTasks',
      label: 'List Feature Tasks',
      description:
        'List persisted tasks for the current feature or another feature by id.',
      parameters: featurePhaseToolParameters.listFeatureTasks,
      execute: async (_toolCallId, args) => {
        const result = host.listFeatureTasks(args as ListFeatureTasksOptions);
        return {
          content: [
            {
              type: 'text',
              text: `Listed ${result.length} tasks.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: 'getTaskResult',
      label: 'Get Task Result',
      description:
        'Inspect persisted completion result for a task that already landed.',
      parameters: featurePhaseToolParameters.getTaskResult,
      execute: async (_toolCallId, args) => {
        const result = host.getTaskResult(args as GetTaskResultOptions);
        return {
          content: [
            {
              type: 'text',
              text: `Loaded result for task ${result.taskId}.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: 'listFeatureEvents',
      label: 'List Feature Events',
      description:
        'Inspect persisted feature events, optionally filtered by phase and limited to recent entries.',
      parameters: featurePhaseToolParameters.listFeatureEvents,
      execute: async (_toolCallId, args) => {
        const result = host.listFeatureEvents(args as ListFeatureEventsOptions);
        return {
          content: [
            {
              type: 'text',
              text: `Listed ${result.length} feature events.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: 'listFeatureRuns',
      label: 'List Feature Runs',
      description:
        'Inspect stored feature-phase runs for current feature, optionally filtered by phase.',
      parameters: featurePhaseToolParameters.listFeatureRuns,
      execute: async (_toolCallId, args) => {
        const result = host.listFeatureRuns(args as ListFeatureRunsOptions);
        return {
          content: [
            {
              type: 'text',
              text: `Listed ${result.length} feature-phase runs.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: 'getChangedFiles',
      label: 'Get Changed Files',
      description:
        'Collect deduplicated files changed by landed tasks for current feature.',
      parameters: featurePhaseToolParameters.getChangedFiles,
      execute: async (_toolCallId, args) => {
        const result = host.getChangedFiles(args as GetChangedFilesOptions);
        return {
          content: [
            {
              type: 'text',
              text: `Collected ${result.length} changed files.`,
            },
          ],
          details: result,
        };
      },
    },
  ];

  switch (phase) {
    case 'discuss':
      tools.push({
        name: 'submitDiscuss',
        label: 'Submit Discuss Summary',
        description:
          'Finalize feature discussion with structured planning input. Call exactly once before discuss phase completes.',
        parameters: featurePhaseToolParameters.submitDiscuss,
        execute: async (_toolCallId, args) => {
          const result = host.submitDiscuss(args as SubmitDiscussOptions);
          return {
            content: [
              {
                type: 'text',
                text: `Submitted discuss summary: ${result.summary}.`,
              },
            ],
            details: result,
          };
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
        execute: async (_toolCallId, args) => {
          const result = host.submitResearch(args as SubmitResearchOptions);
          return {
            content: [
              {
                type: 'text',
                text: `Submitted research summary: ${result.summary}.`,
              },
            ],
            details: result,
          };
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
        execute: async (_toolCallId, args) => {
          const result = host.submitSummarize(args as SubmitSummarizeOptions);
          return {
            content: [
              {
                type: 'text',
                text: `Submitted durable summary: ${result.summary}.`,
              },
            ],
            details: result,
          };
        },
      });
      break;
    case 'verify':
      tools.push({
        name: 'submitVerify',
        label: 'Submit Verify Verdict',
        description:
          'Finalize semantic feature verification with a structured pass or repair-needed verdict. Call exactly once before verify phase completes.',
        parameters: featurePhaseToolParameters.submitVerify,
        execute: async (_toolCallId, args) => {
          const result = host.submitVerify(args as SubmitVerifyOptions);
          return {
            content: [
              {
                type: 'text',
                text: `Submitted verify verdict: ${result.outcome ?? (result.ok ? 'pass' : 'repair_needed')}.`,
              },
            ],
            details: result,
          };
        },
      });
      break;
  }

  return tools;
}

function formatToolText(
  toolName: ProposalToolName,
  result: PlannerToolResult,
): string {
  switch (toolName) {
    case 'addFeature': {
      const feature = result as Feature;
      return `Added feature ${feature.id} (${feature.name}).`;
    }
    case 'editFeature': {
      const feature = result as Feature;
      return `Updated feature ${feature.id}.`;
    }
    case 'addTask': {
      const task = result as Task;
      return `Added task ${task.id} to feature ${task.featureId}.`;
    }
    case 'editTask': {
      const task = result as Task;
      return `Updated task ${task.id}.`;
    }
    case 'submit':
      return 'Proposal submitted.';
    case 'removeFeature':
      return 'Feature removed from proposal.';
    case 'removeTask':
      return 'Task removed from proposal.';
    case 'addDependency':
      return 'Dependency added to proposal.';
    case 'removeDependency':
      return 'Dependency removed from proposal.';
  }
}

function readEventPhase(event: EventRecord): AgentRun['phase'] | undefined {
  const phase = event.payload?.phase;
  switch (phase) {
    case 'execute':
    case 'discuss':
    case 'research':
    case 'plan':
    case 'feature_ci':
    case 'verify':
    case 'summarize':
    case 'replan':
      return phase;
    default:
      return undefined;
  }
}
