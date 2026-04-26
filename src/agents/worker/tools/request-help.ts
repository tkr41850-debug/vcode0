import type { IpcBridge } from '@agents/worker/ipc-bridge';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  query: Type.String({
    description:
      'Question or request for the human operator. Be specific — this blocks the task until a response arrives.',
  }),
});

interface RequestHelpDetails {
  query: string;
  responseKind: 'answer' | 'discuss';
}

export function createRequestHelpTool(
  ipc: IpcBridge,
): AgentTool<typeof parameters, RequestHelpDetails> {
  return {
    name: 'request_help',
    label: 'Request Help',
    description:
      'Ask the human operator for guidance. Blocks the agent until the orchestrator delivers a help response.',
    parameters,
    execute: async (toolCallId, params) => {
      const response = await ipc.requestHelp(toolCallId, params.query);
      const text =
        response.kind === 'answer'
          ? response.text
          : '[operator chose to discuss — expect follow-up steering]';
      return {
        content: [{ type: 'text', text }],
        details: { query: params.query, responseKind: response.kind },
      };
    },
  };
}
