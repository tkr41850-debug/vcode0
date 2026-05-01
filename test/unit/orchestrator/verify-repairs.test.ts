import { InMemoryFeatureGraph } from '@core/graph/index';
import type { Task } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function createCoordinatorGraph(tasks: Task[] = []) {
  return new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        status: 'in_progress',
        workControl: 'verifying',
        collabControl: 'branch_open',
      }),
    ],
    tasks,
  });
}

function runVerifyFailure(params: {
  issues?: Array<{
    id: string;
    severity: 'blocking' | 'concern' | 'nit';
    description: string;
    location?: string;
    suggestedFix?: string;
  }>;
  summary?: string;
  failedChecks?: string[];
  repairFocus?: string[];
  tasks?: ReturnType<typeof createTaskFixture>[];
}) {
  const graph = createCoordinatorGraph(params.tasks ?? []);
  const coordinator = new FeatureLifecycleCoordinator(graph);

  graph.__enterTick();
  try {
    coordinator.completePhase('f-1', 'verify', {
      ok: false,
      summary: params.summary ?? 'verify failed',
      outcome: 'repair_needed',
      ...(params.failedChecks !== undefined
        ? { failedChecks: params.failedChecks }
        : {}),
      ...(params.repairFocus !== undefined
        ? { repairFocus: params.repairFocus }
        : {}),
      ...(params.issues !== undefined ? { issues: params.issues } : {}),
    });
  } finally {
    graph.__leaveTick();
  }

  return {
    graph,
    repairTasks: [...graph.tasks.values()].filter(
      (task) => task.repairSource === 'verify',
    ),
  };
}

describe('FeatureLifecycleCoordinator.enqueueVerifyRepairs', () => {
  it('creates one ready repair task for a blocking issue', () => {
    const { graph, repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing integration proof',
        },
      ],
    });

    expect(graph.features.get('f-1')).toMatchObject({
      workControl: 'executing_repair',
      status: 'pending',
      collabControl: 'branch_open',
    });
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      status: 'ready',
      repairSource: 'verify',
      description: 'missing integration proof',
    });
  });

  it('creates one ready repair task for a concern issue', () => {
    const { repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'concern',
          description: 'retry policy drift',
        },
      ],
    });

    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]?.description).toBe('retry policy drift');
  });

  it('falls back to one synthesized repair task when only nit issues are present', () => {
    const { graph, repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'nit',
          description: 'typo in comment',
        },
      ],
      failedChecks: ['restore missing proof'],
      summary: 'repair needed despite nits only',
    });

    expect(graph.features.get('f-1')).toMatchObject({
      workControl: 'executing_repair',
      status: 'pending',
    });
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]?.description).toBe(
      'Repair feature verification issues: restore missing proof',
    );
  });

  it('fans out blocking and concern issues while dropping nits', () => {
    const { repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing integration proof',
        },
        {
          id: 'vi-2',
          severity: 'concern',
          description: 'retry output drift',
        },
        {
          id: 'vi-3',
          severity: 'nit',
          description: 'typo in comment',
        },
      ],
    });

    expect(repairTasks).toHaveLength(2);
    expect(repairTasks.map((task) => task.description)).toEqual([
      'missing integration proof',
      'retry output drift',
    ]);
  });

  it('maps file-like locations into reservedWritePaths', () => {
    const { repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing error handling',
          location: 'src/auth.ts',
        },
      ],
    });

    expect(repairTasks[0]?.reservedWritePaths).toEqual(['src/auth.ts']);
    expect(repairTasks[0]?.description).toBe(
      'missing error handling @ src/auth.ts',
    );
  });

  it('leaves reservedWritePaths unset for non-path locations', () => {
    const { repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing error handling',
          location: 'missing error handling',
        },
      ],
    });

    expect(repairTasks[0]?.reservedWritePaths).toBeUndefined();
    expect(repairTasks[0]?.description).toBe(
      'missing error handling @ missing error handling',
    );
  });

  it('escalates to replanning when the repair cap is already consumed', () => {
    const { graph, repairTasks } = runVerifyFailure({
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'done',
          collabControl: 'merged',
          repairSource: 'verify',
          description: 'previous verify repair',
        }),
      ],
      issues: [
        {
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing integration proof',
        },
      ],
      summary: 'failed again',
    });

    expect(graph.features.get('f-1')).toMatchObject({
      workControl: 'replanning',
      status: 'pending',
      collabControl: 'branch_open',
    });
    expect(repairTasks).toHaveLength(1);
  });

  it('creates multiple verify repair tasks while consuming one repair cycle', () => {
    const { graph, repairTasks } = runVerifyFailure({
      issues: [
        {
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing integration proof',
        },
        {
          id: 'vi-2',
          severity: 'blocking',
          description: 'missing retry coverage',
        },
        {
          id: 'vi-3',
          severity: 'blocking',
          description: 'missing ci evidence',
        },
      ],
    });

    expect(graph.features.get('f-1')).toMatchObject({
      workControl: 'executing_repair',
      status: 'pending',
    });
    expect(repairTasks).toHaveLength(3);
    expect(repairTasks.every((task) => task.status === 'ready')).toBe(true);
  });
});
