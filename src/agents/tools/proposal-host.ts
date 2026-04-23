import type { FeatureGraph, PlannerFeatureEditPatch } from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  type GraphProposal,
  GraphProposalBuilder,
  type GraphProposalMode,
} from '@core/proposals/index';
import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
} from '@core/types/index';

import type {
  AddFeatureOptions,
  AddMilestoneOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditTaskOptions,
  RemoveFeatureOptions,
  RemoveTaskOptions,
  SetFeatureDoDOptions,
  SetFeatureObjectiveOptions,
  SubmitProposalOptions,
} from './types.js';

export class GraphProposalToolHost {
  readonly draft: InMemoryFeatureGraph;
  private readonly builder: GraphProposalBuilder;
  private submitted = false;
  private proposalDetails: SubmitProposalOptions | undefined;

  constructor(
    graph: FeatureGraph,
    readonly mode: GraphProposalMode,
  ) {
    this.draft = new InMemoryFeatureGraph(graph.snapshot());
    this.builder = new GraphProposalBuilder(mode);
  }

  addMilestone(args: AddMilestoneOptions): Milestone {
    this.assertMutable();
    const milestoneId = this.nextMilestoneId();
    const milestone = this.draft.createMilestone({
      id: milestoneId,
      name: args.name,
      description: args.description,
    });
    this.builder.addOp({
      kind: 'add_milestone',
      milestoneId: milestone.id,
      name: args.name,
      description: args.description,
    });
    return milestone;
  }

  addFeature(args: AddFeatureOptions): Feature {
    this.assertMutable();
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
    this.assertMutable();
    this.draft.removeFeature(args.featureId);
    this.builder.addOp({
      kind: 'remove_feature',
      featureId: args.featureId,
    });
  }

  editFeature(args: EditFeatureOptions): Feature {
    this.assertMutable();
    const current = this.draft.features.get(args.featureId);
    if (current === undefined) {
      return this.draft.editFeature(args.featureId, args.patch);
    }
    const diff = diffFeaturePatch(current, args.patch);
    const feature = this.draft.editFeature(args.featureId, args.patch);
    if (Object.keys(diff).length === 0) {
      return feature;
    }
    this.builder.addOp({
      kind: 'edit_feature',
      featureId: args.featureId,
      patch: diff,
    });
    return feature;
  }

  addTask(args: AddTaskOptions): Task {
    this.assertMutable();
    const plannerFields = {
      ...(args.weight !== undefined ? { weight: args.weight } : {}),
      ...(args.reservedWritePaths !== undefined
        ? { reservedWritePaths: args.reservedWritePaths }
        : {}),
      ...(args.objective !== undefined ? { objective: args.objective } : {}),
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      ...(args.expectedFiles !== undefined
        ? { expectedFiles: args.expectedFiles }
        : {}),
      ...(args.references !== undefined ? { references: args.references } : {}),
      ...(args.outcomeVerification !== undefined
        ? { outcomeVerification: args.outcomeVerification }
        : {}),
    };
    const task = this.draft.addTask({
      featureId: args.featureId,
      description: args.description,
      ...plannerFields,
    });
    this.builder.allocateTaskId(task.id);
    this.builder.addOp({
      kind: 'add_task',
      taskId: task.id,
      featureId: args.featureId,
      description: args.description,
      ...plannerFields,
    });
    return task;
  }

  setFeatureObjective(args: SetFeatureObjectiveOptions): Feature {
    return this.editFeature({
      featureId: args.featureId,
      patch: { featureObjective: args.objective },
    });
  }

  setFeatureDoD(args: SetFeatureDoDOptions): Feature {
    return this.editFeature({
      featureId: args.featureId,
      patch: { featureDoD: args.dod },
    });
  }

  removeTask(args: RemoveTaskOptions): void {
    this.assertMutable();
    this.draft.removeTask(args.taskId);
    this.builder.addOp({
      kind: 'remove_task',
      taskId: args.taskId,
    });
  }

  editTask(args: EditTaskOptions): Task {
    this.assertMutable();
    const task = this.draft.editTask(args.taskId, args.patch);
    this.builder.addOp({
      kind: 'edit_task',
      taskId: args.taskId,
      patch: args.patch,
    });
    return task;
  }

  addDependency(args: DependencyOptions): void {
    this.assertMutable();
    this.draft.addDependency(args);
    this.builder.addOp({
      kind: 'add_dependency',
      fromId: args.from,
      toId: args.to,
    });
  }

  removeDependency(args: DependencyOptions): void {
    this.assertMutable();
    this.draft.removeDependency(args);
    this.builder.addOp({
      kind: 'remove_dependency',
      fromId: args.from,
      toId: args.to,
    });
  }

  submit(args: SubmitProposalOptions): void {
    if (this.submitted) {
      throw new Error('proposal already submitted');
    }
    this.submitted = true;
    this.proposalDetails = args;
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

  getProposalDetails(): SubmitProposalOptions {
    if (this.proposalDetails === undefined) {
      throw new Error('proposal details not submitted');
    }
    return this.proposalDetails;
  }

  private assertMutable(): void {
    if (this.submitted) {
      throw new Error('proposal already submitted');
    }
  }

  private nextMilestoneId(): MilestoneId {
    let max = 0;
    for (const milestoneId of this.draft.milestones.keys()) {
      const numeric = Number.parseInt(milestoneId.slice(2), 10);
      if (!Number.isNaN(numeric) && numeric > max) {
        max = numeric;
      }
    }
    return `m-${max + 1}`;
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
): GraphProposalToolHost {
  return new GraphProposalToolHost(graph, mode);
}

const EDITABLE_FEATURE_KEYS = [
  'name',
  'description',
  'summary',
  'roughDraft',
  'featureObjective',
  'featureDoD',
] as const satisfies readonly (keyof PlannerFeatureEditPatch)[];

function diffFeaturePatch(
  current: Feature,
  patch: PlannerFeatureEditPatch,
): PlannerFeatureEditPatch {
  const diff: PlannerFeatureEditPatch = {};
  for (const key of EDITABLE_FEATURE_KEYS) {
    const next = patch[key];
    if (next === undefined) {
      continue;
    }
    if (equalsFeatureField(current[key], next)) {
      continue;
    }
    (diff as Record<string, unknown>)[key] = next;
  }
  return diff;
}

function equalsFeatureField(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}
