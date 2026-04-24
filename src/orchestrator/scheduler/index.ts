import type { FeatureGraph } from '@core/graph/index';
import type { Feature, FeatureId, Task } from '@core/types/index';
import {
  DEFAULT_LONG_FEATURE_BLOCKING_MS,
  DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD,
  WarningEvaluator,
} from '@core/warnings/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { SummaryCoordinator } from '@orchestrator/summaries/index';

import { ActiveLocks } from './active-locks.js';
import {
  dispatchReadyWork as dispatchSchedulerReadyWork,
  markFeaturePhaseRunning as markRunningFeaturePhase,
  markTaskRunning as markRunningTask,
} from './dispatch.js';
import { handleSchedulerEvent, type SchedulerEvent } from './events.js';
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

export type { SchedulerEvent } from './events.js';

// Plan 04-01: the `ui_cancel_feature_run_work` event handler needs to
// abort running tasks + update agent-run rows. compose.ts constructs the
// scheduler and wires a closure bound to its `{ graph, store, runtime }`
// context; unit tests that don't exercise cancellation can omit this
// dep and a no-op is used.
export interface SchedulerLoopOptions {
  cancelFeatureRunWork?: (featureId: FeatureId) => Promise<void>;
}

export class SchedulerLoop {
  private readonly events: SchedulerEvent[] = [];
  private readonly readySince = new Map<string, number>();
  private readonly features: FeatureLifecycleCoordinator;
  private readonly conflicts: ConflictCoordinator;
  private readonly summaries: SummaryCoordinator;
  private readonly warnings: WarningEvaluator;
  private readonly activeLocks = new ActiveLocks();
  private readonly cancelFeatureRunWork: (
    featureId: FeatureId,
  ) => Promise<void>;
  private emittedWarnings = new Set<string>();
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;
  private autoExecutionEnabled = true;

  constructor(
    private readonly graph: FeatureGraph,
    private readonly ports: OrchestratorPorts,
    options: SchedulerLoopOptions = {},
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
    });
    this.cancelFeatureRunWork =
      options.cancelFeatureRunWork ?? (() => Promise.resolve());
  }

  enqueue(event: SchedulerEvent): void {
    this.events.push(event);
    // Plan 04-01: wake the sleeping poll timer so enqueued events drain
    // within a microtask turn instead of waiting up to 1s for the poll.
    this.wakeSleep?.();
  }

  isAutoExecutionEnabled(): boolean {
    return this.autoExecutionEnabled;
  }

  setAutoExecutionEnabled(enabled: boolean): boolean {
    this.autoExecutionEnabled = enabled;
    return this.autoExecutionEnabled;
  }

  isRunning(): boolean {
    return this.running;
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
    // Plan 04-01: guard all graph mutations happen inside a tick. When
    // `GVC_ASSERT_TICK_BOUNDARY=1`, any mutation called outside of this
    // enter/leave pair throws; in production the counter is cheap (two
    // integer ops) and the assert short-circuits.
    this.graph.__enterTick();
    try {
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
    } finally {
      this.graph.__leaveTick();
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
      cancelFeatureRunWork: (featureId) => this.cancelFeatureRunWork(featureId),
      onShutdown: () => this.requestShutdown(),
    });
  }

  private requestShutdown(): void {
    // Graceful drain: flip `running` to false so the loop exits after the
    // current tick; wake the sleep so we don't wait up to 1s for the
    // existing timer to expire. Idempotent on repeated shutdowns.
    this.running = false;
    this.wakeSleep?.();
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
    layer: 'feature' | 'task' | 'mergeTrain',
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
