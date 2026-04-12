import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createGitDiffTool } from '@agents/worker/tools/git-diff';
import { createGitStatusTool } from '@agents/worker/tools/git-status';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
}

describe('worker git tools', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'worker-git-'));
    await initRepo(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('git_status', () => {
    it('reports a clean repo', async () => {
      const tool = createGitStatusTool(tmpDir);
      const result = await tool.execute('call-1', {});
      expect(result.details.isClean).toBe(true);
    });

    it('reports untracked files', async () => {
      await fs.writeFile(path.join(tmpDir, 'new.txt'), 'x');

      const tool = createGitStatusTool(tmpDir);
      const result = await tool.execute('call-1', {});

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('new.txt');
      expect(result.details.isClean).toBe(false);
      expect(result.details.untracked).toBe(1);
    });
  });

  describe('git_diff', () => {
    it('returns diff for working-tree changes against HEAD', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'one\n');
      const git = simpleGit(tmpDir);
      await git.add('.');
      await git.commit('init');

      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'two\n');

      const tool = createGitDiffTool(tmpDir);
      const result = await tool.execute('call-1', {});

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('-one');
      expect(text).toContain('+two');
      expect(result.details.ref).toBe('HEAD');
    });
  });
});
