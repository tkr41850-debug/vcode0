import type { PlannerToolset } from '@agents/tools';
import { describe, expect, it } from 'vitest';

import { createGraphToolset } from '../../../src/agents/tools/graph-toolset.js';
import {
  createGraphWithFeature,
  createGraphWithMilestone,
} from '../../helpers/graph-builders.js';

describe('GraphToolset (PlannerToolset)', () => {
  it('exposes the five planner tools', () => {
    const graph = createGraphWithMilestone();
    const toolset: PlannerToolset = createGraphToolset(graph);

    const names = toolset.tools.map((t) => t.name);
    expect(names).toContain('createMilestone');
    expect(names).toContain('createFeature');
    expect(names).toContain('createTask');
    expect(names).toContain('addDependency');
    expect(names).toContain('submit');
  });

  it('createMilestone delegates to the graph and returns a Milestone', async () => {
    const graph = createGraphWithMilestone();
    const toolset = createGraphToolset(graph);
    const tool = toolset.tools.find((t) => t.name === 'createMilestone')!;

    const result = await tool.execute({
      id: 'm-2',
      name: 'Second',
      description: 'Second milestone',
    });

    expect(result).toBeDefined();
    expect((result as { id: string }).id).toBe('m-2');
    expect(graph.milestones.has('m-2')).toBe(true);
  });

  it('createFeature delegates to the graph and returns a Feature', async () => {
    const graph = createGraphWithMilestone();
    const toolset = createGraphToolset(graph);
    const tool = toolset.tools.find((t) => t.name === 'createFeature')!;

    const result = await tool.execute({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Auth',
      description: 'Add auth',
    });

    expect(result).toBeDefined();
    expect((result as { id: string }).id).toBe('f-1');
    expect(graph.features.has('f-1')).toBe(true);
  });

  it('createTask delegates to the graph and returns a Task', async () => {
    const graph = createGraphWithFeature();
    const toolset = createGraphToolset(graph);
    const tool = toolset.tools.find((t) => t.name === 'createTask')!;

    const result = await tool.execute({
      id: 't-1',
      featureId: 'f-1',
      description: 'Implement login',
    });

    expect(result).toBeDefined();
    expect((result as { id: string }).id).toBe('t-1');
    expect(graph.tasks.has('t-1')).toBe(true);
  });

  it('addDependency delegates to the graph', async () => {
    const graph = createGraphWithFeature();
    graph.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'T1',
    });
    graph.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
    });
    const toolset = createGraphToolset(graph);
    const tool = toolset.tools.find((t) => t.name === 'addDependency')!;

    await tool.execute({ from: 't-2', to: 't-1' });

    const t2 = graph.tasks.get('t-2');
    expect(t2!.dependsOn).toContain('t-1');
  });

  it('submit returns undefined (no-op confirmation)', async () => {
    const graph = createGraphWithMilestone();
    const toolset = createGraphToolset(graph);
    const tool = toolset.tools.find((t) => t.name === 'submit')!;

    const result = await tool.execute({});
    expect(result).toBeUndefined();
  });
});
