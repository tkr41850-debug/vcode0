import { randomUUID } from 'node:crypto';

import type { FeatureGraph } from '@core/graph/index';
import { PROJECT_SCOPE_ID, type ProjectAgentRun } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { dispatchProjectRunUnit } from '@orchestrator/scheduler/dispatch';
import type { SchedulerEvent } from '@orchestrator/scheduler/index';

export type ProjectDispatchFn = (params: {
  run: ProjectAgentRun;
  ports: OrchestratorPorts;
  graph: FeatureGraph;
  handleEvent: (event: SchedulerEvent) => Promise<void>;
}) => Promise<void>;

export interface ProjectPlannerCoordinatorOptions {
  dispatchFn?: ProjectDispatchFn;
  idGen?: () => string;
  maxRetries?: number;
}

export class ProjectPlannerCoordinator {
  private readonly dispatchFn: ProjectDispatchFn;
  private readonly idGen: () => string;
  private readonly maxRetries: number;

  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
    private readonly handleEvent: (event: SchedulerEvent) => Promise<void>,
    options: ProjectPlannerCoordinatorOptions = {},
  ) {
    this.dispatchFn = options.dispatchFn ?? dispatchProjectRunUnit;
    this.idGen = options.idGen ?? randomUUID;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async startProjectPlannerSession(): Promise<string> {
    const id = `run-project:${this.idGen()}`;
    const run: ProjectAgentRun = {
      id,
      scopeType: 'project',
      scopeId: PROJECT_SCOPE_ID,
      phase: 'plan',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: this.maxRetries,
    };
    this.ports.store.createAgentRun(run);
    void this.dispatchFn({
      run,
      ports: this.ports,
      graph: this.graph,
      handleEvent: this.handleEvent,
    });
    return Promise.resolve(id);
  }

  async resumeProjectPlannerSession(id: string): Promise<void> {
    const run = this.ports.store.getProjectSession(id);
    if (run === undefined) {
      throw new Error(`project session "${id}" not found`);
    }
    if (run.scopeType !== 'project') {
      throw new Error(`run "${id}" is not a project session`);
    }
    if (
      run.runStatus === 'await_approval' ||
      run.runStatus === 'await_response'
    ) {
      return;
    }
    if (
      run.runStatus === 'failed' ||
      run.runStatus === 'cancelled' ||
      run.runStatus === 'completed'
    ) {
      throw new Error(
        `project session "${id}" cannot be resumed (status="${run.runStatus}")`,
      );
    }
    void this.dispatchFn({
      run,
      ports: this.ports,
      graph: this.graph,
      handleEvent: this.handleEvent,
    });
    return Promise.resolve();
  }

  async cancelProjectPlannerSession(id: string): Promise<void> {
    const run = this.ports.store.getProjectSession(id);
    if (run === undefined) {
      throw new Error(`project session "${id}" not found`);
    }
    if (run.scopeType !== 'project') {
      throw new Error(`run "${id}" is not a project session`);
    }
    if (
      run.runStatus === 'completed' ||
      run.runStatus === 'cancelled' ||
      run.runStatus === 'failed'
    ) {
      return;
    }
    if (
      run.runStatus === 'running' ||
      run.runStatus === 'await_response' ||
      run.runStatus === 'await_approval'
    ) {
      await this.ports.runtime.abortRun(id);
    }
    this.ports.store.updateAgentRun(id, {
      runStatus: 'cancelled',
      owner: 'system',
      attention: 'none',
    });
  }
}
