import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { simpleGit } from 'simple-git';

const parameters = Type.Object({});

interface GitStatusDetails {
  isClean: boolean;
  modified: number;
  staged: number;
  untracked: number;
}

export function createGitStatusTool(
  workdir: string,
): AgentTool<typeof parameters, GitStatusDetails> {
  return {
    name: 'git_status',
    label: 'Git Status',
    description:
      'Return `git status --porcelain` output for the task worktree and a summary of change counts.',
    parameters,
    execute: async () => {
      const git = simpleGit(workdir);
      const status = await git.status();
      const porcelain = await git.raw(['status', '--porcelain=v1']);
      return {
        content: [{ type: 'text', text: porcelain.trimEnd() }],
        details: {
          isClean: status.isClean(),
          modified: status.modified.length,
          staged: status.staged.length,
          untracked: status.not_added.length,
        },
      };
    },
  };
}
