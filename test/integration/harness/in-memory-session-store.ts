import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionStore } from '@runtime/sessions/index';

/**
 * Map-backed `SessionStore` for integration tests — avoids `.gvc0/sessions`
 * filesystem writes that `FileSessionStore` would produce and lets tests
 * inspect saved message streams directly.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentMessage[]>();

  save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    // Defensive copy so later mutation of the agent's message list doesn't
    // retroactively change what the store "persisted".
    this.sessions.set(sessionId, [...messages]);
    return Promise.resolve();
  }

  load(sessionId: string): Promise<AgentMessage[] | null> {
    const messages = this.sessions.get(sessionId);
    return Promise.resolve(messages === undefined ? null : [...messages]);
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
