import type { GraphSnapshot } from '@core/graph/index';
import type { FeatureId, MilestoneId } from '@core/types/index';
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
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  StatusBar,
} from '@tui/components/index';
import { ComposerProposalController } from '@tui/proposal-controller';
import { TuiViewModelBuilder } from '@tui/view-model/index';

import { createTuiCommandContext } from './app-command-context.js';
import { executeSlashCommand, handleComposerSubmit } from './app-composer.js';
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
  resolveSelectedNodeId,
  selectedFeatureIdFromNode,
  selectedMilestoneIdFromNode,
} from './app-state.js';
import type { TuiDataSource } from './data-source.js';

export type { AgentRun, FeaturePhaseAgentRun } from '@core/types/index';
export type { InitializeProjectCommand } from '@tui/commands/index';
export type { WorkerCountsViewModel } from '@tui/view-model/index';
export type { TuiDataSource } from './data-source.js';

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

  constructor(private readonly dataSource: TuiDataSource) {
    this.proposalController = new ComposerProposalController({
      snapshot: () => this.dataSource.snapshot(),
      isAutoExecutionEnabled: () => this.dataSource.isAutoExecutionEnabled(),
      setAutoExecutionEnabled: (enabled) =>
        this.dataSource.setAutoExecutionEnabled(enabled),
      getFeatureRun: (featureId, phase) =>
        this.dataSource.getFeatureRun(featureId, phase),
      saveFeatureRun: (run) => this.dataSource.saveFeatureRun(run),
      enqueueApprovalDecision: (event) => {
        this.dataSource.enqueueApprovalDecision(event);
      },
      enqueueRerun: (event) => {
        this.dataSource.rerunFeatureProposal(event);
      },
    });

    this.composer.onChange = (text) => {
      this.composerText = text;
      this.refresh();
    };
    this.composer.onSubmit = (text) => {
      void handleComposerSubmit({
        text,
        executeSlashCommand: (input) => this.executeSlashCommand(input),
        addToHistory: (input) => this.composer.addToHistory(input),
        setNotice: (notice) => {
          this.notice = notice;
        },
        refresh: () => this.refresh(),
      });
    };

    this.commandContext = createTuiCommandContext({
      dataSource: this.dataSource,
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
    const snapshot = this.displayedSnapshot();
    const runs = this.dataSource.listAgentRuns();
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
    const pendingRun = pendingProposalForSelection({
      draftState,
      selectedFeatureId: this.selectedFeatureId(),
      authoritativeSnapshot: this.dataSource.snapshot(),
      getFeatureRun: (featureId, phase) =>
        this.dataSource.getFeatureRun(featureId, phase),
    });

    this.dagView.setModel(
      nodes,
      this.selectedNodeId,
      draftState !== undefined ? 'gvc0 progress [draft]' : 'gvc0 progress',
      nodes.length === 0 ? this.viewModels.buildEmptyState() : undefined,
    );
    this.statusBar.setModel(
      this.viewModels.buildStatusBar({
        tasks: snapshot.tasks,
        workerCounts: this.dataSource.getWorkerCounts(),
        autoExecutionEnabled: this.dataSource.isAutoExecutionEnabled(),
        keybindHints: [...NAVIGATION_KEYBINDS, ...this.commands.getAll()],
        ...(selectedNode !== undefined
          ? { selectedLabel: selectedNode.label }
          : {}),
        ...(this.notice !== undefined ? { notice: this.notice } : {}),
        dataMode: draftState !== undefined ? 'draft' : 'live',
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
    this.refresh();
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
      dataSource: this.dataSource,
      proposalController: this.proposalController,
      currentSelection: this.currentSelection(),
      setSelectedNodeId: (nodeId) => {
        this.selectedNodeId = nodeId;
      },
    });
  }

  private displayedSnapshot(): GraphSnapshot {
    return displayedSnapshot(
      this.dataSource.snapshot(),
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
    });
  }

  private moveSelection(step: number): void {
    const result = shiftSelection({
      viewModels: this.viewModels,
      snapshot: this.displayedSnapshot(),
      runs: this.dataSource.listAgentRuns(),
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
      runs: this.dataSource.listAgentRuns(),
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
      runs: this.dataSource.listAgentRuns(),
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
