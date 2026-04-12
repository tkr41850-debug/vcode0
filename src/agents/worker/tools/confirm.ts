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
      'Marker the worker uses to acknowledge it has verified its own work after submit(). Orchestrator-side squash-merge is driven by the scheduler; this tool emits a progress notification so the operator can observe the confirmation.',
    parameters,
    execute: async () => {
      ipc.progress(`task ${ipc.taskId} confirmed`);
      return {
        content: [{ type: 'text', text: 'confirmed' }],
        details: { taskId: ipc.taskId },
      };
    },
  };
}
