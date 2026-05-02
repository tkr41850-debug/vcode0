import type { GraphSnapshot } from '@core/graph/index';

export interface LiveProjectPlannerEntry {
  sessionId: string;
  snapshot: GraphSnapshot;
  opCount: number;
  submissionCount: number;
}

/**
 * Sibling of LivePlannerSessions for project-scope planner sessions. Keyed on
 * the project session uid (agent_runs.id). Operates on the project draft
 * graph snapshot rather than a feature-scoped one. Pure data store.
 */
export class LiveProjectPlannerSessions {
  private readonly entries = new Map<string, LiveProjectPlannerEntry>();
  private attachedSessionId: string | undefined;

  attach(sessionId: string): void {
    this.attachedSessionId = sessionId;
    if (!this.entries.has(sessionId)) {
      // No-op until the first op arrives; entry is created lazily so a fresh
      // session has no draft snapshot before any planner op fires.
    }
  }

  detach(): void {
    this.attachedSessionId = undefined;
  }

  getAttachedSessionId(): string | undefined {
    return this.attachedSessionId;
  }

  recordOp(sessionId: string, draftSnapshot: GraphSnapshot): void {
    const existing = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      sessionId,
      snapshot: draftSnapshot,
      opCount: (existing?.opCount ?? 0) + 1,
      submissionCount: existing?.submissionCount ?? 0,
    });
  }

  recordSubmit(
    sessionId: string,
    submissionIndex: number,
    fallbackSnapshot: GraphSnapshot,
  ): void {
    const existing = this.entries.get(sessionId);
    if (existing === undefined) {
      this.entries.set(sessionId, {
        sessionId,
        snapshot: fallbackSnapshot,
        opCount: 0,
        submissionCount: submissionIndex,
      });
      return;
    }
    existing.submissionCount = submissionIndex;
  }

  end(sessionId: string): void {
    this.entries.delete(sessionId);
    if (this.attachedSessionId === sessionId) {
      this.attachedSessionId = undefined;
    }
  }

  snapshot(sessionId: string): LiveProjectPlannerEntry | undefined {
    return this.entries.get(sessionId);
  }

  size(): number {
    return this.entries.size;
  }
}
