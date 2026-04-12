import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { simpleGit } from 'simple-git';

const parameters = Type.Object({
  ref: Type.Optional(
    Type.String({
      description:
        'Git reference to diff against. Defaults to HEAD (working tree changes).',
    }),
  ),
  staged: Type.Optional(
    Type.Boolean({
      description:
        'If true, diff the staging area instead of the working tree.',
    }),
  ),
});

interface GitDiffDetails {
  ref: string;
  staged: boolean;
  bytes: number;
}

export function createGitDiffTool(
  workdir: string,
): AgentTool<typeof parameters, GitDiffDetails> {
  return {
    name: 'git_diff',
    label: 'Git Diff',
    description:
      'Return `git diff` output for the task worktree. Accepts an optional ref and a staged flag.',
    parameters,
    execute: async (_toolCallId, params) => {
      const git = simpleGit(workdir);
      const args = ['diff'];
      if (params.staged === true) args.push('--staged');
      const ref = params.ref ?? 'HEAD';
      if (!(params.staged === true && params.ref === undefined)) {
        args.push(ref);
      }
      const diff = await git.raw(args);
      return {
        content: [{ type: 'text', text: diff }],
        details: {
          ref,
          staged: params.staged ?? false,
          bytes: Buffer.byteLength(diff),
        },
      };
    },
  };
}
