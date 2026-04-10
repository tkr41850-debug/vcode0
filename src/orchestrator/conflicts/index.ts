import type { Feature, Task } from '@core/types/index';
import type { OverlapIncident } from '@git';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class ConflictCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  handleSameFeatureOverlap(
    _feature: Feature,
    _incident: OverlapIncident,
  ): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }

  handleCrossFeatureOverlap(
    _primary: Feature,
    _secondary: Feature,
    _tasks: Task[],
  ): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }
}
