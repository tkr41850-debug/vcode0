import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import type { ApprovalPayload } from '@runtime/contracts';
import {
  composeApplication,
  formatWorkerOutput,
  initializeProjectGraph,
  summarizeApprovalPayload,
} from '@root/compose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('compose helpers', () => {
  it('formats wait and terminal worker output for monitor visibility', () => {
    expect(
      formatWorkerOutput({
        type: 'request_help',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        query: 'Need operator guidance',
      }),
    ).toBe('help requested: Need operator guidance');

    expect(
      formatWorkerOutput({
        type: 'request_approval',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        payload: {
          kind: 'custom',
          label: 'Approve destructive step',
          detail: 'Delete generated cache files',
        },
      }),
    ).toBe('approval requested: Approve destructive step');

    expect(
      formatWorkerOutput({
        type: 'error',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        error: 'boom',
      }),
    ).toBe('error: boom');

    expect(
      formatWorkerOutput({
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usd: 0.01,
        },
        result: {
          summary: 'done',
          filesChanged: [],
        },
      }),
    ).toBe('completed: done');
  });

  it('summarizes approval payload labels by kind', () => {
    const payloads: ApprovalPayload[] = [
      {
        kind: 'custom',
        label: 'Approve destructive step',
        detail: 'Delete generated cache files',
      },
      {
        kind: 'destructive_action',
        description: 'Delete generated cache files',
        affectedPaths: ['dist/cache'],
      },
      {
        kind: 'replan_proposal',
        summary: 'Switch to fallback task order',
        proposedMutations: ['move t-2 after t-3'],
      },
    ];

    expect(payloads.map((payload) => summarizeApprovalPayload(payload))).toEqual([
      'Approve destructive step',
      'Delete generated cache files',
      'Switch to fallback task order',
    ]);
  });
});

describe('composeApplication', () => {
  let originalCwd = '';
  let tmpDir = '';

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-app-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('bootstraps app runtime files and lifecycle', async () => {
    const app = await composeApplication();

    await app.stop();

    await expect(fs.stat(path.join(tmpDir, '.gvc0'))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpDir, '.gvc0', 'worktrees')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpDir, '.gvc0', 'config.json')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpDir, '.gvc0', 'state.db')),
    ).resolves.toBeTruthy();

    await expect(
      fs.readFile(path.join(tmpDir, '.gvc0', 'config.json'), 'utf-8'),
    ).resolves.toContain('"tokenProfile": "balanced"');
  });

  it('initializes starter milestone and planning feature through TUI command path', async () => {
    const app = await composeApplication();
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);

    try {
      expect(graph.snapshot().milestones).toEqual([]);
      expect(graph.snapshot().features).toEqual([]);

      const created = initializeProjectGraph(graph, {
        milestoneName: 'Milestone 1',
        milestoneDescription: 'Initial milestone',
        featureName: 'Project startup',
        featureDescription: 'Plan initial project work',
      });

      expect(created).toEqual({ milestoneId: 'm-1', featureId: 'f-1' });

      const snapshot = graph.snapshot();
      expect(snapshot.milestones).toHaveLength(1);
      expect(snapshot.milestones[0]).toEqual(
        expect.objectContaining({
          id: 'm-1',
          name: 'Milestone 1',
          steeringQueuePosition: 0,
        }),
      );
      expect(snapshot.features).toHaveLength(1);
      expect(snapshot.features[0]).toEqual(
        expect.objectContaining({
          id: 'f-1',
          milestoneId: 'm-1',
          workControl: 'planning',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
    } finally {
      db.close();
      await app.stop();
    }
  });

  it('rejects repeated project initialization', async () => {
    const app = await composeApplication();
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);

    try {
      initializeProjectGraph(graph, {
        milestoneName: 'Milestone 1',
        milestoneDescription: 'Initial milestone',
        featureName: 'Project startup',
        featureDescription: 'Plan initial project work',
      });

      expect(() =>
        initializeProjectGraph(graph, {
          milestoneName: 'Milestone 2',
          milestoneDescription: 'Another milestone',
          featureName: 'Another feature',
          featureDescription: 'Should not be created',
        }),
      ).toThrow('project already initialized');
    } finally {
      db.close();
      await app.stop();
    }
  });
});
