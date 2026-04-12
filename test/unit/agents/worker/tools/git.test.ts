import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createGitDiffTool } from '@agents/worker/tools/git-diff';
import { createGitStatusTool } from '@agents/worker/tools/git-status';
import { simpleGit } from 'simple-git';
import { beforeEach, describe, expect, it } from 'vitest';

import { useTmpDir } from '../../../../helpers/tmp-dir.js';

async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
}

describe('worker git tools', () => {
  const getTmpDir = useTmpDir('worker-git');

  beforeEach(async () => {
    await initRepo(getTmpDir());
  });

  describe('git_status', () => {
    it('reports a clean repo', async () => {
      const tool = createGitStatusTool(getTmpDir());
      const result = await tool.execute('call-1', {});
      expect(result.details.isClean).toBe(true);
    });

    it('reports untracked files', async () => {
      await fs.writeFile(path.join(getTmpDir(), 'new.txt'), 'x');

      const tool = createGitStatusTool(getTmpDir());
      const result = await tool.execute('call-1', {});

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('new.txt');
      expect(result.details.isClean).toBe(false);
      expect(result.details.untracked).toBe(1);
    });
  });

  describe('git_diff', () => {
    it('returns diff for working-tree changes against HEAD', async () => {
      await fs.writeFile(path.join(getTmpDir(), 'a.txt'), 'one\n');
      const git = simpleGit(getTmpDir());
      await git.add('.');
      await git.commit('init');

      await fs.writeFile(path.join(getTmpDir(), 'a.txt'), 'two\n');

      const tool = createGitDiffTool(getTmpDir());
      const result = await tool.execute('call-1', {});

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('-one');
      expect(text).toContain('+two');
      expect(result.details.ref).toBe('HEAD');
    });
  });
});
