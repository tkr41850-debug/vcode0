import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createAppendKnowledgeTool } from '@agents/worker/tools/append-knowledge';
import { createRecordDecisionTool } from '@agents/worker/tools/record-decision';
import { describe, expect, it } from 'vitest';

import { useTmpDir } from '../../../../helpers/tmp-dir.js';

describe('worker knowledge tools', () => {
  const getTmpDir = useTmpDir('worker-knowledge');

  describe('append_knowledge', () => {
    it('appends to .gvc0/KNOWLEDGE.md, creating the directory', async () => {
      const tool = createAppendKnowledgeTool(getTmpDir());

      await tool.execute('call-1', { entry: 'always run tests' });
      await tool.execute('call-2', { entry: 'never commit secrets' });

      const contents = await fs.readFile(
        path.join(getTmpDir(), '.gvc0', 'KNOWLEDGE.md'),
        'utf-8',
      );
      expect(contents).toContain('always run tests');
      expect(contents).toContain('never commit secrets');
    });
  });

  describe('record_decision', () => {
    it('appends a decision with rationale and timestamp marker', async () => {
      const tool = createRecordDecisionTool(getTmpDir());

      await tool.execute('call-1', {
        decision: 'use sqlite',
        rationale: 'simple local persistence',
      });

      const contents = await fs.readFile(
        path.join(getTmpDir(), '.gvc0', 'DECISIONS.md'),
        'utf-8',
      );
      expect(contents).toContain('## use sqlite');
      expect(contents).toContain('simple local persistence');
      expect(contents).toMatch(/_Recorded \d{4}-\d{2}-\d{2}/);
    });
  });
});
