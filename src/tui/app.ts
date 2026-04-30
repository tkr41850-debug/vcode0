import type { GraphSnapshot } from '@core/graph/index';
import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import type {
  FeatureId,
  MilestoneId,
  ProposalPhaseDetails,
} from '@core/types/index';
import { Editor, ProcessTerminal, TUI } from '@mariozechner/pi-tui';
import type { ProposalOpScopeRef, UiPort } from '@orchestrator/ports/index';
import {
  buildComposerSlashCommands,
  CommandRegistry,
  NAVIGATION_KEYBINDS,
  type TuiCommandContext,
} from '@tui/commands/index';
import {
  AgentMonitorOverlay,
  ComposerStatus,
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  StatusBar,
} from '@tui/components/index';
import { DelegatingAutocompleteProvider } from '@tui/composer-autocomplete';
import {
  type LivePlannerEntry,
  LivePlannerSessions,
} from '@tui/live-planner-sessions';
import { ComposerProposalController } from '@tui/proposal-controller';
import { TuiViewModelBuilder } from '@tui/view-model/index';

import { createTuiCommandContext } from './app-command-context.js';
import {
  executeSlashCommand,
  handleComposerSubmit,
  routePlainTextInput,
} from './app-composer.js';
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
  toggleAgentMonitorOverlay,
  toggleDependencyOverlay,
  toggleHelpOverlay,
} from './app-overlays.js';
import {
  buildFlattenedNodes,
  displayedSnapshot,
  findSelectedNode,
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
  private readonly helpOverlay = new HelpOverlay();
  private readonly commands = new CommandRegistry();
  private readonly viewModels = new TuiViewModelBuilder();
  private readonly proposalController: ComposerProposalController;
  private readonly overlays: OverlayState = {
    monitorHandle: undefined,
    dependencyHandle: undefined,
    helpHandle: undefined,
  };
  private started = false;
  private selectedNodeId: string | undefined;
  private selectedWorkerId: string | undefined;
  private notice: string | undefined;
  private focusMode: 'composer' | 'graph' = 'composer';
  private composerText = '';
  private readonly commandContext: TuiCommandContext;
  private readonly livePlannerSessions = new LivePlannerSessions();
  private activeLivePlannerEntry: LivePlannerEntry | undefined;

  constructor(private readonly deps: TuiAppDeps) {
    this.proposalController = new ComposerProposalController({
      snapshot: () => this.deps.snapshot(),
      isAutoExecutionEnabled: () => this.deps.isAutoExecutionEnabled(),
      setAutoExecutionEnabled: (enabled) =>
        this.deps.setAutoExecutionEnabled(enabled),
      getFeatureRun: (featureId, phase) =>
        this.deps.getFeatureRun(featureId, phase),
      saveFeatureRun: (run) => this.deps.saveFeatureRun(run),
      enqueueApprovalDecision: (event) => {
        this.deps.enqueueApprovalDecision(event);
      },
      enqueueRerun: (event) => {
        this.deps.rerunFeatureProposal(event);
      },
    });

    this.composer.setAutocompleteProvider(
      new DelegatingAutocompleteProvider(() => ({
        commands: buildComposerSlashCommands({
          snapshot:
            this.proposalController.getDraftSnapshot() ?? this.deps.snapshot(),
          selection: this.currentSelection(),
        }),
      })),
    );
    this.composer.onChange = (text) => {
      this.composerText = text;
      this.refresh();
    };
    this.composer.onSubmit = (text) => {
      void handleComposerSubmit({
        text,
        executeSlashCommand: (input) => this.executeSlashCommand(input),
        executePlainText: (input) => this.executePlainText(input),
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
    const runs = this.deps.listAgentRuns();
    const draftState = this.proposalController.getDraftState();
    const draftSnapshot = this.proposalController.getDraftSnapshot();
    const baseSnapshot = draftSnapshot ?? this.deps.snapshot();
    const baseFlattened = buildFlattenedNodes(
      this.viewModels,
      baseSnapshot,
      runs,
    );
    this.selectedNodeId = resolveSelectedNodeId(
      baseFlattened,
      this.selectedNodeId,
    );
    const selectedNode = findSelectedNode(baseFlattened, this.selectedNodeId);
    const selectedFeatureIdResolved = selectedFeatureIdFromNode(selectedNode);

    const pendingRun = pendingProposalForSelection({
      draftState,
      selectedFeatureId: selectedFeatureIdResolved,
      authoritativeSnapshot: this.deps.snapshot(),
      getFeatureRun: (featureId, phase) =>
        this.deps.getFeatureRun(featureId, phase),
    });
    const pendingTaskRun = pendingTaskRunForSelection({
      draftState,
      selectedTaskId: selectedNode?.taskId,
      getTaskRun: (taskId) => this.deps.getTaskRun(taskId),
    });
    this.activeLivePlannerEntry =
      draftState === undefined && pendingRun === undefined
        ? this.livePlannerSessions.findForFeature(selectedFeatureIdResolved)
        : undefined;
    const liveProposalEntry = this.activeLivePlannerEntry;
    const snapshot = displayedSnapshot(
      this.deps.snapshot(),
      draftSnapshot,
      liveProposalEntry?.snapshot,
    );

    // Detect operator-attached run on the selected feature for composer-strip
    // feedback. Persisted state is the source of truth (Phase 6.2 marker:
    // owner='manual' AND attention='operator' AND phase ∈ {plan,replan}).
    const attachedFeature =
      selectedFeatureIdResolved !== undefined
        ? baseSnapshot.features.find((f) => f.id === selectedFeatureIdResolved)
        : undefined;
    const attachedPhase =
      attachedFeature?.workControl === 'planning'
        ? 'plan'
        : attachedFeature?.workControl === 'replanning'
          ? 'replan'
          : undefined;
    const attachedRun =
      selectedFeatureIdResolved !== undefined && attachedPhase !== undefined
        ? this.deps.getFeatureRun(selectedFeatureIdResolved, attachedPhase)
        : undefined;
    const attachedView =
      attachedRun !== undefined &&
      attachedRun.owner === 'manual' &&
      attachedRun.attention === 'operator' &&
      (attachedRun.runStatus === 'running' ||
        attachedRun.runStatus === 'await_response')
        ? {
            featureId: selectedFeatureIdResolved as FeatureId,
            phase: attachedPhase as 'plan' | 'replan',
            runStatus: attachedRun.runStatus,
          }
        : undefined;
    const nodes = this.viewModels.buildMilestoneTree(
      snapshot.milestones,
      snapshot.features,
      snapshot.tasks,
      runs,
    );

    const dataMode: 'live' | 'draft' | 'live-planner' =
      draftState !== undefined
        ? 'draft'
        : liveProposalEntry !== undefined
          ? 'live-planner'
          : 'live';
    const dagTitle =
      draftState !== undefined
        ? 'gvc0 progress [draft]'
        : attachedView !== undefined
          ? 'gvc0 progress [attached]'
          : liveProposalEntry !== undefined
            ? 'gvc0 progress [live planner]'
            : 'gvc0 progress';

    this.dagView.setModel(
      nodes,
      this.selectedNodeId,
      dagTitle,
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
        dataMode,
        focusMode: this.focusMode,
        ...(pendingRun !== undefined
          ? { pendingProposalPhase: pendingRun.phase }
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
        ...(pendingRun !== undefined
          ? {
              pendingProposalPhase: pendingRun.phase,
              pendingFeatureId: pendingRun.scopeId,
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
        ...(liveProposalEntry !== undefined
          ? {
              liveProposalFeatureId: liveProposalEntry.scope.featureId,
              liveProposalPhase: liveProposalEntry.scope.phase,
              liveProposalOpCount: liveProposalEntry.opCount,
              liveProposalSubmissionCount: liveProposalEntry.submissionCount,
            }
          : {}),
        ...(attachedView !== undefined
          ? {
              attachedFeatureId: attachedView.featureId,
              attachedPhase: attachedView.phase,
              attachedRunStatus: attachedView.runStatus,
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
              baseSnapshot.milestones,
              baseSnapshot.features,
            ),
      );
    }

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
    this.refresh();
  }

  onProposalOp(
    scope: ProposalOpScopeRef,
    _op: GraphProposalOp,
    draftSnapshot: GraphSnapshot,
  ): void {
    this.livePlannerSessions.recordOp(scope, draftSnapshot);
    this.refresh();
  }

  onProposalSubmitted(
    scope: ProposalOpScopeRef,
    _details: ProposalPhaseDetails,
    _proposal: GraphProposal,
    submissionIndex: number,
  ): void {
    this.livePlannerSessions.recordSubmit(
      scope,
      submissionIndex,
      this.deps.snapshot(),
    );
    this.refresh();
  }

  onProposalPhaseEnded(
    scope: ProposalOpScopeRef,
    _outcome: 'completed' | 'failed',
  ): void {
    this.livePlannerSessions.end(scope.agentRunId);
    this.refresh();
  }

  /**
   * @internal Test/inspection accessor: exposes current live-planner mirror
   * state (tracked sessions count + active entry resolved against current
   * selection). Updated as part of refresh(). Production code MUST NOT call.
   */
  getLivePlannerStateForTests(): {
    sessionCount: number;
    activeEntry: LivePlannerEntry | undefined;
  } {
    return {
      sessionCount: this.livePlannerSessions.size(),
      activeEntry: this.activeLivePlannerEntry,
    };
  }

  /**
   * @internal Test seam: drives the selection state that refresh() resolves
   * against. Production code MUST NOT call.
   */
  setSelectedNodeIdForTests(nodeId: string | undefined): void {
    this.selectedNodeId = nodeId;
  }

  private handleInput(data: string): boolean {
    return handleGraphInput({
      data,
      focusMode: this.focusMode,
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
    });
  }

  private async executePlainText(text: string): Promise<string> {
    return routePlainTextInput({
      text,
      selection: this.currentSelection(),
      snapshot: this.deps.snapshot(),
      dataSource: this.deps,
      draftActive: this.proposalController.getDraftState() !== undefined,
    });
  }

  private displayedSnapshot(): GraphSnapshot {
    return displayedSnapshot(
      this.deps.snapshot(),
      this.proposalController.getDraftSnapshot(),
      this.activeLivePlannerEntry?.snapshot,
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
}
