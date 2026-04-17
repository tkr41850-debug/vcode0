import type { FeatureGraph } from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  type GraphProposal,
  GraphProposalBuilder,
  type GraphProposalMode,
} from '@core/proposals/index';
import type { Feature, FeatureId, Task } from '@core/types/index';

import type {
  AddFeatureOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditTaskOptions,
  ProposalToolHost,
  RemoveFeatureOptions,
  RemoveTaskOptions,
} from './types.js';

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
