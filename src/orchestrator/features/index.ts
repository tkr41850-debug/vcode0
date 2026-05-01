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
  VerifyIssue,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class FeatureLifecycleCoordinator {
  private readonly mergeTrain: MergeTrainCoordinator;

  constructor(
    private readonly graph: FeatureGraph,
    reentryCap?: number,
  ) {
    this.mergeTrain = new MergeTrainCoordinator(reentryCap);
  }

  setReentryCap(reentryCap: number | undefined): void {
    this.mergeTrain.setReentryCap(reentryCap);
  }

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
    this.advancePhase(feature.id, 'ci_check');
  }

  markAwaitingMerge(feature: Feature): void {
    this.mergeTrain.enqueueFeatureMerge(feature.id, this.graph);
  }

  completeIntegration(featureId: FeatureId): void {
    this.mergeTrain.completeIntegration(featureId, this.graph);
  }

  failIntegration(
    featureId: FeatureId,
    ports: Pick<OrchestratorPorts, 'store'>,
    summary?: string,
  ): void {
    const feature = this.requireFeature(featureId);

    // Increment the re-entry count (single increment path — the original
    // failIntegration did this inline; we preserve it here so ejectFromQueue
    // is not called on an `integrating` feature, which would require the
    // illegal `integrating → branch_open` FSM edge).
    const reentryCount = (feature.mergeTrainReentryCount ?? 0) + 1;

    // Transition directly to 'conflict' (valid from both 'integrating' and
    // 'merge_queued') and clear queue-local fields + update count.
    this.graph.transitionFeature(featureId, { collabControl: 'conflict' });
    this.graph.updateMergeTrainState(featureId, {
      mergeTrainManualPosition: undefined,
      mergeTrainEnteredAt: undefined,
      mergeTrainEntrySeq: undefined,
      mergeTrainReentryCount: reentryCount,
    });

    // Cap check: if a reentryCap is configured and this ejection hits it,
    // park the feature in the inbox instead of creating a repair task.
    const cap = this.mergeTrain.reentryCap;
    if (cap !== undefined && reentryCount >= cap) {
      const now = Date.now();
      ports.store.appendInboxItem({
        id: `inbox-merge-cap-${featureId}-${now}`,
        ts: now,
        featureId,
        kind: 'merge_train_cap_reached',
        payload: {
          reentryCount,
          cap,
          ...(summary !== undefined ? { reason: summary } : {}),
        },
      });
      ports.store.appendEvent({
        eventType: 'merge_train_feature_parked',
        entityId: featureId,
        timestamp: now,
        payload: {
          reentryCount,
          ...(summary !== undefined ? { summary } : {}),
        },
      });
      return;
    }

    // Below cap (or no cap): normal path — create a repair task as before.
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
      case 'ci_check':
        if (verification === undefined) {
          throw new Error('ci_check completion requires verification summary');
        }
        if (verification.ok === false) {
          this.failCiCheck(featureId, verification.summary);
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
          this.enqueueVerifyRepairs(featureId, verification.issues ?? [], {
            ...(verification.summary !== undefined
              ? { summary: verification.summary }
              : {}),
            ...(verification.failedChecks !== undefined
              ? { failedChecks: verification.failedChecks }
              : {}),
            ...(verification.repairFocus !== undefined
              ? { repairFocus: verification.repairFocus }
              : {}),
          });
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

  enqueueVerifyRepairs(
    featureId: FeatureId,
    issues: readonly VerifyIssue[],
    fallback?: {
      summary?: string;
      failedChecks?: readonly string[];
      repairFocus?: readonly string[];
    },
  ): void {
    const actionableIssues = issues.filter((issue) => issue.severity !== 'nit');
    const repairTasks =
      actionableIssues.length > 0
        ? actionableIssues.map((issue) => ({
            description: this.describeVerifyIssue(issue),
            reservedWritePaths: this.reservedWritePathsFromLocation(
              issue.location,
            ),
          }))
        : [
            {
              description: this.describeFallbackVerifyRepair(fallback),
              reservedWritePaths: undefined,
            },
          ];

    if (!this.beginRepairAttempt(featureId)) {
      return;
    }

    for (const repairTask of repairTasks) {
      this.addOneRepairTask(featureId, repairTask.description, {
        repairSource: 'verify',
        ...(repairTask.reservedWritePaths !== undefined
          ? { reservedWritePaths: repairTask.reservedWritePaths }
          : {}),
      });
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

  private failCiCheck(featureId: FeatureId, summary?: string): void {
    this.enqueueRepairTask(featureId, 'ci_check', 'ci check issues', summary);
  }

  private enqueueRepairTask(
    featureId: FeatureId,
    repairSource: 'ci_check' | 'verify' | 'integration',
    noun: string,
    summary?: string,
  ): void {
    if (!this.beginRepairAttempt(featureId)) {
      return;
    }

    const detail = summary?.trim();
    this.addOneRepairTask(
      featureId,
      detail && detail.length > 0
        ? `Repair ${noun}: ${detail}`
        : `Repair ${noun}`,
      { repairSource },
    );
  }

  private beginRepairAttempt(featureId: FeatureId): boolean {
    const feature = this.requireFeature(featureId);
    const repairCount = this.countRepairTasks(featureId);

    if (feature.workControl === 'executing_repair') {
      if (repairCount >= MAX_REPAIR_ATTEMPTS) {
        this.markPhaseFailed(featureId);
        this.advancePhase(featureId, 'replanning');
        return false;
      }
      return true;
    }

    this.markPhaseFailed(featureId);
    if (repairCount >= MAX_REPAIR_ATTEMPTS) {
      this.advancePhase(featureId, 'executing_repair');
      this.markPhaseFailed(featureId);
      this.advancePhase(featureId, 'replanning');
      return false;
    }

    this.advancePhase(featureId, 'executing_repair');
    return true;
  }

  private addOneRepairTask(
    featureId: FeatureId,
    description: string,
    opts: {
      repairSource: 'ci_check' | 'verify' | 'integration';
      reservedWritePaths?: string[];
    },
  ): void {
    const repairTask = this.graph.addTask({
      featureId,
      description,
      repairSource: opts.repairSource,
      ...(opts.reservedWritePaths !== undefined
        ? { reservedWritePaths: opts.reservedWritePaths }
        : {}),
    });
    this.graph.transitionTask(repairTask.id, { status: 'ready' });
  }

  private describeVerifyIssue(issue: VerifyIssue): string {
    const location = issue.location?.trim();
    const suggestedFix = issue.suggestedFix?.trim();
    return `${issue.description}${location !== undefined && location.length > 0 ? ` @ ${location}` : ''}${suggestedFix !== undefined && suggestedFix.length > 0 ? `\n\nSuggested: ${suggestedFix}` : ''}`;
  }

  private describeFallbackVerifyRepair(fallback?: {
    summary?: string;
    failedChecks?: readonly string[];
    repairFocus?: readonly string[];
  }): string {
    const detail =
      fallback?.failedChecks
        ?.find((entry) => entry.trim().length > 0)
        ?.trim() ??
      fallback?.repairFocus?.find((entry) => entry.trim().length > 0)?.trim() ??
      fallback?.summary?.trim() ??
      'feature verification issues';

    // A zero-task executing_repair feature would never re-enter ci_check, so
    // repair_needed without actionable issues still gets one fallback repair task.
    return `Repair feature verification issues: ${detail}`;
  }

  private reservedWritePathsFromLocation(
    location?: string,
  ): string[] | undefined {
    const trimmed = location?.trim();
    if (
      trimmed === undefined ||
      trimmed.length === 0 ||
      trimmed.includes(' ') ||
      !/[\\/.]/.test(trimmed)
    ) {
      return undefined;
    }
    return [trimmed];
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
