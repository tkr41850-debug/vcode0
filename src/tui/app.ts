import type { GraphSnapshot } from '@core/graph/index';
import type { AgentRun, FeatureId, MilestoneId } from '@core/types/index';
import {
  Key,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  TUI,
} from '@mariozechner/pi-tui';
import type { UiPort } from '@orchestrator/ports/index';
import {
  CommandRegistry,
  NAVIGATION_KEYBINDS,
  type TuiCommandContext,
  type TuiCommandKey,
} from '@tui/commands/index';
import {
  AgentMonitorOverlay,
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  StatusBar,
} from '@tui/components/index';
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
  toggleAutoExecution(): boolean;
  toggleMilestoneQueue(milestoneId: MilestoneId): void;
  cancelFeature(featureId: FeatureId): void;
  quit(): Promise<void>;
}

export class TuiApp implements UiPort {
  private readonly interactiveTerminal =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal);
  private readonly dagView = new DagView();
  private readonly statusBar = new StatusBar();
  private readonly monitorOverlay = new AgentMonitorOverlay();
  private readonly dependencyOverlay = new DependencyDetailOverlay();
  private readonly helpOverlay = new HelpOverlay();
  private readonly commands = new CommandRegistry();
  private readonly viewModels = new TuiViewModelBuilder();
  private monitorHandle: OverlayHandle | undefined;
  private dependencyHandle: OverlayHandle | undefined;
  private helpHandle: OverlayHandle | undefined;
  private started = false;
  private selectedNodeId: string | undefined;
  private selectedWorkerId: string | undefined;
  private notice: string | undefined;
  private readonly commandContext: TuiCommandContext;

  constructor(private readonly dataSource: TuiDataSource) {
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
    this.tui.addInputListener((data) => {
      return this.handleInput(data) ? { consume: true } : undefined;
    });
    this.tui.start();
    this.started = true;
    this.refresh();
  }

  refresh(): void {
    const { milestones, features, tasks } = this.dataSource.snapshot();
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
    this.dagView.setModel(nodes, this.selectedNodeId, 'gvc0 progress');
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
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return true;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
      return this.hideTopOverlay();
    }
    if (matchesKey(data, 'q') && this.hasVisibleOverlay()) {
      return this.hideTopOverlay();
    }

    const commandKey = this.matchCommandKey(data);
    if (commandKey === undefined) {
      return false;
    }

    void this.commands.executeByKey(commandKey, this.commandContext);
    return true;
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
    const { milestones, features, tasks } = this.dataSource.snapshot();
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
    const { milestones, features, tasks } = this.dataSource.snapshot();
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
      maxHeight: '60%',
      anchor: 'bottom-center',
      offsetY: -1,
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

    const { milestones, features } = this.dataSource.snapshot();
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
