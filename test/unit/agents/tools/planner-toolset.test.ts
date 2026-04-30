import {
  createPlannerToolset,
  createProposalToolHost,
  type PlannerToolDefinition,
  type PlannerToolName,
  type PlannerToolset,
} from '@agents/tools';
import { formatToolText } from '@agents/tools/planner-toolset';
import type { ProposalPhaseDetails } from '@core/types/index';
import { describe, expect, it } from 'vitest';

import { createGraphWithFeature } from '../../../helpers/graph-builders.js';

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

describe('createPlannerToolset', () => {
  it('returns full proposal tool catalog', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createPlannerToolset(host);

    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      'addMilestone',
      'addFeature',
      'removeFeature',
      'editFeature',
      'addTask',
      'removeTask',
      'editTask',
      'setFeatureObjective',
      'setFeatureDoD',
      'addDependency',
      'removeDependency',
      'submit',
    ]);
  });

  it('executes proposal tools through host', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createPlannerToolset(host);

    const milestone = await requireTool(toolset, 'addMilestone').execute({
      name: 'Milestone 2',
      description: 'second milestone',
    });
    expect(milestone).toMatchObject({
      name: 'Milestone 2',
      description: 'second milestone',
    });

    const feature = await requireTool(toolset, 'addFeature').execute({
      milestoneId: milestone.id,
      name: 'New feature',
      description: 'Added from planner toolset',
    });
    expect(feature).toMatchObject({
      milestoneId: milestone.id,
      name: 'New feature',
    });

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

  it('allows submit tool to be invoked multiple times (checkpoint-style)', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createPlannerToolset(host);

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

  it('formats tool text for representative operations', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createPlannerToolset(host);

    const milestone = await requireTool(toolset, 'addMilestone').execute({
      name: 'Milestone 2',
      description: 'second milestone',
    });

    expect(formatToolText('addMilestone', milestone)).toContain(milestone.id);
    expect(formatToolText('submit', undefined)).toContain('submitted');
    expect(formatToolText('removeFeature', undefined)).toContain('removed');
  });
});
