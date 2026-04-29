import type { IpcBridge } from '@agents/worker/ipc-bridge';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({});

interface ConfirmDetails {
  taskId: string;
}

export function createConfirmTool(
  ipc: IpcBridge,
): AgentTool<typeof parameters, ConfirmDetails> {
  return {
    name: 'confirm',
    label: 'Confirm Task',
    description:
      'Self-attest that you have verified your own work after `submit`. Call after running the verification checks named in the task contract and observing them pass; do not call if any check failed or you did not run the named checks. This is a progress marker, not a merge trigger — `submit` is the terminal task-complete signal and the orchestrator drives squash-merge from that independently.',
    parameters,
    execute: (_toolCallId) => {
      ipc.progress(`task ${ipc.taskId} confirmed`);
      return Promise.resolve({
        content: [{ type: 'text', text: 'confirmed' }],
        details: { taskId: ipc.taskId },
      });
    },
  };
}
