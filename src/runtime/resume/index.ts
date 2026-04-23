/**
 * Pi-SDK resume facade (plan 03-05).
 *
 * Consumption point for Phase 7's two-tier pause + respawn-with-replay
 * (REQ-INBOX-02 / REQ-INBOX-03). Hides the strategy choice behind a stable
 * import surface so Phase 7 and Phase 9 can call `resume(...)` without
 * knowing which underlying path is active.
 *
 * Strategy decision: `persist-tool-outputs` — see
 * `docs/spikes/pi-sdk-resume.md`. The five-scenario spike showed that
 * pi-sdk's native `Agent.continue()` throws `"Cannot continue from message
 * role: assistant"` on every realistic resume shape, so we splice
 * persisted tool-results back onto the transcript before calling
 * `continue()`.
 */

import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai';

import type { ToolOutputStore } from './tool-output-store.js';

export type ResumeStrategy = 'native' | 'persist-tool-outputs' | 'hybrid';

/**
 * Active resume strategy. Set at compile time per the plan-03-05 spike
 * decision. Phase 7 and Phase 9 treat this as read-only metadata.
 */
export const RESUME_STRATEGY: ResumeStrategy = 'persist-tool-outputs';

export type ResumeOutcome =
  | { kind: 'resumed' }
  | { kind: 'already-terminated'; reason: string };

export interface ResumeOptions {
  agent: Agent;
  savedMessages: AgentMessage[];
  toolOutputs: ToolOutputStore;
}

/**
 * Rehydrate a paused/crashed Agent run. The caller is responsible for
 * constructing the Agent with `savedMessages` as its initial transcript
 * (the pi-sdk constructor copies the array, so we can still mutate the
 * ones we pass in here).
 *
 * Behavior:
 * 1. If the last message is a non-tool-call assistant message (e.g., a
 *    plain text wrap-up), the run has already terminated cleanly —
 *    return `already-terminated` without calling continue(). Phase 7
 *    treats this as a no-op resume.
 * 2. If the last message is an assistant message that contains tool
 *    calls, splice matching `ToolResultMessage` entries from the
 *    `toolOutputs` store. Any tool call without a persisted result is
 *    logged in the outcome but NOT synthesized — that would make the
 *    transcript lie about tool execution. Phase 7 escalates that case
 *    to the inbox as "resume-incomplete".
 * 3. After the splice, call `agent.continue()` and await idle.
 *
 * Note: if a future pi-sdk version relaxes the "assistant last"
 * restriction, this splice becomes a no-op on the already-terminal path
 * and we can revisit the strategy decision.
 */
export async function resume(opts: ResumeOptions): Promise<ResumeOutcome> {
  const { agent, savedMessages, toolOutputs } = opts;

  const last = savedMessages.at(-1);
  if (last === undefined) {
    return { kind: 'already-terminated', reason: 'empty-transcript' };
  }

  if (last.role !== 'assistant') {
    // Transcript already ends on a user/tool-result message — pi-sdk will
    // accept continue() directly, no splice needed.
    await agent.continue();
    await agent.waitForIdle();
    return { kind: 'resumed' };
  }

  // Last message is assistant. Inspect for pending tool calls that need
  // synthetic tool-result splicing.
  const assistantLast = last;
  const toolCalls = extractToolCalls(assistantLast);

  if (toolCalls.length === 0) {
    // Plain text assistant — agent run has terminated. No resume work to do.
    return {
      kind: 'already-terminated',
      reason: 'assistant-text-terminal',
    };
  }

  const spliced: AgentMessage[] = [...savedMessages];
  const missing: string[] = [];
  for (const tc of toolCalls) {
    const saved = toolOutputs.get(tc.id);
    if (saved === undefined) {
      missing.push(tc.id);
      continue;
    }
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: saved.toolCallId,
      toolName: saved.toolName,
      content: saved.content,
      isError: saved.isError,
      timestamp: saved.timestamp,
      ...(saved.details !== undefined ? { details: saved.details } : {}),
    };
    spliced.push(toolResult);
  }

  if (missing.length > 0) {
    // Cannot synthesize: bail with a structured outcome so Phase 7 can
    // escalate. Do NOT call continue() — it would throw, and we would lose
    // the diagnostic about which tool-call results were missing.
    return {
      kind: 'already-terminated',
      reason: `missing-tool-outputs:${missing.join(',')}`,
    };
  }

  // Mutate the agent's transcript via its state accessor so pi-sdk's
  // copy-on-assign semantics snapshot the spliced array.
  agent.state.messages = spliced;

  await agent.continue();
  await agent.waitForIdle();
  return { kind: 'resumed' };
}

interface ToolCallRef {
  id: string;
  name: string;
}

function extractToolCalls(message: AgentMessage): ToolCallRef[] {
  if (message.role !== 'assistant') return [];
  const assistant = message as AssistantMessage;
  const calls: ToolCallRef[] = [];
  for (const block of assistant.content) {
    if (block.type === 'toolCall') {
      calls.push({ id: block.id, name: block.name });
    }
  }
  return calls;
}

// Re-export store types so callers only need to import from @runtime/resume.
export type {
  PersistedToolOutput,
  ToolOutputStore,
} from './tool-output-store.js';
export {
  createFileToolOutputStore,
  createInMemoryToolOutputStore,
} from './tool-output-store.js';
