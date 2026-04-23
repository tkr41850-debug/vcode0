import type { FeatureGraph } from '@core/graph/index';
import { MergeTrainCoordinator } from '@core/merge-train/index';
import type {
  AgentRunPhase,
  Feature,
  FeatureId,
  Task,
  TaskId,
  VerificationSummary,
  VerifyIssue,
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

  runCiCheck(_feature: Feature): void {}

  onTaskLanded(taskId: TaskId): void {
    const task = this.requireTask(taskId);
    const feature = this.requireFeature(task.featureId);
    if (feature.workControl !== 'executing') {
      return;
    }

    if (!this.allFeatureTasksLanded(feature.id)) {
      return;
    }

    this.markPhaseDone(feature.id);
    this.advancePhase(feature.id, 'ci_check');
  }

  markAwaitingMerge(feature: Feature): void {
    this.mergeTrain.enqueueFeatureMerge(feature.id, this.graph);
  }

  completeIntegration(featureId: FeatureId): void {
    this.mergeTrain.completeIntegration(featureId, this.graph);
  }

  rerouteToReplan(featureId: FeatureId, issues: VerifyIssue[]): void {
    const feature = this.requireFeature(featureId);

    let ejectFromIntegrating = false;
    if (feature.collabControl === 'merge_queued') {
      this.mergeTrain.ejectFromQueue(featureId, this.graph);
    } else if (feature.collabControl === 'integrating') {
      // Route through conflict so we can exit integrating; clear after
      // advancePhase puts us in replanning.
      this.graph.transitionFeature(featureId, { collabControl: 'conflict' });
      ejectFromIntegrating = true;
    }

    const merged = mergeVerifyIssues(feature.verifyIssues, issues);
    if (merged !== undefined) {
      this.graph.editFeature(featureId, { verifyIssues: merged });
    }

    this.markPhaseFailed(featureId);
    this.advancePhase(featureId, 'replanning');

    if (ejectFromIntegrating) {
      this.graph.transitionFeature(featureId, { collabControl: 'branch_open' });
      this.graph.updateMergeTrainState(featureId, {
        mergeTrainManualPosition: undefined,
        mergeTrainEnteredAt: undefined,
        mergeTrainEntrySeq: undefined,
        mergeTrainReentryCount: (feature.mergeTrainReentryCount ?? 0) + 1,
      });
    }
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
      case 'ci_check':
        if (verification === undefined) {
          throw new Error('ci_check completion requires verification summary');
        }
        if (verification.ok === false) {
          const issues = ciCheckIssuesFromVerification(
            featureId,
            verification,
            'feature',
          );
          this.rerouteToReplan(featureId, issues);
          return;
        }
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'verifying');
        return;
      case 'verify':
        if (verification === undefined) {
          throw new Error('verify completion requires verification summary');
        }
        // `verification.ok` already encodes severity policy: blocking/concern
        // issues force `ok=false`; nit-only verdicts stay `ok=true` and pass
        // through to awaiting_merge. Nits surface in `verification.issues`
        // for persistence without triggering replanning.
        if (verification.ok === false) {
          this.markPhaseFailed(featureId);
          this.advancePhase(featureId, 'replanning');
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

  beginNextIntegration(): FeatureId | undefined {
    for (const feature of this.graph.features.values()) {
      if (feature.collabControl === 'integrating') {
        return feature.id;
      }
    }

    const nextFeatureId = this.mergeTrain.nextToIntegrate(this.graph);
    if (nextFeatureId === undefined) {
      return undefined;
    }

    const feature = this.requireFeature(nextFeatureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(nextFeatureId, { status: 'in_progress' });
    }

    this.mergeTrain.beginIntegration(nextFeatureId, this.graph);
    return nextFeatureId;
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

function mergeVerifyIssues(
  existing: VerifyIssue[] | undefined,
  incoming: VerifyIssue[],
): VerifyIssue[] | undefined {
  if (incoming.length === 0) {
    return existing;
  }
  return existing !== undefined ? [...existing, ...incoming] : [...incoming];
}

function ciCheckIssuesFromVerification(
  featureId: FeatureId,
  verification: VerificationSummary,
  phase: 'feature' | 'post_rebase',
): VerifyIssue[] {
  if (verification.issues !== undefined && verification.issues.length > 0) {
    return verification.issues;
  }
  const failed = verification.failedChecks ?? [];
  if (failed.length === 0) {
    return [
      {
        source: 'ci_check',
        id: `ci-${featureId}-${phase}-1`,
        severity: 'blocking',
        phase,
        checkName: 'ci_check',
        command: '',
        description: verification.summary ?? 'ci_check failed',
      },
    ];
  }
  return failed.map((name, index) => ({
    source: 'ci_check',
    id: `ci-${featureId}-${phase}-${index + 1}`,
    severity: 'blocking',
    phase,
    checkName: name,
    command: name,
    description: `${name} failed`,
  }));
}
