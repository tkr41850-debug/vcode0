import type { Feature, Task } from '@core/types/index';

import type {
  AddFeatureOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditTaskOptions,
  PlannerToolDefinition,
  PlannerToolResult,
  PlannerToolset,
  ProposalToolHost,
  ProposalToolName,
  RemoveFeatureOptions,
  RemoveTaskOptions,
  SubmitProposalOptions,
} from './types.js';

export function createPlannerToolset(host: ProposalToolHost): PlannerToolset {
  return {
    tools: [
      {
        name: 'addFeature',
        description:
          'Add a new feature under an existing milestone to the proposal graph.',
        execute: (args: AddFeatureOptions) =>
          Promise.resolve(host.addFeature(args)),
      },
      {
        name: 'removeFeature',
        description: 'Remove a feature from the proposal graph.',
        execute: (args: RemoveFeatureOptions) => {
          host.removeFeature(args);
          return Promise.resolve(undefined);
        },
      },
      {
        name: 'editFeature',
        description:
          'Edit an existing feature in the proposal graph without changing authoritative state.',
        execute: (args: EditFeatureOptions) =>
          Promise.resolve(host.editFeature(args)),
      },
      {
        name: 'addTask',
        description: 'Add a task to an existing feature in the proposal graph.',
        execute: (args: AddTaskOptions) => Promise.resolve(host.addTask(args)),
      },
      {
        name: 'removeTask',
        description: 'Remove a task from the proposal graph.',
        execute: (args: RemoveTaskOptions) => {
          host.removeTask(args);
          return Promise.resolve(undefined);
        },
      },
      {
        name: 'editTask',
        description: 'Edit an existing task in the proposal graph.',
        execute: (args: EditTaskOptions) =>
          Promise.resolve(host.editTask(args)),
      },
      {
        name: 'addDependency',
        description:
          'Add a feature or task dependency in the proposal graph and validate it immediately.',
        execute: (args: DependencyOptions) => {
          host.addDependency(args);
          return Promise.resolve(undefined);
        },
      },
      {
        name: 'removeDependency',
        description:
          'Remove a feature or task dependency from the proposal graph.',
        execute: (args: DependencyOptions) => {
          host.removeDependency(args);
          return Promise.resolve(undefined);
        },
      },
      {
        name: 'submit',
        description: 'Finalize the proposal graph for approval.',
        execute: (args: SubmitProposalOptions) => {
          host.submit(args);
          return Promise.resolve(undefined);
        },
      },
    ] as readonly PlannerToolDefinition[],
  };
}

export function formatToolText(
  toolName: ProposalToolName,
  result: PlannerToolResult,
): string {
  switch (toolName) {
    case 'addFeature': {
      const feature = result as Feature;
      return `Added feature ${feature.id} (${feature.name}).`;
    }
    case 'editFeature': {
      const feature = result as Feature;
      return `Updated feature ${feature.id}.`;
    }
    case 'addTask': {
      const task = result as Task;
      return `Added task ${task.id} to feature ${task.featureId}.`;
    }
    case 'editTask': {
      const task = result as Task;
      return `Updated task ${task.id}.`;
    }
    case 'submit':
      return 'Proposal submitted.';
    case 'removeFeature':
      return 'Feature removed from proposal.';
    case 'removeTask':
      return 'Task removed from proposal.';
    case 'addDependency':
      return 'Dependency added to proposal.';
    case 'removeDependency':
      return 'Dependency removed from proposal.';
  }
}
