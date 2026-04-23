import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRunPhase,
  Feature,
  FeatureId,
  Task,
  VerificationSummary,
} from '@core/types/index';
import {
  DEFAULT_CI_CHECK_REPLAN_LOOP_THRESHOLD,
  DEFAULT_LONG_FEATURE_BLOCKING_MS,
  DEFAULT_REBASE_REPLAN_LOOP_THRESHOLD,
  DEFAULT_TOTAL_REPLAN_LOOP_THRESHOLD,
  DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD,
  WarningEvaluator,
} from '@core/warnings/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import type { ProposalPhase } from '@orchestrator/proposals/index';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
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
  private readonly conflicts: ConflictCoordinator;
  private readonly summaries: SummaryCoordinator;
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
    this.warnings = new WarningEvaluator({
      budgetWarnPercent: ports.config.budget?.warnAtPercent ?? 80,
      budgetGlobalUsd: ports.config.budget?.globalUsd ?? 1,
      featureChurnThreshold: 3,
      taskFailureThreshold: 3,
      longFeatureBlockingMs:
        ports.config.warnings?.longFeatureBlockingMs ??
        DEFAULT_LONG_FEATURE_BLOCKING_MS,
      verifyReplanLoopThreshold:
        ports.config.warnings?.verifyReplanLoopThreshold ??
        DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD,
      ciCheckReplanLoopThreshold:
        ports.config.warnings?.ciCheckReplanLoopThreshold ??
        DEFAULT_CI_CHECK_REPLAN_LOOP_THRESHOLD,
      rebaseReplanLoopThreshold:
        ports.config.warnings?.rebaseReplanLoopThreshold ??
        DEFAULT_REBASE_REPLAN_LOOP_THRESHOLD,
      totalReplanLoopThreshold:
        ports.config.warnings?.totalReplanLoopThreshold ??
        DEFAULT_TOTAL_REPLAN_LOOP_THRESHOLD,
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
    this.features.beginNextIntegration();
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
