import type { FeatureGraph } from '@core/graph/index';
import {
  buildCombinedGraph,
  computeGraphMetrics,
  type ExecutionRunReader,
  prioritizeReadyWork,
  type SchedulableUnit,
  schedulableUnitKey,
} from '@core/scheduling/index';
import type {
  AgentRun,
  AgentRunPhase,
  Feature,
  FeatureId,
  Task,
  TaskAgentRun,
  VerificationSummary,
} from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
import type {
  DispatchTaskResult,
  TaskRuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';

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
      type: 'feature_integration_complete';
      featureId: FeatureId;
    }
  | {
      type: 'feature_integration_failed';
      featureId: FeatureId;
      error: string;
    }
  | {
      type: 'shutdown';
    };

export class SchedulerLoop {
  private readonly events: SchedulerEvent[] = [];
  private readonly readySince = new Map<string, number>();
  private readonly features: FeatureLifecycleCoordinator;
  private readonly summaries: SummaryCoordinator;
  private intervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly graph: FeatureGraph,
    private readonly ports: OrchestratorPorts,
  ) {
    this.features = new FeatureLifecycleCoordinator(graph);
    this.summaries = new SummaryCoordinator(graph, ports.config.tokenProfile);
  }

  enqueue(event: SchedulerEvent): void {
    this.events.push(event);
  }

  run(): Promise<void> {
    if (this.intervalId !== undefined) {
      return Promise.resolve();
    }

    this.intervalId = setInterval(() => {
      void this.tick(Date.now());
    }, 1000);

    return Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.readySince.clear();
    await this.ports.runtime.stopAll();
  }

  protected async tick(now: number): Promise<void> {
    while (this.events.length > 0) {
      const event = this.events.shift();
      if (event !== undefined) {
        await this.handleEvent(event);
      }
    }

    this.summaries.reconcilePostMerge();
    this.features.beginNextIntegration();
    await this.dispatchReadyWork(now);
    this.ports.ui.refresh();
  }

  protected async handleEvent(event: SchedulerEvent): Promise<void> {
    if (event.type === 'worker_message') {
      const message = event.message;
      const run = this.ports.store.getAgentRun(message.agentRunId);
      if (run?.scopeType !== 'task') {
        return;
      }

      if (message.type === 'result') {
        this.graph.transitionTask(run.scopeId, {
          status: 'done',
          result: message.result,
        });
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'completed',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        return;
      }

      if (message.type === 'error') {
        this.graph.transitionTask(run.scopeId, {
          status: 'ready',
        });
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'retry_await',
          owner: 'system',
          retryAt: Date.now() + 1000,
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        return;
      }

      if (message.type === 'request_help') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'await_response',
          owner: 'manual',
          payloadJson: JSON.stringify({ query: message.query }),
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        return;
      }

      if (message.type === 'request_approval') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'await_approval',
          owner: 'manual',
          payloadJson: JSON.stringify(message.payload),
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
      return;
    }

    if (event.type === 'feature_phase_complete') {
      const run = this.ports.store.getAgentRun(
        `run-feature:${event.featureId}:${event.phase}`,
      );
      if (run !== undefined) {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'completed',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }

      if (event.phase === 'summarize') {
        this.summaries.completeSummary(event.featureId, event.summary);
        return;
      }

      this.features.completePhase(
        event.featureId,
        event.phase,
        event.verification,
      );
      return;
    }

    if (event.type === 'feature_phase_error') {
      const run = this.ports.store.getAgentRun(
        `run-feature:${event.featureId}:${event.phase}`,
      );
      if (run !== undefined) {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'retry_await',
          owner: 'system',
          retryAt: Date.now() + 1000,
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
      return;
    }

    if (event.type === 'feature_integration_complete') {
      this.features.completeIntegration(event.featureId);
      return;
    }

    if (event.type === 'feature_integration_failed') {
      void event.error;
      this.features.failIntegration(event.featureId);
      return;
    }
  }

  protected async dispatchReadyWork(now: number): Promise<void> {
    const idleWorkers = this.ports.runtime.idleWorkerCount();
    if (idleWorkers <= 0) {
      this.syncReadySince([], now);
      return;
    }

    const runs = this.createRunReader();
    const ready = prioritizeReadyWork(
      this.graph,
      runs,
      computeGraphMetrics(buildCombinedGraph(this.graph)),
      now,
      this.readySince,
    );
    this.syncReadySince(ready, now);

    let dispatched = 0;
    for (const unit of ready) {
      if (dispatched >= idleWorkers) {
        break;
      }

      if (unit.kind === 'task') {
        await this.dispatchTaskUnit(unit.task);
        dispatched++;
        continue;
      }

      await this.dispatchFeaturePhaseUnit(unit.feature, unit.phase);
      dispatched++;
    }
  }

  private createRunReader(): ExecutionRunReader {
    const runs = this.ports.store.listAgentRuns();
    const byTaskId = new Map<string, AgentRun>();
    const byFeaturePhase = new Map<string, AgentRun>();

    for (const run of runs) {
      if (run.scopeType === 'task') {
        byTaskId.set(run.scopeId, run);
      } else {
        byFeaturePhase.set(`${run.scopeId}:${run.phase}`, run);
      }
    }

    return {
      getExecutionRun(
        scopeId: string,
        phase?: AgentRunPhase,
      ): AgentRun | undefined {
        if (phase !== undefined) {
          return byFeaturePhase.get(`${scopeId}:${phase}`);
        }
        return byTaskId.get(scopeId);
      },
    };
  }

  private syncReadySince(units: readonly SchedulableUnit[], now: number): void {
    const nextKeys = new Set<string>();

    for (const unit of units) {
      const key = schedulableUnitKey(unit);
      nextKeys.add(key);
      if (!this.readySince.has(key)) {
        this.readySince.set(key, now);
      }
    }

    for (const key of this.readySince.keys()) {
      if (!nextKeys.has(key)) {
        this.readySince.delete(key);
      }
    }
  }

  private async dispatchTaskUnit(task: Task): Promise<void> {
    const run = this.ensureTaskRun(task);
    const dispatch = this.taskDispatchForRun(run);
    const result = await this.ports.runtime.dispatchTask(task, dispatch);

    if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
      const fallback = await this.ports.runtime.dispatchTask(task, {
        mode: 'start',
        agentRunId: run.id,
      });
      this.markTaskRunning(task);
      this.persistRunningTaskRun(run, fallback);
      return;
    }

    this.markTaskRunning(task);
    this.persistRunningTaskRun(run, result);
  }

  private ensureTaskRun(task: Task): TaskAgentRun {
    const existing = this.ports.store.listAgentRuns({
      scopeType: 'task',
      scopeId: task.id,
      phase: 'execute',
    })[0];

    if (existing?.scopeType === 'task') {
      return existing;
    }

    const run: TaskAgentRun = {
      id: `run-task:${task.id}`,
      scopeType: 'task',
      scopeId: task.id,
      phase: 'execute',
      runStatus: 'ready',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    this.ports.store.createAgentRun(run);
    return run;
  }

  private ensureFeaturePhaseRun(
    feature: Feature,
    phase: AgentRunPhase,
  ): AgentRun {
    const existing = this.ports.store.listAgentRuns({
      scopeType: 'feature_phase',
      scopeId: feature.id,
      phase,
    })[0];

    if (existing !== undefined) {
      return existing;
    }

    const run: AgentRun = {
      id: `run-feature:${feature.id}:${phase}`,
      scopeType: 'feature_phase',
      scopeId: feature.id,
      phase,
      runStatus: 'ready',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    this.ports.store.createAgentRun(run);
    return run;
  }

  private taskDispatchForRun(run: TaskAgentRun): TaskRuntimeDispatch {
    if (run.sessionId) {
      return {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: run.sessionId,
      };
    }

    return {
      mode: 'start',
      agentRunId: run.id,
    };
  }

  private async dispatchFeaturePhaseUnit(
    feature: Feature,
    phase: AgentRunPhase,
  ): Promise<void> {
    const run = this.ensureFeaturePhaseRun(feature, phase);
    this.markFeaturePhaseRunning(feature);
    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'running',
      owner: 'system',
    });

    try {
      const runContext = { agentRunId: run.id };
      switch (phase) {
        case 'discuss': {
          const result = await this.ports.agents.discussFeature(
            feature,
            runContext,
          );
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: result.summary,
          });
          return;
        }
        case 'research': {
          const result = await this.ports.agents.researchFeature(
            feature,
            runContext,
          );
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: result.summary,
          });
          return;
        }
        case 'plan': {
          const result = await this.ports.agents.planFeature(
            feature,
            runContext,
          );
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: result.summary,
          });
          return;
        }
        case 'verify': {
          const verification = await this.ports.agents.verifyFeature(
            feature,
            runContext,
          );
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: verification.summary ?? '',
            verification,
          });
          return;
        }
        case 'summarize': {
          const result = await this.ports.agents.summarizeFeature(
            feature,
            runContext,
          );
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: result.summary,
          });
          return;
        }
        case 'replan': {
          const result = await this.ports.agents.replanFeature(
            feature,
            'scheduler',
            runContext,
          );
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: result.summary,
          });
          return;
        }
        case 'execute':
        case 'feature_ci':
          return;
      }
    } catch (error) {
      await this.handleEvent({
        type: 'feature_phase_error',
        featureId: feature.id,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private markTaskRunning(task: Task): void {
    if (task.status !== 'running' || task.collabControl !== 'branch_open') {
      this.graph.transitionTask(task.id, {
        status: 'running',
        collabControl: 'branch_open',
      });
    }
  }

  private markFeaturePhaseRunning(feature: Feature): void {
    if (feature.status !== 'in_progress') {
      this.graph.transitionFeature(feature.id, {
        status: 'in_progress',
      });
    }
  }

  private persistRunningTaskRun(
    run: TaskAgentRun,
    result: DispatchTaskResult,
  ): void {
    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'running',
      owner: 'system',
      sessionId: result.sessionId,
      restartCount:
        run.runStatus === 'retry_await'
          ? run.restartCount + 1
          : run.restartCount,
    });
  }
}
