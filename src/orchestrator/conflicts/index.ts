import type {
  Feature,
  FeatureId,
  Task,
  TaskId,
  TaskSuspendReason,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export interface OverlapIncident {
  featureId: FeatureId;
  taskIds: TaskId[];
  files: string[];
  blockedByFeatureId?: FeatureId;
  suspendReason: TaskSuspendReason;
}

export class ConflictCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  async handleSameFeatureOverlap(
    _feature: Feature,
    incident: OverlapIncident,
    tasks: Task[] = [],
  ): Promise<void> {
    const dominantTaskId = incident.taskIds[0];

    for (const task of tasks) {
      if (!incident.taskIds.includes(task.id) || task.id === dominantTaskId) {
        continue;
      }

      // TODO: use simple-git directly to rebase task worktree, then
      // resume or steer the task via this.ports.runtime based on outcome.
      void this.ports;
      void task;
    }
  }

  async handleCrossFeatureOverlap(
    _primary: Feature,
    _secondary: Feature,
    tasks: Task[],
  ): Promise<void> {
    // TODO: use simple-git directly to rebase feature branch, then
    // resume or steer affected tasks via this.ports.runtime based on outcome.
    void tasks;
  }
}
