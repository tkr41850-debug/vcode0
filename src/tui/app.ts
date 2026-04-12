import type { Store, UiPort } from '@orchestrator/ports/index';
import {
  AgentMonitorOverlay,
  type Component,
  DagView,
  StatusBar,
} from '@tui/components/index';
import { TuiViewModelBuilder } from '@tui/view-model/index';

export interface TuiAppOptions {
  /** Store used to populate view models. If omitted, app renders an empty frame. */
  store?: Store;
  /** Poll interval for store snapshots, in milliseconds. */
  pollIntervalMs?: number;
  /** Frame writer; defaults to process.stdout. Injected by tests. */
  writeFrame?: (lines: string[]) => void;
}

/**
 * Bootstrap TUI renderer. Writes plain-text frames derived from the live
 * store snapshot — later phases will promote this to a differential pi-tui
 * component tree. show() blocks until dispose() is called (same contract as
 * the previous StubUiPort).
 */
export class TuiApp implements UiPort {
  private readonly dag = new DagView();
  private readonly status = new StatusBar();
  private readonly overlay = new AgentMonitorOverlay();
  private readonly builder = new TuiViewModelBuilder();
  private readonly store: Store | undefined;
  private readonly pollIntervalMs: number;
  private readonly writeFrame: (lines: string[]) => void;

  private pollTimer: NodeJS.Timeout | undefined;
  private resolveShow: (() => void) | undefined;
  private disposed = false;

  constructor(options: TuiAppOptions = {}) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.writeFrame =
      options.writeFrame ??
      ((lines: string[]): void => {
        process.stdout.write(`${lines.join('\n')}\n`);
      });
  }

  async show(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.refreshFromStore();
    this.renderFrame();
    if (this.store !== undefined && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval((): void => {
        void this.refreshFromStore().then((): void => {
          this.renderFrame();
        });
      }, this.pollIntervalMs);
      if (typeof this.pollTimer.unref === 'function') {
        this.pollTimer.unref();
      }
    }
    return new Promise<void>((resolve): void => {
      this.resolveShow = resolve;
    });
  }

  refresh(): void {
    for (const component of [
      this.dag,
      this.status,
      this.overlay,
    ] as Component[]) {
      component.invalidate();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.resolveShow !== undefined) {
      this.resolveShow();
      this.resolveShow = undefined;
    }
  }

  private async refreshFromStore(): Promise<void> {
    if (this.store === undefined) {
      return;
    }
    const [milestones, features, tasks, runs] = await Promise.all([
      this.store.listMilestones(),
      this.store.listFeatures(),
      this.store.listTasks(),
      this.store.listAgentRuns(),
    ]);
    this.dag.setTree(
      this.builder.buildMilestoneTree(milestones, features, tasks, runs),
    );
    const runningWorkers = runs.filter((r) => r.runStatus === 'running').length;
    const completedTasks = tasks.filter((t) => t.status === 'done').length;
    this.status.setData({
      runningWorkers,
      idleWorkers: 0,
      completedTasks,
      totalTasks: tasks.length,
      totalUsd: 0,
    });
  }

  private renderFrame(): void {
    const width = 80;
    const lines: string[] = [];
    lines.push('gvc0 — DAG');
    lines.push('');
    lines.push(...this.dag.render(width));
    lines.push('');
    lines.push(...this.status.render(width));
    const overlayLines = this.overlay.render(width);
    if (overlayLines.length > 0) {
      lines.push('');
      lines.push(...overlayLines);
    }
    this.writeFrame(lines);
  }
}
