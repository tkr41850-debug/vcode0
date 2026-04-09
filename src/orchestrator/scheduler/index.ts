import type { FeatureGraph } from '@core/graph/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class SchedulerLoop {
  constructor(
    private readonly graph: FeatureGraph,
    private readonly ports: OrchestratorPorts,
  ) {}

  run(): Promise<void> {
    this.ports.ui.refresh();
    void this.graph;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return this.ports.runtime.stopAll();
  }
}
