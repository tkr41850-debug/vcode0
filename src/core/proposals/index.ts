import type {
  FeatureGraph,
  MilestoneEditPatch,
  PlannerFeatureEditPatch,
  SplitSpec,
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

export interface EditMilestoneProposalOp {
  kind: 'edit_milestone';
  milestoneId: MilestoneId;
  patch: MilestoneEditPatch;
}

export interface RemoveMilestoneProposalOp {
  kind: 'remove_milestone';
  milestoneId: MilestoneId;
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

export interface MoveFeatureProposalOp {
  kind: 'move_feature';
  featureId: FeatureId;
  milestoneId: MilestoneId;
}

export interface SplitFeatureProposalOp {
  kind: 'split_feature';
  featureId: FeatureId;
  splits: SplitSpec[];
}

export interface MergeFeaturesProposalOp {
  kind: 'merge_features';
  featureIds: FeatureId[];
  name: string;
}

export interface AddTaskProposalOp {
  kind: 'add_task';
  taskId: TaskId;
  featureId: FeatureId;
  description: string;
  weight?: TaskWeight;
  reservedWritePaths?: string[];
  objective?: string;
  scope?: string;
  expectedFiles?: string[];
  references?: string[];
  outcomeVerification?: string;
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

export interface ReorderTasksProposalOp {
  kind: 'reorder_tasks';
  featureId: FeatureId;
  taskIds: TaskId[];
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
  | EditMilestoneProposalOp
  | RemoveMilestoneProposalOp
  | AddFeatureProposalOp
  | RemoveFeatureProposalOp
  | EditFeatureProposalOp
  | MoveFeatureProposalOp
  | SplitFeatureProposalOp
  | MergeFeaturesProposalOp
  | AddTaskProposalOp
  | RemoveTaskProposalOp
  | EditTaskProposalOp
  | ReorderTasksProposalOp
  | AddDependencyProposalOp
  | RemoveDependencyProposalOp;

export interface GraphProposal {
  version: 1;
  mode: GraphProposalMode;
  aliases: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>;
  ops: GraphProposalOp[];
}

export type ProposalWarningCode =
  | 'remove_started_milestone'
  | 'remove_started_feature'
  | 'remove_started_task'
  | 'edit_started_milestone'
  | 'edit_started_feature'
  | 'move_started_feature'
  | 'split_started_feature'
  | 'merge_started_feature'
  | 'edit_started_task'
  | 'reorder_started_task'
  | 'add_dependency_started_work'
  | 'remove_dependency_started_work';

export interface ProposalWarning {
  code: ProposalWarningCode;
  opIndex: number;
  entityId: MilestoneId | FeatureId | TaskId;
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
  resolvedAliases: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>;
}

export interface ProposalApplyOptions {
  additiveOnly?: boolean;
  plannerCollisionFeatureIds?: readonly FeatureId[];
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
  private readonly aliases = new Map<
    ProposalAlias,
    MilestoneId | FeatureId | TaskId
  >();
  private readonly reverseAliases = new Map<
    MilestoneId | FeatureId | TaskId,
    ProposalAlias
  >();
  private nextAlias = 1;

  constructor(private readonly mode: GraphProposalMode) {}

  allocateMilestoneId(milestoneId: MilestoneId): ProposalAlias {
    return this.allocateAlias(milestoneId);
  }

  allocateFeatureId(featureId: FeatureId): ProposalAlias {
    return this.allocateAlias(featureId);
  }

  allocateTaskId(taskId: TaskId): ProposalAlias {
    return this.allocateAlias(taskId);
  }

  aliasFor(id: MilestoneId | FeatureId | TaskId): ProposalAlias | undefined {
    return this.reverseAliases.get(id);
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
        MilestoneId | FeatureId | TaskId
      >,
      ops: [...this.ops],
    };
  }

  private allocateAlias(id: MilestoneId | FeatureId | TaskId): ProposalAlias {
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
): MilestoneId | FeatureId | TaskId | undefined {
  return proposal.aliases[alias];
}

export function collectProposalWarnings(
  graph: FeatureGraph,
  proposal: GraphProposal,
  options: ProposalApplyOptions = {},
): ProposalWarning[] {
  const { ops: resolvedOps } = resolveProposalAliases(graph, proposal.ops);
  return collectWarningsForResolvedOps(graph, resolvedOps, options);
}

function collectWarningsForResolvedOps(
  graph: FeatureGraph,
  ops: readonly GraphProposalOp[],
  options: ProposalApplyOptions,
): ProposalWarning[] {
  return collectWarningsForOps(graph, ops, options);
}

function collectWarningsForOps(
  graph: FeatureGraph,
  ops: readonly GraphProposalOp[],
  options: ProposalApplyOptions,
): ProposalWarning[] {
  const warnings: ProposalWarning[] = [];

  for (const [opIndex, op] of ops.entries()) {
    if (op.kind === 'remove_task') {
      const task = graph.tasks.get(op.taskId);
      if (task !== undefined && !taskIsRemovable(task)) {
        warnings.push({
          code: 'remove_started_task',
          opIndex,
          entityId: task.id,
          message: `Task "${task.id}" cannot be removed while status="${task.status}"; cancel the task first`,
        });
      }
      continue;
    }

    if (op.kind === 'remove_feature') {
      const feature = graph.features.get(op.featureId);
      const hasStartedWork =
        feature !== undefined &&
        (options.additiveOnly
          ? featureHasLiveWork(graph, feature)
          : featureHasStarted(graph, feature));
      if (feature !== undefined && hasStartedWork) {
        warnings.push({
          code: 'remove_started_feature',
          opIndex,
          entityId: feature.id,
          message: startedFeatureMessage(feature.id),
        });
      }
      continue;
    }

    if (!options.additiveOnly) {
      continue;
    }

    warnings.push(...collectAdditiveOnlyWarnings(graph, op, opIndex, options));
  }

  return warnings;
}

export function applyGraphProposal(
  graph: FeatureGraph,
  proposal: GraphProposal,
  options: ProposalApplyOptions = {},
): ProposalApplyResult {
  if (!isGraphProposal(proposal)) {
    throw new Error('invalid proposal payload');
  }

  const { ops: resolvedOps, aliasForOp } = resolveProposalAliases(
    graph,
    proposal.ops,
  );
  const warnings = collectWarningsForResolvedOps(graph, resolvedOps, options);
  const applied: GraphProposalOp[] = [];
  const skipped: ProposalSkippedOp[] = [];
  const resolvedAliases: Record<
    ProposalAlias,
    MilestoneId | FeatureId | TaskId
  > = {};

  for (const [opIndex, op] of resolvedOps.entries()) {
    const staleReason = staleReasonForOp(graph, op, options);
    if (staleReason !== undefined) {
      skipped.push({ opIndex, op, reason: staleReason });
      continue;
    }

    try {
      applyProposalOp(graph, op);
      applied.push(op);
      const bindings = aliasForOp.get(opIndex);
      if (bindings !== undefined) {
        for (const binding of bindings) {
          resolvedAliases[binding.alias] = binding.concrete;
        }
      }
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
    resolvedAliases,
  };
}

interface AliasCounters {
  m: number;
  f: number;
  t: number;
}

interface AliasBinding {
  alias: ProposalAlias;
  concrete: MilestoneId | FeatureId | TaskId;
}

function resolveProposalAliases(
  graph: FeatureGraph,
  ops: readonly GraphProposalOp[],
): {
  ops: GraphProposalOp[];
  aliasForOp: Map<number, AliasBinding[]>;
} {
  const resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId> = {};
  const counters: AliasCounters = {
    m: maxNumericSuffix(graph.milestones.keys()),
    f: maxNumericSuffix(graph.features.keys()),
    t: maxNumericSuffix(graph.tasks.keys()),
  };
  const aliasForOp = new Map<number, AliasBinding[]>();

  const rewritten: GraphProposalOp[] = [];
  for (const [index, op] of ops.entries()) {
    const declared = declaredAliases(op);
    const next = rewriteOp(op, resolved, counters);
    const bindings = declared.flatMap((alias) => {
      const concrete = resolved[alias];
      return concrete === undefined ? [] : [{ alias, concrete }];
    });
    if (bindings.length > 0) {
      aliasForOp.set(index, bindings);
    }
    rewritten.push(next);
  }
  return { ops: rewritten, aliasForOp };
}

function declaredAliases(op: GraphProposalOp): ProposalAlias[] {
  switch (op.kind) {
    case 'add_milestone':
      return isAlias(op.milestoneId) ? [op.milestoneId] : [];
    case 'add_feature':
      return isAlias(op.featureId) ? [op.featureId] : [];
    case 'split_feature': {
      const aliases: ProposalAlias[] = [];
      for (const split of op.splits) {
        if (isAlias(split.id)) {
          aliases.push(split.id);
        }
      }
      return aliases;
    }
    case 'add_task':
      return isAlias(op.taskId) ? [op.taskId] : [];
    default:
      return [];
  }
}

function rewriteOp(
  op: GraphProposalOp,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
  counters: AliasCounters,
): GraphProposalOp {
  switch (op.kind) {
    case 'add_milestone':
      return {
        ...op,
        milestoneId: allocateMilestoneAlias(op.milestoneId, resolved, counters),
      };
    case 'edit_milestone':
    case 'remove_milestone':
      return {
        ...op,
        milestoneId: resolveMilestoneRef(op.milestoneId, resolved),
      };
    case 'add_feature':
      return {
        ...op,
        featureId: allocateFeatureAlias(op.featureId, resolved, counters),
        milestoneId: resolveMilestoneRef(op.milestoneId, resolved),
      };
    case 'remove_feature':
    case 'edit_feature':
      return { ...op, featureId: resolveFeatureRef(op.featureId, resolved) };
    case 'move_feature':
      return {
        ...op,
        featureId: resolveFeatureRef(op.featureId, resolved),
        milestoneId: resolveMilestoneRef(op.milestoneId, resolved),
      };
    case 'split_feature':
      return rewriteSplitFeatureOp(op, resolved, counters);
    case 'merge_features':
      return {
        ...op,
        featureIds: op.featureIds.map((featureId) =>
          resolveFeatureRef(featureId, resolved),
        ),
      };
    case 'add_task':
      return {
        ...op,
        taskId: allocateTaskAlias(op.taskId, resolved, counters),
        featureId: resolveFeatureRef(op.featureId, resolved),
      };
    case 'remove_task':
    case 'edit_task':
      return { ...op, taskId: resolveTaskRef(op.taskId, resolved) };
    case 'reorder_tasks':
      return {
        ...op,
        featureId: resolveFeatureRef(op.featureId, resolved),
        taskIds: op.taskIds.map((taskId) => resolveTaskRef(taskId, resolved)),
      };
    case 'add_dependency':
    case 'remove_dependency':
      return {
        ...op,
        fromId: resolveEndpointRef(op.fromId, resolved),
        toId: resolveEndpointRef(op.toId, resolved),
      };
  }
}

function rewriteSplitFeatureOp(
  op: SplitFeatureProposalOp,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
  counters: AliasCounters,
): SplitFeatureProposalOp {
  for (const split of op.splits) {
    allocateFeatureAlias(split.id, resolved, counters);
  }

  return {
    ...op,
    featureId: resolveFeatureRef(op.featureId, resolved),
    splits: op.splits.map((split) => ({
      ...split,
      id: resolveFeatureRef(split.id, resolved),
      ...(split.deps !== undefined
        ? { deps: split.deps.map((dep) => resolveFeatureRef(dep, resolved)) }
        : {}),
    })),
  };
}

function allocateMilestoneAlias(
  id: MilestoneId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
  counters: AliasCounters,
): MilestoneId {
  if (!isAlias(id)) {
    return id as MilestoneId;
  }
  counters.m += 1;
  const concrete: MilestoneId = `m-${counters.m}`;
  resolved[id] = concrete;
  return concrete;
}

function allocateFeatureAlias(
  id: FeatureId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
  counters: AliasCounters,
): FeatureId {
  if (!isAlias(id)) {
    return id as FeatureId;
  }
  counters.f += 1;
  const concrete: FeatureId = `f-${counters.f}`;
  resolved[id] = concrete;
  return concrete;
}

function allocateTaskAlias(
  id: TaskId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
  counters: AliasCounters,
): TaskId {
  if (!isAlias(id)) {
    return id as TaskId;
  }
  counters.t += 1;
  const concrete: TaskId = `t-${counters.t}`;
  resolved[id] = concrete;
  return concrete;
}

function resolveMilestoneRef(
  id: MilestoneId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
): MilestoneId {
  if (isAlias(id)) {
    const hit = resolved[id];
    return hit === undefined ? (id as MilestoneId) : (hit as MilestoneId);
  }
  return id as MilestoneId;
}

function resolveFeatureRef(
  id: FeatureId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
): FeatureId {
  if (isAlias(id)) {
    const hit = resolved[id];
    return hit === undefined ? (id as FeatureId) : (hit as FeatureId);
  }
  return id as FeatureId;
}

function resolveTaskRef(
  id: TaskId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
): TaskId {
  if (isAlias(id)) {
    const hit = resolved[id];
    return hit === undefined ? (id as TaskId) : (hit as TaskId);
  }
  return id as TaskId;
}

function resolveEndpointRef(
  id: FeatureId | TaskId | string,
  resolved: Record<ProposalAlias, MilestoneId | FeatureId | TaskId>,
): FeatureId | TaskId {
  if (isAlias(id)) {
    const hit = resolved[id];
    return hit === undefined
      ? (id as FeatureId | TaskId)
      : (hit as FeatureId | TaskId);
  }
  return id as FeatureId | TaskId;
}

function isAlias(value: string): value is ProposalAlias {
  return value.startsWith('#');
}

function maxNumericSuffix(keys: Iterable<string>): number {
  let max = 0;
  for (const key of keys) {
    const idx = key.indexOf('-');
    if (idx < 0) {
      continue;
    }
    const numeric = Number.parseInt(key.slice(idx + 1), 10);
    if (!Number.isNaN(numeric) && numeric > max) {
      max = numeric;
    }
  }
  return max;
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
    case 'edit_milestone':
      graph.editMilestone(op.milestoneId, op.patch);
      return;
    case 'remove_milestone':
      graph.removeMilestone(op.milestoneId);
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
    case 'move_feature':
      graph.changeMilestone(op.featureId, op.milestoneId);
      return;
    case 'split_feature':
      graph.splitFeature(op.featureId, op.splits);
      return;
    case 'merge_features':
      graph.mergeFeatures(op.featureIds, op.name);
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
        ...(op.objective !== undefined ? { objective: op.objective } : {}),
        ...(op.scope !== undefined ? { scope: op.scope } : {}),
        ...(op.expectedFiles !== undefined
          ? { expectedFiles: op.expectedFiles }
          : {}),
        ...(op.references !== undefined ? { references: op.references } : {}),
        ...(op.outcomeVerification !== undefined
          ? { outcomeVerification: op.outcomeVerification }
          : {}),
      });
      return;
    case 'remove_task':
      graph.removeTask(op.taskId);
      return;
    case 'edit_task':
      graph.editTask(op.taskId, op.patch);
      return;
    case 'reorder_tasks':
      graph.reorderTasks(op.featureId, op.taskIds);
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
  options: ProposalApplyOptions = {},
): string | undefined {
  if (options.additiveOnly) {
    const additiveOnlyReason = additiveOnlyReasonForOp(graph, op, options);
    if (additiveOnlyReason !== undefined) {
      return additiveOnlyReason;
    }
  }

  switch (op.kind) {
    case 'add_milestone':
      return graph.milestones.has(op.milestoneId)
        ? `Milestone "${op.milestoneId}" already exists`
        : undefined;
    case 'edit_milestone':
      return graph.milestones.has(op.milestoneId)
        ? undefined
        : `Milestone "${op.milestoneId}" does not exist`;
    case 'remove_milestone': {
      const milestone = graph.milestones.get(op.milestoneId);
      if (milestone === undefined) {
        return `Milestone "${op.milestoneId}" does not exist`;
      }
      const featureIds = [...graph.features.values()]
        .filter((feature) => feature.milestoneId === op.milestoneId)
        .map((feature) => feature.id);
      return featureIds.length === 0
        ? undefined
        : `Milestone "${op.milestoneId}" still has features: ${featureIds.join(', ')}`;
    }
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
        return startedFeatureMessage(op.featureId);
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
    case 'move_feature': {
      const feature = graph.features.get(op.featureId);
      if (feature === undefined) {
        return `Feature "${op.featureId}" does not exist`;
      }
      if (!graph.milestones.has(op.milestoneId)) {
        return `Milestone "${op.milestoneId}" does not exist`;
      }
      return feature.milestoneId === op.milestoneId
        ? `Feature "${op.featureId}" already belongs to milestone "${op.milestoneId}"`
        : undefined;
    }
    case 'split_feature':
      return graph.features.has(op.featureId)
        ? undefined
        : `Feature "${op.featureId}" does not exist`;
    case 'merge_features': {
      if (op.featureIds.length < 2) {
        return 'mergeFeatures requires at least two feature ids';
      }
      const uniqueFeatureIds = new Set(op.featureIds);
      if (uniqueFeatureIds.size !== op.featureIds.length) {
        return 'mergeFeatures requires unique feature ids';
      }
      for (const featureId of op.featureIds) {
        if (!graph.features.has(featureId)) {
          return `Feature "${featureId}" does not exist`;
        }
      }
      return undefined;
    }
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
      return taskIsRemovable(task)
        ? undefined
        : `Task "${op.taskId}" cannot be removed while status="${task.status}"; cancel the task first`;
    }
    case 'edit_task':
      return graph.tasks.has(op.taskId)
        ? undefined
        : `Task "${op.taskId}" does not exist`;
    case 'reorder_tasks': {
      if (!graph.features.has(op.featureId)) {
        return `Feature "${op.featureId}" does not exist`;
      }
      for (const taskId of op.taskIds) {
        const task = graph.tasks.get(taskId);
        if (task === undefined) {
          return `Task "${taskId}" does not exist`;
        }
        if (task.featureId !== op.featureId) {
          return `Task "${taskId}" does not belong to feature "${op.featureId}"`;
        }
      }
      return undefined;
    }
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

function taskIsRemovable(task: Task): boolean {
  return task.status === 'pending' || task.status === 'cancelled';
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

function milestoneHasLiveWork(
  graph: FeatureGraph,
  milestoneId: MilestoneId,
): boolean {
  const milestone = graph.milestones.get(milestoneId);
  if (milestone === undefined) {
    return false;
  }
  if (milestone.status !== 'pending') {
    return true;
  }
  return [...graph.features.values()].some(
    (feature) =>
      feature.milestoneId === milestoneId && featureHasLiveWork(graph, feature),
  );
}

function featureHasLiveWork(graph: FeatureGraph, feature: Feature): boolean {
  return (
    feature.status === 'in_progress' ||
    feature.status === 'done' ||
    feature.workControl === 'executing' ||
    feature.workControl === 'ci_check' ||
    feature.workControl === 'verifying' ||
    feature.workControl === 'awaiting_merge' ||
    feature.workControl === 'summarizing' ||
    feature.workControl === 'executing_repair' ||
    feature.workControl === 'replanning' ||
    feature.workControl === 'work_complete' ||
    feature.collabControl !== 'none' ||
    [...graph.tasks.values()].some(
      (task) => task.featureId === feature.id && taskHasLiveWork(task),
    )
  );
}

function taskHasLiveWork(task: Task): boolean {
  return (
    task.status !== 'pending' ||
    task.collabControl !== 'none' ||
    task.result !== undefined
  );
}

function startedFeatureMessage(featureId: FeatureId): string {
  return `Feature "${featureId}" already has started work`;
}

function hasPlannerCollisionFeature(
  featureId: FeatureId,
  options: ProposalApplyOptions,
): boolean {
  return options.plannerCollisionFeatureIds?.includes(featureId) ?? false;
}

function taskHasPlannerOnlyLiveWork(task: Task): boolean {
  return (
    task.result === undefined &&
    ((task.status === 'pending' && task.collabControl === 'none') ||
      (task.status === 'stuck' && task.collabControl === 'branch_open'))
  );
}

function featureHasPlannerOnlyLiveWork(
  graph: FeatureGraph,
  feature: Feature,
  options: ProposalApplyOptions,
): boolean {
  if (!hasPlannerCollisionFeature(feature.id, options)) {
    return false;
  }
  if (
    feature.workControl !== 'planning' &&
    feature.workControl !== 'replanning'
  ) {
    return false;
  }
  if (
    feature.collabControl !== 'none' &&
    feature.collabControl !== 'branch_open'
  ) {
    return false;
  }

  return [...graph.tasks.values()]
    .filter((task) => task.featureId === feature.id)
    .every(
      (task) => !taskHasLiveWork(task) || taskHasPlannerOnlyLiveWork(task),
    );
}

function taskHasCollisionSafePlannerState(
  graph: FeatureGraph,
  task: Task,
  options: ProposalApplyOptions,
): boolean {
  if (!taskHasPlannerOnlyLiveWork(task)) {
    return false;
  }
  const feature = graph.features.get(task.featureId);
  return (
    feature !== undefined &&
    featureHasPlannerOnlyLiveWork(graph, feature, options)
  );
}

function additiveOnlyBlocksFeature(
  graph: FeatureGraph,
  feature: Feature,
  options: ProposalApplyOptions,
): boolean {
  return (
    featureHasLiveWork(graph, feature) &&
    !featureHasPlannerOnlyLiveWork(graph, feature, options)
  );
}

function additiveOnlyBlocksTask(
  graph: FeatureGraph,
  task: Task,
  options: ProposalApplyOptions,
): boolean {
  return (
    taskHasLiveWork(task) &&
    !taskHasCollisionSafePlannerState(graph, task, options)
  );
}

function collectAdditiveOnlyWarnings(
  graph: FeatureGraph,
  op: GraphProposalOp,
  opIndex: number,
  options: ProposalApplyOptions,
): ProposalWarning[] {
  switch (op.kind) {
    case 'edit_milestone':
      return milestoneHasLiveWork(graph, op.milestoneId)
        ? [
            {
              code: 'edit_started_milestone',
              opIndex,
              entityId: op.milestoneId,
              message: `Milestone "${op.milestoneId}" already has started work`,
            },
          ]
        : [];
    case 'remove_milestone':
      return milestoneHasLiveWork(graph, op.milestoneId)
        ? [
            {
              code: 'remove_started_milestone',
              opIndex,
              entityId: op.milestoneId,
              message: `Milestone "${op.milestoneId}" already has started work`,
            },
          ]
        : [];
    case 'edit_feature': {
      const feature = graph.features.get(op.featureId);
      return feature !== undefined &&
        additiveOnlyBlocksFeature(graph, feature, options)
        ? [
            {
              code: 'edit_started_feature',
              opIndex,
              entityId: feature.id,
              message: startedFeatureMessage(feature.id),
            },
          ]
        : [];
    }
    case 'move_feature': {
      const feature = graph.features.get(op.featureId);
      return feature !== undefined &&
        additiveOnlyBlocksFeature(graph, feature, options)
        ? [
            {
              code: 'move_started_feature',
              opIndex,
              entityId: feature.id,
              message: startedFeatureMessage(feature.id),
            },
          ]
        : [];
    }
    case 'split_feature': {
      const feature = graph.features.get(op.featureId);
      return feature !== undefined &&
        additiveOnlyBlocksFeature(graph, feature, options)
        ? [
            {
              code: 'split_started_feature',
              opIndex,
              entityId: feature.id,
              message: startedFeatureMessage(feature.id),
            },
          ]
        : [];
    }
    case 'merge_features': {
      const liveFeatures = op.featureIds.filter((featureId) => {
        const feature = graph.features.get(featureId);
        return (
          feature !== undefined &&
          additiveOnlyBlocksFeature(graph, feature, options)
        );
      });
      return liveFeatures.map((featureId) => ({
        code: 'merge_started_feature' as const,
        opIndex,
        entityId: featureId,
        message: startedFeatureMessage(featureId),
      }));
    }
    case 'edit_task': {
      const task = graph.tasks.get(op.taskId);
      return task !== undefined && additiveOnlyBlocksTask(graph, task, options)
        ? [
            {
              code: 'edit_started_task',
              opIndex,
              entityId: task.id,
              message: `Task "${task.id}" already has started work`,
            },
          ]
        : [];
    }
    case 'reorder_tasks':
      return op.taskIds
        .map((taskId) => graph.tasks.get(taskId))
        .filter(
          (task): task is Task =>
            task !== undefined && additiveOnlyBlocksTask(graph, task, options),
        )
        .map((task) => ({
          code: 'reorder_started_task' as const,
          opIndex,
          entityId: task.id,
          message: `Task "${task.id}" already has started work`,
        }));
    case 'add_dependency':
    case 'remove_dependency': {
      const endpointWarnings: ProposalWarning[] = [];
      const featureEndpoint =
        isFeatureId(op.fromId) && isFeatureId(op.toId)
          ? [graph.features.get(op.fromId), graph.features.get(op.toId)]
          : [];
      for (const feature of featureEndpoint) {
        if (
          feature !== undefined &&
          additiveOnlyBlocksFeature(graph, feature, options)
        ) {
          endpointWarnings.push({
            code:
              op.kind === 'add_dependency'
                ? 'add_dependency_started_work'
                : 'remove_dependency_started_work',
            opIndex,
            entityId: feature.id,
            message: startedFeatureMessage(feature.id),
          });
        }
      }
      if (endpointWarnings.length > 0) {
        return endpointWarnings;
      }
      const taskEndpoint =
        !isFeatureId(op.fromId) && !isFeatureId(op.toId)
          ? [graph.tasks.get(op.fromId), graph.tasks.get(op.toId)]
          : [];
      return taskEndpoint
        .filter(
          (task): task is Task =>
            task !== undefined && additiveOnlyBlocksTask(graph, task, options),
        )
        .map((task) => ({
          code:
            op.kind === 'add_dependency'
              ? 'add_dependency_started_work'
              : 'remove_dependency_started_work',
          opIndex,
          entityId: task.id,
          message: `Task "${task.id}" already has started work`,
        }));
    }
    default:
      return [];
  }
}

function additiveOnlyReasonForOp(
  graph: FeatureGraph,
  op: GraphProposalOp,
  options: ProposalApplyOptions,
): string | undefined {
  switch (op.kind) {
    case 'edit_milestone':
    case 'remove_milestone':
      return milestoneHasLiveWork(graph, op.milestoneId)
        ? `Milestone "${op.milestoneId}" already has started work`
        : undefined;
    case 'edit_feature':
    case 'move_feature':
    case 'split_feature': {
      const feature = graph.features.get(op.featureId);
      return feature !== undefined &&
        additiveOnlyBlocksFeature(graph, feature, options)
        ? startedFeatureMessage(feature.id)
        : undefined;
    }
    case 'merge_features': {
      const featureId = op.featureIds.find((candidate) => {
        const feature = graph.features.get(candidate);
        return (
          feature !== undefined &&
          additiveOnlyBlocksFeature(graph, feature, options)
        );
      });
      return featureId === undefined
        ? undefined
        : startedFeatureMessage(featureId);
    }
    case 'edit_task': {
      const task = graph.tasks.get(op.taskId);
      return task !== undefined && additiveOnlyBlocksTask(graph, task, options)
        ? `Task "${task.id}" already has started work`
        : undefined;
    }
    case 'reorder_tasks': {
      const taskId = op.taskIds.find((candidate) => {
        const task = graph.tasks.get(candidate);
        return (
          task !== undefined && additiveOnlyBlocksTask(graph, task, options)
        );
      });
      return taskId === undefined
        ? undefined
        : `Task "${taskId}" already has started work`;
    }
    case 'add_dependency':
    case 'remove_dependency': {
      if (isFeatureId(op.fromId) && isFeatureId(op.toId)) {
        for (const featureId of [op.fromId, op.toId]) {
          const feature = graph.features.get(featureId);
          if (
            feature !== undefined &&
            additiveOnlyBlocksFeature(graph, feature, options)
          ) {
            return startedFeatureMessage(feature.id);
          }
        }
        return undefined;
      }
      for (const taskId of [op.fromId as TaskId, op.toId as TaskId]) {
        const task = graph.tasks.get(taskId);
        if (
          task !== undefined &&
          additiveOnlyBlocksTask(graph, task, options)
        ) {
          return `Task "${task.id}" already has started work`;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
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
    case 'edit_milestone':
      return (
        typeof value.milestoneId === 'string' &&
        isRecord(value.patch) &&
        milestonePatchIsValid(value.patch)
      );
    case 'remove_milestone':
      return typeof value.milestoneId === 'string';
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
    case 'move_feature':
      return (
        typeof value.featureId === 'string' &&
        typeof value.milestoneId === 'string'
      );
    case 'split_feature':
      return (
        typeof value.featureId === 'string' &&
        Array.isArray(value.splits) &&
        value.splits.every((split) => isSplitSpec(split))
      );
    case 'merge_features':
      return (
        Array.isArray(value.featureIds) &&
        value.featureIds.length >= 2 &&
        value.featureIds.every((featureId) => typeof featureId === 'string') &&
        typeof value.name === 'string'
      );
    case 'add_task':
      return (
        typeof value.taskId === 'string' &&
        typeof value.featureId === 'string' &&
        typeof value.description === 'string' &&
        (value.weight === undefined || isTaskWeight(value.weight)) &&
        stringArrayOrUndefined(value.reservedWritePaths) &&
        (value.objective === undefined ||
          typeof value.objective === 'string') &&
        (value.scope === undefined || typeof value.scope === 'string') &&
        stringArrayOrUndefined(value.expectedFiles) &&
        stringArrayOrUndefined(value.references) &&
        (value.outcomeVerification === undefined ||
          typeof value.outcomeVerification === 'string')
      );
    case 'remove_task':
      return typeof value.taskId === 'string';
    case 'edit_task':
      return (
        typeof value.taskId === 'string' &&
        isRecord(value.patch) &&
        taskPatchIsValid(value.patch)
      );
    case 'reorder_tasks':
      return (
        typeof value.featureId === 'string' &&
        Array.isArray(value.taskIds) &&
        value.taskIds.length > 0 &&
        value.taskIds.every((taskId) => typeof taskId === 'string')
      );
    case 'add_dependency':
    case 'remove_dependency':
      return typeof value.fromId === 'string' && typeof value.toId === 'string';
    default:
      return false;
  }
}

const ALLOWED_MILESTONE_PATCH_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
]);

const ALLOWED_FEATURE_PATCH_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'summary',
  'roughDraft',
  'featureObjective',
  'featureDoD',
]);

function milestonePatchIsValid(patch: Record<string, unknown>): boolean {
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_MILESTONE_PATCH_KEYS.has(key)) {
      return false;
    }
  }
  return (
    (patch.name === undefined || typeof patch.name === 'string') &&
    (patch.description === undefined || typeof patch.description === 'string')
  );
}

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
    (patch.summary === undefined || typeof patch.summary === 'string') &&
    (patch.roughDraft === undefined || typeof patch.roughDraft === 'string') &&
    (patch.featureObjective === undefined ||
      typeof patch.featureObjective === 'string') &&
    stringArrayOrUndefined(patch.featureDoD)
  );
}

function taskPatchIsValid(patch: Record<string, unknown>): boolean {
  return (
    (patch.description === undefined ||
      typeof patch.description === 'string') &&
    (patch.weight === undefined || isTaskWeight(patch.weight)) &&
    stringArrayOrUndefined(patch.reservedWritePaths) &&
    (patch.objective === undefined || typeof patch.objective === 'string') &&
    (patch.scope === undefined || typeof patch.scope === 'string') &&
    stringArrayOrUndefined(patch.expectedFiles) &&
    stringArrayOrUndefined(patch.references) &&
    (patch.outcomeVerification === undefined ||
      typeof patch.outcomeVerification === 'string')
  );
}

function isSplitSpec(value: unknown): value is SplitSpec {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    stringArrayOrUndefined(value.deps)
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
