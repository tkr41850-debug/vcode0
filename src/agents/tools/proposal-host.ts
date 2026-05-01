import type {
  FeatureGraph,
  MilestoneEditPatch,
  PlannerFeatureEditPatch,
} from '@core/graph/index';
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
  TaskId,
} from '@core/types/index';

import type {
  AddFeatureOptions,
  AddMilestoneOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditMilestoneOptions,
  EditTaskOptions,
  MergeFeaturesOptions,
  MoveFeatureOptions,
  RemoveFeatureOptions,
  RemoveMilestoneOptions,
  RemoveTaskOptions,
  ReorderTasksOptions,
  SetFeatureDoDOptions,
  SetFeatureObjectiveOptions,
  SplitFeatureOptions,
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
    const alias = this.builder.allocateMilestoneId(milestone.id);
    this.builder.addOp({
      kind: 'add_milestone',
      milestoneId: alias as unknown as MilestoneId,
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
    const alias = this.builder.allocateFeatureId(feature.id);
    this.builder.addOp({
      kind: 'add_feature',
      featureId: alias as unknown as FeatureId,
      milestoneId: this.refMilestone(args.milestoneId),
      name: args.name,
      description: args.description,
    });
    return feature;
  }

  editMilestone(args: EditMilestoneOptions): Milestone {
    this.assertMutable();
    const current = this.draft.milestones.get(args.milestoneId);
    if (current === undefined) {
      return this.draft.editMilestone(args.milestoneId, args.patch);
    }
    const diff = diffMilestonePatch(current, args.patch);
    const milestone = this.draft.editMilestone(args.milestoneId, args.patch);
    if (Object.keys(diff).length === 0) {
      return milestone;
    }
    this.builder.addOp({
      kind: 'edit_milestone',
      milestoneId: this.refMilestone(args.milestoneId),
      patch: diff,
    });
    return milestone;
  }

  removeMilestone(args: RemoveMilestoneOptions): void {
    this.assertMutable();
    this.draft.removeMilestone(args.milestoneId);
    this.builder.addOp({
      kind: 'remove_milestone',
      milestoneId: this.refMilestone(args.milestoneId),
    });
  }

  removeFeature(args: RemoveFeatureOptions): void {
    this.assertMutable();
    this.draft.removeFeature(args.featureId);
    this.builder.addOp({
      kind: 'remove_feature',
      featureId: this.refFeature(args.featureId),
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
      featureId: this.refFeature(args.featureId),
      patch: diff,
    });
    return feature;
  }

  moveFeature(args: MoveFeatureOptions): Feature {
    this.assertMutable();
    const current = this.draft.features.get(args.featureId);
    if (current?.milestoneId === args.milestoneId) {
      return current;
    }
    this.draft.changeMilestone(args.featureId, args.milestoneId);
    const feature = this.draft.features.get(args.featureId);
    if (feature === undefined) {
      throw new Error(`feature "${args.featureId}" does not exist after move`);
    }
    this.builder.addOp({
      kind: 'move_feature',
      featureId: this.refFeature(args.featureId),
      milestoneId: this.refMilestone(args.milestoneId),
    });
    return feature;
  }

  splitFeature(args: SplitFeatureOptions): Feature[] {
    this.assertMutable();
    const features = this.draft.splitFeature(args.featureId, args.splits);
    for (const feature of features) {
      this.builder.allocateFeatureId(feature.id);
    }
    this.builder.addOp({
      kind: 'split_feature',
      featureId: this.refFeature(args.featureId),
      splits: args.splits.map((split) => ({
        ...split,
        id: this.refFeature(split.id),
        ...(split.deps !== undefined
          ? { deps: split.deps.map((dep) => this.refFeature(dep)) }
          : {}),
      })),
    });
    return features;
  }

  mergeFeatures(args: MergeFeaturesOptions): Feature {
    this.assertMutable();
    const feature = this.draft.mergeFeatures(args.featureIds, args.name);
    this.builder.addOp({
      kind: 'merge_features',
      featureIds: args.featureIds.map((featureId) =>
        this.refFeature(featureId),
      ),
      name: args.name,
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
    const alias = this.builder.allocateTaskId(task.id);
    this.builder.addOp({
      kind: 'add_task',
      taskId: alias as unknown as TaskId,
      featureId: this.refFeature(args.featureId),
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
      taskId: this.refTask(args.taskId),
    });
  }

  editTask(args: EditTaskOptions): Task {
    this.assertMutable();
    const task = this.draft.editTask(args.taskId, args.patch);
    this.builder.addOp({
      kind: 'edit_task',
      taskId: this.refTask(args.taskId),
      patch: args.patch,
    });
    return task;
  }

  reorderTasks(args: ReorderTasksOptions): Task[] {
    this.assertMutable();
    const currentOrder = this.listFeatureTasksInOrder(args.featureId);
    if (
      currentOrder.length === args.taskIds.length &&
      currentOrder.every((task, index) => task.id === args.taskIds[index])
    ) {
      return currentOrder;
    }
    this.draft.reorderTasks(args.featureId, args.taskIds);
    const tasks = this.listFeatureTasksInOrder(args.featureId);
    this.builder.addOp({
      kind: 'reorder_tasks',
      featureId: this.refFeature(args.featureId),
      taskIds: args.taskIds.map((taskId) => this.refTask(taskId)),
    });
    return tasks;
  }

  addDependency(args: DependencyOptions): void {
    this.assertMutable();
    this.draft.addDependency(args);
    this.builder.addOp({
      kind: 'add_dependency',
      fromId: this.refEndpoint(args.from),
      toId: this.refEndpoint(args.to),
    });
  }

  removeDependency(args: DependencyOptions): void {
    this.assertMutable();
    this.draft.removeDependency(args);
    this.builder.addOp({
      kind: 'remove_dependency',
      fromId: this.refEndpoint(args.from),
      toId: this.refEndpoint(args.to),
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

  private refMilestone(id: MilestoneId): MilestoneId {
    const alias = this.builder.aliasFor(id);
    return alias === undefined ? id : (alias as unknown as MilestoneId);
  }

  private refFeature(id: FeatureId): FeatureId {
    const alias = this.builder.aliasFor(id);
    return alias === undefined ? id : (alias as unknown as FeatureId);
  }

  private refTask(id: TaskId): TaskId {
    const alias = this.builder.aliasFor(id);
    return alias === undefined ? id : (alias as unknown as TaskId);
  }

  private refEndpoint<T extends FeatureId | TaskId>(id: T): T {
    const alias = this.builder.aliasFor(id);
    return alias === undefined ? id : (alias as unknown as T);
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

  private listFeatureTasksInOrder(featureId: FeatureId): Task[] {
    return [...this.draft.tasks.values()]
      .filter((task) => task.featureId === featureId)
      .sort((left, right) => left.orderInFeature - right.orderInFeature);
  }
}

export function createProposalToolHost(
  graph: FeatureGraph,
  mode: GraphProposalMode,
): GraphProposalToolHost {
  return new GraphProposalToolHost(graph, mode);
}

const EDITABLE_MILESTONE_KEYS = [
  'name',
  'description',
] as const satisfies readonly (keyof MilestoneEditPatch)[];

const EDITABLE_FEATURE_KEYS = [
  'name',
  'description',
  'summary',
  'roughDraft',
  'featureObjective',
  'featureDoD',
] as const satisfies readonly (keyof PlannerFeatureEditPatch)[];

function diffMilestonePatch(
  current: Milestone,
  patch: MilestoneEditPatch,
): MilestoneEditPatch {
  const diff: MilestoneEditPatch = {};
  for (const key of EDITABLE_MILESTONE_KEYS) {
    const next = patch[key];
    if (next === undefined) {
      continue;
    }
    if (current[key] === next) {
      continue;
    }
    diff[key] = next;
  }
  return diff;
}

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
