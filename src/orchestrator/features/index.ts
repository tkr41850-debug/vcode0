import { MAX_REPAIR_ATTEMPTS } from '@core/fsm/index';
import type { FeatureGraph } from '@core/graph/index';
import { MergeTrainCoordinator } from '@core/merge-train/index';
import type {
  AgentRunPhase,
  Feature,
  FeatureId,
  Task,
  TaskId,
  VerificationSummary,
} from '@core/types/index';

export class FeatureLifecycleCoordinator {
  private readonly mergeTrain = new MergeTrainCoordinator();

  constructor(private readonly graph: FeatureGraph) {}

  openBranch(feature: Feature): void {
    if (feature.collabControl === 'none') {
      this.graph.transitionFeature(feature.id, {
        collabControl: 'branch_open',
      });
    }
  }

  runFeatureCi(_feature: Feature): void {}

  onTaskLanded(taskId: TaskId): void {
    const task = this.requireTask(taskId);
    const feature = this.requireFeature(task.featureId);
    if (
      feature.workControl !== 'executing' &&
      feature.workControl !== 'executing_repair'
    ) {
      return;
    }

    if (!this.allFeatureTasksLanded(feature.id)) {
      return;
    }

    if (
      feature.workControl === 'executing_repair' &&
      feature.collabControl === 'conflict'
    ) {
      this.graph.transitionFeature(feature.id, {
        collabControl: 'branch_open',
      });
    }

    this.markPhaseDone(feature.id);
    this.advancePhase(feature.id, 'feature_ci');
  }

  markAwaitingMerge(feature: Feature): void {
    this.mergeTrain.enqueueFeatureMerge(feature.id, this.graph);
  }

  completeIntegration(featureId: FeatureId): void {
    this.mergeTrain.completeIntegration(featureId, this.graph);
  }

  failIntegration(featureId: FeatureId, summary?: string): void {
    const feature = this.requireFeature(featureId);
    const reentryCount = (feature.mergeTrainReentryCount ?? 0) + 1;

    this.graph.transitionFeature(featureId, { collabControl: 'conflict' });
    this.graph.updateMergeTrainState(featureId, {
      mergeTrainManualPosition: undefined,
      mergeTrainEnteredAt: undefined,
      mergeTrainEntrySeq: undefined,
      mergeTrainReentryCount: reentryCount,
    });
    this.enqueueRepairTask(
      featureId,
      'integration',
      'integration issues',
      summary,
    );
  }

  createIntegrationRepair(featureId: FeatureId, summary?: string): void {
    const feature = this.requireFeature(featureId);
    if (feature.collabControl !== 'conflict') {
      this.graph.transitionFeature(featureId, { collabControl: 'conflict' });
    }
    this.enqueueRepairTask(
      featureId,
      'integration',
      'integration issues',
      summary,
    );
  }

  completePhase(
    featureId: FeatureId,
    phase: AgentRunPhase,
    verification?: VerificationSummary,
  ): void {
    switch (phase) {
      case 'discuss':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'researching');
        return;
      case 'research':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'planning');
        return;
      case 'plan':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'executing', 'branch_open');
        return;
      case 'feature_ci':
        if (verification === undefined) {
          throw new Error(
            'feature_ci completion requires verification summary',
          );
        }
        if (verification.ok === false) {
          this.failPreQueueVerification(
            featureId,
            'feature CI',
            verification.summary,
          );
          return;
        }
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'verifying');
        return;
      case 'verify':
        if (verification === undefined) {
          throw new Error('verify completion requires verification summary');
        }
        if (verification.ok === false) {
          this.failPreQueueVerification(
            featureId,
            'feature verification',
            verification.summary,
          );
          return;
        }
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'awaiting_merge');
        if (this.requireFeature(featureId).collabControl === 'conflict') {
          this.graph.transitionFeature(featureId, {
            collabControl: 'branch_open',
          });
        }
        this.markAwaitingMerge(this.requireFeature(featureId));
        return;
      case 'replan':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'planning');
        return;
      case 'execute':
      case 'summarize':
        return;
    }
  }

  beginNextIntegration(): void {
    for (const feature of this.graph.features.values()) {
      if (feature.collabControl === 'integrating') {
        return;
      }
    }

    const nextFeatureId = this.mergeTrain.nextToIntegrate(this.graph);
    if (nextFeatureId === undefined) {
      return;
    }

    const feature = this.requireFeature(nextFeatureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(nextFeatureId, { status: 'in_progress' });
    }

    this.mergeTrain.beginIntegration(nextFeatureId, this.graph);
  }

  private markPhaseDone(featureId: FeatureId): void {
    const feature = this.requireFeature(featureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(featureId, { status: 'in_progress' });
    }
    if (this.requireFeature(featureId).status !== 'done') {
      this.graph.transitionFeature(featureId, { status: 'done' });
    }
  }

  private markPhaseFailed(featureId: FeatureId): void {
    const feature = this.requireFeature(featureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(featureId, { status: 'in_progress' });
    }
    if (this.requireFeature(featureId).status !== 'failed') {
      this.graph.transitionFeature(featureId, { status: 'failed' });
    }
  }

  private failPreQueueVerification(
    featureId: FeatureId,
    label: string,
    summary?: string,
  ): void {
    this.enqueueRepairTask(
      featureId,
      label === 'feature CI' ? 'feature_ci' : 'verify',
      `${label.toLowerCase()} issues`,
      summary,
    );
  }

  private enqueueRepairTask(
    featureId: FeatureId,
    repairSource: 'feature_ci' | 'verify' | 'integration',
    noun: string,
    summary?: string,
  ): void {
    const feature = this.requireFeature(featureId);
    const repairCount = this.countRepairTasks(featureId);

    if (feature.workControl === 'executing_repair') {
      if (repairCount >= MAX_REPAIR_ATTEMPTS) {
        this.markPhaseFailed(featureId);
        this.advancePhase(featureId, 'replanning');
        return;
      }
    } else {
      this.markPhaseFailed(featureId);
      if (repairCount >= MAX_REPAIR_ATTEMPTS) {
        this.advancePhase(featureId, 'executing_repair');
        this.markPhaseFailed(featureId);
        this.advancePhase(featureId, 'replanning');
        return;
      }

      this.advancePhase(featureId, 'executing_repair');
    }

    const detail = summary?.trim();
    const repairTask = this.graph.addTask({
      featureId,
      description:
        detail && detail.length > 0
          ? `Repair ${noun}: ${detail}`
          : `Repair ${noun}`,
      repairSource,
    });
    this.graph.transitionTask(repairTask.id, { status: 'ready' });
  }

  private allFeatureTasksLanded(featureId: FeatureId): boolean {
    let sawTask = false;
    for (const task of this.graph.tasks.values()) {
      if (task.featureId !== featureId) {
        continue;
      }
      sawTask = true;
      if (task.status !== 'done' || task.collabControl !== 'merged') {
        return false;
      }
    }
    return sawTask;
  }

  private countRepairTasks(featureId: FeatureId): number {
    let count = 0;
    for (const task of this.graph.tasks.values()) {
      if (task.featureId === featureId && task.repairSource !== undefined) {
        count++;
      }
    }
    return count;
  }

  private advancePhase(
    featureId: FeatureId,
    workControl: Feature['workControl'],
    collabControl?: Feature['collabControl'],
  ): void {
    this.graph.transitionFeature(featureId, {
      workControl,
      status: workControl === 'work_complete' ? 'done' : 'pending',
      ...(collabControl !== undefined ? { collabControl } : {}),
    });
  }

  private requireFeature(featureId: FeatureId): Feature {
    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      throw new Error(`feature "${featureId}" does not exist`);
    }
    return feature;
  }

  private requireTask(taskId: TaskId): Task {
    const task = this.graph.tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`task "${taskId}" does not exist`);
    }
    return task;
  }
}
