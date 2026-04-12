import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StubUiPort } from '@app/stub-ports';
import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';
import type { GitPort } from '@git';
import type { OrchestratorPorts } from '@orchestrator/ports';
import { composeApplication } from '@root/compose';
import type { WorkerToOrchestratorMessage } from '@runtime';
import type { ProcessWorkerPool } from '@runtime/process-worker-pool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeMilestone(): Milestone {
  return {
    id: 'm-1' as MilestoneId,
    name: 'M1',
    description: 'smoke milestone',
    status: 'pending',
    order: 0,
  };
}

function makeFeature(): Feature {
  return {
    id: 'f-1' as FeatureId,
    milestoneId: 'm-1' as MilestoneId,
    orderInMilestone: 0,
    name: 'SmokeFeat',
    description: 'exercised end-to-end',
    dependsOn: [],
    status: 'pending',
    workControl: 'discussing',
    collabControl: 'none',
    featureBranch: 'feat-f-1',
  };
}

function makeTask(id: TaskId, order: number, deps: TaskId[] = []): Task {
  return {
    id,
    featureId: 'f-1' as FeatureId,
    orderInFeature: order,
    description: `task ${id}`,
    dependsOn: deps,
    status: 'ready',
    collabControl: 'none',
  };
}

describe('e2e smoke: compose → dispatch → merge', () => {
  let tempDir = '';
  let previousCwd = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'gvc0-e2e-smoke-'));
    process.chdir(tempDir);

    git(tempDir, 'init', '-b', 'main');
    git(tempDir, 'config', 'user.name', 'Test User');
    git(tempDir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(tempDir, 'README.md'), '# fixture\n');
    git(tempDir, 'add', 'README.md');
    git(tempDir, 'commit', '-m', 'chore: seed');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('drives a 2-task feature through runtime dispatch and merge train', async () => {
    const app = composeApplication({ ui: new StubUiPort() });
    const ports = (app as unknown as { ports: OrchestratorPorts }).ports;
    const runtime = ports.runtime as ProcessWorkerPool;
    const gitPort = ports.git as GitPort;
    const store = ports.store;

    // Seed a minimal DAG directly through the store.
    const milestone = makeMilestone();
    const feature = makeFeature();
    const t1 = makeTask('t-1' as TaskId, 0);
    const t2 = makeTask('t-2' as TaskId, 1, ['t-1' as TaskId]);
    await store.saveGraphState({
      milestones: [milestone],
      features: [feature],
      tasks: [t1, t2],
    });

    // Start the app (StubUiPort.show blocks until dispose — wait a tick
    // so recovery + show register before we drive ports).
    const started = app.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 1. GitPort: create the feature branch in the seeded repo.
    const handle = await gitPort.createFeatureBranch(feature);
    expect(handle.branchName).toBe('feat-f-1');
    const branches = git(tempDir, 'branch', '--list');
    expect(branches).toContain('feat-f-1');

    // 2. RuntimePort: dispatch both tasks through the ProcessWorkerPool and
    // await the phase-5 stub child results.
    const runTask = async (task: Task): Promise<WorkerToOrchestratorMessage> =>
      new Promise((resolve) => {
        const unsub = runtime.onMessage((msg: WorkerToOrchestratorMessage) => {
          if (
            (msg.type === 'result' || msg.type === 'error') &&
            msg.taskId === task.id
          ) {
            unsub();
            resolve(msg);
          }
        });
        void runtime.dispatchTask(task, {
          mode: 'start',
          agentRunId: `run-${task.id}`,
        });
      });

    const [r1, r2] = await Promise.all([runTask(t1), runTask(t2)]);
    expect(r1.type).toBe('result');
    expect(r2.type).toBe('result');
    if (r1.type === 'result') {
      expect(r1.result.summary).toContain('[phase5-stub] completed t-1');
    }
    if (r2.type === 'result') {
      expect(r2.result.summary).toContain('[phase5-stub] completed t-2');
    }

    // 3. GitPort.mergeFeatureBranch: add a real commit to the feature branch
    // (the runtime child is a stub and does not write files), then squash
    // merge into main via the merge train. The branch lives in the feature
    // worktree created above.
    const featureWorktree = join(tempDir, handle.worktreePath);
    writeFileSync(join(featureWorktree, 'feature.txt'), 'smoke\n');
    git(featureWorktree, 'add', 'feature.txt');
    git(featureWorktree, 'commit', '-m', 'feat: smoke payload');

    await gitPort.mergeFeatureBranch({
      featureId: feature.id,
      branchName: 'feat-f-1',
    });

    // main now contains the squashed merge.
    const mainLog = git(tempDir, 'log', '--oneline', 'main');
    expect(mainLog).toContain('merge: feat-f-1');
    const mainFiles = git(tempDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(mainFiles).toContain('feature.txt');

    // 4. Clean shutdown: stopAll tears down worker children; StubUiPort.show
    // resolves when dispose() runs.
    await app.stop();
    await started;
  }, 120_000);
});
