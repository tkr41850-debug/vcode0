import type { IpcBridge } from '@agents/worker/ipc-bridge';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  kind: Type.Union(
    [
      Type.Literal('replan_proposal'),
      Type.Literal('destructive_action'),
      Type.Literal('custom'),
    ],
    {
      description:
        'Type of approval being requested. Controls the payload shape the operator sees.',
    },
  ),
  summary: Type.String({
    description:
      'Short headline describing what is being requested. For destructive actions, name the action.',
  }),
  detail: Type.String({
    description:
      'Longer explanation. For replan_proposal, describe the proposed mutations. For destructive_action, describe the side effects.',
  }),
  affectedPaths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Paths that will be affected. Required for destructive_action, optional otherwise.',
    }),
  ),
});

interface RequestApprovalDetails {
  kind: 'replan_proposal' | 'destructive_action' | 'custom';
  decision: 'approved' | 'approve_always' | 'reject' | 'discuss';
}

export function createRequestApprovalTool(
  ipc: IpcBridge,
): AgentTool<typeof parameters, RequestApprovalDetails> {
  return {
    name: 'request_approval',
    label: 'Request Approval',
    description:
      'Ask the human operator to approve a replan proposal or destructive action. Blocks until an approval decision arrives.',
    parameters,
    execute: async (toolCallId, params) => {
      const payload =
        params.kind === 'replan_proposal'
          ? {
              kind: 'replan_proposal' as const,
              summary: params.summary,
              proposedMutations: params.affectedPaths ?? [],
            }
          : params.kind === 'destructive_action'
            ? {
                kind: 'destructive_action' as const,
                description: params.detail,
                affectedPaths: params.affectedPaths ?? [],
              }
            : {
                kind: 'custom' as const,
                label: params.summary,
                detail: params.detail,
              };

      const decision = await ipc.requestApproval(payload, toolCallId);
      const text =
        decision.kind === 'approved'
          ? 'approved'
          : decision.kind === 'approve_always'
            ? 'approved (always)'
            : decision.kind === 'reject'
              ? `rejected${decision.comment !== undefined ? `: ${decision.comment}` : ''}`
              : 'operator chose to discuss';
      const content = [{ type: 'text' as const, text }];
      const details = { kind: params.kind, decision: decision.kind };
      await ipc.recordToolOutput({
        toolCallId,
        toolName: 'request_approval',
        content,
        details,
        isError: false,
        timestamp: Date.now(),
      });

      return {
        content,
        details,
      };
    },
  };
}
