import type { IpcBridge } from '@agents/worker/ipc-bridge';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  summary: Type.String({
    description:
      'Concise description of what this task accomplished. Used as the task result summary and squash-commit message.',
  }),
  filesChanged: Type.Array(Type.String(), {
    description:
      'Paths (relative to the worktree root) touched by this task. Used for overlap tracking and merge-train bookkeeping.',
  }),
});

interface SubmitDetails {
  summary: string;
  filesChanged: string[];
}

export function createSubmitTool(
  ipc: IpcBridge,
): AgentTool<typeof parameters, SubmitDetails> {
  return {
    name: 'submit',
    label: 'Submit Task',
    description:
      'Signal that the task is complete. Emits the terminal `result` IPC message with the summary and files changed. Call exactly once when work is done.',
    parameters,
    execute: async (_toolCallId, params) => {
      ipc.submitResult({
        summary: params.summary,
        filesChanged: params.filesChanged,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Submitted task ${ipc.taskId}: ${params.summary}`,
          },
        ],
        details: {
          summary: params.summary,
          filesChanged: params.filesChanged,
        },
      };
    },
  };
}
