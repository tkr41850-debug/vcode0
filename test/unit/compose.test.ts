import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { composeApplication, initializeProjectGraph } from '@root/compose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
        }),
      );
    } finally {
      db.close();
      await app.stop();
    }
  });
});
