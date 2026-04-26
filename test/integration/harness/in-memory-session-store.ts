import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionCheckpoint, SessionStore } from '@runtime/sessions/index';

/**
 * Map-backed `SessionStore` for integration tests — avoids `.gvc0/sessions`
 * filesystem writes that `FileSessionStore` would produce and lets tests
 * inspect saved checkpoints directly.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionCheckpoint>();

  save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    return this.saveCheckpoint(sessionId, { messages });
  }

  load(sessionId: string): Promise<AgentMessage[] | null> {
    const checkpoint = this.sessions.get(sessionId);
    return Promise.resolve(
      checkpoint === undefined ? null : structuredClone(checkpoint.messages),
    );
  }

  saveCheckpoint(
    sessionId: string,
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    // Defensive copy so later mutation of agent state doesn't rewrite what the
    // store persisted.
    this.sessions.set(sessionId, {
      messages: structuredClone(checkpoint.messages),
      ...(checkpoint.pendingWait !== undefined
        ? { pendingWait: clonePendingWait(checkpoint.pendingWait) }
        : {}),
      ...(checkpoint.completedToolResults !== undefined
        ? {
            completedToolResults: checkpoint.completedToolResults.map(
              (result) => structuredClone(result),
            ),
          }
        : {}),
      ...(checkpoint.terminalResult !== undefined
        ? { terminalResult: structuredClone(checkpoint.terminalResult) }
        : {}),
    });
    return Promise.resolve();
  }

  loadCheckpoint(sessionId: string): Promise<SessionCheckpoint | null> {
    const checkpoint = this.sessions.get(sessionId);
    if (checkpoint === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      messages: structuredClone(checkpoint.messages),
      ...(checkpoint.pendingWait !== undefined
        ? { pendingWait: clonePendingWait(checkpoint.pendingWait) }
        : {}),
      ...(checkpoint.completedToolResults !== undefined
        ? {
            completedToolResults: checkpoint.completedToolResults.map(
              (result) => structuredClone(result),
            ),
          }
        : {}),
      ...(checkpoint.terminalResult !== undefined
        ? { terminalResult: structuredClone(checkpoint.terminalResult) }
        : {}),
    });
  }

  delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  /** Test-only accessor — lists the session IDs currently stored. */
  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }
}

function clonePendingWait(
  pendingWait: NonNullable<SessionCheckpoint['pendingWait']>,
): NonNullable<SessionCheckpoint['pendingWait']> {
  if (pendingWait.kind === 'help') {
    return { ...pendingWait };
  }
  return {
    kind: 'approval',
    toolCallId: pendingWait.toolCallId,
    payload: structuredClone(pendingWait.payload),
  };
}
