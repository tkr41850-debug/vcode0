import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PathLockClaimer } from '@agents/worker/path-lock';
import { resolveInsideWorkdir } from '@agents/worker/tools/_fs';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  path: Type.String({
    description: 'File path relative to the worktree root.',
  }),
  content: Type.String({
    description: 'Full file contents to write. Overwrites any existing file.',
  }),
});

interface WriteFileDetails {
  path: string;
  bytes: number;
}

export function createWriteFileTool(
  workdir: string,
  claimer: PathLockClaimer,
): AgentTool<typeof parameters, WriteFileDetails> {
  return {
    name: 'write_file',
    label: 'Write File',
    description:
      'Write (or overwrite) a file at the given path, creating parent directories as needed.',
    parameters,
    execute: async (_toolCallId, params) => {
      await claimer.claim(params.path);
      const abs = resolveInsideWorkdir(workdir, params.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, params.content, 'utf-8');
      const bytes = Buffer.byteLength(params.content);
      return {
        content: [
          { type: 'text', text: `Wrote ${bytes} bytes to ${params.path}` },
        ],
        details: { path: params.path, bytes },
      };
    },
  };
}
