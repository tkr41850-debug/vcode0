import type { AgentRun } from '@core/types/index';
import type { ProjectSessionFilter } from '@orchestrator/ports/index';
import type { ParsedSlashCommand } from '@tui/commands/index';

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

/**
 * Drives the project-planner mode lifecycle for the TUI. Owns the picker
 * state (entry → list sessions → choose start-new / resume) and the
 * attached-session pointer that the view-model reads to render the
 * composer scope label and the chat surface.
 */
export class ProjectPlannerController {
  private state: ProjectPlannerState = {};

  constructor(private readonly env: ProjectPlannerEnvironment) {}

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
