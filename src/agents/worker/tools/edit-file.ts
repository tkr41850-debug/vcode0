import * as fs from 'node:fs/promises';

import { resolveInsideWorkdir } from '@agents/worker/tools/_fs';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  path: Type.String({
    description: 'File path relative to the worktree root.',
  }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description: 'Exact substring to replace. Must appear exactly once.',
      }),
      newText: Type.String({
        description: 'Replacement text.',
      }),
    }),
    {
      description:
        'Ordered list of substring replacements. Each edit must match exactly once in the current file contents.',
    },
  ),
});

interface EditFileDetails {
  path: string;
  edits: number;
}

export function createEditFileTool(
  workdir: string,
): AgentTool<typeof parameters, EditFileDetails> {
  return {
    name: 'edit_file',
    label: 'Edit File',
    description:
      'Apply an ordered list of exact-string replacements to a file. Each edit must match exactly once in the current contents.',
    parameters,
    execute: async (_toolCallId, params) => {
      const abs = resolveInsideWorkdir(workdir, params.path);
      let contents = await fs.readFile(abs, 'utf-8');

      for (const [i, edit] of params.edits.entries()) {
        const firstIdx = contents.indexOf(edit.oldText);
        if (firstIdx === -1) {
          throw new Error(`edit ${i}: oldText not found in ${params.path}`);
        }
        const lastIdx = contents.lastIndexOf(edit.oldText);
        if (firstIdx !== lastIdx) {
          throw new Error(
            `edit ${i}: oldText matches multiple locations in ${params.path}`,
          );
        }
        contents =
          contents.slice(0, firstIdx) +
          edit.newText +
          contents.slice(firstIdx + edit.oldText.length);
      }

      await fs.writeFile(abs, contents, 'utf-8');
      return {
        content: [
          {
            type: 'text',
            text: `Applied ${params.edits.length} edit(s) to ${params.path}`,
          },
        ],
        details: { path: params.path, edits: params.edits.length },
      };
    },
  };
}
