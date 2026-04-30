import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRunPhase,
  Feature,
  FeatureId,
  Task,
  VerificationSummary,
} from '@core/types/index';
import { WarningEvaluator } from '@core/warnings/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { IntegrationCoordinator } from '@orchestrator/integration/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import type { ProposalPhase } from '@orchestrator/proposals/index';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
import { defaultWarningThresholds } from '@root/config';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';

import { ActiveLocks } from './active-locks.js';
import {
  dispatchReadyWork as dispatchSchedulerReadyWork,
  markFeaturePhaseRunning as markRunningFeaturePhase,
  markTaskRunning as markRunningTask,
} from './dispatch.js';
import { handleSchedulerEvent } from './events.js';
import {
  coordinateCrossFeatureRuntimeOverlaps as coordinateCrossFeatureRuntimeOverlapGroups,
  coordinateSameFeatureRuntimeOverlaps as coordinateSameFeatureRuntimeOverlapGroups,
} from './overlaps.js';
import {
  uiStateFingerprint as buildUiStateFingerprint,
  emitEmptyVerificationChecksWarning as emitEmptyVerificationChecksWarningEvent,
  emitWarningSignals as emitSchedulerWarnings,
  didRetryWindowExpire as retryWindowExpired,
} from './warnings.js';

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
      sessionId?: string;
      extra?: unknown;
      verification?: VerificationSummary;
    }
  | {
      type: 'feature_phase_approval_decision';
      featureId: FeatureId;
      phase: ProposalPhase;
      decision: 'approved' | 'rejected';
      comment?: string;
    }
  | {
      type: 'feature_phase_rerun_requested';
      featureId: FeatureId;
      phase: ProposalPhase;
      reason?: string;
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
      type: 'shutdown';
    };

export class SchedulerLoop {
  private readonly events: SchedulerEvent[] = [];
  private readonly readySince = new Map<string, number>();
  private readonly features: FeatureLifecycleCoordinator;
  private readonly conflicts: ConflictCoordinator;
  private readonly summaries: SummaryCoordinator;
  private readonly integration: IntegrationCoordinator;
  private readonly warnings: WarningEvaluator;
  private readonly activeLocks = new ActiveLocks();
  private emittedWarnings = new Set<string>();
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;
  private autoExecutionEnabled = true;

  constructor(
    private readonly graph: FeatureGraph,
    private readonly ports: OrchestratorPorts,
  ) {
    this.features = new FeatureLifecycleCoordinator(graph);
    this.conflicts = new ConflictCoordinator(ports, graph);
    this.summaries = new SummaryCoordinator(graph, ports.config.tokenProfile);
    this.integration = new IntegrationCoordinator({
      ports,
      graph,
      features: this.features,
    });
    const thresholds = defaultWarningThresholds();
    this.warnings = new WarningEvaluator({
      budgetWarnPercent:
        ports.config.budget?.warnAtPercent ?? thresholds.budgetWarnPercent,
      budgetGlobalUsd:
        ports.config.budget?.globalUsd ?? thresholds.budgetGlobalUsd,
      featureChurnThreshold: thresholds.featureChurnThreshold,
      taskFailureThreshold: thresholds.taskFailureThreshold,
      longFeatureBlockingMs:
        ports.config.warnings?.longFeatureBlockingMs ??
        thresholds.longFeatureBlockingMs,
      verifyReplanLoopThreshold:
        ports.config.warnings?.verifyReplanLoopThreshold ??
        thresholds.verifyReplanLoopThreshold,
      ciCheckReplanLoopThreshold:
        ports.config.warnings?.ciCheckReplanLoopThreshold ??
        thresholds.ciCheckReplanLoopThreshold,
      rebaseReplanLoopThreshold:
        ports.config.warnings?.rebaseReplanLoopThreshold ??
        thresholds.rebaseReplanLoopThreshold,
      totalReplanLoopThreshold:
        ports.config.warnings?.totalReplanLoopThreshold ??
        thresholds.totalReplanLoopThreshold,
    });
  }

  enqueue(event: SchedulerEvent): void {
    this.events.push(event);
  }

  isAutoExecutionEnabled(): boolean {
    return this.autoExecutionEnabled;
  }

  setAutoExecutionEnabled(enabled: boolean): boolean {
    this.autoExecutionEnabled = enabled;
    return this.autoExecutionEnabled;
  }

  run(): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }

    this.running = true;
    this.loopPromise = this.loop();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeSleep?.();
    if (this.loopPromise !== undefined) {
      await this.loopPromise;
      this.loopPromise = undefined;
    }

    this.readySince.clear();
    await this.ports.runtime.stopAll();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.sleep(1000);
      if (!this.running) {
        break;
      }
      try {
        await this.tick(Date.now());
      } catch (err) {
        console.error('[scheduler] tick threw:', err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleep = undefined;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeSleep = undefined;
        resolve();
      };
    });
  }

  async step(now: number): Promise<void> {
    await this.tick(now);
  }

  protected async tick(now: number): Promise<void> {
    const beforeFingerprint = this.uiStateFingerprint();

    while (this.events.length > 0) {
      const event = this.events.shift();
      if (event !== undefined) {
        await this.handleEvent(event);
      }
    }

    this.summaries.reconcilePostMerge();
    const integratingId = this.features.beginNextIntegration();
    if (integratingId !== undefined) {
      const outcome = await this.integration.runIntegration(integratingId);
      if (outcome.kind === 'merged') {
        this.enqueue({
          type: 'feature_integration_complete',
          featureId: integratingId,
        });
      }
    }
    await this.coordinateSameFeatureRuntimeOverlaps();
    await this.coordinateCrossFeatureRuntimeOverlaps();
    const warningsChanged = this.emitWarningSignals(now);
    await this.dispatchReadyWork(now);

    if (
      beforeFingerprint !== this.uiStateFingerprint() ||
      this.didRetryWindowExpire(now) ||
      warningsChanged
    ) {
      this.ports.ui.refresh();
    }
  }

  protected async handleEvent(event: SchedulerEvent): Promise<void> {
    await handleSchedulerEvent({
      event,
      graph: this.graph,
      ports: this.ports,
      features: this.features,
      conflicts: this.conflicts,
      summaries: this.summaries,
      activeLocks: this.activeLocks,
      emitEmptyVerificationChecksWarning: (entityId, layer, now) =>
        this.emitEmptyVerificationChecksWarning(entityId, layer, now),
    });
  }

  protected async dispatchReadyWork(now: number): Promise<void> {
    await dispatchSchedulerReadyWork({
      graph: this.graph,
      ports: this.ports,
      now,
      autoExecutionEnabled: this.autoExecutionEnabled,
      readySince: this.readySince,
      handleEvent: (event) => this.handleEvent(event),
      markTaskRunning: (task) => this.markTaskRunning(task),
      markFeaturePhaseRunning: (feature) =>
        this.markFeaturePhaseRunning(feature),
    });
  }

  private async coordinateCrossFeatureRuntimeOverlaps(): Promise<void> {
    await coordinateCrossFeatureRuntimeOverlapGroups({
      graph: this.graph,
      conflicts: this.conflicts,
    });
  }

  private async coordinateSameFeatureRuntimeOverlaps(): Promise<void> {
    await coordinateSameFeatureRuntimeOverlapGroups({
      graph: this.graph,
      conflicts: this.conflicts,
    });
  }

  private emitWarningSignals(now: number): boolean {
    const result = emitSchedulerWarnings(
      {
        graph: this.graph,
        warnings: this.warnings,
        store: this.ports.store,
        config: this.ports.config,
      },
      this.emittedWarnings,
      now,
    );
    this.emittedWarnings = result.emittedWarnings;
    return result.changed;
  }

  private emitEmptyVerificationChecksWarning(
    entityId: FeatureId,
    layer: 'feature' | 'task',
    now: number,
  ): void {
    this.emittedWarnings = emitEmptyVerificationChecksWarningEvent(
      {
        graph: this.graph,
        warnings: this.warnings,
        store: this.ports.store,
        config: this.ports.config,
      },
      this.emittedWarnings,
      entityId,
      layer,
      now,
    );
  }

  private markTaskRunning(task: Task): void {
    markRunningTask(
      (taskId, patch) => this.graph.transitionTask(taskId, patch),
      task,
    );
  }

  private markFeaturePhaseRunning(feature: Feature): void {
    markRunningFeaturePhase(
      (featureId, patch) => this.graph.transitionFeature(featureId, patch),
      feature,
    );
  }

  private uiStateFingerprint(): string {
    return buildUiStateFingerprint(
      this.graph,
      this.ports.store,
      this.autoExecutionEnabled,
    );
  }

  private didRetryWindowExpire(now: number): boolean {
    return retryWindowExpired(this.ports.store, now);
  }
}
