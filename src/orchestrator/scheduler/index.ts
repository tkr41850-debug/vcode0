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

  async run(): Promise<void> {
    this.ports.ui.refresh();

    // Dispatch ready tasks
    const readyTasks = this.graph.readyTasks();
    const idleCount = this.ports.runtime.idleWorkerCount();
    const toDispatch = readyTasks.slice(0, idleCount);

    for (const task of toDispatch) {
      await this.ports.runtime.dispatchTask(task, {
        mode: 'start',
        agentRunId: `run-${task.id}`,
      });
    }

    // Drain enqueued events
    while (this.events.length > 0) {
      const event = this.events.shift()!;
      if (event.type === 'shutdown') {
        return;
      }
    }
  }

  stop(): Promise<void> {
    this.enqueue({ type: 'shutdown' });
    return this.ports.runtime.stopAll();
  }
}
