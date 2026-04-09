import type { UiPort } from '@orchestrator/ports/index';
import type { Component } from '@tui/components/index';
import { AgentMonitorOverlay, DagView, StatusBar } from '@tui/components/index';

export class TuiApp implements UiPort {
  private readonly components: Component[];

  constructor() {
    this.components = [
      new DagView(),
      new StatusBar(),
      new AgentMonitorOverlay(),
    ];
  }

  show(): Promise<void> {
    void this.components;
    return Promise.resolve();
  }

  refresh(): void {
    for (const component of this.components) {
      component.invalidate();
    }
  }

  dispose(): void {}
}
