import type { GraphSnapshot } from '@core/graph/index';
import type { GraphProposal } from '@core/proposals/index';
import type { AgentRun, FeatureId } from '@core/types/index';
import type { ProjectSessionFilter } from '@orchestrator/ports/index';
import { findRunningTasksAffected } from '@orchestrator/proposals/running-tasks-affected';
import type { ParsedSlashCommand } from '@tui/commands/index';
import {
  diffProposalSnapshots,
  renderProposalDiff,
} from '@tui/proposal-review';

/**
 * Active runStatuses queried for the picker. Excludes terminal states
 * (`completed`, `failed`, `cancelled`) since those rows are not resumable.
 */
const ACTIVE_PROJECT_RUN_STATUSES: AgentRun['runStatus'][] = [
  'running',
  'await_response',
  'await_approval',
];

export interface ProjectPlannerEnvironment {
  listProjectSessions(
    this: void,
    filter?: ProjectSessionFilter,
  ): readonly AgentRun[];
  startProjectPlannerSession(this: void): Promise<string>;
  resumeProjectPlannerSession(this: void, id: string): Promise<void>;
  attachProjectSession(this: void, sessionId: string): void;
  detachProjectSession(this: void): void;
}

export type ProjectPlannerPickerSelection =
  | { kind: 'start-new' }
  | { kind: 'resume'; sessionId: string };

export type ProjectPlannerPickerOption = ProjectPlannerPickerSelection & {
  label: string;
  description: string;
};

export interface ProjectPlannerPickerState {
  options: readonly ProjectPlannerPickerOption[];
}

export interface ProjectPlannerState {
  attachedSessionId?: string;
  picker?: ProjectPlannerPickerState;
}

export interface ProjectPlannerCommandResult {
  message: string;
}

export interface ProjectProposalReviewInput {
  before: GraphSnapshot;
  after: GraphSnapshot;
  proposal: GraphProposal;
  agentRuns: readonly AgentRun[];
}

export interface ProjectProposalCancellationApproval {
  affectedFeatureIds: FeatureId[];
  affectedRunCount: number;
  text: string;
}

export interface ProjectProposalReviewView {
  diffText: string;
  cancellationApproval?: ProjectProposalCancellationApproval;
}

export interface ProjectPlannerControllerOptions {
  /** Override the running-tasks-affected helper (used by tests). */
  findRunningTasksAffected?: typeof findRunningTasksAffected;
}

/**
 * Drives the project-planner mode lifecycle for the TUI. Owns the picker
 * state (entry → list sessions → choose start-new / resume) and the
 * attached-session pointer that the view-model reads to render the
 * composer scope label and the chat surface.
 */
export class ProjectPlannerController {
  private state: ProjectPlannerState = {};
  private readonly findRunningTasksAffected: typeof findRunningTasksAffected;

  constructor(
    private readonly env: ProjectPlannerEnvironment,
    options: ProjectPlannerControllerOptions = {},
  ) {
    this.findRunningTasksAffected =
      options.findRunningTasksAffected ?? findRunningTasksAffected;
  }

  getState(): ProjectPlannerState {
    return this.state;
  }

  getAttachedSessionId(): string | undefined {
    return this.state.attachedSessionId;
  }

  async enter(): Promise<void> {
    const sessions = this.env.listProjectSessions({
      runStatuses: ACTIVE_PROJECT_RUN_STATUSES,
    });
    this.state = {
      ...this.state,
      picker: { options: buildPickerOptions(sessions) },
    };
  }

  async selectOption(selection: ProjectPlannerPickerSelection): Promise<void> {
    if (selection.kind === 'start-new') {
      const sessionId = await this.env.startProjectPlannerSession();
      this.env.attachProjectSession(sessionId);
      this.state = { attachedSessionId: sessionId };
      return;
    }
    await this.env.resumeProjectPlannerSession(selection.sessionId);
    this.env.attachProjectSession(selection.sessionId);
    this.state = { attachedSessionId: selection.sessionId };
  }

  detach(): void {
    this.env.detachProjectSession();
    this.state = {};
  }

  /**
   * Attach to a session that compose has already started (greenfield
   * bootstrap auto-spawn). Skips the picker and the start/resume coordinator
   * calls because the session already exists; only updates local state and
   * the live proposal-mirror tracker.
   */
  attachExternal(sessionId: string): void {
    this.env.attachProjectSession(sessionId);
    this.state = { attachedSessionId: sessionId };
  }

  /**
   * Pre-flight a project-scope proposal: render the diff and, if any
   * affected feature has a running task or feature_phase run, surface a
   * cancellation-approval block so the operator can explicitly approve
   * cancelling those runs before the topology change applies. Uses the
   * shared `running-tasks-affected` helper — single source of truth with
   * the apply-time CAS check in `applyProjectProposal`.
   */
  reviewProposal(input: ProjectProposalReviewInput): ProjectProposalReviewView {
    const diffText = renderProposalDiff(
      diffProposalSnapshots(input.before, input.after),
    );
    const taskFeatureLookup = buildTaskFeatureLookup(input.before);
    const affectedFeatureIds = this.findRunningTasksAffected({
      proposal: input.proposal,
      agentRuns: input.agentRuns,
      taskFeatureLookup,
    });
    if (affectedFeatureIds.length === 0) {
      return { diffText };
    }
    const affectedSet = new Set<FeatureId>(affectedFeatureIds);
    const affectedRunCount = countAffectedRuns(
      input.agentRuns,
      affectedSet,
      taskFeatureLookup,
    );
    const text = `Approving will cancel ${affectedRunCount} running run${affectedRunCount === 1 ? '' : 's'} on feature(s) ${affectedFeatureIds.join(', ')}. Confirm cancellation to apply.`;
    return {
      diffText,
      cancellationApproval: {
        affectedFeatureIds,
        affectedRunCount,
        text,
      },
    };
  }

  async execute(
    parsed: ParsedSlashCommand,
  ): Promise<ProjectPlannerCommandResult> {
    if (parsed.name !== 'project') {
      throw new Error(`unexpected slash command "${parsed.name}"`);
    }
    const positional = parsed.positionals?.[0];
    const previous = this.state.attachedSessionId;
    if (positional === 'detach') {
      this.detach();
      return {
        message:
          previous === undefined
            ? 'project-planner mode not attached'
            : `Detached from project-planner session ${previous}.`,
      };
    }
    if (positional === undefined && previous !== undefined) {
      this.detach();
      return {
        message: `Detached from project-planner session ${previous}.`,
      };
    }
    await this.enter();
    const optionCount = this.state.picker?.options.length ?? 0;
    return {
      message: `Project-planner picker open (${optionCount} option${optionCount === 1 ? '' : 's'}).`,
    };
  }
}

function buildTaskFeatureLookup(
  snapshot: GraphSnapshot,
): (taskId: string) => FeatureId | undefined {
  const map = new Map<string, FeatureId>();
  for (const task of snapshot.tasks) {
    map.set(task.id, task.featureId);
  }
  return (taskId: string) => map.get(taskId);
}

function countAffectedRuns(
  agentRuns: readonly AgentRun[],
  affectedFeatures: Set<FeatureId>,
  taskFeatureLookup: (taskId: string) => FeatureId | undefined,
): number {
  let count = 0;
  for (const run of agentRuns) {
    if (run.runStatus !== 'running') continue;
    if (run.scopeType === 'feature_phase') {
      if (affectedFeatures.has(run.scopeId)) count += 1;
    } else if (run.scopeType === 'task') {
      const fid = taskFeatureLookup(run.scopeId);
      if (fid !== undefined && affectedFeatures.has(fid)) count += 1;
    }
  }
  return count;
}

function buildPickerOptions(
  sessions: readonly AgentRun[],
): readonly ProjectPlannerPickerOption[] {
  const projectSessions = sessions.filter(
    (run): run is AgentRun & { scopeType: 'project' } =>
      run.scopeType === 'project',
  );
  const resumeOptions: ProjectPlannerPickerOption[] = projectSessions.map(
    (run) => ({
      kind: 'resume',
      sessionId: run.id,
      label: `resume ${run.id}`,
      description: `${run.runStatus} · phase ${run.phase}`,
    }),
  );
  return [
    ...resumeOptions,
    {
      kind: 'start-new',
      label: 'start new session',
      description: 'Start a new project-planner session',
    },
  ];
}
