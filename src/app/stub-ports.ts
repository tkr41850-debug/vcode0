import { NotYetWiredError } from '@app/errors';
import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  Task,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
  VerificationSummary,
} from '@core/types/index';
import type {
  FeatureBranchHandle,
  FeatureBranchRebaseResult,
  GitPort,
  OverlapIncident,
  TaskWorktreeHandle,
  TaskWorktreeRebaseResult,
} from '@git';
import type { FeatureMergeRequest } from '@git/contracts';
import type { UiPort } from '@orchestrator/ports/index';
import type {
  DispatchTaskResult,
  RuntimePort,
  RuntimeSteeringDirective,
  TaskControlResult,
  TaskRuntimeDispatch,
} from '@runtime/contracts';

/* eslint-disable @typescript-eslint/require-await */

/**
 * StubGitPort — every method throws NotYetWiredError. Replaced in Phase 4 by
 * LocalGitPort. Lives here so the compose root can wire a complete port set.
 */
export class StubGitPort implements GitPort {
  async createFeatureBranch(_feature: Feature): Promise<FeatureBranchHandle> {
    throw new NotYetWiredError('git.createFeatureBranch');
  }
  async createTaskWorktree(
    _task: Task,
    _feature: Feature,
  ): Promise<TaskWorktreeHandle> {
    throw new NotYetWiredError('git.createTaskWorktree');
  }
  async mergeTaskWorktree(_task: Task, _result: TaskResult): Promise<void> {
    throw new NotYetWiredError('git.mergeTaskWorktree');
  }
  async mergeFeatureBranch(_request: FeatureMergeRequest): Promise<void> {
    throw new NotYetWiredError('git.mergeFeatureBranch');
  }
  async rebaseTaskWorktree(
    _task: Task,
    _feature: Feature,
  ): Promise<TaskWorktreeRebaseResult> {
    throw new NotYetWiredError('git.rebaseTaskWorktree');
  }
  async rebaseFeatureBranch(
    _feature: Feature,
  ): Promise<FeatureBranchRebaseResult> {
    throw new NotYetWiredError('git.rebaseFeatureBranch');
  }
  async scanFeatureOverlap(_feature: Feature): Promise<OverlapIncident[]> {
    throw new NotYetWiredError('git.scanFeatureOverlap');
  }
}

/**
 * StubRuntimePort — process-per-task pool not yet wired (Phase 5). Methods
 * that the recovery / shutdown paths need to call without an active workload
 * are tolerant: idleWorkerCount returns 0, stopAll is a no-op so app.stop()
 * works during the bootstrap phase. Anything that would actually run a task
 * throws NotYetWiredError.
 */
export class StubRuntimePort implements RuntimePort {
  async dispatchTask(
    _task: Task,
    _dispatch: TaskRuntimeDispatch,
  ): Promise<DispatchTaskResult> {
    throw new NotYetWiredError('runtime.dispatchTask');
  }
  async steerTask(
    _taskId: string,
    _directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult> {
    throw new NotYetWiredError('runtime.steerTask');
  }
  async suspendTask(
    _taskId: string,
    _reason: TaskSuspendReason,
    _files?: string[],
  ): Promise<TaskControlResult> {
    throw new NotYetWiredError('runtime.suspendTask');
  }
  async resumeTask(
    _taskId: string,
    _reason: TaskResumeReason,
  ): Promise<TaskControlResult> {
    throw new NotYetWiredError('runtime.resumeTask');
  }
  async abortTask(_taskId: string): Promise<TaskControlResult> {
    throw new NotYetWiredError('runtime.abortTask');
  }
  idleWorkerCount(): number {
    return 0;
  }
  async stopAll(): Promise<void> {
    // intentional no-op so app.stop() succeeds during bootstrap
  }
}

/**
 * StubAgentPort — synthetic placeholder. Replaced in Phase 6 by PiAgentPort.
 * Methods return short summary strings so the existing planner/replanner unit
 * tests against this surface keep working; touching them through compose at
 * runtime is harmless because no scheduling drives them yet.
 */
export class StubAgentPort {
  async discussFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return { summary: `[stub] discussed ${feature.name}` };
  }
  async researchFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return { summary: `[stub] researched ${feature.name}` };
  }
  async planFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return { summary: `[stub] planned ${feature.name}` };
  }
  async verifyFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<VerificationSummary> {
    return { ok: true, summary: `[stub] verified ${feature.name}` };
  }
  async summarizeFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return { summary: `[stub] summarized ${feature.name}` };
  }
  async replanFeature(
    feature: Feature,
    reason: string,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return { summary: `[stub] replanned ${feature.name}: ${reason}` };
  }
}

/**
 * StubUiPort — minimal event loop. show() blocks on a promise that only
 * resolves when dispose() is called or SIGINT/SIGTERM is received. Replaced in
 * Phase 3 by the real pi-tui rendering port.
 */
export class StubUiPort implements UiPort {
  private resolveShow: (() => void) | undefined;

  show(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveShow = resolve;
      // Print a banner so an interactive run knows what's happening.
      process.stderr.write(
        '\ngvc0: bootstrap UI active (no rendering yet — Ctrl+C to exit)\n',
      );
    });
  }

  refresh(): void {
    // intentional no-op until the real TUI lands
  }

  dispose(): void {
    if (this.resolveShow !== undefined) {
      this.resolveShow();
      this.resolveShow = undefined;
    }
  }
}
