import type { IpcBridge } from '@agents/worker/ipc-bridge';
import { createConfirmTool } from '@agents/worker/tools/confirm';
import { createRequestApprovalTool } from '@agents/worker/tools/request-approval';
import { createRequestHelpTool } from '@agents/worker/tools/request-help';
import { createSubmitTool } from '@agents/worker/tools/submit';
import type { TaskResult } from '@core/types/index';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
} from '@runtime/contracts';
import { describe, expect, it } from 'vitest';

interface MockBridge extends IpcBridge {
  _lastResult?: TaskResult;
  _progressMessages: string[];
  _lastHelpQuery?: string;
  _lastHelpToolCallId?: string;
  _lastApprovalPayload?: ApprovalPayload;
  _lastApprovalToolCallId?: string;
  _recordedToolOutputs: Array<{
    toolCallId: string;
    toolName: string;
    content: unknown;
    details?: unknown;
    isError: boolean;
    timestamp: number;
  }>;
  _nextHelpResponse?: HelpResponse;
  _nextApprovalDecision?: ApprovalDecision;
}

function createMockBridge(): MockBridge {
  const bridge: MockBridge = {
    taskId: 't-1',
    agentRunId: 'r-1',
    _progressMessages: [],
    _recordedToolOutputs: [],
    progress(msg: string) {
      bridge._progressMessages.push(msg);
    },
    requestHelp(query: string, toolCallId: string) {
      bridge._lastHelpQuery = query;
      bridge._lastHelpToolCallId = toolCallId;
      return Promise.resolve(bridge._nextHelpResponse ?? { kind: 'discuss' });
    },
    requestApproval(payload: ApprovalPayload, toolCallId: string) {
      bridge._lastApprovalPayload = payload;
      bridge._lastApprovalToolCallId = toolCallId;
      return Promise.resolve(
        bridge._nextApprovalDecision ?? { kind: 'approved' },
      );
    },
    recordToolOutput(output) {
      bridge._recordedToolOutputs.push(output);
      return Promise.resolve();
    },
    claimLock(_paths: readonly string[]) {
      return Promise.resolve({ granted: true } as const);
    },
    submitResult(result: TaskResult) {
      bridge._lastResult = result;
    },
  };
  return bridge;
}

describe('worker ipc-coupled tools', () => {
  describe('submit', () => {
    it('emits a result through the bridge', async () => {
      const bridge = createMockBridge();
      const tool = createSubmitTool(bridge);

      await tool.execute('call-1', {
        summary: 'did the thing',
        filesChanged: ['src/a.ts', 'src/b.ts'],
      });

      expect(bridge._lastResult).toEqual({
        summary: 'did the thing',
        filesChanged: ['src/a.ts', 'src/b.ts'],
      });
    });
  });

  describe('confirm', () => {
    it('emits progress and does not submit a result', async () => {
      const bridge = createMockBridge();
      const tool = createConfirmTool(bridge);

      await tool.execute('call-1', {});

      expect(bridge._progressMessages).toHaveLength(1);
      expect(bridge._lastResult).toBeUndefined();
    });
  });

  describe('request_help', () => {
    it('forwards the query and returns operator answer text', async () => {
      const bridge = createMockBridge();
      bridge._nextHelpResponse = { kind: 'answer', text: 'use option B' };
      const tool = createRequestHelpTool(bridge);

      const result = await tool.execute('call-1', {
        query: 'which option should I pick?',
      });

      expect(bridge._lastHelpQuery).toBe('which option should I pick?');
      expect(bridge._lastHelpToolCallId).toBe('call-1');
      expect((result.content[0] as { text: string }).text).toBe('use option B');
      expect(result.details.responseKind).toBe('answer');
      expect(bridge._recordedToolOutputs).toEqual([
        expect.objectContaining({
          toolCallId: 'call-1',
          toolName: 'request_help',
          isError: false,
          details: {
            query: 'which option should I pick?',
            responseKind: 'answer',
          },
        }),
      ]);
    });

    it('reports discuss branch when operator chooses to discuss', async () => {
      const bridge = createMockBridge();
      bridge._nextHelpResponse = { kind: 'discuss' };
      const tool = createRequestHelpTool(bridge);

      const result = await tool.execute('call-1', { query: 'halp' });

      expect(result.details.responseKind).toBe('discuss');
      expect(bridge._recordedToolOutputs).toEqual([
        expect.objectContaining({
          toolCallId: 'call-1',
          toolName: 'request_help',
          isError: false,
          details: { query: 'halp', responseKind: 'discuss' },
        }),
      ]);
    });
  });

  describe('request_approval', () => {
    it('forwards a replan_proposal payload and reports approval', async () => {
      const bridge = createMockBridge();
      bridge._nextApprovalDecision = { kind: 'approved' };
      const tool = createRequestApprovalTool(bridge);

      const result = await tool.execute('call-1', {
        kind: 'replan_proposal',
        summary: 'split feature',
        detail: 'split foo into foo-a and foo-b',
        affectedPaths: ['mutation-1'],
      });

      expect(bridge._lastApprovalPayload?.kind).toBe('replan_proposal');
      expect(bridge._lastApprovalToolCallId).toBe('call-1');
      if (bridge._lastApprovalPayload?.kind === 'replan_proposal') {
        expect(bridge._lastApprovalPayload.proposedMutations).toEqual([
          'mutation-1',
        ]);
      }
      expect(result.details.decision).toBe('approved');
      expect(bridge._recordedToolOutputs).toEqual([
        expect.objectContaining({
          toolCallId: 'call-1',
          toolName: 'request_approval',
          isError: false,
          details: { kind: 'replan_proposal', decision: 'approved' },
        }),
      ]);
    });

    it('forwards a destructive_action payload with affected paths', async () => {
      const bridge = createMockBridge();
      bridge._nextApprovalDecision = {
        kind: 'reject',
        comment: 'too risky',
      };
      const tool = createRequestApprovalTool(bridge);

      const result = await tool.execute('call-1', {
        kind: 'destructive_action',
        summary: 'rm -rf dist',
        detail: 'delete dist for clean build',
        affectedPaths: ['dist'],
      });

      expect(bridge._lastApprovalPayload?.kind).toBe('destructive_action');
      expect(bridge._lastApprovalToolCallId).toBe('call-1');
      expect(result.details.decision).toBe('reject');
      expect((result.content[0] as { text: string }).text).toContain(
        'too risky',
      );
      expect(bridge._recordedToolOutputs).toEqual([
        expect.objectContaining({
          toolCallId: 'call-1',
          toolName: 'request_approval',
          isError: false,
          details: { kind: 'destructive_action', decision: 'reject' },
        }),
      ]);
    });
  });
});
