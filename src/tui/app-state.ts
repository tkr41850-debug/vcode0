import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  Feature,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  TaskAgentRun,
  TopPlannerAgentRun,
} from '@core/types/index';
import { readTopPlannerProposalMetadata } from '@orchestrator/proposals/index';
import type { ComposerSelection } from '@tui/commands/index';
import {
  type DagNodeViewModel,
  flattenDagNodes,
  type TuiViewModelBuilder,
} from '@tui/view-model/index';

export function displayedSnapshot(
  liveSnapshot: GraphSnapshot,
  draftSnapshot: GraphSnapshot | undefined,
): GraphSnapshot {
  return draftSnapshot ?? liveSnapshot;
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

export type PendingFeatureProposalRun = FeaturePhaseAgentRun & {
  phase: 'plan' | 'replan';
  runStatus: 'await_approval';
};

export type PendingTopPlannerProposalRun = TopPlannerAgentRun & {
  phase: 'plan';
  runStatus: 'await_approval';
};

export type PendingProposalRun =
  | PendingFeatureProposalRun
  | PendingTopPlannerProposalRun;

export type PendingTopPlannerSessionAction =
  | { kind: 'submit'; prompt: string }
  | { kind: 'rerun' };

export interface PendingProposalSelection {
  run: PendingProposalRun;
  approvalHint?: string;
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
  getTopPlannerRun: () => TopPlannerAgentRun | undefined;
}): PendingProposalSelection | undefined {
  if (params.draftState !== undefined) {
    return undefined;
  }

  const featureRun =
    params.selectedFeatureId === undefined
      ? undefined
      : pendingFeatureProposalForSelection(
          params.authoritativeSnapshot,
          params.selectedFeatureId,
          params.getFeatureRun,
        );
  if (featureRun !== undefined) {
    return { run: featureRun };
  }

  const topPlannerRun = params.getTopPlannerRun();
  if (!isPendingTopPlannerProposalRun(topPlannerRun)) {
    return undefined;
  }

  const metadata = readTopPlannerProposalMetadata(topPlannerRun.payloadJson);
  const collisionCount = metadata?.collidedFeatureRuns.length ?? 0;
  return {
    run: topPlannerRun,
    ...(collisionCount > 0
      ? {
          approvalHint:
            collisionCount === 1
              ? 'resets 1 planner run'
              : `resets ${collisionCount} planner runs`,
        }
      : {}),
  };
}

function pendingFeatureProposalForSelection(
  snapshot: GraphSnapshot,
  featureId: FeatureId,
  getFeatureRun: (
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ) => FeaturePhaseAgentRun | undefined,
): PendingFeatureProposalRun | undefined {
  const feature = featureFromSnapshot(snapshot, featureId);
  if (feature === undefined) {
    return undefined;
  }

  const phase = phaseForFeature(feature);
  if (phase === undefined) {
    return undefined;
  }

  const run = getFeatureRun(featureId, phase);
  return isPendingFeatureProposalRun(run) ? run : undefined;
}

function isPendingFeatureProposalRun(
  run: FeaturePhaseAgentRun | undefined,
): run is PendingFeatureProposalRun {
  return (
    run !== undefined &&
    run.runStatus === 'await_approval' &&
    (run.phase === 'plan' || run.phase === 'replan')
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

export function hasReusableTopPlannerSession(
  run: TopPlannerAgentRun | undefined,
): run is TopPlannerAgentRun & { sessionId: string } {
  return run?.sessionId !== undefined;
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
    run.runStatus === 'checkpointed_await_response' ||
    run.runStatus === 'checkpointed_await_approval' ||
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
