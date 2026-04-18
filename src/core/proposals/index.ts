import type {
  FeatureGraph,
  PlannerFeatureEditPatch,
  TaskEditPatch,
} from '@core/graph/index';
import { GraphValidationError } from '@core/graph/index';
import type {
  Feature,
  FeatureId,
  MilestoneId,
  Task,
  TaskId,
  TaskWeight,
} from '@core/types/index';

export type GraphProposalMode = 'plan' | 'replan';
export type ProposalAlias = `#${number}`;

export interface AddMilestoneProposalOp {
  kind: 'add_milestone';
  milestoneId: MilestoneId;
  name: string;
  description: string;
}

export interface AddFeatureProposalOp {
  kind: 'add_feature';
  featureId: FeatureId;
  milestoneId: MilestoneId;
  name: string;
  description: string;
}

export interface RemoveFeatureProposalOp {
  kind: 'remove_feature';
  featureId: FeatureId;
}

export interface EditFeatureProposalOp {
  kind: 'edit_feature';
  featureId: FeatureId;
  patch: PlannerFeatureEditPatch;
}

export interface AddTaskProposalOp {
  kind: 'add_task';
  taskId: TaskId;
  featureId: FeatureId;
  description: string;
  weight?: TaskWeight;
  reservedWritePaths?: string[];
}

export interface RemoveTaskProposalOp {
  kind: 'remove_task';
  taskId: TaskId;
}

export interface EditTaskProposalOp {
  kind: 'edit_task';
  taskId: TaskId;
  patch: TaskEditPatch;
}

export interface AddDependencyProposalOp {
  kind: 'add_dependency';
  fromId: FeatureId | TaskId;
  toId: FeatureId | TaskId;
}

export interface RemoveDependencyProposalOp {
  kind: 'remove_dependency';
  fromId: FeatureId | TaskId;
  toId: FeatureId | TaskId;
}

export type GraphProposalOp =
  | AddMilestoneProposalOp
  | AddFeatureProposalOp
  | RemoveFeatureProposalOp
  | EditFeatureProposalOp
  | AddTaskProposalOp
  | RemoveTaskProposalOp
  | EditTaskProposalOp
  | AddDependencyProposalOp
  | RemoveDependencyProposalOp;

export interface GraphProposal {
  version: 1;
  mode: GraphProposalMode;
  aliases: Record<ProposalAlias, FeatureId | TaskId>;
  ops: GraphProposalOp[];
}

export type ProposalWarningCode =
  | 'remove_started_feature'
  | 'remove_started_task';

export interface ProposalWarning {
  code: ProposalWarningCode;
  opIndex: number;
  entityId: FeatureId | TaskId;
  message: string;
}

export interface ProposalSkippedOp {
  opIndex: number;
  op: GraphProposalOp;
  reason: string;
}

export interface ProposalApplyResult {
  proposal: GraphProposal;
  applied: GraphProposalOp[];
  skipped: ProposalSkippedOp[];
  warnings: ProposalWarning[];
  summary: string;
}

export function isGraphProposal(value: unknown): value is GraphProposal {
  if (!isRecord(value) || value.version !== 1) {
    return false;
  }
  if (value.mode !== 'plan' && value.mode !== 'replan') {
    return false;
  }
  if (!isRecord(value.aliases) || !Array.isArray(value.ops)) {
    return false;
  }
  return value.ops.every((op) => isGraphProposalOp(op));
}

export class GraphProposalBuilder {
  private readonly ops: GraphProposalOp[] = [];
  private readonly aliases = new Map<ProposalAlias, FeatureId | TaskId>();
  private readonly reverseAliases = new Map<
    FeatureId | TaskId,
    ProposalAlias
  >();
  private nextAlias = 1;

  constructor(private readonly mode: GraphProposalMode) {}

  allocateFeatureId(featureId: FeatureId): ProposalAlias {
    return this.allocateAlias(featureId);
  }

  allocateTaskId(taskId: TaskId): ProposalAlias {
    return this.allocateAlias(taskId);
  }

  addOp(op: GraphProposalOp): void {
    this.ops.push(op);
  }

  build(): GraphProposal {
    return {
      version: 1,
      mode: this.mode,
      aliases: Object.fromEntries(this.aliases) as Record<
        ProposalAlias,
        FeatureId | TaskId
      >,
      ops: [...this.ops],
    };
  }

  private allocateAlias(id: FeatureId | TaskId): ProposalAlias {
    const existing = this.reverseAliases.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const alias: ProposalAlias = `#${this.nextAlias}`;
    this.nextAlias += 1;
    this.aliases.set(alias, id);
    this.reverseAliases.set(id, alias);
    return alias;
  }
}

export function resolveProposalAlias(
  proposal: GraphProposal,
  alias: ProposalAlias,
): FeatureId | TaskId | undefined {
  return proposal.aliases[alias];
}

export function collectProposalWarnings(
  graph: FeatureGraph,
  proposal: GraphProposal,
): ProposalWarning[] {
  const warnings: ProposalWarning[] = [];

  for (const [opIndex, op] of proposal.ops.entries()) {
    if (op.kind === 'remove_task') {
      const task = graph.tasks.get(op.taskId);
      if (task !== undefined && taskHasStarted(task)) {
        warnings.push({
          code: 'remove_started_task',
          opIndex,
          entityId: task.id,
          message: `Task "${task.id}" already started`,
        });
      }
      continue;
    }

    if (op.kind === 'remove_feature') {
      const feature = graph.features.get(op.featureId);
      if (feature !== undefined && featureHasStarted(graph, feature)) {
        warnings.push({
          code: 'remove_started_feature',
          opIndex,
          entityId: feature.id,
          message: `Feature "${feature.id}" already has started work`,
        });
      }
    }
  }

  return warnings;
}

export function applyGraphProposal(
  graph: FeatureGraph,
  proposal: GraphProposal,
): ProposalApplyResult {
  if (!isGraphProposal(proposal)) {
    throw new Error('invalid proposal payload');
  }

  const warnings = collectProposalWarnings(graph, proposal);
  const applied: GraphProposalOp[] = [];
  const skipped: ProposalSkippedOp[] = [];

  for (const [opIndex, op] of proposal.ops.entries()) {
    const staleReason = staleReasonForOp(graph, op);
    if (staleReason !== undefined) {
      skipped.push({ opIndex, op, reason: staleReason });
      continue;
    }

    try {
      applyProposalOp(graph, op);
      applied.push(op);
    } catch (error) {
      if (error instanceof GraphValidationError) {
        skipped.push({ opIndex, op, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  return {
    proposal,
    applied,
    skipped,
    warnings,
    summary: `${applied.length} applied, ${skipped.length} skipped, ${warnings.length} warnings`,
  };
}

function applyProposalOp(graph: FeatureGraph, op: GraphProposalOp): void {
  switch (op.kind) {
    case 'add_milestone':
      graph.createMilestone({
        id: op.milestoneId,
        name: op.name,
        description: op.description,
      });
      return;
    case 'add_feature':
      graph.createFeature({
        id: op.featureId,
        milestoneId: op.milestoneId,
        name: op.name,
        description: op.description,
      });
      return;
    case 'remove_feature':
      graph.removeFeature(op.featureId);
      return;
    case 'edit_feature':
      graph.editFeature(op.featureId, op.patch);
      return;
    case 'add_task':
      graph.createTask({
        id: op.taskId,
        featureId: op.featureId,
        description: op.description,
        ...(op.weight !== undefined ? { weight: op.weight } : {}),
        ...(op.reservedWritePaths !== undefined
          ? { reservedWritePaths: op.reservedWritePaths }
          : {}),
      });
      return;
    case 'remove_task':
      graph.removeTask(op.taskId);
      return;
    case 'edit_task':
      graph.editTask(op.taskId, op.patch);
      return;
    case 'add_dependency':
      if (isFeatureId(op.fromId) && isFeatureId(op.toId)) {
        graph.addDependency({ from: op.fromId, to: op.toId });
        return;
      }
      graph.addDependency({ from: op.fromId as TaskId, to: op.toId as TaskId });
      return;
    case 'remove_dependency':
      if (isFeatureId(op.fromId) && isFeatureId(op.toId)) {
        graph.removeDependency({ from: op.fromId, to: op.toId });
        return;
      }
      graph.removeDependency({
        from: op.fromId as TaskId,
        to: op.toId as TaskId,
      });
      return;
  }
}

function staleReasonForOp(
  graph: FeatureGraph,
  op: GraphProposalOp,
): string | undefined {
  switch (op.kind) {
    case 'add_milestone':
      return graph.milestones.has(op.milestoneId)
        ? `Milestone "${op.milestoneId}" already exists`
        : undefined;
    case 'add_feature':
      if (graph.features.has(op.featureId)) {
        return `Feature "${op.featureId}" already exists`;
      }
      if (!graph.milestones.has(op.milestoneId)) {
        return `Milestone "${op.milestoneId}" does not exist`;
      }
      return undefined;
    case 'remove_feature': {
      const feature = graph.features.get(op.featureId);
      if (feature === undefined) {
        return `Feature "${op.featureId}" does not exist`;
      }
      if (featureHasStarted(graph, feature)) {
        return `Feature "${op.featureId}" already has started work`;
      }
      const dependents = [...graph.features.values()]
        .filter((candidate) => candidate.dependsOn.includes(op.featureId))
        .map((candidate) => candidate.id);
      return dependents.length === 0
        ? undefined
        : `Feature "${op.featureId}" still has dependents: ${dependents.join(', ')}`;
    }
    case 'edit_feature':
      return graph.features.has(op.featureId)
        ? undefined
        : `Feature "${op.featureId}" does not exist`;
    case 'add_task':
      if (graph.tasks.has(op.taskId)) {
        return `Task "${op.taskId}" already exists`;
      }
      return graph.features.has(op.featureId)
        ? undefined
        : `Feature "${op.featureId}" does not exist`;
    case 'remove_task': {
      const task = graph.tasks.get(op.taskId);
      if (task === undefined) {
        return `Task "${op.taskId}" does not exist`;
      }
      return taskHasStarted(task)
        ? `Task "${op.taskId}" already started`
        : undefined;
    }
    case 'edit_task':
      return graph.tasks.has(op.taskId)
        ? undefined
        : `Task "${op.taskId}" does not exist`;
    case 'add_dependency':
      return dependencyReason(graph, op.fromId, op.toId, true);
    case 'remove_dependency':
      return dependencyReason(graph, op.fromId, op.toId, false);
  }
}

function dependencyReason(
  graph: FeatureGraph,
  fromId: FeatureId | TaskId,
  toId: FeatureId | TaskId,
  adding: boolean,
): string | undefined {
  if (isFeatureId(fromId) !== isFeatureId(toId)) {
    return 'Dependency endpoints must both be features or both be tasks';
  }

  if (isFeatureId(fromId) && isFeatureId(toId)) {
    const from = graph.features.get(fromId);
    const to = graph.features.get(toId);
    if (from === undefined) {
      return `Feature "${fromId}" does not exist`;
    }
    if (to === undefined) {
      return `Feature "${toId}" does not exist`;
    }
    const exists = from.dependsOn.includes(toId);
    if (adding && exists) {
      return `Feature "${fromId}" already depends on "${toId}"`;
    }
    if (!adding && !exists) {
      return `Feature "${fromId}" does not depend on "${toId}"`;
    }
    return undefined;
  }

  const from = graph.tasks.get(fromId as TaskId);
  const to = graph.tasks.get(toId as TaskId);
  if (from === undefined) {
    return `Task "${fromId}" does not exist`;
  }
  if (to === undefined) {
    return `Task "${toId}" does not exist`;
  }
  if (from.featureId !== to.featureId) {
    return `Task "${fromId}" and task "${toId}" belong to different features`;
  }
  const exists = from.dependsOn.includes(toId as TaskId);
  if (adding && exists) {
    return `Task "${fromId}" already depends on "${toId}"`;
  }
  if (!adding && !exists) {
    return `Task "${fromId}" does not depend on "${toId}"`;
  }
  return undefined;
}

function taskHasStarted(task: Task): boolean {
  return task.status !== 'pending' || task.collabControl !== 'none';
}

function featureHasStarted(graph: FeatureGraph, feature: Feature): boolean {
  if (feature.status !== 'pending') {
    return true;
  }

  for (const task of graph.tasks.values()) {
    if (task.featureId === feature.id && taskHasStarted(task)) {
      return true;
    }
  }

  return false;
}

function isFeatureId(id: FeatureId | TaskId): id is FeatureId {
  return id.startsWith('f-');
}

function isGraphProposalOp(value: unknown): value is GraphProposalOp {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }

  switch (value.kind) {
    case 'add_milestone':
      return (
        typeof value.milestoneId === 'string' &&
        typeof value.name === 'string' &&
        typeof value.description === 'string'
      );
    case 'add_feature':
      return (
        typeof value.featureId === 'string' &&
        typeof value.milestoneId === 'string' &&
        typeof value.name === 'string' &&
        typeof value.description === 'string'
      );
    case 'remove_feature':
      return typeof value.featureId === 'string';
    case 'edit_feature':
      return (
        typeof value.featureId === 'string' &&
        isRecord(value.patch) &&
        featurePatchIsValid(value.patch)
      );
    case 'add_task':
      return (
        typeof value.taskId === 'string' &&
        typeof value.featureId === 'string' &&
        typeof value.description === 'string' &&
        (value.weight === undefined || isTaskWeight(value.weight)) &&
        stringArrayOrUndefined(value.reservedWritePaths)
      );
    case 'remove_task':
      return typeof value.taskId === 'string';
    case 'edit_task':
      return (
        typeof value.taskId === 'string' &&
        isRecord(value.patch) &&
        taskPatchIsValid(value.patch)
      );
    case 'add_dependency':
    case 'remove_dependency':
      return typeof value.fromId === 'string' && typeof value.toId === 'string';
    default:
      return false;
  }
}

const ALLOWED_FEATURE_PATCH_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'summary',
]);

function featurePatchIsValid(patch: Record<string, unknown>): boolean {
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_FEATURE_PATCH_KEYS.has(key)) {
      return false;
    }
  }
  return (
    (patch.name === undefined || typeof patch.name === 'string') &&
    (patch.description === undefined ||
      typeof patch.description === 'string') &&
    (patch.summary === undefined || typeof patch.summary === 'string')
  );
}

function taskPatchIsValid(patch: Record<string, unknown>): boolean {
  return (
    (patch.description === undefined ||
      typeof patch.description === 'string') &&
    (patch.weight === undefined || isTaskWeight(patch.weight)) &&
    stringArrayOrUndefined(patch.reservedWritePaths)
  );
}

function isTaskWeight(value: unknown): value is TaskWeight {
  return (
    value === 'trivial' ||
    value === 'small' ||
    value === 'medium' ||
    value === 'heavy'
  );
}

function stringArrayOrUndefined(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
