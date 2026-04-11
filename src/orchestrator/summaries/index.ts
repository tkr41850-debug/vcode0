import type { Feature } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class SummaryCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  async summarize(feature: Feature): Promise<void> {
    const tasks = await this.ports.store.listTasks();
    const featureTasks = tasks.filter((t) => t.featureId === feature.id);
    const summary = `Feature "${feature.name}": ${featureTasks.length} task(s) completed.`;

    await this.ports.store.updateFeature(feature.id, { summary });
    await this.ports.store.appendEvent({
      eventType: 'feature_summarized',
      entityId: feature.id,
      timestamp: Date.now(),
      payload: { summary },
    });
  }

  async skip(feature: Feature): Promise<void> {
    await this.ports.store.appendEvent({
      eventType: 'summary_skipped',
      entityId: feature.id,
      timestamp: Date.now(),
    });
  }
}
