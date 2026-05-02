import {
  type AgentRun,
  PROJECT_SCOPE_ID,
  type ProjectAgentRun,
} from '@core/types/index';
import type { ProjectSessionFilter } from '@orchestrator/ports/index';
import { ProjectPlannerController } from '@tui/project-planner-controller';
import { describe, expect, it, vi } from 'vitest';

function makeProjectRun(
  overrides: Partial<ProjectAgentRun> = {},
): ProjectAgentRun {
  return {
    id: 'run-project:s-1',
    scopeType: 'project',
    scopeId: PROJECT_SCOPE_ID,
    phase: 'plan',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

interface MakeEnvOptions {
  sessions?: readonly AgentRun[];
  startId?: string;
}

function makeEnv(options: MakeEnvOptions = {}) {
  const sessions = options.sessions ?? [];
  return {
    listProjectSessions: vi.fn(
      (_filter?: ProjectSessionFilter): readonly AgentRun[] => sessions,
    ),
    startProjectPlannerSession: vi.fn(
      async () => options.startId ?? 'run-project:s-new',
    ),
    resumeProjectPlannerSession: vi.fn(async (_id: string) => {}),
    attachProjectSession: vi.fn((_id: string) => {}),
    detachProjectSession: vi.fn(() => {}),
  };
}

describe('ProjectPlannerController', () => {
  it('builds picker with only start-new when no sessions exist', async () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    await controller.enter();

    const state = controller.getState();
    expect(state.attachedSessionId).toBeUndefined();
    expect(state.picker?.options.map((option) => option.kind)).toEqual([
      'start-new',
    ]);
    expect(env.listProjectSessions).toHaveBeenCalledWith({
      runStatuses: ['running', 'await_response', 'await_approval'],
    });
  });

  it('builds picker with resume + start-new when one running session exists', async () => {
    const sessions = [
      makeProjectRun({ id: 'run-project:s-1', runStatus: 'running' }),
    ];
    const env = makeEnv({ sessions });
    const controller = new ProjectPlannerController(env);

    await controller.enter();

    const options = controller.getState().picker?.options ?? [];
    expect(options).toEqual([
      expect.objectContaining({
        kind: 'resume',
        sessionId: 'run-project:s-1',
      }),
      expect.objectContaining({ kind: 'start-new' }),
    ]);
  });

  it('attaches when start-new option is selected', async () => {
    const env = makeEnv({ startId: 'run-project:s-new' });
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({ kind: 'start-new' });

    expect(env.startProjectPlannerSession).toHaveBeenCalledOnce();
    expect(controller.getState().attachedSessionId).toBe('run-project:s-new');
    expect(controller.getState().picker).toBeUndefined();
  });

  it('attaches when a resume option is selected', async () => {
    const sessions = [
      makeProjectRun({ id: 'run-project:s-1', runStatus: 'running' }),
    ];
    const env = makeEnv({ sessions });
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({
      kind: 'resume',
      sessionId: 'run-project:s-1',
    });

    expect(env.resumeProjectPlannerSession).toHaveBeenCalledWith(
      'run-project:s-1',
    );
    expect(controller.getState().attachedSessionId).toBe('run-project:s-1');
    expect(controller.getState().picker).toBeUndefined();
  });

  it('detaches via /project detach action', async () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({ kind: 'start-new' });
    expect(controller.getState().attachedSessionId).toBe('run-project:s-new');

    controller.detach();

    expect(controller.getState().attachedSessionId).toBeUndefined();
    expect(controller.getState().picker).toBeUndefined();
  });

  it('detach is a no-op when not attached', () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    expect(() => {
      controller.detach();
    }).not.toThrow();
    expect(controller.getState().attachedSessionId).toBeUndefined();
  });

  it('handles /project slash via execute', async () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    const result = await controller.execute({ name: 'project', args: {} });

    expect(controller.getState().picker).toBeDefined();
    expect(typeof result.message).toBe('string');
  });

  it('calls env.attachProjectSession on start-new selection', async () => {
    const env = makeEnv({ startId: 'run-project:s-new' });
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({ kind: 'start-new' });

    expect(env.attachProjectSession).toHaveBeenCalledWith('run-project:s-new');
  });

  it('calls env.attachProjectSession on resume selection', async () => {
    const sessions = [
      makeProjectRun({ id: 'run-project:s-1', runStatus: 'running' }),
    ];
    const env = makeEnv({ sessions });
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({
      kind: 'resume',
      sessionId: 'run-project:s-1',
    });

    expect(env.attachProjectSession).toHaveBeenCalledWith('run-project:s-1');
  });

  it('calls env.detachProjectSession on detach', async () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({ kind: 'start-new' });
    controller.detach();

    expect(env.detachProjectSession).toHaveBeenCalledOnce();
  });

  it('treats /project re-issue while attached as detach', async () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({ kind: 'start-new' });
    expect(controller.getState().attachedSessionId).toBe('run-project:s-new');

    const result = await controller.execute({ name: 'project', args: {} });

    expect(controller.getState().attachedSessionId).toBeUndefined();
    expect(env.detachProjectSession).toHaveBeenCalled();
    expect(result.message).toMatch(/[Dd]etached/);
  });

  it('handles /project detach slash via execute', async () => {
    const env = makeEnv();
    const controller = new ProjectPlannerController(env);

    await controller.enter();
    await controller.selectOption({ kind: 'start-new' });

    const result = await controller.execute({
      name: 'project',
      args: {},
      positionals: ['detach'],
    });

    expect(controller.getState().attachedSessionId).toBeUndefined();
    expect(typeof result.message).toBe('string');
  });
});
