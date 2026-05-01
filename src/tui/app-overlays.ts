import type { GvcConfig } from '@config';
import type { GraphSnapshot } from '@core/graph/index';
import type { FeatureId, MilestoneId, TaskId } from '@core/types/index';
import type { OverlayHandle, TUI } from '@mariozechner/pi-tui';
import type { InboxItemRecord } from '@orchestrator/ports/index';
import type { TuiCommand, TuiKeybindHint } from '@tui/commands/index';
import type {
  AgentMonitorOverlay,
  ConfigOverlay,
  DependencyDetailOverlay,
  HelpOverlay,
  InboxOverlay,
  MergeTrainOverlay,
  PlannerAuditOverlay,
  PlannerSessionOverlay,
  ProposalReviewOverlay,
  TaskTranscriptOverlay,
} from '@tui/components/index';
import type {
  TuiViewModelBuilder,
  WorkerLogViewModel,
} from '@tui/view-model/index';

import type { PendingTopPlannerSessionAction } from './app-state.js';

export interface OverlayState {
  monitorHandle: OverlayHandle | undefined;
  dependencyHandle: OverlayHandle | undefined;
  helpHandle: OverlayHandle | undefined;
  inboxHandle: OverlayHandle | undefined;
  plannerAuditHandle: OverlayHandle | undefined;
  proposalReviewHandle: OverlayHandle | undefined;
  mergeTrainHandle: OverlayHandle | undefined;
  configHandle: OverlayHandle | undefined;
  plannerSessionHandle: OverlayHandle | undefined;
  transcriptHandle: OverlayHandle | undefined;
}

export function hideAllOverlays(state: OverlayState): void {
  state.monitorHandle?.hide();
  state.monitorHandle = undefined;
  state.dependencyHandle?.hide();
  state.dependencyHandle = undefined;
  state.helpHandle?.hide();
  state.helpHandle = undefined;
  state.inboxHandle?.hide();
  state.inboxHandle = undefined;
  state.plannerAuditHandle?.hide();
  state.plannerAuditHandle = undefined;
  state.proposalReviewHandle?.hide();
  state.proposalReviewHandle = undefined;
  state.mergeTrainHandle?.hide();
  state.mergeTrainHandle = undefined;
  state.configHandle?.hide();
  state.configHandle = undefined;
  state.plannerSessionHandle?.hide();
  state.plannerSessionHandle = undefined;
  state.transcriptHandle?.hide();
  state.transcriptHandle = undefined;
}

export function hasVisibleOverlay(state: OverlayState): boolean {
  return (
    state.helpHandle !== undefined ||
    state.monitorHandle !== undefined ||
    state.dependencyHandle !== undefined ||
    state.inboxHandle !== undefined ||
    state.plannerAuditHandle !== undefined ||
    state.proposalReviewHandle !== undefined ||
    state.mergeTrainHandle !== undefined ||
    state.configHandle !== undefined ||
    state.plannerSessionHandle !== undefined ||
    state.transcriptHandle !== undefined
  );
}

export function hideTopOverlay(params: {
  state: OverlayState;
  refresh: () => void;
  setNotice: (notice: string) => void;
  onHidePlannerSession?: () => void;
}): boolean {
  const { state, refresh, setNotice, onHidePlannerSession } = params;
  if (state.helpHandle !== undefined) {
    state.helpHandle.hide();
    state.helpHandle = undefined;
    setNotice('help hidden');
    refresh();
    return true;
  }
  if (state.monitorHandle !== undefined) {
    state.monitorHandle.hide();
    state.monitorHandle = undefined;
    setNotice('monitor hidden');
    refresh();
    return true;
  }
  if (state.dependencyHandle !== undefined) {
    state.dependencyHandle.hide();
    state.dependencyHandle = undefined;
    setNotice('dependency detail hidden');
    refresh();
    return true;
  }
  if (state.inboxHandle !== undefined) {
    state.inboxHandle.hide();
    state.inboxHandle = undefined;
    setNotice('inbox hidden');
    refresh();
    return true;
  }
  if (state.plannerAuditHandle !== undefined) {
    state.plannerAuditHandle.hide();
    state.plannerAuditHandle = undefined;
    setNotice('planner audit hidden');
    refresh();
    return true;
  }
  if (state.proposalReviewHandle !== undefined) {
    state.proposalReviewHandle.hide();
    state.proposalReviewHandle = undefined;
    setNotice('proposal review hidden');
    refresh();
    return true;
  }
  if (state.mergeTrainHandle !== undefined) {
    state.mergeTrainHandle.hide();
    state.mergeTrainHandle = undefined;
    setNotice('merge train hidden');
    refresh();
    return true;
  }
  if (state.configHandle !== undefined) {
    state.configHandle.hide();
    state.configHandle = undefined;
    setNotice('config hidden');
    refresh();
    return true;
  }
  if (state.plannerSessionHandle !== undefined) {
    state.plannerSessionHandle.hide();
    state.plannerSessionHandle = undefined;
    onHidePlannerSession?.();
    setNotice('planner session hidden');
    refresh();
    return true;
  }
  if (state.transcriptHandle !== undefined) {
    state.transcriptHandle.hide();
    state.transcriptHandle = undefined;
    setNotice('transcript hidden');
    refresh();
    return true;
  }

  return false;
}

export function toggleHelpOverlay(params: {
  state: OverlayState;
  tui: TUI;
  helpOverlay: HelpOverlay;
  navigationKeybinds: readonly TuiKeybindHint[];
  commandEntries: readonly TuiCommand[];
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    helpOverlay,
    navigationKeybinds,
    commandEntries,
    refresh,
    setNotice,
  } = params;
  if (state.helpHandle !== undefined) {
    state.helpHandle.hide();
    state.helpHandle = undefined;
    setNotice('help hidden');
    refresh();
    return;
  }

  helpOverlay.setModel('Help', [...navigationKeybinds, ...commandEntries]);
  state.helpHandle = tui.showOverlay(helpOverlay, {
    width: '70%',
    maxHeight: '60%',
    anchor: 'center',
  });
  setNotice('help shown');
  refresh();
}

export function toggleAgentMonitorOverlay(params: {
  state: OverlayState;
  tui: TUI;
  monitorOverlay: AgentMonitorOverlay;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const { state, tui, monitorOverlay, refresh, setNotice } = params;
  if (state.monitorHandle !== undefined) {
    state.monitorHandle.hide();
    state.monitorHandle = undefined;
    setNotice('monitor hidden');
    refresh();
    return;
  }

  state.monitorHandle = tui.showOverlay(monitorOverlay, {
    width: '85%',
    maxHeight: '55%',
    anchor: 'bottom-center',
    offsetY: -4,
  });
  setNotice('monitor shown');
  refresh();
}

export function toggleDependencyOverlay(params: {
  state: OverlayState;
  tui: TUI;
  dependencyOverlay: DependencyDetailOverlay;
  viewModels: TuiViewModelBuilder;
  snapshot: GraphSnapshot;
  selectedFeatureId: FeatureId | undefined;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    dependencyOverlay,
    viewModels,
    snapshot,
    selectedFeatureId,
    refresh,
    setNotice,
  } = params;
  if (state.dependencyHandle !== undefined) {
    state.dependencyHandle.hide();
    state.dependencyHandle = undefined;
    setNotice('dependency detail hidden');
    refresh();
    return;
  }

  dependencyOverlay.setDetail(
    selectedFeatureId === undefined
      ? undefined
      : viewModels.buildDependencyDetail(
          selectedFeatureId,
          snapshot.milestones,
          snapshot.features,
        ),
  );
  state.dependencyHandle = tui.showOverlay(dependencyOverlay, {
    width: '70%',
    maxHeight: '40%',
    anchor: 'center',
  });
  setNotice('dependency detail shown');
  refresh();
}

export function toggleInboxOverlay(params: {
  state: OverlayState;
  tui: TUI;
  inboxOverlay: InboxOverlay;
  viewModels: TuiViewModelBuilder;
  items: InboxItemRecord[];
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const { state, tui, inboxOverlay, viewModels, items, refresh, setNotice } =
    params;
  if (state.inboxHandle !== undefined) {
    state.inboxHandle.hide();
    state.inboxHandle = undefined;
    setNotice('inbox hidden');
    refresh();
    return;
  }

  inboxOverlay.setModel(viewModels.buildInbox(items));
  state.inboxHandle = tui.showOverlay(inboxOverlay, {
    width: '80%',
    maxHeight: '50%',
    anchor: 'center',
  });
  setNotice('inbox shown');
  refresh();
}

export function togglePlannerAuditOverlay(params: {
  state: OverlayState;
  tui: TUI;
  plannerAuditOverlay: PlannerAuditOverlay;
  viewModels: TuiViewModelBuilder;
  entries: Array<{
    ts: number;
    action:
      | 'requested'
      | 'prompt_recorded'
      | 'rerun_requested'
      | 'applied'
      | 'rejected'
      | 'apply_failed'
      | 'collision_resolved';
    prompt?: string;
    sessionMode?: 'continue' | 'fresh';
    runId?: string;
    sessionId?: string;
    previousSessionId?: string;
    featureIds: FeatureId[];
    milestoneIds: MilestoneId[];
    collisionCount: number;
    detail?: string;
  }>;
  selectedFeatureId: FeatureId | undefined;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    plannerAuditOverlay,
    viewModels,
    entries,
    selectedFeatureId,
    refresh,
    setNotice,
  } = params;
  if (state.plannerAuditHandle !== undefined) {
    state.plannerAuditHandle.hide();
    state.plannerAuditHandle = undefined;
    setNotice('planner audit hidden');
    refresh();
    return;
  }

  plannerAuditOverlay.setModel(
    selectedFeatureId === undefined
      ? viewModels.buildPlannerAudit({ entries })
      : viewModels.buildPlannerAudit({ entries, selectedFeatureId }),
  );
  state.plannerAuditHandle = tui.showOverlay(plannerAuditOverlay, {
    width: '80%',
    maxHeight: '50%',
    anchor: 'center',
  });
  setNotice('planner audit shown');
  refresh();
}

export function toggleProposalReviewOverlay(params: {
  state: OverlayState;
  tui: TUI;
  proposalReviewOverlay: ProposalReviewOverlay;
  viewModels: TuiViewModelBuilder;
  pendingProposal:
    | {
        review: {
          scopeType: 'feature_phase' | 'top_planner';
          scopeId: string;
          phase: 'plan' | 'replan';
          prompt?: string;
          sessionMode?: 'continue' | 'fresh';
          runId: string;
          sessionId?: string;
          previousSessionId?: string;
          featureIds: FeatureId[];
          milestoneIds: MilestoneId[];
          totalOps: number;
          opSummaries: Array<{ kind: string; count: number }>;
          changeSummary: string;
          collisions: Array<{
            featureId: FeatureId;
            runId: string;
            phase: 'plan' | 'replan';
            runStatus: string;
            sessionId?: string;
            resetsSavedSession: boolean;
          }>;
          approvalNotice: string;
          previewError?: string;
        };
        approvalHint?: string;
      }
    | undefined;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    proposalReviewOverlay,
    viewModels,
    pendingProposal,
    refresh,
    setNotice,
  } = params;
  if (state.proposalReviewHandle !== undefined) {
    state.proposalReviewHandle.hide();
    state.proposalReviewHandle = undefined;
    setNotice('proposal review hidden');
    refresh();
    return;
  }

  proposalReviewOverlay.setModel(
    viewModels.buildProposalReview(pendingProposal),
  );
  state.proposalReviewHandle = tui.showOverlay(proposalReviewOverlay, {
    width: '80%',
    maxHeight: '55%',
    anchor: 'center',
  });
  setNotice('proposal review shown');
  refresh();
}

export function toggleMergeTrainOverlay(params: {
  state: OverlayState;
  tui: TUI;
  mergeTrainOverlay: MergeTrainOverlay;
  viewModels: TuiViewModelBuilder;
  snapshot: GraphSnapshot;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    mergeTrainOverlay,
    viewModels,
    snapshot,
    refresh,
    setNotice,
  } = params;
  if (state.mergeTrainHandle !== undefined) {
    state.mergeTrainHandle.hide();
    state.mergeTrainHandle = undefined;
    setNotice('merge train hidden');
    refresh();
    return;
  }

  mergeTrainOverlay.setModel(viewModels.buildMergeTrain(snapshot.features));
  state.mergeTrainHandle = tui.showOverlay(mergeTrainOverlay, {
    width: '80%',
    maxHeight: '50%',
    anchor: 'center',
  });
  setNotice('merge train shown');
  refresh();
}

export function toggleConfigOverlay(params: {
  state: OverlayState;
  tui: TUI;
  configOverlay: ConfigOverlay;
  viewModels: TuiViewModelBuilder;
  refresh: () => void;
  setNotice: (notice: string) => void;
  getConfig: () => GvcConfig;
}): void {
  const {
    state,
    tui,
    configOverlay,
    viewModels,
    refresh,
    setNotice,
    getConfig,
  } = params;
  if (state.configHandle !== undefined) {
    state.configHandle.hide();
    state.configHandle = undefined;
    setNotice('config hidden');
    refresh();
    return;
  }

  configOverlay.setModel(viewModels.buildConfig(getConfig()));
  state.configHandle = tui.showOverlay(configOverlay, {
    width: '80%',
    maxHeight: '50%',
    anchor: 'center',
  });
  setNotice('config shown');
  refresh();
}

export function showPlannerSessionOverlay(params: {
  state: OverlayState;
  tui: TUI;
  plannerSessionOverlay: PlannerSessionOverlay;
  viewModels: TuiViewModelBuilder;
  pendingAction: PendingTopPlannerSessionAction;
}): void {
  const { state, tui, plannerSessionOverlay, viewModels, pendingAction } =
    params;

  plannerSessionOverlay.setModel(
    viewModels.buildPlannerSessionPicker(
      pendingAction.kind === 'submit'
        ? { mode: 'submit', prompt: pendingAction.prompt }
        : { mode: 'rerun' },
    ),
  );

  if (state.plannerSessionHandle === undefined) {
    state.plannerSessionHandle = tui.showOverlay(plannerSessionOverlay, {
      width: '70%',
      maxHeight: '40%',
      anchor: 'center',
    });
  }
}

export function shouldRenderAfterWorkerOutput(
  lastRenderAt: number,
  now: number,
  intervalMs: number,
): boolean {
  return now - lastRenderAt >= intervalMs;
}

export function toggleTranscriptOverlay(params: {
  state: OverlayState;
  tui: TUI;
  transcriptOverlay: TaskTranscriptOverlay;
  viewModels: TuiViewModelBuilder;
  taskId: TaskId | undefined;
  logs: WorkerLogViewModel[];
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    transcriptOverlay,
    viewModels,
    taskId,
    logs,
    refresh,
    setNotice,
  } = params;
  if (state.transcriptHandle !== undefined) {
    state.transcriptHandle.hide();
    state.transcriptHandle = undefined;
    setNotice('transcript hidden');
    refresh();
    return;
  }

  transcriptOverlay.setModel(viewModels.buildTaskTranscript(taskId, logs));
  state.transcriptHandle = tui.showOverlay(transcriptOverlay, {
    width: '80%',
    maxHeight: '55%',
    anchor: 'bottom-center',
  });
  setNotice('transcript shown');
  refresh();
}

export function pushWorkerOutput(params: {
  monitorOverlay: Pick<
    AgentMonitorOverlay,
    'upsertLog' | 'getSelectedWorkerId'
  >;
  runId: string;
  taskId: string;
  text: string;
}): string | undefined {
  const lines = params.text.split(/\r?\n/).filter((line) => line.length > 0);
  const timestamp = Date.now();

  for (const line of lines) {
    params.monitorOverlay.upsertLog(
      params.runId,
      params.taskId,
      line,
      timestamp,
    );
  }

  return params.monitorOverlay.getSelectedWorkerId();
}
