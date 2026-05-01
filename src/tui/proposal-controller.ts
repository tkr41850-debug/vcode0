import {
  createPlannerToolset,
  createProposalToolHost,
  type DependencyOptions,
  type GraphProposalToolHost,
  type PlannerToolArgsMap,
  type PlannerToolDefinition,
  type PlannerToolName,
  type PlannerToolResult,
} from '@agents/tools';
import {
  type GraphSnapshot,
  InMemoryFeatureGraph,
  type SplitSpec,
} from '@core/graph/index';
import type { GraphProposalMode } from '@core/proposals/index';
import type {
  Feature,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  ProposalPhaseDetails,
  TaskId,
  TopPlannerAgentRun,
} from '@core/types/index';
import {
  type ComposerSelection,
  isTaskWeight,
  type ParsedSlashCommand,
  parseSlashCommand,
} from '@tui/commands/index';

export interface ComposerProposalEnvironment {
  snapshot(this: void): GraphSnapshot;
  isAutoExecutionEnabled(this: void): boolean;
  setAutoExecutionEnabled(this: void, enabled: boolean): boolean;
  getFeatureRun(
    this: void,
    featureId: FeatureId,
    phase: GraphProposalMode,
  ): FeaturePhaseAgentRun | undefined;
  getTopPlannerRun(this: void): TopPlannerAgentRun | undefined;
  saveFeatureRun(this: void, run: FeaturePhaseAgentRun): void;
  enqueueApprovalDecision(
    this: void,
    event: {
      featureId: FeatureId;
      phase: GraphProposalMode;
      decision: 'approved' | 'rejected';
      comment?: string;
    },
  ): void;
  enqueueTopPlannerApprovalDecision(
    this: void,
    event: { decision: 'approved' | 'rejected'; comment?: string },
  ): void;
  enqueueRerun(
    this: void,
    event: { featureId: FeatureId; phase: GraphProposalMode },
  ): void;
  enqueueTopPlannerRerun(
    this: void,
    event?: { reason?: string; sessionMode?: 'continue' | 'fresh' },
  ): void;
  requestTopPlannerRerunSelection?(this: void): boolean;
}

export interface ComposerCommandResult {
  message: string;
}

export interface ComposerDraftState {
  featureId: FeatureId;
  phase: GraphProposalMode;
  commandCount: number;
}

interface ActiveDraft {
  featureId: FeatureId;
  phase: GraphProposalMode;
  host: GraphProposalToolHost;
  toolByName: Map<PlannerToolName, PlannerToolDefinition>;
  previousAutoExecutionEnabled: boolean;
  commandCount: number;
}

interface PendingFeatureProposalRun extends FeaturePhaseAgentRun {
  phase: GraphProposalMode;
  runStatus: 'await_approval';
}

interface PendingTopPlannerProposalRun extends TopPlannerAgentRun {
  phase: 'plan';
  runStatus: 'await_approval';
}

type PendingProposalRun =
  | PendingFeatureProposalRun
  | PendingTopPlannerProposalRun;

const TUI_SUBMIT_DETAILS: ProposalPhaseDetails = {
  summary: 'Submitted from TUI draft.',
  chosenApproach: 'Use current TUI draft proposal as approval payload.',
  keyConstraints: [
    'TUI submit does not capture structured planner rationale yet',
  ],
  decompositionRationale: ['Preserve current TUI approval workflow'],
  orderingRationale: [
    'Allow approval flow without blocking on richer TUI inputs',
  ],
  verificationExpectations: ['Review proposal before approval'],
  risksTradeoffs: ['Less planning context than agent-generated proposals'],
  assumptions: ['Reviewer will inspect proposal diff directly'],
};

export class ComposerProposalController {
  private draft: ActiveDraft | undefined;

  constructor(private readonly env: ComposerProposalEnvironment) {}

  getDraftSnapshot(): GraphSnapshot | undefined {
    return this.draft?.host.draft.snapshot();
  }

  getDraftState(): ComposerDraftState | undefined {
    const draft = this.draft;
    if (draft === undefined) {
      return undefined;
    }
    return {
      featureId: draft.featureId,
      phase: draft.phase,
      commandCount: draft.commandCount,
    };
  }

  async execute(
    input: string,
    selection: ComposerSelection = {},
  ): Promise<ComposerCommandResult> {
    const parsed = parseSlashCommand(input);

    switch (parsed.name) {
      case 'milestone-add': {
        const draft = this.requireDraft(selection, true);
        const milestone = await this.executePlannerTool(draft, 'addMilestone', {
          name: readStringArg(parsed, 'name'),
          description: readStringArg(parsed, 'description'),
        });
        return { message: `Added milestone ${milestone.id}.` };
      }
      case 'feature-add': {
        const draft = this.requireDraft(selection, true);
        const feature = await this.executePlannerTool(draft, 'addFeature', {
          milestoneId: readMilestoneId(parsed, selection),
          name: readStringArg(parsed, 'name'),
          description: readStringArg(parsed, 'description'),
        });
        return { message: `Added feature ${feature.id}.` };
      }
      case 'feature-remove': {
        const draft = this.requireDraft(selection, true);
        await this.executePlannerTool(draft, 'removeFeature', {
          featureId: readFeatureId(parsed, selection),
        });
        return { message: 'Removed feature from draft.' };
      }
      case 'feature-edit': {
        const draft = this.requireDraft(selection, true);
        const patch = buildFeaturePatch(parsed);
        const feature = await this.executePlannerTool(draft, 'editFeature', {
          featureId: readFeatureId(parsed, selection),
          patch,
        });
        return { message: `Updated feature ${feature.id}.` };
      }
      case 'feature-move': {
        const draft = this.requireDraft(selection, true);
        const feature = await this.executePlannerTool(draft, 'moveFeature', {
          featureId: readFeatureId(parsed, selection),
          milestoneId: readMilestoneId(parsed, selection),
        });
        return {
          message: `Moved feature ${feature.id} to milestone ${feature.milestoneId}.`,
        };
      }
      case 'feature-split': {
        const draft = this.requireDraft(selection, true);
        const featureId = readFeatureId(parsed, selection);
        const features = await this.executePlannerTool(draft, 'splitFeature', {
          featureId,
          splits: buildSplitSpecs(draft, parsed),
        });
        return {
          message: `Split feature ${featureId} into ${features.length} features.`,
        };
      }
      case 'feature-merge': {
        const draft = this.requireDraft(selection, true);
        const feature = await this.executePlannerTool(draft, 'mergeFeatures', {
          featureIds: readMergeFeatureIds(parsed),
          name: readStringArg(parsed, 'name'),
        });
        return { message: `Merged features into ${feature.id}.` };
      }
      case 'task-add': {
        const draft = this.requireDraft(selection, true);
        const task = await this.executePlannerTool(draft, 'addTask', {
          featureId: readFeatureId(parsed, selection),
          description: readStringArg(parsed, 'description'),
          ...readOptionalWeight(parsed),
        });
        return { message: `Added task ${task.id}.` };
      }
      case 'task-remove': {
        const draft = this.requireDraft(selection, true);
        await this.executePlannerTool(draft, 'removeTask', {
          taskId: readTaskId(parsed, selection),
        });
        return { message: 'Removed task from draft.' };
      }
      case 'task-edit': {
        const draft = this.requireDraft(selection, true);
        const patch = buildTaskPatch(parsed);
        const task = await this.executePlannerTool(draft, 'editTask', {
          taskId: readTaskId(parsed, selection),
          patch,
        });
        return { message: `Updated task ${task.id}.` };
      }
      case 'task-reorder': {
        const draft = this.requireDraft(selection, true);
        const featureId = readFeatureId(parsed, selection);
        const tasks = await this.executePlannerTool(draft, 'reorderTasks', {
          featureId,
          taskIds: readTaskReorderIds(draft, parsed, featureId),
        });
        return {
          message: `Reordered ${tasks.length} tasks in feature ${featureId}.`,
        };
      }
      case 'dep-add': {
        const draft = this.requireDraft(selection, true);
        await this.executePlannerTool(
          draft,
          'addDependency',
          readDependencyOptions(parsed),
        );
        return { message: 'Added dependency to draft.' };
      }
      case 'dep-remove': {
        const draft = this.requireDraft(selection, true);
        await this.executePlannerTool(
          draft,
          'removeDependency',
          readDependencyOptions(parsed),
        );
        return { message: 'Removed dependency from draft.' };
      }
      case 'submit':
        return this.submitDraft();
      case 'discard':
        return this.discardDraft();
      case 'approve':
        return this.approvePending(selection);
      case 'reject':
        return this.rejectPending(parsed, selection);
      case 'rerun':
        return this.rerunPending(selection);
      default:
        throw new Error(`unsupported planner command "${parsed.name}"`);
    }
  }

  private requireDraft(
    selection: ComposerSelection,
    pauseAutoExecution: boolean,
  ): ActiveDraft {
    if (this.draft !== undefined) {
      return this.draft;
    }

    const featureId = selection.featureId;
    if (featureId === undefined) {
      throw new Error('select planning or replanning feature first');
    }

    const feature = this.env
      .snapshot()
      .features.find((entry) => entry.id === featureId);
    if (feature === undefined) {
      throw new Error(`feature "${featureId}" does not exist`);
    }

    const phase = phaseForFeature(feature);
    const previousAutoExecutionEnabled = this.env.isAutoExecutionEnabled();
    if (pauseAutoExecution) {
      this.env.setAutoExecutionEnabled(false);
    }

    const host = createProposalToolHost(
      buildGraphFromSnapshot(this.env.snapshot()),
      phase,
    );
    const toolset = createPlannerToolset(host);
    this.draft = {
      featureId,
      phase,
      host,
      toolByName: new Map(toolset.tools.map((tool) => [tool.name, tool])),
      previousAutoExecutionEnabled,
      commandCount: 0,
    };
    return this.draft;
  }

  private async executePlannerTool<Name extends PlannerToolName>(
    draft: ActiveDraft,
    name: Name,
    args: PlannerToolArgsMap[Name],
  ): Promise<PlannerToolResult<Name>> {
    const tool = draft.toolByName.get(name) as
      | PlannerToolDefinition<Name>
      | undefined;
    if (tool === undefined) {
      throw new Error(`planner tool "${name}" missing`);
    }
    const result = await tool.execute(args);
    draft.commandCount += 1;
    return result;
  }

  private submitDraft(): ComposerCommandResult {
    const draft = this.draft;
    if (draft === undefined) {
      throw new Error('no active draft to submit');
    }

    draft.host.submit(TUI_SUBMIT_DETAILS);
    const proposal = draft.host.buildProposal();
    const run: FeaturePhaseAgentRun = {
      id: `run-feature:${draft.featureId}:${draft.phase}`,
      scopeType: 'feature_phase',
      scopeId: draft.featureId,
      phase: draft.phase,
      runStatus: 'await_approval',
      owner: 'manual',
      attention: 'none',
      payloadJson: JSON.stringify(proposal),
      restartCount: 0,
      maxRetries: 3,
    };
    this.env.saveFeatureRun(run);
    this.env.setAutoExecutionEnabled(draft.previousAutoExecutionEnabled);
    this.draft = undefined;
    return {
      message: `Submitted proposal for ${run.scopeId}.`,
    };
  }

  private discardDraft(): ComposerCommandResult {
    const draft = this.draft;
    if (draft === undefined) {
      throw new Error('no active draft to discard');
    }

    this.env.setAutoExecutionEnabled(draft.previousAutoExecutionEnabled);
    this.draft = undefined;
    return { message: 'Discarded draft proposal.' };
  }

  private approvePending(selection: ComposerSelection): ComposerCommandResult {
    const pending = this.requirePendingRun(selection);
    if (pending.scopeType === 'feature_phase') {
      this.env.enqueueApprovalDecision({
        featureId: pending.scopeId,
        phase: pending.phase,
        decision: 'approved',
      });
    } else {
      this.env.enqueueTopPlannerApprovalDecision({ decision: 'approved' });
    }
    return { message: `Approved proposal for ${pending.scopeId}.` };
  }

  private rejectPending(
    parsed: ParsedSlashCommand,
    selection: ComposerSelection,
  ): ComposerCommandResult {
    const pending = this.requirePendingRun(selection);
    const comment = readOptionalStringArg(parsed, 'comment');
    if (pending.scopeType === 'feature_phase') {
      this.env.enqueueApprovalDecision({
        featureId: pending.scopeId,
        phase: pending.phase,
        decision: 'rejected',
        ...(comment !== undefined ? { comment } : {}),
      });
    } else {
      this.env.enqueueTopPlannerApprovalDecision({
        decision: 'rejected',
        ...(comment !== undefined ? { comment } : {}),
      });
    }
    return { message: `Rejected proposal for ${pending.scopeId}.` };
  }

  private rerunPending(selection: ComposerSelection): ComposerCommandResult {
    const pending = this.requirePendingRun(selection);
    if (pending.scopeType === 'feature_phase') {
      this.env.enqueueRerun({
        featureId: pending.scopeId,
        phase: pending.phase,
      });
      return { message: `Requested rerun for ${pending.scopeId}.` };
    }

    if (this.env.requestTopPlannerRerunSelection?.() === true) {
      return { message: 'Choose continue or fresh for top-planner rerun.' };
    }

    this.env.enqueueTopPlannerRerun();
    return { message: `Requested rerun for ${pending.scopeId}.` };
  }

  private requirePendingRun(selection: ComposerSelection): PendingProposalRun {
    const snapshot = this.env.snapshot();
    const featureId = selection.featureId;
    let selectedFeatureError: string | undefined;

    if (featureId !== undefined) {
      const feature = snapshot.features.find((entry) => entry.id === featureId);
      if (feature === undefined) {
        throw new Error(`feature "${featureId}" does not exist`);
      }

      const phase = phaseForFeatureIfPending(feature);
      if (phase !== undefined) {
        const run = this.env.getFeatureRun(featureId, phase);
        if (isPendingFeatureProposalRun(run)) {
          return run;
        }
        selectedFeatureError = `feature "${featureId}" has no pending proposal`;
      } else {
        selectedFeatureError = `feature "${featureId}" is not in planning or replanning`;
      }
    }

    const topPlannerRun = this.env.getTopPlannerRun();
    if (isPendingTopPlannerProposalRun(topPlannerRun)) {
      return topPlannerRun;
    }

    if (selectedFeatureError !== undefined) {
      throw new Error(selectedFeatureError);
    }
    throw new Error('select feature with pending proposal first');
  }
}

function buildGraphFromSnapshot(snapshot: GraphSnapshot): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph(snapshot);
}

function phaseForFeature(feature: Feature): GraphProposalMode {
  const phase = phaseForFeatureIfPending(feature);
  if (phase !== undefined) {
    return phase;
  }
  throw new Error(`feature "${feature.id}" is not in planning or replanning`);
}

function phaseForFeatureIfPending(
  feature: Feature,
): GraphProposalMode | undefined {
  switch (feature.workControl) {
    case 'planning':
      return 'plan';
    case 'replanning':
      return 'replan';
    default:
      return undefined;
  }
}

function isProposalRunPhase(
  phase: FeaturePhaseAgentRun['phase'],
): phase is GraphProposalMode {
  return phase === 'plan' || phase === 'replan';
}

function isPendingFeatureProposalRun(
  run: FeaturePhaseAgentRun | undefined,
): run is PendingFeatureProposalRun {
  return (
    run !== undefined &&
    run.runStatus === 'await_approval' &&
    isProposalRunPhase(run.phase)
  );
}

function isPendingTopPlannerProposalRun(
  run: TopPlannerAgentRun | undefined,
): run is PendingTopPlannerProposalRun {
  return (
    run !== undefined &&
    run.runStatus === 'await_approval' &&
    run.phase === 'plan'
  );
}

function readStringArg(parsed: ParsedSlashCommand, key: string): string {
  const value = parsed.args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function readOptionalStringArg(
  parsed: ParsedSlashCommand,
  key: string,
): string | undefined {
  const value = parsed.args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFeatureId(
  parsed: ParsedSlashCommand,
  selection: ComposerSelection,
): FeatureId {
  const value = parsed.args.feature;
  if (typeof value === 'string' && value.startsWith('f-')) {
    return value as FeatureId;
  }
  if (selection.featureId !== undefined) {
    return selection.featureId;
  }
  throw new Error('--feature is required');
}

function readTaskId(
  parsed: ParsedSlashCommand,
  selection: ComposerSelection,
): TaskId {
  const value = parsed.args.task;
  if (typeof value === 'string' && value.startsWith('t-')) {
    return value as TaskId;
  }
  if (selection.taskId !== undefined) {
    return selection.taskId;
  }
  throw new Error('--task is required');
}

function readMilestoneId(
  parsed: ParsedSlashCommand,
  selection: ComposerSelection,
): MilestoneId {
  const value = parsed.args.milestone;
  if (typeof value === 'string' && value.startsWith('m-')) {
    return value as MilestoneId;
  }
  if (selection.milestoneId !== undefined) {
    return selection.milestoneId;
  }
  throw new Error('--milestone is required');
}

function readDependencyOptions(parsed: ParsedSlashCommand): DependencyOptions {
  const from = readDependencyArg(parsed, 'from');
  const to = readDependencyArg(parsed, 'to');

  if (from.startsWith('f-') && to.startsWith('f-')) {
    return { from: from as FeatureId, to: to as FeatureId };
  }
  if (from.startsWith('t-') && to.startsWith('t-')) {
    return { from: from as TaskId, to: to as TaskId };
  }

  throw new Error(
    'dependency endpoints must both be features or both be tasks',
  );
}

function readMergeFeatureIds(parsed: ParsedSlashCommand): FeatureId[] {
  const positionals = parsed.positionals ?? [];
  if (positionals.length < 2) {
    throw new Error('feature merge requires at least two feature ids');
  }
  const seen = new Set<string>();
  return positionals.map((value) => {
    if (!value.startsWith('f-')) {
      throw new Error(`feature merge id must start with "f-": "${value}"`);
    }
    if (seen.has(value)) {
      throw new Error(
        `feature merge requires unique feature ids; repeated "${value}"`,
      );
    }
    seen.add(value);
    return value as FeatureId;
  });
}

function buildSplitSpecs(
  draft: ActiveDraft,
  parsed: ParsedSlashCommand,
): SplitSpec[] {
  const rawSpecs = parsed.positionals ?? [];
  if (rawSpecs.length === 0) {
    throw new Error('feature split requires at least one split spec');
  }

  const parsedSpecs = rawSpecs.map(parseSplitSpec);
  const aliasToFeatureId = new Map<string, FeatureId>();
  const nextFeatureIds = allocateNextFeatureIds(draft, parsedSpecs.length);

  for (let index = 0; index < parsedSpecs.length; index += 1) {
    const spec = parsedSpecs[index];
    const nextFeatureId = nextFeatureIds[index];
    if (spec === undefined || nextFeatureId === undefined) {
      continue;
    }
    if (aliasToFeatureId.has(spec.alias)) {
      throw new Error(`duplicate split alias "${spec.alias}"`);
    }
    aliasToFeatureId.set(spec.alias, nextFeatureId);
  }

  return parsedSpecs.map((spec) => ({
    id: aliasToFeatureId.get(spec.alias) as FeatureId,
    name: spec.name,
    description: spec.description,
    ...(spec.deps.length > 0
      ? {
          deps: spec.deps.map((depAlias) => {
            const depFeatureId = aliasToFeatureId.get(depAlias);
            if (depFeatureId === undefined) {
              throw new Error(
                `split spec for alias "${spec.alias}" references unknown alias "${depAlias}"`,
              );
            }
            return depFeatureId;
          }),
        }
      : {}),
  }));
}

function readTaskReorderIds(
  draft: ActiveDraft,
  parsed: ParsedSlashCommand,
  featureId: FeatureId,
): TaskId[] {
  const positionals = parsed.positionals ?? [];
  if (positionals.length === 0) {
    throw new Error('task reorder requires ordered task ids');
  }

  const featureTaskIds = listFeatureTaskIds(draft, featureId);
  if (featureTaskIds.length === 0) {
    throw new Error(`feature "${featureId}" has no tasks to reorder`);
  }
  if (positionals.length !== featureTaskIds.length) {
    throw new Error(
      `task reorder requires all ${featureTaskIds.length} tasks for feature "${featureId}", got ${positionals.length}`,
    );
  }

  const featureTaskIdSet = new Set(featureTaskIds);
  const seen = new Set<string>();
  const taskIds = positionals.map((value) => {
    if (!value.startsWith('t-')) {
      throw new Error(`task reorder id must start with "t-": "${value}"`);
    }
    if (seen.has(value)) {
      throw new Error(`task reorder repeats task "${value}"`);
    }
    if (!featureTaskIdSet.has(value as TaskId)) {
      throw new Error(
        `task "${value}" does not belong to feature "${featureId}"`,
      );
    }
    seen.add(value);
    return value as TaskId;
  });

  for (const taskId of featureTaskIds) {
    if (!seen.has(taskId)) {
      throw new Error(
        `task reorder missing task "${taskId}" for feature "${featureId}"`,
      );
    }
  }

  return taskIds;
}

function readDependencyArg(
  parsed: ParsedSlashCommand,
  key: 'from' | 'to',
): FeatureId | TaskId {
  const value = parsed.args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  if (value.startsWith('f-') || value.startsWith('t-')) {
    return value as FeatureId | TaskId;
  }
  throw new Error(`--${key} must reference feature or task id`);
}

function buildFeaturePatch(parsed: ParsedSlashCommand): {
  name?: string;
  description?: string;
} {
  const patch: { name?: string; description?: string } = {};
  const name = readOptionalStringArg(parsed, 'name');
  const description = readOptionalStringArg(parsed, 'description');
  if (name !== undefined) {
    patch.name = name;
  }
  if (description !== undefined) {
    patch.description = description;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('feature edit requires at least one patch field');
  }
  return patch;
}

function buildTaskPatch(parsed: ParsedSlashCommand): {
  description?: string;
  weight?: 'trivial' | 'small' | 'medium' | 'heavy';
} {
  const patch: {
    description?: string;
    weight?: 'trivial' | 'small' | 'medium' | 'heavy';
  } = {};
  const description = readOptionalStringArg(parsed, 'description');
  const weight = readOptionalStringArg(parsed, 'weight');
  if (description !== undefined) {
    patch.description = description;
  }
  if (weight !== undefined) {
    if (!isTaskWeight(weight)) {
      throw new Error(`invalid task weight "${weight}"`);
    }
    patch.weight = weight;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('task edit requires at least one patch field');
  }
  return patch;
}

interface ParsedSplitSpecInput {
  alias: string;
  name: string;
  description: string;
  deps: string[];
}

function parseSplitSpec(rawSpec: string): ParsedSplitSpecInput {
  const parts = rawSpec.split('|');
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      `invalid split spec "${rawSpec}"; expected <alias>|<name>|<description>[|<dep-alias>,<dep-alias>]`,
    );
  }

  const [alias, name, description, depsText] = parts.map((part) => part.trim());
  if (
    alias === undefined ||
    alias.length === 0 ||
    name === undefined ||
    name.length === 0 ||
    description === undefined ||
    description.length === 0
  ) {
    throw new Error(
      `invalid split spec "${rawSpec}"; alias, name, and description are required`,
    );
  }

  const deps =
    depsText === undefined || depsText.length === 0
      ? []
      : depsText.split(',').map((entry) => entry.trim());
  if (deps.some((dep) => dep.length === 0)) {
    throw new Error(
      `invalid split spec "${rawSpec}"; dependency aliases must be non-empty`,
    );
  }
  if (new Set(deps).size !== deps.length) {
    throw new Error(
      `invalid split spec "${rawSpec}"; dependency aliases must be unique`,
    );
  }

  return { alias, name, description, deps };
}

function allocateNextFeatureIds(
  draft: ActiveDraft,
  count: number,
): FeatureId[] {
  const snapshot = draft.host.draft.snapshot();
  let max = 0;
  for (const feature of snapshot.features) {
    const numeric = Number.parseInt(feature.id.slice(2), 10);
    if (!Number.isNaN(numeric) && numeric > max) {
      max = numeric;
    }
  }
  return Array.from(
    { length: count },
    (_, index) => `f-${max + index + 1}` as FeatureId,
  );
}

function listFeatureTaskIds(
  draft: ActiveDraft,
  featureId: FeatureId,
): TaskId[] {
  return draft.host.draft
    .snapshot()
    .tasks.filter((task) => task.featureId === featureId)
    .sort((left, right) => left.orderInFeature - right.orderInFeature)
    .map((task) => task.id);
}

function readOptionalWeight(parsed: ParsedSlashCommand): {
  weight?: 'trivial' | 'small' | 'medium' | 'heavy';
} {
  const weight = readOptionalStringArg(parsed, 'weight');
  if (weight === undefined) {
    return {};
  }
  if (!isTaskWeight(weight)) {
    throw new Error(`invalid task weight "${weight}"`);
  }
  return { weight };
}
