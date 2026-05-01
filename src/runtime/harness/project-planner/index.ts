import type { LiveProposalPhaseSession } from '@agents/runtime';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ProjectRunPayload, RunScope } from '@runtime/contracts';
import type {
  FeaturePhaseDispatchOutcome,
  FeaturePhaseSessionHandle,
  ResumeFeaturePhaseResult,
} from '@runtime/harness/feature-phase/index';
import { createProposalPhaseSessionHandle } from '@runtime/harness/feature-phase/index';
import type { SessionStore } from '@runtime/sessions/index';

export type ProjectScope = Extract<RunScope, { kind: 'project' }>;

export interface ProjectPlannerBackend {
  start(
    scope: ProjectScope,
    payload: ProjectRunPayload,
    agentRunId: string,
  ): Promise<FeaturePhaseSessionHandle>;
  resume(
    scope: ProjectScope,
    run: { agentRunId: string; sessionId: string },
    payload: ProjectRunPayload,
  ): Promise<ResumeFeaturePhaseResult>;
}

export interface ProjectPlannerAgentSessionFactory {
  startProjectPlanner(run: {
    agentRunId: string;
    sessionId?: string;
    messages?: AgentMessage[];
  }): LiveProposalPhaseSession;
}

/**
 * Backend for project-scope agent dispatch. Mirrors
 * {@link DiscussFeaturePhaseBackend} for project-scope sessions: produces a
 * {@link FeaturePhaseSessionHandle} backed by a {@link LiveProposalPhaseSession}
 * so the rest of the dispatch pipeline (await_approval persistence, planner
 * chat input, help/abort routing) remains uniform with feature-phase plan/replan.
 */
export class ProjectPlannerBackendImpl implements ProjectPlannerBackend {
  constructor(
    private readonly factory: ProjectPlannerAgentSessionFactory,
    private readonly sessionStore: SessionStore,
  ) {}

  start(
    _scope: ProjectScope,
    _payload: ProjectRunPayload,
    agentRunId: string,
  ): Promise<FeaturePhaseSessionHandle> {
    const session = this.factory.startProjectPlanner({ agentRunId });
    return Promise.resolve(toHandle(agentRunId, session));
  }

  async resume(
    _scope: ProjectScope,
    run: { agentRunId: string; sessionId: string },
    _payload: ProjectRunPayload,
  ): Promise<ResumeFeaturePhaseResult> {
    const messages = await this.sessionStore.load(run.sessionId);
    if (messages === null) {
      return {
        kind: 'not_resumable',
        sessionId: run.sessionId,
        reason: 'session_not_found',
      };
    }
    const session = this.factory.startProjectPlanner({
      agentRunId: run.agentRunId,
      sessionId: run.sessionId,
      messages,
    });
    return {
      kind: 'resumed',
      handle: toHandle(run.sessionId, session),
    };
  }
}

function toHandle(
  sessionId: string,
  session: LiveProposalPhaseSession,
): FeaturePhaseSessionHandle {
  // project sessions reuse the proposal/plan handle shape — the apply path
  // (Step 4.4) discriminates on agent_runs.scopeType, not on the handle phase.
  return createProposalPhaseSessionHandle({
    sessionId,
    session,
    phase: 'plan',
  });
}

export type { FeaturePhaseDispatchOutcome };
