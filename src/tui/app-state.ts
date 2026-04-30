import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  Feature,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  TaskAgentRun,
} from '@core/types/index';
import type { ComposerSelection } from '@tui/commands/index';
import {
  type DagNodeViewModel,
  flattenDagNodes,
  type TuiViewModelBuilder,
} from '@tui/view-model/index';

export function displayedSnapshot(
  authoritativeSnapshot: GraphSnapshot,
  draftSnapshot: GraphSnapshot | undefined,
  livePlannerSnapshot: GraphSnapshot | undefined,
): GraphSnapshot {
  return draftSnapshot ?? livePlannerSnapshot ?? authoritativeSnapshot;
}

export function buildFlattenedNodes(
  viewModels: TuiViewModelBuilder,
  snapshot: GraphSnapshot,
  runs: AgentRun[],
): DagNodeViewModel[] {
  return flattenDagNodes(
    viewModels.buildMilestoneTree(
      snapshot.milestones,
      snapshot.features,
      snapshot.tasks,
      runs,
    ),
  );
}

export function resolveSelectedNodeId(
  flattened: DagNodeViewModel[],
  selectedNodeId: string | undefined,
): string | undefined {
  if (flattened.length === 0) {
    return undefined;
  }
  if (
    selectedNodeId === undefined ||
    !flattened.some((node) => node.id === selectedNodeId)
  ) {
    return flattened[0]?.id;
  }
  return selectedNodeId;
}

export function findSelectedNode(
  flattened: DagNodeViewModel[],
  selectedNodeId: string | undefined,
): DagNodeViewModel | undefined {
  return flattened.find((node) => node.id === selectedNodeId);
}

export function currentSelectionFromNode(
  node: DagNodeViewModel | undefined,
): ComposerSelection {
  return {
    ...(node?.milestoneId !== undefined
      ? { milestoneId: node.milestoneId }
      : {}),
    ...(node?.featureId !== undefined ? { featureId: node.featureId } : {}),
    ...(node?.taskId !== undefined ? { taskId: node.taskId } : {}),
  };
}

export function selectedMilestoneIdFromNode(
  node: DagNodeViewModel | undefined,
): MilestoneId | undefined {
  if (node?.kind === 'milestone') {
    return node.milestoneId;
  }
  return node?.milestoneId;
}

export function selectedFeatureIdFromNode(
  node: DagNodeViewModel | undefined,
): FeatureId | undefined {
  if (node?.kind === 'feature' || node?.kind === 'task') {
    return node.featureId;
  }
  return undefined;
}

export function featureFromSnapshot(
  snapshot: GraphSnapshot,
  featureId: FeatureId,
): Feature | undefined {
  return snapshot.features.find((feature) => feature.id === featureId);
}

export function pendingProposalForSelection(params: {
  draftState:
    | { featureId: FeatureId; phase: 'plan' | 'replan'; commandCount: number }
    | undefined;
  selectedFeatureId: FeatureId | undefined;
  authoritativeSnapshot: GraphSnapshot;
  getFeatureRun: (
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ) => FeaturePhaseAgentRun | undefined;
}): FeaturePhaseAgentRun | undefined {
  if (
    params.draftState !== undefined ||
    params.selectedFeatureId === undefined
  ) {
    return undefined;
  }

  const feature = featureFromSnapshot(
    params.authoritativeSnapshot,
    params.selectedFeatureId,
  );
  if (feature === undefined) {
    return undefined;
  }

  const phase = phaseForFeature(feature);
  if (phase === undefined) {
    return undefined;
  }

  const run = params.getFeatureRun(params.selectedFeatureId, phase);
  return run?.runStatus === 'await_approval' ? run : undefined;
}

export function pendingTaskRunForSelection(params: {
  draftState:
    | { featureId: FeatureId; phase: 'plan' | 'replan'; commandCount: number }
    | undefined;
  selectedTaskId: string | undefined;
  getTaskRun: (taskId: string) => TaskAgentRun | undefined;
}): TaskAgentRun | undefined {
  if (params.draftState !== undefined || params.selectedTaskId === undefined) {
    return undefined;
  }

  const run = params.getTaskRun(params.selectedTaskId);
  if (run === undefined) {
    return undefined;
  }

  return run.runStatus === 'await_response' ||
    run.runStatus === 'await_approval' ||
    (run.runStatus === 'running' && run.owner === 'manual')
    ? run
    : undefined;
}

export function phaseForFeature(
  feature: Feature,
): 'plan' | 'replan' | undefined {
  switch (feature.workControl) {
    case 'planning':
      return 'plan';
    case 'replanning':
      return 'replan';
    default:
      return undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
