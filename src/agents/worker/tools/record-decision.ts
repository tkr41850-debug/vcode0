import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  decision: Type.String({
    description: 'Short headline for the architectural decision.',
  }),
  rationale: Type.String({
    description: 'Explanation of why this decision was made.',
  }),
});

interface RecordDecisionDetails {
  path: string;
  bytesAppended: number;
}

const DECISIONS_REL = path.join('.gvc0', 'DECISIONS.md');

export function createRecordDecisionTool(
  projectRoot: string,
): AgentTool<typeof parameters, RecordDecisionDetails> {
  return {
    name: 'record_decision',
    label: 'Record Decision',
    description:
      'Append an architectural decision and its rationale to the project decisions log (.gvc0/DECISIONS.md).',
    parameters,
    execute: async (_toolCallId, params) => {
      const abs = path.join(projectRoot, DECISIONS_REL);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const timestamp = new Date().toISOString();
      const payload = `## ${params.decision}\n\n_Recorded ${timestamp}_\n\n${params.rationale.trimEnd()}\n\n`;
      await fs.appendFile(abs, payload, 'utf-8');
      return {
        content: [
          {
            type: 'text',
            text: `Recorded decision "${params.decision}" in ${DECISIONS_REL}`,
          },
        ],
        details: { path: DECISIONS_REL, bytesAppended: payload.length },
      };
    },
  };
}
