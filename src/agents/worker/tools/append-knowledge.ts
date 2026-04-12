import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  entry: Type.String({
    description:
      'Markdown-formatted lesson, pattern, or note to append to .gvc0/KNOWLEDGE.md.',
  }),
});

interface AppendKnowledgeDetails {
  path: string;
  bytesAppended: number;
}

const KNOWLEDGE_REL = path.join('.gvc0', 'KNOWLEDGE.md');

export function createAppendKnowledgeTool(
  projectRoot: string,
): AgentTool<typeof parameters, AppendKnowledgeDetails> {
  return {
    name: 'append_knowledge',
    label: 'Append Knowledge',
    description:
      'Append a lesson or pattern to the project-wide knowledge file (.gvc0/KNOWLEDGE.md).',
    parameters,
    execute: async (_toolCallId, params) => {
      const abs = path.join(projectRoot, KNOWLEDGE_REL);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const payload = `${params.entry.trimEnd()}\n\n`;
      await fs.appendFile(abs, payload, 'utf-8');
      return {
        content: [
          {
            type: 'text',
            text: `Appended ${payload.length} chars to ${KNOWLEDGE_REL}`,
          },
        ],
        details: { path: KNOWLEDGE_REL, bytesAppended: payload.length },
      };
    },
  };
}
