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

  it('executes proposal tools through host and formats tool text', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const toolset = createPlannerToolset(host);

    const milestone = await requireTool(toolset, 'addMilestone').execute({
      name: 'Milestone 2',
      description: 'second milestone',
    });
    expect(milestone).toMatchObject({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    expect(formatToolText('addMilestone', milestone)).toBe(
      'Added milestone m-2 (Milestone 2).',
    );

    const feature = await requireTool(toolset, 'addFeature').execute({
      milestoneId: 'm-2',
      name: 'New feature',
      description: 'Added from planner toolset',
    });
    expect(feature).toMatchObject({
      id: 'f-2',
      milestoneId: 'm-2',
      name: 'New feature',
    });
    expect(formatToolText('addFeature', feature)).toBe(
      'Added feature f-2 (New feature).',
    );

    const task = await requireTool(toolset, 'addTask').execute({
      featureId: 'f-1',
      description: 'Draft task',
    });
    expect(task).toMatchObject({
      id: 't-1',
      featureId: 'f-1',
      description: 'Draft task',
    });
    expect(formatToolText('addTask', task)).toBe(
      'Added task t-1 to feature f-1.',
    );

    await requireTool(toolset, 'submit').execute(proposalDetails);

    expect(host.wasSubmitted()).toBe(true);
    expect(formatToolText('submit', undefined)).toBe('Proposal submitted.');
    expect(formatToolText('removeFeature', undefined)).toBe(
      'Feature removed from proposal.',
    );
    expect(formatToolText('removeTask', undefined)).toBe(
      'Task removed from proposal.',
    );
    expect(formatToolText('addDependency', undefined)).toBe(
      'Dependency added to proposal.',
    );
    expect(formatToolText('removeDependency', undefined)).toBe(
      'Dependency removed from proposal.',
    );
  });
});
