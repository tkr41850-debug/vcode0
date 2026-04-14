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
import type { Feature, FeatureId, MilestoneId, Task } from '@core/types/index';
import type { AgentTool } from '@mariozechner/pi-agent-core';
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

export type PlannerToolArgs<Name extends AgentToolName = AgentToolName> =
  PlannerToolArgsMap[Name];

export type PlannerToolResult<Name extends AgentToolName = AgentToolName> =
  PlannerToolResultMap[Name];

export interface PlannerToolDefinition<
  Name extends AgentToolName = AgentToolName,
> {
  name: Name;
  description: string;
  execute(args: PlannerToolArgs<Name>): Promise<PlannerToolResult<Name>>;
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

export function createProposalToolHost(
  graph: FeatureGraph,
  mode: GraphProposalMode,
): ProposalToolHost {
  return new GraphProposalToolHost(graph, mode);
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

// biome-ignore lint/suspicious/noExplicitAny: matches pi-sdk AgentTool<any>[] surface
export type ProposalAgentTool = AgentTool<any>;

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
