import type { GraphSnapshot } from '@core/graph/index';
import type {
  FeatureId,
  MilestoneId,
  PlannerSessionMode,
} from '@core/types/index';
import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
} from '@mariozechner/pi-tui';
import type { UiPort } from '@orchestrator/ports/index';
import {
  buildComposerSlashCommands,
  CommandRegistry,
  NAVIGATION_KEYBINDS,
  type TuiCommandContext,
} from '@tui/commands/index';
import {
  AgentMonitorOverlay,
  ComposerStatus,
  ConfigOverlay,
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  InboxOverlay,
  MergeTrainOverlay,
  PlannerAuditOverlay,
  PlannerSessionOverlay,
  ProposalReviewOverlay,
  StatusBar,
  TaskTranscriptOverlay,
} from '@tui/components/index';
import { ComposerProposalController } from '@tui/proposal-controller';
import { TuiViewModelBuilder } from '@tui/view-model/index';

import { createTuiCommandContext } from './app-command-context.js';
import { executeSlashCommand, handleComposerSubmit } from './app-composer.js';
import type { TuiAppDeps } from './app-deps.js';
import {
  currentSelection as buildCurrentSelection,
  handleGraphInput,
  selectedNode as resolveSelectedNode,
  moveSelection as shiftSelection,
} from './app-navigation.js';
import {
  hasVisibleOverlay,
  hideAllOverlays,
  hideTopOverlay,
  type OverlayState,
  pushWorkerOutput,
  shouldRenderAfterWorkerOutput,
  showPlannerSessionOverlay,
  toggleAgentMonitorOverlay,
  toggleConfigOverlay,
  toggleDependencyOverlay,
  toggleHelpOverlay,
  toggleInboxOverlay,
  toggleMergeTrainOverlay,
  togglePlannerAuditOverlay,
  toggleProposalReviewOverlay,
  toggleTranscriptOverlay,
} from './app-overlays.js';
import {
  buildFlattenedNodes,
  displayedSnapshot,
  findSelectedNode,
  hasReusableTopPlannerSession,
  type PendingTopPlannerSessionAction,
  pendingProposalForSelection,
  pendingTaskRunForSelection,
  resolveSelectedNodeId,
  selectedFeatureIdFromNode,
  selectedMilestoneIdFromNode,
} from './app-state.js';

export type { AgentRun, FeaturePhaseAgentRun } from '@core/types/index';
export type { InitializeProjectCommand } from '@tui/commands/index';
export type { WorkerCountsViewModel } from '@tui/view-model/index';
export type { TuiAppDeps } from './app-deps.js';

export class TuiApp implements UiPort {
  private readonly interactiveTerminal =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal);
  private readonly dagView = new DagView();
  private readonly statusBar = new StatusBar();
  private readonly composerStatus = new ComposerStatus();
  private readonly composer = new Editor(this.tui, {
    borderColor: (value) => value,
    selectList: {
      selectedPrefix: (value) => value,
      selectedText: (value) => value,
      description: (value) => value,
      scrollInfo: (value) => value,
      noMatch: (value) => value,
    },
  });
  private readonly monitorOverlay = new AgentMonitorOverlay();
  private readonly dependencyOverlay = new DependencyDetailOverlay();
  private readonly inboxOverlay = new InboxOverlay();
  private readonly plannerAuditOverlay = new PlannerAuditOverlay();
  private readonly proposalReviewOverlay = new ProposalReviewOverlay();
  private readonly mergeTrainOverlay = new MergeTrainOverlay();
  private readonly configOverlay = new ConfigOverlay();
  private readonly plannerSessionOverlay = new PlannerSessionOverlay();
  private readonly transcriptOverlay = new TaskTranscriptOverlay();
  private readonly helpOverlay = new HelpOverlay();
  private readonly commands = new CommandRegistry();
  private readonly viewModels = new TuiViewModelBuilder();
  private readonly proposalController: ComposerProposalController;
  private readonly overlays: OverlayState = {
    monitorHandle: undefined,
    dependencyHandle: undefined,
    helpHandle: undefined,
    inboxHandle: undefined,
    plannerAuditHandle: undefined,
    proposalReviewHandle: undefined,
    mergeTrainHandle: undefined,
    configHandle: undefined,
    plannerSessionHandle: undefined,
    transcriptHandle: undefined,
  };
  private started = false;
  private pendingTopPlannerSessionAction:
    | PendingTopPlannerSessionAction
    | undefined;
  private selectedNodeId: string | undefined;
  private selectedWorkerId: string | undefined;
  private lastWorkerRenderAt = 0;
  private readonly workerRenderIntervalMs = 100;
  private notice: string | undefined;
  private focusMode: 'composer' | 'graph' = 'composer';
  private composerText = '';
  private readonly commandContext: TuiCommandContext;

  constructor(private readonly deps: TuiAppDeps) {
    this.proposalController = new ComposerProposalController({
      snapshot: () => this.deps.snapshot(),
      isAutoExecutionEnabled: () => this.deps.isAutoExecutionEnabled(),
      setAutoExecutionEnabled: (enabled) =>
        this.deps.setAutoExecutionEnabled(enabled),
      getFeatureRun: (featureId, phase) =>
        this.deps.getFeatureRun(featureId, phase),
      getTopPlannerRun: () => this.deps.getTopPlannerRun(),
      saveFeatureRun: (run) => this.deps.saveFeatureRun(run),
      enqueueApprovalDecision: (event) => {
        this.deps.enqueueApprovalDecision(event);
      },
      enqueueTopPlannerApprovalDecision: (event) => {
        this.deps.enqueueTopPlannerApprovalDecision(event);
      },
      enqueueRerun: (event) => {
        this.deps.rerunFeatureProposal(event);
      },
      enqueueTopPlannerRerun: (event) => {
        this.deps.rerunTopPlannerProposal(event);
      },
      requestTopPlannerRerunSelection: () =>
        this.requestTopPlannerRerunSelection(),
    });

    this.composer.onChange = (text) => {
      this.composerText = text;
      this.refresh();
    };
    this.composer.onSubmit = (text) => {
      void handleComposerSubmit({
        text,
        executeSlashCommand: (input) => this.executeSlashCommand(input),
        requestTopLevelPlan: (prompt, options) =>
          this.deps.requestTopLevelPlan(prompt, options),
        requestTopPlannerSessionSelection: (action) =>
          this.requestTopPlannerSessionSelection(action),
        addToHistory: (input) => this.composer.addToHistory(input),
        setNotice: (notice) => {
          this.notice = notice;
        },
        refresh: () => this.refresh(),
      });
    };

    this.commandContext = createTuiCommandContext({
      dataSource: this.deps,
      monitorOverlay: this.monitorOverlay,
      selectedMilestoneId: () => this.selectedMilestoneId(),
      selectedFeatureId: () => this.selectedFeatureId(),
      toggleAgentMonitor: () => this.toggleAgentMonitorOverlay(),
      toggleHelp: () => this.toggleHelpOverlay(),
      toggleInbox: () => this.toggleInboxOverlay(),
      togglePlannerAudit: () => this.togglePlannerAuditOverlay(),
      toggleProposalReview: () => this.toggleProposalReviewOverlay(),
      toggleMergeTrain: () => this.toggleMergeTrainOverlay(),
      toggleTranscript: () => this.toggleTranscriptOverlay(),
      toggleConfig: () => this.toggleConfigOverlay(),
      toggleDependencyDetail: () => this.toggleDependencyOverlay(),
      setSelectedWorkerId: (workerId) => {
        this.selectedWorkerId = workerId;
      },
      setNotice: (notice) => {
        this.notice = notice;
      },
      refresh: () => this.refresh(),
    });
  }

  show(): Promise<void> {
    if (this.started) {
      this.refresh();
      return Promise.resolve();
    }

    if (!this.interactiveTerminal) {
      throw new Error('gvc0 TUI requires an interactive TTY on stdin/stdout');
    }

    this.tui.addChild(this.dagView);
    this.tui.addChild(this.statusBar);
    this.tui.addChild(this.composerStatus);
    this.tui.addChild(this.composer);
    this.tui.addInputListener((data) => {
      return this.handleInput(data) ? { consume: true } : undefined;
    });
    this.tui.start();
    this.tui.setFocus(this.composer);
    this.started = true;
    this.refresh();
    return Promise.resolve();
  }

  refresh(): void {
    const snapshot = this.displayedSnapshot();
    const runs = this.deps.listAgentRuns();
    const nodes = this.viewModels.buildMilestoneTree(
      snapshot.milestones,
      snapshot.features,
      snapshot.tasks,
      runs,
    );
    const flattened = buildFlattenedNodes(this.viewModels, snapshot, runs);
    this.selectedNodeId = resolveSelectedNodeId(flattened, this.selectedNodeId);

    const selectedNode = findSelectedNode(flattened, this.selectedNodeId);
    const draftState = this.proposalController.getDraftState();
    const pendingProposal = pendingProposalForSelection({
      draftState,
      selectedFeatureId: this.selectedFeatureId(),
      authoritativeSnapshot: this.deps.snapshot(),
      getFeatureRun: (featureId, phase) =>
        this.deps.getFeatureRun(featureId, phase),
      getTopPlannerRun: () => this.deps.getTopPlannerRun(),
    });
    const pendingTaskRun = pendingTaskRunForSelection({
      draftState,
      selectedTaskId: selectedNode?.taskId,
      getTaskRun: (taskId) => this.deps.getTaskRun(taskId),
    });
    const pendingTopPlannerSessionAction = this.pendingTopPlannerSessionAction;

    this.dagView.setModel(
      nodes,
      this.selectedNodeId,
      draftState !== undefined ? 'gvc0 progress [draft]' : 'gvc0 progress',
      nodes.length === 0 ? this.viewModels.buildEmptyState() : undefined,
    );
    this.statusBar.setModel(
      this.viewModels.buildStatusBar({
        tasks: snapshot.tasks,
        workerCounts: this.deps.getWorkerCounts(),
        autoExecutionEnabled: this.deps.isAutoExecutionEnabled(),
        keybindHints: [...NAVIGATION_KEYBINDS, ...this.commands.getAll()],
        ...(selectedNode !== undefined
          ? { selectedLabel: selectedNode.label }
          : {}),
        ...(this.notice !== undefined ? { notice: this.notice } : {}),
        dataMode: draftState !== undefined ? 'draft' : 'live',
        focusMode: this.focusMode,
        ...(pendingProposal !== undefined
          ? {
              pendingProposalPhase: pendingProposal.run.phase,
              pendingProposalTarget:
                pendingProposal.run.scopeType === 'top_planner'
                  ? 'top-planner'
                  : pendingProposal.run.scopeId,
              ...(pendingProposal.approvalHint !== undefined
                ? { pendingProposalHint: pendingProposal.approvalHint }
                : {}),
            }
          : {}),
      }),
    );
    this.composerStatus.setModel(
      this.viewModels.buildComposer({
        text: this.composerText,
        focusMode: this.focusMode,
        ...(draftState !== undefined
          ? {
              draftFeatureId: draftState.featureId,
              draftPhase: draftState.phase,
              draftCommandCount: draftState.commandCount,
            }
          : {}),
        ...(pendingProposal !== undefined
          ? {
              pendingProposalPhase: pendingProposal.run.phase,
              pendingProposalTarget:
                pendingProposal.run.scopeType === 'top_planner'
                  ? 'top-planner'
                  : pendingProposal.run.scopeId,
              ...(pendingProposal.approvalHint !== undefined
                ? { pendingProposalHint: pendingProposal.approvalHint }
                : {}),
            }
          : {}),
        ...(pendingTaskRun !== undefined
          ? {
              pendingTaskId: pendingTaskRun.scopeId,
              pendingTaskRunStatus: pendingTaskRun.runStatus,
              pendingTaskOwner: pendingTaskRun.owner,
              pendingTaskPayloadJson: pendingTaskRun.payloadJson,
            }
          : {}),
        ...(pendingTopPlannerSessionAction !== undefined
          ? {
              pendingSessionSummary:
                pendingTopPlannerSessionAction.kind === 'submit'
                  ? 'submit choice pending'
                  : 'rerun choice pending',
            }
          : {}),
      }),
    );

    const selectedFeatureId = this.selectedFeatureId();
    if (this.overlays.dependencyHandle !== undefined) {
      this.dependencyOverlay.setDetail(
        selectedFeatureId === undefined
          ? undefined
          : this.viewModels.buildDependencyDetail(
              selectedFeatureId,
              snapshot.milestones,
              snapshot.features,
            ),
      );
    }
    if (this.overlays.inboxHandle !== undefined) {
      this.inboxOverlay.setModel(
        this.viewModels.buildInbox(this.deps.listInboxItems()),
      );
    }
    if (this.overlays.plannerAuditHandle !== undefined) {
      const plannerAuditEntries = this.deps.listPlannerAuditEntries(
        selectedFeatureId === undefined
          ? undefined
          : { featureId: selectedFeatureId },
      );
      this.plannerAuditOverlay.setModel(
        selectedFeatureId === undefined
          ? this.viewModels.buildPlannerAudit({
              entries: plannerAuditEntries,
            })
          : this.viewModels.buildPlannerAudit({
              entries: plannerAuditEntries,
              selectedFeatureId,
            }),
      );
    }
    if (this.overlays.proposalReviewHandle !== undefined) {
      this.proposalReviewOverlay.setModel(
        this.viewModels.buildProposalReview(pendingProposal),
      );
    }
    if (this.overlays.mergeTrainHandle !== undefined) {
      this.mergeTrainOverlay.setModel(
        this.viewModels.buildMergeTrain(snapshot.features),
      );
    }
    if (this.overlays.configHandle !== undefined) {
      this.configOverlay.setModel(
        this.viewModels.buildConfig(this.deps.getConfig()),
      );
    }
    if (
      this.overlays.plannerSessionHandle !== undefined &&
      pendingTopPlannerSessionAction !== undefined
    ) {
      showPlannerSessionOverlay({
        state: this.overlays,
        tui: this.tui,
        plannerSessionOverlay: this.plannerSessionOverlay,
        viewModels: this.viewModels,
        pendingAction: pendingTopPlannerSessionAction,
      });
    }
    if (this.overlays.transcriptHandle !== undefined) {
      this.transcriptOverlay.setModel(
        this.viewModels.buildTaskTranscript(
          selectedNode?.taskId,
          this.monitorOverlay.getLogs(),
        ),
      );
    }

    this.composer.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        buildComposerSlashCommands({
          snapshot,
          selection: this.currentSelection(),
        }),
      ),
    );
    this.monitorOverlay.setSelectedWorker(this.selectedWorkerId);
    if (this.started && this.interactiveTerminal) {
      this.tui.requestRender();
    }
  }

  dispose(): void {
    if (!this.started) {
      return;
    }

    hideAllOverlays(this.overlays);
    this.tui.stop();
    this.started = false;
  }

  onWorkerOutput(runId: string, taskId: string, text: string): void {
    this.selectedWorkerId = pushWorkerOutput({
      monitorOverlay: this.monitorOverlay,
      runId,
      taskId,
      text,
    });
    const now = Date.now();
    if (
      shouldRenderAfterWorkerOutput(
        this.lastWorkerRenderAt,
        now,
        this.workerRenderIntervalMs,
      )
    ) {
      this.lastWorkerRenderAt = now;
      this.refresh();
    }
  }

  private handleInput(data: string): boolean {
    return handleGraphInput({
      data,
      focusMode: this.focusMode,
      composerText: this.composerText,
      hasVisibleOverlay: this.hasVisibleOverlay(),
      hideTopOverlay: () => this.hideTopOverlay(),
      focusGraph: () => this.focusGraph(),
      focusComposer: (seedText) => this.focusComposer(seedText),
      moveSelection: (step) => this.moveSelection(step),
      commands: this.commands.getAll(),
      commandContext: this.commandContext,
      executeByKey: (key, context) => this.commands.executeByKey(key, context),
    });
  }

  private async executeSlashCommand(input: string): Promise<string> {
    return executeSlashCommand({
      input,
      commandContext: this.commandContext,
      notice: this.notice,
      dataSource: this.deps,
      proposalController: this.proposalController,
      currentSelection: this.currentSelection(),
      setSelectedNodeId: (nodeId) => {
        this.selectedNodeId = nodeId;
      },
      executePendingTopPlannerSessionChoice: (sessionMode) =>
        this.executePendingTopPlannerSessionChoice(sessionMode),
    });
  }

  private requestTopPlannerSessionSelection(
    action: PendingTopPlannerSessionAction,
  ): string | undefined {
    if (!hasReusableTopPlannerSession(this.deps.getTopPlannerRun())) {
      return undefined;
    }

    this.pendingTopPlannerSessionAction = action;
    showPlannerSessionOverlay({
      state: this.overlays,
      tui: this.tui,
      plannerSessionOverlay: this.plannerSessionOverlay,
      viewModels: this.viewModels,
      pendingAction: action,
    });
    this.notice =
      action.kind === 'submit'
        ? 'Choose continue or fresh for top-level planning.'
        : 'Choose continue or fresh for top-planner rerun.';
    this.refresh();
    return this.notice;
  }

  private requestTopPlannerRerunSelection(): boolean {
    return (
      this.requestTopPlannerSessionSelection({ kind: 'rerun' }) !== undefined
    );
  }

  private executePendingTopPlannerSessionChoice(
    sessionMode: PlannerSessionMode,
  ): string {
    const action = this.pendingTopPlannerSessionAction;
    if (action === undefined) {
      throw new Error('no pending planner session choice');
    }

    this.clearPendingTopPlannerSessionChoice();
    if (action.kind === 'submit') {
      return this.deps.requestTopLevelPlan(action.prompt, { sessionMode });
    }

    this.deps.rerunTopPlannerProposal({ sessionMode });
    return 'Requested rerun for top-planner.';
  }

  private clearPendingTopPlannerSessionChoice(): void {
    this.pendingTopPlannerSessionAction = undefined;
    this.overlays.plannerSessionHandle?.hide();
    this.overlays.plannerSessionHandle = undefined;
  }

  private displayedSnapshot(): GraphSnapshot {
    return displayedSnapshot(
      this.deps.snapshot(),
      this.proposalController.getDraftSnapshot(),
    );
  }

  private hasVisibleOverlay(): boolean {
    return hasVisibleOverlay(this.overlays);
  }

  private hideTopOverlay(): boolean {
    return hideTopOverlay({
      state: this.overlays,
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
      onHidePlannerSession: () => {
        this.pendingTopPlannerSessionAction = undefined;
      },
    });
  }

  private moveSelection(step: number): void {
    const result = shiftSelection({
      viewModels: this.viewModels,
      snapshot: this.displayedSnapshot(),
      runs: this.deps.listAgentRuns(),
      selectedNodeId: this.selectedNodeId,
      step,
    });
    this.selectedNodeId = result.selectedNodeId;
    this.notice = result.notice;
    this.refresh();
  }

  private currentSelection() {
    return buildCurrentSelection({
      viewModels: this.viewModels,
      snapshot: this.displayedSnapshot(),
      runs: this.deps.listAgentRuns(),
      selectedNodeId: this.selectedNodeId,
    });
  }

  private focusComposer(seedText?: string): void {
    this.focusMode = 'composer';
    if (seedText !== undefined && this.composerText.trim().length === 0) {
      this.composer.setText(seedText);
      this.composerText = seedText;
    }
    this.tui.setFocus(this.composer);
    this.refresh();
  }

  private focusGraph(): void {
    this.focusMode = 'graph';
    this.tui.setFocus(null);
    this.refresh();
  }

  private selectedMilestoneId(): MilestoneId | undefined {
    return selectedMilestoneIdFromNode(this.selectedNode());
  }

  private selectedFeatureId(): FeatureId | undefined {
    return selectedFeatureIdFromNode(this.selectedNode());
  }

  private selectedNode() {
    return resolveSelectedNode({
      viewModels: this.viewModels,
      snapshot: this.displayedSnapshot(),
      runs: this.deps.listAgentRuns(),
      selectedNodeId: this.selectedNodeId,
    });
  }

  private toggleHelpOverlay(): void {
    toggleHelpOverlay({
      state: this.overlays,
      tui: this.tui,
      helpOverlay: this.helpOverlay,
      navigationKeybinds: NAVIGATION_KEYBINDS,
      commandEntries: this.commands.getAll(),
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleAgentMonitorOverlay(): void {
    toggleAgentMonitorOverlay({
      state: this.overlays,
      tui: this.tui,
      monitorOverlay: this.monitorOverlay,
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleDependencyOverlay(): void {
    toggleDependencyOverlay({
      state: this.overlays,
      tui: this.tui,
      dependencyOverlay: this.dependencyOverlay,
      viewModels: this.viewModels,
      snapshot: this.displayedSnapshot(),
      selectedFeatureId: this.selectedFeatureId(),
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleInboxOverlay(): void {
    toggleInboxOverlay({
      state: this.overlays,
      tui: this.tui,
      inboxOverlay: this.inboxOverlay,
      viewModels: this.viewModels,
      items: this.deps.listInboxItems(),
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private togglePlannerAuditOverlay(): void {
    const selectedFeatureId = this.selectedFeatureId();
    togglePlannerAuditOverlay({
      state: this.overlays,
      tui: this.tui,
      plannerAuditOverlay: this.plannerAuditOverlay,
      viewModels: this.viewModels,
      entries: this.deps.listPlannerAuditEntries(
        selectedFeatureId === undefined
          ? undefined
          : { featureId: selectedFeatureId },
      ),
      selectedFeatureId,
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleProposalReviewOverlay(): void {
    const pendingProposal = pendingProposalForSelection({
      draftState: this.proposalController.getDraftState(),
      selectedFeatureId: this.selectedFeatureId(),
      authoritativeSnapshot: this.deps.snapshot(),
      getFeatureRun: (featureId, phase) =>
        this.deps.getFeatureRun(featureId, phase),
      getTopPlannerRun: () => this.deps.getTopPlannerRun(),
    });
    toggleProposalReviewOverlay({
      state: this.overlays,
      tui: this.tui,
      proposalReviewOverlay: this.proposalReviewOverlay,
      viewModels: this.viewModels,
      pendingProposal,
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleMergeTrainOverlay(): void {
    toggleMergeTrainOverlay({
      state: this.overlays,
      tui: this.tui,
      mergeTrainOverlay: this.mergeTrainOverlay,
      viewModels: this.viewModels,
      snapshot: this.displayedSnapshot(),
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleConfigOverlay(): void {
    toggleConfigOverlay({
      state: this.overlays,
      tui: this.tui,
      configOverlay: this.configOverlay,
      viewModels: this.viewModels,
      getConfig: () => this.deps.getConfig(),
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }

  private toggleTranscriptOverlay(): void {
    toggleTranscriptOverlay({
      state: this.overlays,
      tui: this.tui,
      transcriptOverlay: this.transcriptOverlay,
      viewModels: this.viewModels,
      taskId: this.selectedNode()?.taskId,
      logs: this.monitorOverlay.getLogs(),
      refresh: () => this.refresh(),
      setNotice: (notice) => {
        this.notice = notice;
      },
    });
  }
}
