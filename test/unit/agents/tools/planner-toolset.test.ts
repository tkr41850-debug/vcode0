import {
  buildProposalAgentToolset,
  createFeaturePlanToolset,
  createProjectPlannerToolset,
  createProposalToolHost,
  type PlannerToolDefinition,
  type PlannerToolName,
  type PlannerToolset,
} from '@agents/tools';
import { formatToolText } from '@agents/tools/planner-toolset';
import type { ProposalPhaseDetails } from '@core/types/index';
import { describe, expect, it } from 'vitest';

import {
  createGraphWithFeature,
  createGraphWithTask,
} from '../../../helpers/graph-builders.js';

const proposalDetails: ProposalPhaseDetails = {
  summary: 'Plan ready.',
  chosenApproach: 'Reuse existing prompt registry and proposal host.',
  keyConstraints: ['Keep approval payload as raw proposal JSON'],
  decompositionRationale: [
    'Split prompt/runtime contract fixes from execution',
  ],
  orderingRationale: [
    'Make prompt contract truthful before downstream verify uses it',
  ],
  verificationExpectations: ['Run prompt tests and runtime tests'],
  risksTradeoffs: ['More structured payload means broader test updates'],
  assumptions: ['Proposal apply path still reads payloadJson'],
};

function requireTool<Name extends PlannerToolName>(
  toolset: PlannerToolset,
  name: Name,
): PlannerToolDefinition<Name> {
  const tool = toolset.tools.find((entry) => entry.name === name);
  if (tool === undefined) {
    throw new Error(`planner tool "${name}" missing`);
  }
  return tool as PlannerToolDefinition<Name>;
}

describe('createFeaturePlanToolset', () => {
  it('returns the feature-plan tool catalog (no project-scope topology tools)', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      'addTask',
      'editTask',
      'removeTask',
      'setFeatureObjective',
      'setFeatureDoD',
      'editFeatureSpec',
      'addDependency',
      'removeDependency',
      'submit',
    ]);
  });

  it('executes feature-plan tools through host', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    const task = await requireTool(toolset, 'addTask').execute({
      featureId: 'f-1',
      description: 'Draft task',
    });
    expect(task).toMatchObject({
      featureId: 'f-1',
      description: 'Draft task',
    });

    await requireTool(toolset, 'submit').execute(proposalDetails);
    expect(host.wasSubmitted()).toBe(true);
  });

  it('rejects feature→feature addDependency at the feature-plan scope', async () => {
    const graph = createGraphWithFeature();
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
    });
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    await expect(
      requireTool(toolset, 'addDependency').execute({
        from: 'f-2',
        to: 'f-1',
      }),
    ).rejects.toThrow(/feature-to-feature/i);
  });

  it('rejects feature→feature removeDependency at the feature-plan scope', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    await expect(
      requireTool(toolset, 'removeDependency').execute({
        from: 'f-2',
        to: 'f-1',
      }),
    ).rejects.toThrow(/feature-to-feature/i);
  });
});

describe('createProjectPlannerToolset', () => {
  it('returns the project-planner tool catalog (no task-mutation tools)', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createProjectPlannerToolset(host);

    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      'addMilestone',
      'addFeature',
      'removeFeature',
      'editFeature',
      'editFeatureSpec',
      'addDependency',
      'removeDependency',
      'submit',
    ]);
  });

  it('rejects task→task addDependency at the project-planner scope', async () => {
    const graph = createGraphWithTask();
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createProjectPlannerToolset(host);

    await expect(
      requireTool(toolset, 'addDependency').execute({
        from: 't-2',
        to: 't-1',
      }),
    ).rejects.toThrow(/task-to-task/i);
  });

  it('rejects task→task removeDependency at the project-planner scope', async () => {
    const graph = createGraphWithTask();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createProjectPlannerToolset(host);

    await expect(
      requireTool(toolset, 'removeDependency').execute({
        from: 't-2',
        to: 't-1',
      }),
    ).rejects.toThrow(/task-to-task/i);
  });
});

describe('editFeatureSpec', () => {
  it('accepts spec-only patches (description, featureObjective, featureDoD)', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    const result = await requireTool(toolset, 'editFeatureSpec').execute({
      featureId: 'f-1',
      patch: {
        description: 'updated desc',
        featureObjective: 'objective',
        featureDoD: ['dod'],
      },
    });
    expect(result).toMatchObject({
      id: 'f-1',
      description: 'updated desc',
      featureObjective: 'objective',
      featureDoD: ['dod'],
    });
  });

  it('rejects rename via name field', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    await expect(
      requireTool(toolset, 'editFeatureSpec').execute({
        featureId: 'f-1',
        patch: { name: 'renamed' } as never,
      }),
    ).rejects.toThrow(/name/);
  });

  it('rejects milestone reassignment via milestoneId field', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    await expect(
      requireTool(toolset, 'editFeatureSpec').execute({
        featureId: 'f-1',
        patch: { milestoneId: 'm-2' } as never,
      }),
    ).rejects.toThrow(/milestoneId/);
  });
});

describe('createFeaturePlanToolset (legacy submit checkpointing)', () => {
  it('allows submit tool to be invoked multiple times (checkpoint-style)', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createFeaturePlanToolset(host);

    await requireTool(toolset, 'addTask').execute({
      featureId: 'f-1',
      description: 'first',
    });
    await requireTool(toolset, 'submit').execute(proposalDetails);

    await requireTool(toolset, 'addTask').execute({
      featureId: 'f-1',
      description: 'second',
    });
    await expect(
      requireTool(toolset, 'submit').execute({
        ...proposalDetails,
        summary: 'second pass',
      }),
    ).resolves.toBeUndefined();

    expect(host.getProposalDetails().summary).toBe('second pass');
    expect(host.buildProposal().ops).toHaveLength(2);
  });
});

describe('buildProposalAgentToolset', () => {
  it('omits request_help when no callback provided', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const tools = buildProposalAgentToolset(host);
    expect(tools.map((tool) => tool.name)).not.toContain('request_help');
  });

  it('exposes request_help when callback provided; tool routes through callback', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const calls: Array<{ toolCallId: string; query: string }> = [];
    const tools = buildProposalAgentToolset(host, undefined, (id, q) => {
      calls.push({ toolCallId: id, query: q });
      return Promise.resolve({ kind: 'answer', text: `re: ${q}` });
    });
    const helpTool = tools.find((tool) => tool.name === 'request_help');
    expect(helpTool).toBeDefined();
    expect(helpTool?.label).toBe('Request Help');

    const result = await helpTool?.execute('call-1', { query: 'which dep?' });
    expect(calls).toEqual([{ toolCallId: 'call-1', query: 'which dep?' }]);
    expect(result?.content[0]).toMatchObject({
      type: 'text',
      text: 're: which dep?',
    });
  });

  it('routes to feature-plan catalog by default (no kind arg)', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const tools = buildProposalAgentToolset(host);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('addTask')).toBe(true);
    expect(names.has('addMilestone')).toBe(false);
    expect(names.has('addFeature')).toBe(false);
    expect(names.has('removeFeature')).toBe(false);
  });

  it('routes to project-planner catalog when kind is "project"', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const tools = buildProposalAgentToolset(host, undefined, undefined, {
      kind: 'project',
    });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('addMilestone')).toBe(true);
    expect(names.has('addFeature')).toBe(true);
    expect(names.has('editFeature')).toBe(true);
    expect(names.has('addTask')).toBe(false);
    expect(names.has('editTask')).toBe(false);
    expect(names.has('removeTask')).toBe(false);
  });

  it('request_help wiring matches across both scopes', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const cb = () => Promise.resolve({ kind: 'answer' as const, text: 'ok' });
    const featureTools = buildProposalAgentToolset(host, undefined, cb, {
      kind: 'feature',
    });
    const projectTools = buildProposalAgentToolset(host, undefined, cb, {
      kind: 'project',
    });
    expect(featureTools.find((t) => t.name === 'request_help')).toBeDefined();
    expect(projectTools.find((t) => t.name === 'request_help')).toBeDefined();
  });
});

describe('formatToolText', () => {
  it('formats text for representative operations', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createProjectPlannerToolset(host);

    const milestone = await requireTool(toolset, 'addMilestone').execute({
      name: 'Milestone 2',
      description: 'second milestone',
    });

    expect(formatToolText('addMilestone', milestone)).toContain(milestone.id);
    expect(formatToolText('submit', undefined)).toContain('submitted');
    expect(formatToolText('removeFeature', undefined)).toContain('removed');
  });
});
