import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  Feature,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
} from '@core/types/index';
import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  TUI,
} from '@mariozechner/pi-tui';
import type { UiPort } from '@orchestrator/ports/index';
import {
  buildComposerSlashCommands,
  CommandRegistry,
  type ComposerSelection,
  NAVIGATION_KEYBINDS,
  parseSlashCommand,
  type TuiCommandContext,
  type TuiCommandKey,
} from '@tui/commands/index';
import {
  AgentMonitorOverlay,
  ComposerStatus,
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  StatusBar,
} from '@tui/components/index';
import {
  type ComposerDraftState,
  ComposerProposalController,
} from '@tui/proposal-controller';
import {
  type DagNodeViewModel,
  flattenDagNodes,
  TuiViewModelBuilder,
  type WorkerCountsViewModel,
} from '@tui/view-model/index';

export interface TuiDataSource {
  snapshot(): GraphSnapshot;
  listAgentRuns(): AgentRun[];
  getWorkerCounts(): WorkerCountsViewModel;
  isAutoExecutionEnabled(): boolean;
  setAutoExecutionEnabled(enabled: boolean): boolean;
  toggleAutoExecution(): boolean;
  toggleMilestoneQueue(milestoneId: MilestoneId): void;
  cancelFeature(featureId: FeatureId): void;
  saveFeatureRun(run: FeaturePhaseAgentRun): void;
  getFeatureRun(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ): FeaturePhaseAgentRun | undefined;
  enqueueApprovalDecision(event: {
    featureId: FeatureId;
    phase: 'plan' | 'replan';
    decision: 'approved' | 'rejected';
    comment?: string;
  }): void;
  rerunFeatureProposal(event: {
    featureId: FeatureId;
    phase: 'plan' | 'replan';
  }): void;
  quit(): Promise<void>;
}

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
  private monitorHandle: OverlayHandle | undefined;
  private dependencyHandle: OverlayHandle | undefined;
  private helpHandle: OverlayHandle | undefined;
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
      void this.handleComposerSubmit(text);
    };

    this.commandContext = {
      toggleAutoExecution: () => {
        const enabled = this.dataSource.toggleAutoExecution();
        this.notice = enabled ? 'auto execution on' : 'auto execution paused';
        this.refresh();
      },
      toggleMilestoneQueue: () => {
        const milestoneId = this.selectedMilestoneId();
        if (milestoneId === undefined) {
          this.notice = 'select milestone first';
          this.refresh();
          return;
        }
        this.dataSource.toggleMilestoneQueue(milestoneId);
        this.notice = `toggled queue for ${milestoneId}`;
        this.refresh();
      },
      toggleAgentMonitor: () => {
        this.toggleAgentMonitorOverlay();
      },
      selectNextWorker: () => {
        const workerId = this.monitorOverlay.cycleSelection();
        this.selectedWorkerId = workerId;
        if (workerId === undefined) {
          this.notice = 'no workers yet';
        } else {
          this.notice = `selected worker ${workerId}`;
        }
        this.refresh();
      },
      toggleHelp: () => {
        this.toggleHelpOverlay();
      },
      toggleDependencyDetail: () => {
        this.toggleDependencyOverlay();
      },
      cancelSelectedFeature: () => {
        const featureId = this.selectedFeatureId();
        if (featureId === undefined) {
          this.notice = 'select feature first';
          this.refresh();
          return;
        }
        this.dataSource.cancelFeature(featureId);
        this.notice = `cancelled ${featureId}`;
        this.refresh();
      },
      requestQuit: () => {
        void this.dataSource.quit();
      },
    };
  }

  async show(): Promise<void> {
    if (this.started) {
      this.refresh();
      return;
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
  }

  refresh(): void {
    const snapshot = this.displayedSnapshot();
    const { milestones, features, tasks } = snapshot;
    const runs = this.dataSource.listAgentRuns();
    const nodes = this.viewModels.buildMilestoneTree(
      milestones,
      features,
      tasks,
      runs,
    );
    const flattened = flattenDagNodes(nodes);

    if (flattened.length === 0) {
      this.selectedNodeId = undefined;
    } else if (
      this.selectedNodeId === undefined ||
      !flattened.some((node) => node.id === this.selectedNodeId)
    ) {
      this.selectedNodeId = flattened[0]?.id;
    }

    const selectedNode = flattened.find(
      (node) => node.id === this.selectedNodeId,
    );
    const draftState = this.proposalController.getDraftState();
    const pendingRun = this.pendingProposalForSelection();

    this.dagView.setModel(
      nodes,
      this.selectedNodeId,
      draftState !== undefined ? 'gvc0 progress [draft]' : 'gvc0 progress',
    );
    this.statusBar.setModel(
      this.viewModels.buildStatusBar({
        tasks,
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
    if (this.dependencyHandle !== undefined) {
      this.dependencyOverlay.setDetail(
        selectedFeatureId === undefined
          ? undefined
          : this.viewModels.buildDependencyDetail(
              selectedFeatureId,
              milestones,
              features,
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

    this.monitorHandle?.hide();
    this.monitorHandle = undefined;
    this.dependencyHandle?.hide();
    this.dependencyHandle = undefined;
    this.helpHandle?.hide();
    this.helpHandle = undefined;
    this.tui.stop();
    this.started = false;
  }

  onWorkerOutput(runId: string, taskId: string, text: string): void {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const timestamp = Date.now();

    for (const line of lines) {
      this.monitorOverlay.upsertLog(runId, taskId, line, timestamp);
    }

    this.selectedWorkerId = this.monitorOverlay.getSelectedWorkerId();
    this.refresh();
  }

  private handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
      if (this.hideTopOverlay()) {
        return true;
      }
      if (
        this.focusMode === 'composer' &&
        this.composerText.trim().length === 0
      ) {
        this.focusGraph();
        return true;
      }
      if (this.focusMode === 'graph') {
        this.focusComposer();
        return true;
      }
      return false;
    }
    if (matchesKey(data, 'q') && this.hasVisibleOverlay()) {
      return this.hideTopOverlay();
    }

    if (this.focusMode === 'composer') {
      return false;
    }

    if (matchesKey(data, '/')) {
      this.focusComposer('/');
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return true;
    }

    const commandKey = this.matchCommandKey(data);
    if (commandKey === undefined) {
      return false;
    }

    void this.commands.executeByKey(commandKey, this.commandContext);
    return true;
  }

  private async handleComposerSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.notice = undefined;
      this.refresh();
      return;
    }

    if (!trimmed.startsWith('/')) {
      this.notice = 'planner chat not wired yet';
      this.refresh();
      return;
    }

    try {
      const message = await this.executeSlashCommand(trimmed);
      this.composer.addToHistory(trimmed);
      this.notice = message;
    } catch (error) {
      this.notice = formatUnknownError(error);
    }
    this.refresh();
  }

  private async executeSlashCommand(input: string): Promise<string> {
    const parsed = parseSlashCommand(input);

    switch (parsed.name) {
      case 'auto':
        this.commandContext.toggleAutoExecution();
        return this.notice ?? 'toggled auto execution';
      case 'queue':
        this.commandContext.toggleMilestoneQueue();
        return this.notice ?? 'toggled milestone queue';
      case 'monitor':
        this.commandContext.toggleAgentMonitor();
        return this.notice ?? 'toggled monitor';
      case 'worker-next':
        this.commandContext.selectNextWorker();
        return this.notice ?? 'selected next worker';
      case 'help':
        this.commandContext.toggleHelp();
        return this.notice ?? 'toggled help';
      case 'deps':
        this.commandContext.toggleDependencyDetail();
        return this.notice ?? 'toggled dependency detail';
      case 'cancel':
        this.commandContext.cancelSelectedFeature();
        return this.notice ?? 'cancelled feature';
      case 'quit':
        this.commandContext.requestQuit();
        return 'quitting';
      default: {
        const result = await this.proposalController.execute(
          input,
          this.currentSelection(),
        );
        return result.message;
      }
    }
  }

  private displayedSnapshot(): GraphSnapshot {
    return (
      this.proposalController.getDraftSnapshot() ?? this.dataSource.snapshot()
    );
  }

  private pendingProposalForSelection(): FeaturePhaseAgentRun | undefined {
    if (this.proposalController.getDraftState() !== undefined) {
      return undefined;
    }

    const featureId = this.selectedFeatureId();
    if (featureId === undefined) {
      return undefined;
    }

    const feature = this.featureFromAuthoritativeSnapshot(featureId);
    if (feature === undefined) {
      return undefined;
    }

    const phase = phaseForFeature(feature);
    if (phase === undefined) {
      return undefined;
    }

    const run = this.dataSource.getFeatureRun(featureId, phase);
    return run?.runStatus === 'await_approval' ? run : undefined;
  }

  private matchCommandKey(data: string): TuiCommandKey | undefined {
    for (const command of this.commands.getAll()) {
      if (
        (command.key === 'space' && matchesKey(data, Key.space)) ||
        matchesKey(data, command.key)
      ) {
        return command.key;
      }
    }

    return undefined;
  }

  private hasVisibleOverlay(): boolean {
    return (
      this.helpHandle !== undefined ||
      this.monitorHandle !== undefined ||
      this.dependencyHandle !== undefined
    );
  }

  private hideTopOverlay(): boolean {
    if (this.helpHandle !== undefined) {
      this.helpHandle.hide();
      this.helpHandle = undefined;
      this.notice = 'help hidden';
      this.refresh();
      return true;
    }
    if (this.monitorHandle !== undefined) {
      this.monitorHandle.hide();
      this.monitorHandle = undefined;
      this.notice = 'monitor hidden';
      this.refresh();
      return true;
    }
    if (this.dependencyHandle !== undefined) {
      this.dependencyHandle.hide();
      this.dependencyHandle = undefined;
      this.notice = 'dependency detail hidden';
      this.refresh();
      return true;
    }

    return false;
  }

  private moveSelection(step: number): void {
    const { milestones, features, tasks } = this.displayedSnapshot();
    const nodes = flattenDagNodes(
      this.viewModels.buildMilestoneTree(
        milestones,
        features,
        tasks,
        this.dataSource.listAgentRuns(),
      ),
    );
    if (nodes.length === 0) {
      this.selectedNodeId = undefined;
      this.notice = 'nothing to select';
      this.refresh();
      return;
    }

    const currentIndex = nodes.findIndex(
      (node) => node.id === this.selectedNodeId,
    );
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + step + nodes.length) % nodes.length;
    this.selectedNodeId = nodes[nextIndex]?.id;
    this.notice = undefined;
    this.refresh();
  }

  private currentSelection(): ComposerSelection {
    const node = this.selectedNode();
    return {
      ...(node?.milestoneId !== undefined
        ? { milestoneId: node.milestoneId }
        : {}),
      ...(node?.featureId !== undefined ? { featureId: node.featureId } : {}),
      ...(node?.taskId !== undefined ? { taskId: node.taskId } : {}),
    };
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
    const node = this.selectedNode();
    if (node?.kind === 'milestone') {
      return node.milestoneId;
    }
    return node?.milestoneId;
  }

  private selectedFeatureId(): FeatureId | undefined {
    const node = this.selectedNode();
    if (node?.kind === 'feature') {
      return node.featureId;
    }
    if (node?.kind === 'task') {
      return node.featureId;
    }
    return undefined;
  }

  private selectedNode(): DagNodeViewModel | undefined {
    const { milestones, features, tasks } = this.displayedSnapshot();
    const flattened = flattenDagNodes(
      this.viewModels.buildMilestoneTree(
        milestones,
        features,
        tasks,
        this.dataSource.listAgentRuns(),
      ),
    );
    return flattened.find((node) => node.id === this.selectedNodeId);
  }

  private featureFromAuthoritativeSnapshot(
    featureId: FeatureId,
  ): Feature | undefined {
    return this.dataSource
      .snapshot()
      .features.find((feature) => feature.id === featureId);
  }

  private toggleHelpOverlay(): void {
    if (this.helpHandle !== undefined) {
      this.helpHandle.hide();
      this.helpHandle = undefined;
      this.notice = 'help hidden';
      this.refresh();
      return;
    }

    this.helpOverlay.setModel('Help', [
      ...NAVIGATION_KEYBINDS,
      ...this.commands.getAll(),
    ]);
    this.helpHandle = this.tui.showOverlay(this.helpOverlay, {
      width: '70%',
      maxHeight: '60%',
      anchor: 'center',
    });
    this.notice = 'help shown';
    this.refresh();
  }

  private toggleAgentMonitorOverlay(): void {
    if (this.monitorHandle !== undefined) {
      this.monitorHandle.hide();
      this.monitorHandle = undefined;
      this.notice = 'monitor hidden';
      this.refresh();
      return;
    }

    this.monitorHandle = this.tui.showOverlay(this.monitorOverlay, {
      width: '85%',
      maxHeight: '55%',
      anchor: 'bottom-center',
      offsetY: -4,
    });
    this.notice = 'monitor shown';
    this.refresh();
  }

  private toggleDependencyOverlay(): void {
    if (this.dependencyHandle !== undefined) {
      this.dependencyHandle.hide();
      this.dependencyHandle = undefined;
      this.notice = 'dependency detail hidden';
      this.refresh();
      return;
    }

    const { milestones, features } = this.displayedSnapshot();
    const featureId = this.selectedFeatureId();
    this.dependencyOverlay.setDetail(
      featureId === undefined
        ? undefined
        : this.viewModels.buildDependencyDetail(
            featureId,
            milestones,
            features,
          ),
    );
    this.dependencyHandle = this.tui.showOverlay(this.dependencyOverlay, {
      width: '70%',
      maxHeight: '40%',
      anchor: 'center',
    });
    this.notice = 'dependency detail shown';
    this.refresh();
  }
}

function phaseForFeature(feature: Feature): 'plan' | 'replan' | undefined {
  switch (feature.workControl) {
    case 'planning':
      return 'plan';
    case 'replanning':
      return 'replan';
    default:
      return undefined;
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
