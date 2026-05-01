import { type GraphSnapshot, InMemoryFeatureGraph } from '@core/graph/index';
import {
  applyGraphProposal,
  type GraphProposalOp,
} from '@core/proposals/index';
import type {
  AgentRun,
  Feature,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  PlannerSessionMode,
  TaskAgentRun,
  TopPlannerAgentRun,
} from '@core/types/index';
import {
  collectProposalScopeIds,
  parseGraphProposalPayload,
  readTopPlannerProposalMetadata,
  type TopPlannerCollidedFeatureRun,
} from '@orchestrator/proposals/index';
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

export interface PendingProposalOpSummary {
  kind: GraphProposalOp['kind'];
  count: number;
}

export interface PendingProposalCollisionReview
  extends TopPlannerCollidedFeatureRun {
  resetsSavedSession: boolean;
}

export interface PendingProposalReview {
  scopeType: PendingProposalRun['scopeType'];
  scopeId: PendingProposalRun['scopeId'];
  phase: PendingProposalRun['phase'];
  prompt?: string;
  sessionMode?: PlannerSessionMode;
  runId: string;
  sessionId?: string;
  previousSessionId?: string;
  featureIds: FeatureId[];
  milestoneIds: MilestoneId[];
  totalOps: number;
  opSummaries: PendingProposalOpSummary[];
  changeSummary: string;
  collisions: PendingProposalCollisionReview[];
  approvalNotice: string;
  previewError?: string;
}

export interface PendingProposalSelection {
  run: PendingProposalRun;
  review: PendingProposalReview;
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
    return {
      run: featureRun,
      review: buildPendingProposalReview(
        featureRun,
        params.authoritativeSnapshot,
      ),
    };
  }

  const topPlannerRun = params.getTopPlannerRun();
  if (!isPendingTopPlannerProposalRun(topPlannerRun)) {
    return undefined;
  }

  const review = buildPendingProposalReview(
    topPlannerRun,
    params.authoritativeSnapshot,
  );
  const collisionCount = review.collisions.length;
  return {
    run: topPlannerRun,
    review,
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

function buildPendingProposalReview(
  run: PendingProposalRun,
  authoritativeSnapshot: GraphSnapshot,
): PendingProposalReview {
  const metadata =
    run.scopeType === 'top_planner'
      ? readTopPlannerProposalMetadata(run.payloadJson)
      : undefined;
  const collisions =
    metadata?.collidedFeatureRuns.map((entry) => ({
      ...entry,
      resetsSavedSession: entry.sessionId !== undefined,
    })) ?? [];
  const fallbackFeatureIds =
    run.scopeType === 'feature_phase' ? [run.scopeId] : [];
  const fallbackMilestoneIds =
    run.scopeType === 'feature_phase'
      ? [
          featureFromSnapshot(authoritativeSnapshot, run.scopeId)?.milestoneId,
        ].filter((value): value is MilestoneId => value !== undefined)
      : [];
  const approvalNotice = buildPendingProposalApprovalNotice(
    run.scopeType,
    collisions,
  );

  try {
    const proposal = parseGraphProposalPayload(
      run.payloadJson,
      run.scopeType === 'top_planner' ? 'plan' : run.phase,
    );
    const graph = new InMemoryFeatureGraph(authoritativeSnapshot);
    const scope = collectProposalScopeIds(proposal, graph);
    const result =
      run.scopeType === 'top_planner'
        ? applyGraphProposal(graph, proposal, {
            additiveOnly: true,
            ...(collisions.length > 0
              ? {
                  plannerCollisionFeatureIds: collisions.map(
                    (entry) => entry.featureId,
                  ),
                }
              : {}),
          })
        : applyGraphProposal(graph, proposal);

    return {
      scopeType: run.scopeType,
      scopeId: run.scopeId,
      phase: run.phase,
      ...(metadata?.prompt !== undefined ? { prompt: metadata.prompt } : {}),
      ...(metadata?.sessionMode !== undefined
        ? { sessionMode: metadata.sessionMode }
        : {}),
      runId: metadata?.runId ?? run.id,
      ...(metadata?.sessionId !== undefined
        ? { sessionId: metadata.sessionId }
        : run.sessionId !== undefined
          ? { sessionId: run.sessionId }
          : {}),
      ...(metadata?.previousSessionId !== undefined
        ? { previousSessionId: metadata.previousSessionId }
        : {}),
      featureIds:
        metadata !== undefined && metadata.featureIds.length !== 0
          ? metadata.featureIds
          : scope.featureIds.length !== 0
            ? scope.featureIds
            : fallbackFeatureIds,
      milestoneIds:
        metadata !== undefined && metadata.milestoneIds.length !== 0
          ? metadata.milestoneIds
          : scope.milestoneIds.length !== 0
            ? scope.milestoneIds
            : fallbackMilestoneIds,
      totalOps: proposal.ops.length,
      opSummaries: summarizeProposalOps(proposal.ops),
      changeSummary: result.summary,
      collisions,
      approvalNotice,
    };
  } catch (error) {
    return {
      scopeType: run.scopeType,
      scopeId: run.scopeId,
      phase: run.phase,
      ...(metadata?.prompt !== undefined ? { prompt: metadata.prompt } : {}),
      ...(metadata?.sessionMode !== undefined
        ? { sessionMode: metadata.sessionMode }
        : {}),
      runId: metadata?.runId ?? run.id,
      ...(metadata?.sessionId !== undefined
        ? { sessionId: metadata.sessionId }
        : run.sessionId !== undefined
          ? { sessionId: run.sessionId }
          : {}),
      ...(metadata?.previousSessionId !== undefined
        ? { previousSessionId: metadata.previousSessionId }
        : {}),
      featureIds: metadata?.featureIds ?? fallbackFeatureIds,
      milestoneIds: metadata?.milestoneIds ?? fallbackMilestoneIds,
      totalOps: 0,
      opSummaries: [],
      changeSummary: 'Preview unavailable.',
      collisions,
      approvalNotice,
      previewError: formatUnknownError(error),
    };
  }
}

function summarizeProposalOps(
  ops: readonly GraphProposalOp[],
): PendingProposalOpSummary[] {
  const counts = new Map<GraphProposalOp['kind'], number>();
  for (const op of ops) {
    counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

function buildPendingProposalApprovalNotice(
  scopeType: PendingProposalRun['scopeType'],
  collisions: readonly PendingProposalCollisionReview[],
): string {
  if (scopeType === 'top_planner') {
    return collisions.length === 0
      ? 'Accept applies this top-planner proposal additively; reject leaves the current graph unchanged.'
      : `Accept resets the ${collisions.length === 1 ? 'listed planner run' : 'listed planner runs'} before applying; reject leaves them untouched.`;
  }

  return 'Accept applies this feature proposal to the current graph; reject leaves the current graph unchanged.';
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
