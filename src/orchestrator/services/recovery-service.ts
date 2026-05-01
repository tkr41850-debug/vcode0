import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { Task, TaskAgentRun } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { taskDispatchForRun } from '@orchestrator/scheduler/dispatch';
import { buildTaskPayload } from '@runtime/context/index';
import type { WorkerPidRegistry } from '@runtime/worktree/index';
import {
  inspectManagedTaskWorktrees,
  sweepRecoveryLocks,
} from '@runtime/worktree/index';

interface ReconciledWorkerPidState {
  liveWorkerPids: StartupRecoveryPidFinding[];
  clearedDeadWorkerPids: StartupRecoveryPidFinding[];
  ownerStateByTask: Map<Task['id'], 'live' | 'dead'>;
}

export interface StartupRecoveryPidFinding {
  agentRunId: string;
  pid: number;
  taskId?: Task['id'];
}

export interface StartupRecoveryOrphanTaskWorktree {
  taskId: Task['id'];
  featureId: Task['featureId'];
  branch: string;
  path: string;
  ownerState: 'dead' | 'absent';
  registered: boolean;
  hasMetadataIndexLock: boolean;
}

export interface StartupRecoveryRunFinding {
  taskId: Task['id'];
  agentRunId: string;
  sessionId?: string;
  reason?: string;
}

interface StartupRecoveryRunSummary {
  resumedRuns: StartupRecoveryRunFinding[];
  restartedRuns: StartupRecoveryRunFinding[];
  attentionRuns: StartupRecoveryRunFinding[];
}

export interface StartupRecoveryReport {
  liveWorkerPids: StartupRecoveryPidFinding[];
  clearedDeadWorkerPids: StartupRecoveryPidFinding[];
  clearedLocks: Array<{
    kind: 'root_index_lock' | 'worktree_index_lock' | 'worktree_locked_marker';
    path: string;
    branch?: string;
  }>;
  preservedLocks: Array<{
    kind: 'root_index_lock' | 'worktree_index_lock' | 'worktree_locked_marker';
    path: string;
    branch?: string;
  }>;
  orphanTaskWorktrees: StartupRecoveryOrphanTaskWorktree[];
  resumedRuns: StartupRecoveryRunFinding[];
  restartedRuns: StartupRecoveryRunFinding[];
  attentionRuns: StartupRecoveryRunFinding[];
  requiresAttention: boolean;
}

export class RecoveryService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
    private readonly pidRegistry: WorkerPidRegistry,
    private readonly projectRoot = process.cwd(),
  ) {}

  async recoverStartupState(): Promise<StartupRecoveryReport> {
    const pidState = this.reconcileWorkerPids();
    const managedWorktrees = await inspectManagedTaskWorktrees(
      this.projectRoot,
      [...this.graph.tasks.values()].map((task) => ({
        taskId: task.id,
        featureId: task.featureId,
        branch: resolveTaskWorktreeBranch(task),
        ownerState: pidState.ownerStateByTask.get(task.id) ?? 'absent',
      })),
    );
    const staleLockedMarkers = await this.ports.worktree.sweepStaleLocks(
      (pid) => this.pidRegistry.isAlive(pid),
    );
    const lockSweep = await sweepRecoveryLocks(
      this.projectRoot,
      managedWorktrees,
      {
        hasLiveManagedWorker: pidState.liveWorkerPids.length > 0,
      },
    );

    const runRecovery = await this.recoverOrphanedRuns();

    const clearedLocks = [
      ...lockSweep.cleared,
      ...staleLockedMarkers.map((branch) => ({
        kind: 'worktree_locked_marker' as const,
        branch,
        path: path.join(
          this.projectRoot,
          '.git',
          'worktrees',
          branch,
          'locked',
        ),
      })),
    ];
    const orphanTaskWorktrees: StartupRecoveryOrphanTaskWorktree[] = [];
    for (const worktree of managedWorktrees) {
      if (!worktree.present || worktree.ownerState === 'live') {
        continue;
      }
      orphanTaskWorktrees.push({
        taskId: worktree.taskId,
        featureId: worktree.featureId,
        branch: worktree.branch,
        path: worktree.path,
        ownerState: worktree.ownerState,
        registered: worktree.registered,
        hasMetadataIndexLock: worktree.hasMetadataIndexLock,
      });
    }

    return {
      liveWorkerPids: pidState.liveWorkerPids,
      clearedDeadWorkerPids: pidState.clearedDeadWorkerPids,
      clearedLocks,
      preservedLocks: lockSweep.preserved,
      orphanTaskWorktrees,
      resumedRuns: runRecovery.resumedRuns,
      restartedRuns: runRecovery.restartedRuns,
      attentionRuns: runRecovery.attentionRuns,
      requiresAttention:
        orphanTaskWorktrees.length > 0 || runRecovery.attentionRuns.length > 0,
    };
  }

  async recoverOrphanedRuns(): Promise<StartupRecoveryRunSummary> {
    const summary: StartupRecoveryRunSummary = {
      resumedRuns: [],
      restartedRuns: [],
      attentionRuns: [],
    };
    const runs = this.ports.store.listAgentRuns({
      scopeType: 'task',
    });

    for (const run of runs) {
      if (run.scopeType !== 'task') {
        continue;
      }

      if (run.runStatus === 'retry_await') {
        continue;
      }

      const task = this.graph.tasks.get(run.scopeId);
      if (task === undefined) {
        continue;
      }

      if (task.status === 'cancelled') {
        if (run.runStatus !== 'completed' && run.runStatus !== 'cancelled') {
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'cancelled',
            owner: 'system',
            ...(run.sessionId !== undefined
              ? { sessionId: run.sessionId }
              : {}),
          });
        }
        continue;
      }

      if (task.collabControl === 'suspended') {
        if (run.runStatus === 'running') {
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'ready',
            owner: 'system',
            ...(run.sessionId !== undefined
              ? { sessionId: run.sessionId }
              : {}),
          });
        }
        continue;
      }

      if (run.runStatus === 'await_response') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'checkpointed_await_response',
          owner: 'manual',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        continue;
      }

      if (run.runStatus === 'await_approval') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'checkpointed_await_approval',
          owner: 'manual',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        continue;
      }

      if (
        run.runStatus === 'checkpointed_await_response' ||
        run.runStatus === 'checkpointed_await_approval'
      ) {
        continue;
      }

      if (shouldResumeTaskRun(run)) {
        const resumed = await this.resumeTaskRun(task, run);
        if (resumed.kind === 'resumed') {
          summary.resumedRuns.push({
            taskId: task.id,
            agentRunId: run.id,
            sessionId: resumed.sessionId,
          });
          continue;
        }
        if (resumed.kind === 'restarted') {
          summary.restartedRuns.push({
            taskId: task.id,
            agentRunId: run.id,
            sessionId: resumed.sessionId,
            ...(resumed.reason !== undefined ? { reason: resumed.reason } : {}),
          });
          continue;
        }
      }

      if (run.runStatus !== 'running') {
        continue;
      }

      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'ready',
        owner: 'system',
        restartCount: run.restartCount + 1,
      });
    }

    return summary;
  }

  private reconcileWorkerPids(): ReconciledWorkerPidState {
    const liveWorkerPids: StartupRecoveryPidFinding[] = [];
    const clearedDeadWorkerPids: StartupRecoveryPidFinding[] = [];
    const ownerStateByTask = new Map<Task['id'], 'live' | 'dead'>();

    for (const finding of this.pidRegistry.list()) {
      const run = this.ports.store.getAgentRun(finding.agentRunId);
      const taskId = run?.scopeType === 'task' ? run.scopeId : undefined;
      const pidFinding: StartupRecoveryPidFinding = {
        agentRunId: finding.agentRunId,
        pid: finding.pid,
        ...(taskId !== undefined ? { taskId } : {}),
      };

      let alive = true;
      try {
        alive = this.pidRegistry.isAlive(finding.pid);
      } catch {
        alive = true;
      }

      if (alive) {
        liveWorkerPids.push(pidFinding);
        if (taskId !== undefined) {
          ownerStateByTask.set(taskId, 'live');
        }
        continue;
      }

      this.pidRegistry.clear(finding.agentRunId);
      clearedDeadWorkerPids.push(pidFinding);
      if (taskId !== undefined && ownerStateByTask.get(taskId) !== 'live') {
        ownerStateByTask.set(taskId, 'dead');
      }
    }

    return {
      liveWorkerPids,
      clearedDeadWorkerPids,
      ownerStateByTask,
    };
  }

  private async resumeTaskRun(
    task: Task,
    run: TaskAgentRun,
  ): Promise<
    | { kind: 'not_recovered' }
    | { kind: 'resumed'; sessionId: string }
    | { kind: 'restarted'; sessionId: string; reason?: string }
  > {
    if (run.sessionId === undefined) {
      return { kind: 'not_recovered' };
    }

    await this.rebaseTaskWorktree(task);
    const dispatch = taskDispatchForRun(run);
    if (dispatch.mode !== 'resume') {
      return { kind: 'not_recovered' };
    }

    const feature = this.graph.features.get(task.featureId);
    const payload = buildTaskPayload(task, feature);
    const result = await this.ports.runtime.dispatchTask(
      task,
      dispatch,
      payload,
    );
    if (result.kind === 'not_resumable') {
      const fallback = await this.ports.runtime.dispatchTask(
        task,
        {
          mode: 'start',
          agentRunId: run.id,
        },
        payload,
      );
      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'running',
        owner: 'system',
        sessionId: fallback.sessionId,
        restartCount: run.restartCount + 1,
      });
      return {
        kind: 'restarted',
        sessionId: fallback.sessionId,
        reason: result.reason,
      };
    }

    this.ports.store.updateAgentRun(run.id, {
      sessionId: result.sessionId,
      restartCount: run.restartCount + 1,
    });
    return { kind: 'resumed', sessionId: result.sessionId };
  }

  private async rebaseTaskWorktree(task: Task): Promise<void> {
    const feature = this.graph.features.get(task.featureId);
    if (feature === undefined) {
      return;
    }

    const taskDir = path.resolve(
      this.projectRoot,
      worktreePath(resolveTaskWorktreeBranch(task)),
    );

    try {
      await fs.stat(taskDir);
    } catch {
      return;
    }

    const rebaseMarker = path.join(taskDir, 'RECOVERY_REBASE');
    await fs.writeFile(rebaseMarker, feature.featureBranch, 'utf-8');
  }
}

function shouldResumeTaskRun(run: TaskAgentRun): boolean {
  return run.runStatus === 'running';
}
