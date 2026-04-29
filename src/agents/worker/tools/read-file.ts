import * as fs from 'node:fs/promises';

import { resolveInsideWorkdir } from '@agents/worker/tools/_fs';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

/** Cap on bytes returned to the agent. Protects against OOM and token blowups. */
const MAX_READ_BYTES = 256 * 1024;

const parameters = Type.Object({
  path: Type.String({
    description: 'File path relative to the worktree root.',
  }),
});

interface ReadFileDetails {
  path: string;
  bytes: number;
  truncated: boolean;
}

export function createReadFileTool(
  workdir: string,
): AgentTool<typeof parameters, ReadFileDetails> {
  return {
    name: 'read_file',
    label: 'Read File',
    description: `Read a file. Truncated after ${MAX_READ_BYTES} bytes.`,
    parameters,
    execute: async (_toolCallId, params) => {
      const abs = resolveInsideWorkdir(workdir, params.path);
      const handle = await fs.open(abs, 'r');
      try {
        const stat = await handle.stat();
        const readSize = Math.min(stat.size, MAX_READ_BYTES);
        const buffer = Buffer.alloc(readSize);
        await handle.read(buffer, 0, readSize, 0);
        const text = buffer.toString('utf-8');
        const truncated = stat.size > MAX_READ_BYTES;
        const body = truncated
          ? `${text}\n[truncated: ${stat.size - MAX_READ_BYTES} more bytes]`
          : text;
        return {
          content: [{ type: 'text', text: body }],
          details: { path: params.path, bytes: readSize, truncated },
        };
      } finally {
        await handle.close();
      }
    },
  };
}
