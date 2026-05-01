import type { Feature, Milestone, Task } from '@core/types/index';

import type { GraphProposalToolHost } from './proposal-host.js';
import type {
  AddFeatureOptions,
  AddMilestoneOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditMilestoneOptions,
  EditTaskOptions,
  MergeFeaturesOptions,
  MoveFeatureOptions,
  PlannerToolDefinition,
  PlannerToolResult,
  PlannerToolset,
  ProposalToolName,
  RemoveFeatureOptions,
  RemoveMilestoneOptions,
  RemoveTaskOptions,
  ReorderTasksOptions,
  SetFeatureDoDOptions,
  SetFeatureObjectiveOptions,
  SplitFeatureOptions,
  SubmitProposalOptions,
} from './types.js';

export function createPlannerToolset(
  host: GraphProposalToolHost,
): PlannerToolset {
  return {
    tools: [
      {
        name: 'addMilestone',
        description: 'Add a new milestone to the proposal graph.',
        execute: (args: AddMilestoneOptions) =>
          Promise.resolve(host.addMilestone(args)),
      },
      {
        name: 'editMilestone',
        description:
          'Edit an existing milestone in the proposal graph without changing authoritative state.',
        execute: (args: EditMilestoneOptions) =>
          Promise.resolve(host.editMilestone(args)),
      },
      {
        name: 'removeMilestone',
        description: 'Remove an empty milestone from the proposal graph.',
        execute: (args: RemoveMilestoneOptions) => {
          host.removeMilestone(args);
          return Promise.resolve(undefined);
        },
      },
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
        name: 'moveFeature',
        description:
          'Move an existing feature to a different milestone in the proposal graph.',
        execute: (args: MoveFeatureOptions) =>
          Promise.resolve(host.moveFeature(args)),
      },
      {
        name: 'splitFeature',
        description:
          'Split an existing feature into multiple features in the proposal graph.',
        execute: (args: SplitFeatureOptions) =>
          Promise.resolve(host.splitFeature(args)),
      },
      {
        name: 'mergeFeatures',
        description:
          'Merge multiple existing features into one feature in the proposal graph.',
        execute: (args: MergeFeaturesOptions) =>
          Promise.resolve(host.mergeFeatures(args)),
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
        name: 'reorderTasks',
        description:
          'Reorder all tasks within a feature in the proposal graph.',
        execute: (args: ReorderTasksOptions) =>
          Promise.resolve(host.reorderTasks(args)),
      },
      {
        name: 'setFeatureObjective',
        description:
          'Record the planner-approved objective sentence for a feature in the proposal graph.',
        execute: (args: SetFeatureObjectiveOptions) =>
          Promise.resolve(host.setFeatureObjective(args)),
      },
      {
        name: 'setFeatureDoD',
        description:
          'Record the planner-approved definition-of-done checklist for a feature in the proposal graph.',
        execute: (args: SetFeatureDoDOptions) =>
          Promise.resolve(host.setFeatureDoD(args)),
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
    case 'addMilestone': {
      const milestone = result as Milestone;
      return `Added milestone ${milestone.id} (${milestone.name}).`;
    }
    case 'editMilestone': {
      const milestone = result as Milestone;
      return `Updated milestone ${milestone.id}.`;
    }
    case 'addFeature': {
      const feature = result as Feature;
      return `Added feature ${feature.id} (${feature.name}).`;
    }
    case 'editFeature': {
      const feature = result as Feature;
      return `Updated feature ${feature.id}.`;
    }
    case 'moveFeature': {
      const feature = result as Feature;
      return `Moved feature ${feature.id} to milestone ${feature.milestoneId}.`;
    }
    case 'splitFeature': {
      const features = result as Feature[];
      return `Split feature into ${features.length} features.`;
    }
    case 'mergeFeatures': {
      const feature = result as Feature;
      return `Merged features into ${feature.id} (${feature.name}).`;
    }
    case 'addTask': {
      const task = result as Task;
      return `Added task ${task.id} to feature ${task.featureId}.`;
    }
    case 'editTask': {
      const task = result as Task;
      return `Updated task ${task.id}.`;
    }
    case 'reorderTasks': {
      const tasks = result as Task[];
      const featureId = tasks[0]?.featureId;
      return featureId === undefined
        ? 'Reordered tasks.'
        : `Reordered ${tasks.length} tasks in feature ${featureId}.`;
    }
    case 'setFeatureObjective': {
      const feature = result as Feature;
      return `Set feature objective for ${feature.id}.`;
    }
    case 'setFeatureDoD': {
      const feature = result as Feature;
      return `Set feature definition-of-done for ${feature.id}.`;
    }
    case 'submit':
      return 'Proposal submitted.';
    case 'removeMilestone':
      return 'Milestone removed from proposal.';
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
