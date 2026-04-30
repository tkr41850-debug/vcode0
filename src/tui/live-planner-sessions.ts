import type { GraphSnapshot } from '@core/graph/index';
import type { FeatureId } from '@core/types/index';
import type { ProposalOpScopeRef } from '@orchestrator/ports/index';

export interface LivePlannerEntry {
  scope: ProposalOpScopeRef;
  snapshot: GraphSnapshot;
  opCount: number;
  submissionCount: number;
}

/**
 * In-memory tracker of running planner/replanner agent runs the TUI is
 * mirroring. Keyed on agentRunId so overlapping plan/replan attempts on the
 * same feature stay distinct. Pure data store: no rendering or DOM access,
 * so it can be unit-tested without a TTY-backed TuiApp.
 */
export class LivePlannerSessions {
  private readonly entries = new Map<string, LivePlannerEntry>();

  recordOp(scope: ProposalOpScopeRef, draftSnapshot: GraphSnapshot): void {
    const existing = this.entries.get(scope.agentRunId);
    this.entries.set(scope.agentRunId, {
      scope,
      snapshot: draftSnapshot,
      opCount: (existing?.opCount ?? 0) + 1,
      submissionCount: existing?.submissionCount ?? 0,
    });
  }

  recordSubmit(
    scope: ProposalOpScopeRef,
    submissionIndex: number,
    fallbackSnapshot: GraphSnapshot,
  ): void {
    const existing = this.entries.get(scope.agentRunId);
    if (existing === undefined) {
      this.entries.set(scope.agentRunId, {
        scope,
        snapshot: fallbackSnapshot,
        opCount: 0,
        submissionCount: submissionIndex,
      });
      return;
    }
    existing.submissionCount = submissionIndex;
  }

  end(agentRunId: string): void {
    this.entries.delete(agentRunId);
  }

  findForFeature(
    featureId: FeatureId | undefined,
  ): LivePlannerEntry | undefined {
    if (featureId === undefined) {
      return undefined;
    }
    for (const entry of this.entries.values()) {
      if (entry.scope.featureId === featureId) {
        return entry;
      }
    }
    return undefined;
  }

  size(): number {
    return this.entries.size;
  }
}
