import type { FeatureGraph } from '@core/graph/index';

import type {
  AgentToolName,
  PlannerToolArgs,
  PlannerToolDefinition,
  PlannerToolResult,
  PlannerToolset,
} from './index.js';

function tool<N extends AgentToolName>(
  name: N,
  description: string,
  execute: (args: PlannerToolArgs<N>) => Promise<PlannerToolResult<N>>,
): PlannerToolDefinition<N> {
  return { name, description, execute };
}

export function createGraphToolset(graph: FeatureGraph): PlannerToolset {
  const tools: PlannerToolDefinition[] = [
    tool('createMilestone', 'Create a new milestone', async (args) => {
      return graph.createMilestone(args);
    }),
    tool(
      'createFeature',
      'Create a new feature within a milestone',
      async (args) => {
        return graph.createFeature(args);
      },
    ),
    tool('createTask', 'Create a new task within a feature', async (args) => {
      return graph.createTask(args);
    }),
    tool(
      'addDependency',
      'Add a dependency between tasks or features',
      async (args) => {
        graph.addDependency(args);
        return undefined;
      },
    ),
    tool('submit', 'Submit the plan for execution', async () => {
      return undefined;
    }),
  ];

  return { tools };
}
