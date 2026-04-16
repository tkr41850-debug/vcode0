import * as path from 'node:path';

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
  TaskId,
  VerificationSummary,
} from '@core/types/index';
import {
  DEFAULT_LONG_FEATURE_BLOCKING_MS,
  WarningEvaluator,
} from '@core/warnings/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  approveFeatureProposal,
  isProposalPhase,
  type ProposalPhase,
  parseGraphProposalPayload,
  summarizeProposalApply,
} from '@orchestrator/proposals/index';
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
  private emittedWarnings = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | undefined;
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
    if (event.type === 'worker_message') {
      const message = event.message;
      const run = this.ports.store.getAgentRun(message.agentRunId);
      if (run?.scopeType !== 'task') {
        return;
      }

      if (message.type === 'result') {
        const taskLanded = message.completionKind === 'submitted';
        this.graph.transitionTask(run.scopeId, {
          status: 'done',
          ...(taskLanded ? { collabControl: 'merged' as const } : {}),
          result: message.result,
        });
        if (taskLanded) {
          this.features.onTaskLanded(run.scopeId);
          const landedTask = this.graph.tasks.get(run.scopeId);
          if (landedTask !== undefined) {
            if (landedTask.repairSource === 'integration') {
              this.conflicts.clearCrossFeatureBlock(landedTask.featureId);
              const release = await this.conflicts.resumeCrossFeatureTasks(
                landedTask.featureId,
              );
              if (release.kind === 'blocked') {
                this.features.createIntegrationRepair(
                  landedTask.featureId,
                  release.summary,
                );
              }
            }
            await this.conflicts.reconcileSameFeatureTasks(
              landedTask.featureId,
              run.scopeId,
            );
          }
        }
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

    if (event.type === 'feature_phase_rerun_requested') {
      const run = this.ports.store.getAgentRun(
        `run-feature:${event.featureId}:${event.phase}`,
      );
      if (run === undefined) {
        return;
      }

      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'ready',
        owner: 'system',
      });
      this.ports.store.appendEvent({
        eventType: 'proposal_rerun_requested',
        entityId: event.featureId,
        timestamp: Date.now(),
        payload: { phase: event.phase },
      });
      return;
    }

    if (event.type === 'feature_phase_approval_decision') {
      const run = this.ports.store.getAgentRun(
        `run-feature:${event.featureId}:${event.phase}`,
      );
      if (run === undefined || run.runStatus !== 'await_approval') {
        return;
      }

      if (event.decision === 'approved') {
        try {
          const proposal = parseGraphProposalPayload(
            run.payloadJson,
            event.phase,
          );
          const result = approveFeatureProposal(
            this.graph,
            event.featureId,
            event.phase,
            proposal,
          );
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'completed',
            owner: 'system',
            ...(run.payloadJson !== undefined
              ? { payloadJson: run.payloadJson }
              : {}),
            ...(run.sessionId !== undefined
              ? { sessionId: run.sessionId }
              : {}),
          });
          this.ports.store.appendEvent({
            eventType: 'proposal_applied',
            entityId: event.featureId,
            timestamp: Date.now(),
            payload: {
              phase: event.phase,
              ...summarizeProposalApply(result),
            },
          });
        } catch (error) {
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'completed',
            owner: 'manual',
            ...(run.payloadJson !== undefined
              ? { payloadJson: run.payloadJson }
              : {}),
            ...(run.sessionId !== undefined
              ? { sessionId: run.sessionId }
              : {}),
          });
          this.ports.store.appendEvent({
            eventType: 'proposal_apply_failed',
            entityId: event.featureId,
            timestamp: Date.now(),
            payload: {
              phase: event.phase,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'completed',
        owner: 'manual',
        ...(run.payloadJson !== undefined
          ? { payloadJson: run.payloadJson }
          : {}),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      this.ports.store.appendEvent({
        eventType: 'proposal_rejected',
        entityId: event.featureId,
        timestamp: Date.now(),
        payload: {
          phase: event.phase,
          ...(event.comment !== undefined ? { comment: event.comment } : {}),
        },
      });
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

      if (event.phase === 'feature_ci') {
        this.ports.store.appendEvent({
          eventType: 'feature_phase_completed',
          entityId: event.featureId,
          timestamp: Date.now(),
          payload: {
            phase: event.phase,
            summary: event.summary,
            ...(event.verification !== undefined
              ? { extra: event.verification }
              : {}),
          },
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
      const releases = await this.conflicts.releaseCrossFeatureOverlap(
        event.featureId,
      );
      for (const release of releases) {
        if (release.kind === 'repair_needed') {
          const conflictedFiles = release.conflictedFiles ?? [];
          const summary =
            conflictedFiles.length > 0
              ? `Rebase onto main conflicted in ${conflictedFiles.join(', ')}`
              : (release.summary ?? 'Rebase onto main conflicted');
          this.features.createIntegrationRepair(release.featureId, summary);
          continue;
        }

        if (release.kind === 'blocked') {
          this.features.createIntegrationRepair(
            release.featureId,
            release.summary ??
              'Feature worktree missing before rebase onto main',
          );
        }
      }
      return;
    }

    if (event.type === 'feature_integration_failed') {
      this.features.failIntegration(event.featureId, event.error);
      return;
    }
  }

  protected async dispatchReadyWork(now: number): Promise<void> {
    if (!this.autoExecutionEnabled) {
      this.syncReadySince([], now);
      return;
    }

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

      if (await this.dispatchFeaturePhaseUnit(unit.feature, unit.phase)) {
        dispatched++;
      }
    }
  }

  private async coordinateCrossFeatureRuntimeOverlaps(): Promise<void> {
    const runningTasks = [...this.graph.tasks.values()].filter(
      (task) =>
        task.status === 'running' &&
        task.collabControl === 'branch_open' &&
        task.reservedWritePaths !== undefined &&
        task.reservedWritePaths.length > 0,
    );
    if (runningTasks.length <= 1) {
      return;
    }

    const tasksByPath = new Map<string, Task[]>();
    for (const task of runningTasks) {
      for (const reservedPath of task.reservedWritePaths ?? []) {
        const normalizedPath = normalizeReservedWritePath(reservedPath);
        const owners = tasksByPath.get(normalizedPath) ?? [];
        owners.push(task);
        tasksByPath.set(normalizedPath, owners);
      }
    }

    const featurePairFiles = new Map<string, Set<string>>();
    for (const [reservedPath, owners] of tasksByPath) {
      if (owners.length <= 1) {
        continue;
      }

      for (let index = 0; index < owners.length; index++) {
        const left = owners[index];
        if (left === undefined) {
          continue;
        }
        for (
          let peerIndex = index + 1;
          peerIndex < owners.length;
          peerIndex++
        ) {
          const right = owners[peerIndex];
          if (
            right === undefined ||
            left.featureId === right.featureId ||
            left.featureId === right.blockedByFeatureId ||
            right.featureId === left.blockedByFeatureId
          ) {
            continue;
          }

          const [primaryId, secondaryId] = rankCrossFeaturePair(
            this.graph,
            left,
            right,
          );
          const key = `${primaryId}|${secondaryId}`;
          const files = featurePairFiles.get(key) ?? new Set<string>();
          files.add(reservedPath);
          featurePairFiles.set(key, files);
        }
      }
    }

    for (const [pairKey] of featurePairFiles) {
      const [primaryId, secondaryId] = pairKey.split('|') as [
        FeatureId,
        FeatureId,
      ];
      const primary = this.graph.features.get(primaryId);
      const secondary = this.graph.features.get(secondaryId);
      if (
        primary === undefined ||
        secondary === undefined ||
        primary.runtimeBlockedByFeatureId !== undefined ||
        secondary.runtimeBlockedByFeatureId !== undefined
      ) {
        continue;
      }

      const secondaryTasks = runningTasks.filter(
        (task) => task.featureId === secondary.id,
      );
      await this.conflicts.handleCrossFeatureOverlap(
        primary,
        secondary,
        secondaryTasks,
        [...(featurePairFiles.get(pairKey) ?? [])].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
    }
  }

  private async coordinateSameFeatureRuntimeOverlaps(): Promise<void> {
    const tasksByFeature = new Map<FeatureId, Task[]>();

    for (const task of this.graph.tasks.values()) {
      if (
        task.status !== 'running' ||
        task.collabControl !== 'branch_open' ||
        task.reservedWritePaths === undefined ||
        task.reservedWritePaths.length === 0
      ) {
        continue;
      }

      const tasks = tasksByFeature.get(task.featureId) ?? [];
      tasks.push(task);
      tasksByFeature.set(task.featureId, tasks);
    }

    for (const [featureId, tasks] of tasksByFeature) {
      const feature = this.graph.features.get(featureId);
      if (feature === undefined || tasks.length <= 1) {
        continue;
      }

      const adjacency = new Map<TaskId, Set<TaskId>>();
      const overlapFilesByTask = new Map<TaskId, Set<string>>();
      const taskById = new Map<TaskId, Task>(
        tasks.map((task) => [task.id, task]),
      );
      const tasksByPath = new Map<string, Task[]>();

      for (const task of tasks) {
        for (const reservedPath of task.reservedWritePaths ?? []) {
          const normalizedPath = normalizeReservedWritePath(reservedPath);
          const owners = tasksByPath.get(normalizedPath) ?? [];
          owners.push(task);
          tasksByPath.set(normalizedPath, owners);
        }
      }

      for (const [reservedPath, owners] of tasksByPath) {
        if (owners.length <= 1) {
          continue;
        }

        for (const owner of owners) {
          const ownerFiles =
            overlapFilesByTask.get(owner.id) ?? new Set<string>();
          ownerFiles.add(reservedPath);
          overlapFilesByTask.set(owner.id, ownerFiles);

          const ownerAdjacency = adjacency.get(owner.id) ?? new Set<TaskId>();
          for (const peer of owners) {
            if (peer.id !== owner.id) {
              ownerAdjacency.add(peer.id);
            }
          }
          adjacency.set(owner.id, ownerAdjacency);
        }
      }

      const visited = new Set<TaskId>();
      for (const taskId of adjacency.keys()) {
        if (visited.has(taskId)) {
          continue;
        }

        const pending: TaskId[] = [taskId];
        const componentTaskIds: TaskId[] = [];
        const componentFiles = new Set<string>();
        while (pending.length > 0) {
          const currentTaskId = pending.pop();
          if (currentTaskId === undefined || visited.has(currentTaskId)) {
            continue;
          }
          visited.add(currentTaskId);
          componentTaskIds.push(currentTaskId);

          for (const file of overlapFilesByTask.get(currentTaskId) ?? []) {
            componentFiles.add(file);
          }
          for (const peerId of adjacency.get(currentTaskId) ?? []) {
            if (!visited.has(peerId)) {
              pending.push(peerId);
            }
          }
        }

        const componentTasks = componentTaskIds
          .map((componentTaskId) => taskById.get(componentTaskId))
          .filter((task): task is Task => task !== undefined)
          .sort(
            (a, b) =>
              a.orderInFeature - b.orderInFeature || a.id.localeCompare(b.id),
          );
        if (componentTasks.length <= 1) {
          continue;
        }

        await this.conflicts.handleSameFeatureOverlap(
          feature,
          {
            featureId,
            taskIds: componentTasks.map((task) => task.id),
            files: [...componentFiles],
            taskFilesById: Object.fromEntries(
              componentTasks.map((task) => [
                task.id,
                [...(overlapFilesByTask.get(task.id) ?? [])].sort((a, b) =>
                  a.localeCompare(b),
                ),
              ]),
            ),
            suspendReason: 'same_feature_overlap',
          },
          componentTasks,
        );
      }
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

  private emitWarningSignals(now: number): boolean {
    const tasks = [...this.graph.tasks.values()];
    const activeWarningKeys = new Set<string>();
    let changed = false;

    for (const feature of this.graph.features.values()) {
      const warnings = this.warnings.evaluateFeature(feature, now, tasks);
      for (const warning of warnings) {
        const warningKey = `${warning.category}:${warning.entityId}`;
        activeWarningKeys.add(warningKey);
        if (this.emittedWarnings.has(warningKey)) {
          continue;
        }

        this.ports.store.appendEvent({
          eventType: 'warning_emitted',
          entityId: warning.entityId,
          timestamp: warning.occurredAt,
          payload: {
            category: warning.category,
            message: warning.message,
            ...(warning.payload !== undefined
              ? { extra: warning.payload }
              : {}),
          },
        });
        changed = true;
      }
    }

    this.emittedWarnings = activeWarningKeys;
    return changed;
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
  ): Promise<boolean> {
    const run = this.ensureFeaturePhaseRun(feature, phase);
    if (isProposalPhase(phase) && run.runStatus === 'completed') {
      return false;
    }

    this.markFeaturePhaseRunning(feature);
    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'running',
      owner: 'system',
    });

    try {
      const runContext = {
        agentRunId: run.id,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      };
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
          return true;
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
          return true;
        }
        case 'plan': {
          const result = await this.ports.agents.planFeature(
            feature,
            runContext,
          );
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'await_approval',
            owner: 'manual',
            payloadJson: JSON.stringify(result.proposal),
          });
          return true;
        }
        case 'feature_ci': {
          const verification =
            await this.ports.verification.verifyFeature(feature);
          await this.handleEvent({
            type: 'feature_phase_complete',
            featureId: feature.id,
            phase,
            summary: verification.summary ?? '',
            verification,
          });
          return true;
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
          return true;
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
          return true;
        }
        case 'replan': {
          const result = await this.ports.agents.replanFeature(
            feature,
            'scheduler',
            runContext,
          );
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'await_approval',
            owner: 'manual',
            payloadJson: JSON.stringify(result.proposal),
          });
          return true;
        }
        case 'execute':
          return true;
      }
    } catch (error) {
      await this.handleEvent({
        type: 'feature_phase_error',
        featureId: feature.id,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
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

  private uiStateFingerprint(): string {
    return JSON.stringify({
      graph: this.graph.snapshot(),
      runs: this.ports.store.listAgentRuns(),
      autoExecutionEnabled: this.autoExecutionEnabled,
    });
  }

  private didRetryWindowExpire(now: number): boolean {
    const lowerBound = now - 1000;
    return this.ports.store.listAgentRuns().some((run) => {
      return (
        run.runStatus === 'retry_await' &&
        run.retryAt !== undefined &&
        run.retryAt <= now &&
        run.retryAt > lowerBound
      );
    });
  }
}

function normalizeReservedWritePath(reservedPath: string): string {
  const normalized = path.posix.normalize(reservedPath.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function rankCrossFeaturePair(
  graph: FeatureGraph,
  left: Task,
  right: Task,
): [FeatureId, FeatureId] {
  const leftFeature = graph.features.get(left.featureId);
  const rightFeature = graph.features.get(right.featureId);
  if (leftFeature === undefined || rightFeature === undefined) {
    return lexicalFeatureOrder(left.featureId, right.featureId);
  }

  if (leftFeature.dependsOn.includes(rightFeature.id)) {
    return [right.featureId, left.featureId];
  }
  if (rightFeature.dependsOn.includes(leftFeature.id)) {
    return [left.featureId, right.featureId];
  }

  const collabOrder =
    collabRank(leftFeature.collabControl) -
    collabRank(rightFeature.collabControl);
  if (collabOrder !== 0) {
    return collabOrder > 0
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  const workOrder =
    workRank(leftFeature.workControl) - workRank(rightFeature.workControl);
  if (workOrder !== 0) {
    return workOrder > 0
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  const leftMilestoneOrder =
    graph.milestones.get(leftFeature.milestoneId)?.order ??
    Number.MAX_SAFE_INTEGER;
  const rightMilestoneOrder =
    graph.milestones.get(rightFeature.milestoneId)?.order ??
    Number.MAX_SAFE_INTEGER;
  if (leftMilestoneOrder !== rightMilestoneOrder) {
    return leftMilestoneOrder < rightMilestoneOrder
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }
  if (leftFeature.orderInMilestone !== rightFeature.orderInMilestone) {
    return leftFeature.orderInMilestone < rightFeature.orderInMilestone
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  const leftDownstream = countDownstreamDependents(graph, leftFeature.id);
  const rightDownstream = countDownstreamDependents(graph, rightFeature.id);
  if (leftDownstream !== rightDownstream) {
    return leftDownstream > rightDownstream
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  return lexicalFeatureOrder(left.featureId, right.featureId);
}

function lexicalFeatureOrder(
  leftFeatureId: FeatureId,
  rightFeatureId: FeatureId,
): [FeatureId, FeatureId] {
  return leftFeatureId.localeCompare(rightFeatureId) <= 0
    ? [leftFeatureId, rightFeatureId]
    : [rightFeatureId, leftFeatureId];
}

function collabRank(featureCollabControl: Feature['collabControl']): number {
  switch (featureCollabControl) {
    case 'integrating':
      return 3;
    case 'merge_queued':
      return 2;
    case 'branch_open':
      return 1;
    case 'none':
      return 0;
    case 'conflict':
      return -1;
    case 'merged':
    case 'cancelled':
      return -2;
  }
}

function workRank(featureWorkControl: Feature['workControl']): number {
  switch (featureWorkControl) {
    case 'awaiting_merge':
      return 5;
    case 'verifying':
      return 4;
    case 'feature_ci':
      return 3;
    case 'executing_repair':
      return 2;
    case 'executing':
      return 1;
    case 'discussing':
    case 'researching':
    case 'planning':
      return 0;
    case 'replanning':
    case 'summarizing':
    case 'work_complete':
      return -1;
  }
}

function countDownstreamDependents(
  graph: FeatureGraph,
  featureId: FeatureId,
): number {
  const downstream = new Set<FeatureId>();
  const pending: FeatureId[] = [featureId];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    for (const feature of graph.features.values()) {
      if (feature.dependsOn.includes(current) && !downstream.has(feature.id)) {
        downstream.add(feature.id);
        pending.push(feature.id);
      }
    }
  }

  return downstream.size;
}
