import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRunPhase,
  FeatureId,
  VerificationSummary,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';

export type SchedulerEvent =
  | {
      type: 'worker_message';
      message: WorkerToOrchestratorMessage;
    }
  | {
      type: 'feature_phase_complete';
      featureId: FeatureId;
      phase: AgentRunPhase;
      summary: string;
      verification?: VerificationSummary;
    }
  | {
      type: 'feature_phase_error';
      featureId: FeatureId;
      phase: AgentRunPhase;
      error: string;
    }
  | {
      type: 'shutdown';
    };

export class SchedulerLoop {
  private readonly events: SchedulerEvent[] = [];

  constructor(
    private readonly graph: FeatureGraph,
    private readonly ports: OrchestratorPorts,
  ) {}

  enqueue(event: SchedulerEvent): void {
    this.events.push(event);
  }

  run(): Promise<void> {
    this.ports.ui.refresh();
    void this.graph;
    void this.events;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.enqueue({ type: 'shutdown' });
    return this.ports.runtime.stopAll();
  }
}
