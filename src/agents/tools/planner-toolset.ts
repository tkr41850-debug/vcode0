import type { Feature, Milestone, Task } from '@core/types/index';

import type { GraphProposalToolHost } from './proposal-host.js';
import type {
  AddFeatureOptions,
  AddMilestoneOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditTaskOptions,
  PlannerToolDefinition,
  PlannerToolResult,
  PlannerToolset,
  ProposalToolName,
  RemoveFeatureOptions,
  RemoveTaskOptions,
  SetFeatureDoDOptions,
  SetFeatureObjectiveOptions,
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
        name: 'addFeature',
        description:
          'Add a new feature under an existing milestone. A feature is an independent work stream with its own integration branch and lifecycle (discuss → research → plan → execute → verify → summarize). Use this to introduce a new work stream; use addTask to add a unit of work inside an existing feature.',
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
        description:
          'Add a task to an existing feature. A task is a unit of work that runs in a worktree and squash-merges back into its feature branch. Do not use addTask to introduce a new work stream — use addFeature for that. Tasks must belong to a single feature; cross-feature dependencies are expressed at the feature level.',
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
          'Add a feature-to-feature or task-to-task dependency edge. Direction: addDependency({ from, to }) declares that "from" depends on "to" — "to" is the prerequisite that must complete first, "from" is the dependent that runs after. Reads as "from depends on to". Validated immediately for cycles. Task-to-task dependencies cannot cross feature boundaries; use feature-level dependencies for cross-feature ordering.',
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
        description:
          'Finalize the proposal graph for approval. Call exactly once after all proposal mutations (addFeature/addTask/addDependency/...) are complete; this is not a progress checkpoint and cannot be called more than once. After submit the proposal is sealed and further mutations are rejected.',
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
