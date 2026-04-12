import { resolveInsideWorkdir, walkEntries } from '@agents/worker/tools/_fs';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  directory: Type.Optional(
    Type.String({
      description:
        'Directory to list, relative to the worktree root. Defaults to the worktree root.',
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        'If true, walk subdirectories recursively. Defaults to false.',
    }),
  ),
});

interface ListFilesDetails {
  directory: string;
  count: number;
}

export function createListFilesTool(
  workdir: string,
): AgentTool<typeof parameters, ListFilesDetails> {
  return {
    name: 'list_files',
    label: 'List Files',
    description:
      'List files (and directories) inside the worktree. Skips common ignored dirs like .git, node_modules, dist.',
    parameters,
    execute: async (_toolCallId, params) => {
      const relDir = params.directory ?? '';
      const recursive = params.recursive ?? false;
      resolveInsideWorkdir(workdir, relDir);

      const results: string[] = [];
      for await (const entry of walkEntries(workdir, relDir, recursive)) {
        if (entry.isDirectory) {
          if (!recursive) results.push(`${entry.rel}/`);
        } else if (entry.isFile) {
          results.push(entry.rel);
        }
      }
      results.sort();
      return {
        content: [{ type: 'text', text: results.join('\n') }],
        details: { directory: relDir, count: results.length },
      };
    },
  };
}
