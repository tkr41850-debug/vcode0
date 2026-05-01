import type {
  FeatureGraph,
  GraphSnapshot,
  PlannerFeatureEditPatch,
} from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  type GraphProposal,
  GraphProposalBuilder,
  type GraphProposalMode,
  type GraphProposalOp,
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
  EditFeatureSpecOptions,
  EditTaskOptions,
  RemoveFeatureOptions,
  RemoveTaskOptions,
  SetFeatureDoDOptions,
  SetFeatureObjectiveOptions,
  SubmitProposalOptions,
} from './types.js';

export type GraphProposalHostEvent =
  | {
      kind: 'op_recorded';
      op: GraphProposalOp;
      draftSnapshot: GraphSnapshot;
    }
  | {
      kind: 'submitted';
      details: SubmitProposalOptions;
      proposal: GraphProposal;
      submissionIndex: number;
    };

export type GraphProposalHostListener = (event: GraphProposalHostEvent) => void;

export class GraphProposalToolHost {
  readonly draft: InMemoryFeatureGraph;
  private readonly builder: GraphProposalBuilder;
  private submitted = false;
  private submissionCount = 0;
  private proposalDetails: SubmitProposalOptions | undefined;
  private readonly listeners: GraphProposalHostListener[] = [];

  constructor(
    graph: FeatureGraph,
    readonly mode: GraphProposalMode,
  ) {
    this.draft = new InMemoryFeatureGraph(graph.snapshot());
    // The draft is a private side-graph for proposal recording, not driven
    // by the scheduler. Permanently enter its tick so mutations don't trip
    // the GVC_ASSERT_TICK_BOUNDARY guard.
    this.draft.__enterTick();
    this.builder = new GraphProposalBuilder(mode);
  }

  subscribe(listener: GraphProposalHostListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  private recordOp(op: GraphProposalOp): void {
    this.builder.addOp(op);
    if (this.listeners.length === 0) {
      return;
    }
    const draftSnapshot = this.draft.snapshot();
    for (const listener of [...this.listeners]) {
      listener({ kind: 'op_recorded', op, draftSnapshot });
    }
  }

  addMilestone(args: AddMilestoneOptions): Milestone {
    const milestoneId = this.nextMilestoneId();
    const milestone = this.draft.createMilestone({
      id: milestoneId,
      name: args.name,
      description: args.description,
    });
    const alias = this.builder.allocateMilestoneId(milestone.id);
    this.recordOp({
      kind: 'add_milestone',
      milestoneId: alias as unknown as MilestoneId,
      name: args.name,
      description: args.description,
    });
    return milestone;
  }

  addFeature(args: AddFeatureOptions): Feature {
    const featureId = this.nextFeatureId();
    const feature = this.draft.createFeature({
      id: featureId,
      milestoneId: args.milestoneId,
      name: args.name,
      description: args.description,
    });
    const alias = this.builder.allocateFeatureId(feature.id);
    this.recordOp({
      kind: 'add_feature',
      featureId: alias as unknown as FeatureId,
      milestoneId: this.refMilestone(args.milestoneId),
      name: args.name,
      description: args.description,
    });
    return feature;
  }

  removeFeature(args: RemoveFeatureOptions): void {
    this.draft.removeFeature(args.featureId);
    this.recordOp({
      kind: 'remove_feature',
      featureId: this.refFeature(args.featureId),
    });
  }

  editFeature(args: EditFeatureOptions): Feature {
    const current = this.draft.features.get(args.featureId);
    if (current === undefined) {
      return this.draft.editFeature(args.featureId, args.patch);
    }
    const diff = diffFeaturePatch(current, args.patch);
    const feature = this.draft.editFeature(args.featureId, args.patch);
    if (Object.keys(diff).length === 0) {
      return feature;
    }
    this.recordOp({
      kind: 'edit_feature',
      featureId: this.refFeature(args.featureId),
      patch: diff,
    });
    return feature;
  }

  editFeatureSpec(args: EditFeatureSpecOptions): Feature {
    const patch = args.patch as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      if (
        key !== 'description' &&
        key !== 'featureObjective' &&
        key !== 'featureDoD'
      ) {
        throw new Error(
          `editFeatureSpec rejects "${key}": only description / featureObjective / featureDoD are spec-editable. Use editFeature for rename / topology fields (project-planner scope only).`,
        );
      }
    }
    return this.editFeature({ featureId: args.featureId, patch: args.patch });
  }

  addTask(args: AddTaskOptions): Task {
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
    this.recordOp({
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
    this.draft.removeTask(args.taskId);
    this.recordOp({
      kind: 'remove_task',
      taskId: this.refTask(args.taskId),
    });
  }

  editTask(args: EditTaskOptions): Task {
    const task = this.draft.editTask(args.taskId, args.patch);
    this.recordOp({
      kind: 'edit_task',
      taskId: this.refTask(args.taskId),
      patch: args.patch,
    });
    return task;
  }

  addDependency(args: DependencyOptions): void {
    this.draft.addDependency(args);
    this.recordOp({
      kind: 'add_dependency',
      fromId: this.refEndpoint(args.from),
      toId: this.refEndpoint(args.to),
    });
  }

  removeDependency(args: DependencyOptions): void {
    this.draft.removeDependency(args);
    this.recordOp({
      kind: 'remove_dependency',
      fromId: this.refEndpoint(args.from),
      toId: this.refEndpoint(args.to),
    });
  }

  submit(args: SubmitProposalOptions): void {
    this.submitted = true;
    this.submissionCount += 1;
    this.proposalDetails = args;
    if (this.listeners.length === 0) {
      return;
    }
    const proposal = this.builder.build();
    const submissionIndex = this.submissionCount;
    for (const listener of [...this.listeners]) {
      listener({
        kind: 'submitted',
        details: args,
        proposal,
        submissionIndex,
      });
    }
  }

  wasSubmitted(): boolean {
    return this.submitted;
  }

  submissionIndex(): number {
    return this.submissionCount;
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
