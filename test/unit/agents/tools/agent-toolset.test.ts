import {
  buildProposalAgentToolset,
  createFeaturePhaseToolHost,
  createProposalToolHost,
} from '@agents/tools';
import { proposalToolParameters } from '@agents/tools/schemas';
import { describe, expect, it } from 'vitest';

import { createGraphWithFeature } from '../../../helpers/graph-builders.js';
import { InMemoryStore } from '../../../integration/harness/store-memory.js';

describe('buildProposalAgentToolset', () => {
  it('adapts proposal tools with schemas, text content, and result details', async () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    const tools = buildProposalAgentToolset(host);

    const addMilestoneTool = tools.find((tool) => tool.name === 'addMilestone');
    if (!addMilestoneTool) throw new Error('addMilestone tool missing');
    expect(addMilestoneTool.parameters).toBe(
      proposalToolParameters.addMilestone,
    );

    const milestoneResult = await addMilestoneTool.execute('call-1', {
      name: 'Milestone 2',
      description: 'second milestone',
    });

    expect(milestoneResult).toEqual({
      content: [{ type: 'text', text: 'Added milestone m-2 (Milestone 2).' }],
      details: expect.objectContaining({
        id: 'm-2',
        name: 'Milestone 2',
        description: 'second milestone',
      }),
    });

    const addTaskTool = tools.find((tool) => tool.name === 'addTask');
    if (!addTaskTool) throw new Error('addTask tool missing');
    expect(addTaskTool.parameters).toBe(proposalToolParameters.addTask);

    const result = await addTaskTool.execute('call-2', {
      featureId: 'f-1',
      description: 'Draft task',
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Added task t-1 to feature f-1.' }],
      details: expect.objectContaining({
        id: 't-1',
        featureId: 'f-1',
        description: 'Draft task',
      }),
    });
  });

  it('prepends feature inspection tools when inspection host exists', async () => {
    const graph = createGraphWithFeature();
    const proposalHost = createProposalToolHost(graph, 'plan');
    const inspectionHost = createFeaturePhaseToolHost(
      'f-1',
      graph,
      new InMemoryStore(),
    );
    const tools = buildProposalAgentToolset(proposalHost, inspectionHost);

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'getFeatureState',
        'listFeatureTasks',
        'getChangedFiles',
        'addTask',
        'submit',
      ]),
    );

    const getFeatureStateTool = tools.find(
      (tool) => tool.name === 'getFeatureState',
    );
    if (!getFeatureStateTool) throw new Error('getFeatureState tool missing');

    const result = await getFeatureStateTool.execute('call-1', {});

    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Loaded feature f-1 in discussing / none.' },
      ],
      details: expect.objectContaining({
        id: 'f-1',
        workControl: 'discussing',
        collabControl: 'none',
      }),
    });
  });
});
