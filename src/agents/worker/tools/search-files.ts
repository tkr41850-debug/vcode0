import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveInsideWorkdir, walkEntries } from '@agents/worker/tools/_fs';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

/** Skip files larger than this — avoids slurping huge logs into memory. */
const MAX_FILE_BYTES = 1 * 1024 * 1024;

const parameters = Type.Object({
  pattern: Type.String({
    description:
      'Regular expression (JavaScript syntax) applied to each line of each file.',
  }),
  directory: Type.Optional(
    Type.String({
      description:
        'Directory to search, relative to the worktree root. Defaults to the worktree root.',
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: 'Cap on the number of match lines returned. Default 200.',
    }),
  ),
});

interface SearchFilesDetails {
  pattern: string;
  matches: number;
  truncated: boolean;
}

export function createSearchFilesTool(
  workdir: string,
): AgentTool<typeof parameters, SearchFilesDetails> {
  return {
    name: 'search_files',
    label: 'Search Files',
    description:
      'Search for a regex pattern across files in the worktree. Returns matching lines with file path and line number.',
    parameters,
    execute: async (_toolCallId, params) => {
      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern);
      } catch (err) {
        throw new Error(
          `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const limit = params.maxResults ?? 200;
      const relDir = params.directory ?? '';
      resolveInsideWorkdir(workdir, relDir);

      const matches: string[] = [];
      let truncated = false;

      outer: for await (const entry of walkEntries(workdir, relDir)) {
        if (!entry.isFile) continue;
        const abs = path.join(workdir, entry.rel);
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) continue;

        let contents: string;
        try {
          contents = await fs.readFile(abs, 'utf-8');
        } catch {
          continue;
        }
        const lines = contents.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (regex.test(line)) {
            matches.push(`${entry.rel}:${i + 1}: ${line}`);
            if (matches.length >= limit) {
              truncated = true;
              break outer;
            }
          }
        }
      }

      return {
        content: [{ type: 'text', text: matches.join('\n') }],
        details: {
          pattern: params.pattern,
          matches: matches.length,
          truncated,
        },
      };
    },
  };
}
