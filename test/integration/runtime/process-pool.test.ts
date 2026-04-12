import type { Task, TaskId } from '@core/types/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
import { ProcessWorkerPool } from '@runtime/process-worker-pool';
import { afterEach, describe, expect, it } from 'vitest';

function makeTask(id: TaskId): Task {
  return {
    id,
    featureId: 'f-1',
    orderInFeature: 0,
    description: `task ${id}`,
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
  };
}

describe('ProcessWorkerPool (phase 5 stub child)', () => {
  let pool: ProcessWorkerPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.stopAll();
      pool = undefined;
    }
  });

  it('spawns a child, receives a result, and exits cleanly', async () => {
    pool = new ProcessWorkerPool({ maxConcurrency: 2 });

    const results: WorkerToOrchestratorMessage[] = [];
    pool.onMessage((msg) => {
      results.push(msg);
    });

    const task = makeTask('t-1');
    const done = new Promise<WorkerToOrchestratorMessage>((resolve) => {
      const unsub = pool!.onMessage((msg) => {
        if (msg.type === 'result' || msg.type === 'error') {
          unsub();
          resolve(msg);
        }
      });
    });

    const dispatch = await pool.dispatchTask(task, {
      mode: 'start',
      agentRunId: 'r-1',
    });

    expect(dispatch.kind).toBe('started');
    expect(dispatch.taskId).toBe('t-1');

    const final = await done;
    expect(final.type).toBe('result');
    if (final.type === 'result') {
      expect(final.taskId).toBe('t-1');
      expect(final.result.summary).toContain('[phase5-stub] completed t-1');
    }

    // progress message was also emitted
    const sawProgress = results.some((m) => m.type === 'progress');
    expect(sawProgress).toBe(true);
  }, 30_000);

  it('idleWorkerCount reflects live children and resets after stopAll', async () => {
    pool = new ProcessWorkerPool({ maxConcurrency: 3 });
    expect(pool.idleWorkerCount()).toBe(3);
    await pool.stopAll();
    expect(pool.idleWorkerCount()).toBe(3);
  });
});
