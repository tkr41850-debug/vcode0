import type { Feature, Milestone, Task } from '@core/types/index';

import type { GraphProposalToolHost } from './proposal-host.js';
import type {
  AddFeatureOptions,
  AddMilestoneOptions,
  AddTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  EditFeatureSpecOptions,
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

function isFeatureEndpoint(id: string): boolean {
  return id.startsWith('f-');
}

function isTaskEndpoint(id: string): boolean {
  return id.startsWith('t-');
}

function rejectFeatureToFeature(args: DependencyOptions, op: string): void {
  if (isFeatureEndpoint(args.from) || isFeatureEndpoint(args.to)) {
    throw new Error(
      `${op} at feature-plan scope rejects feature-to-feature dependencies (from=${args.from}, to=${args.to}). Cross-feature ordering is project-planner scope.`,
    );
  }
}

function rejectTaskToTask(args: DependencyOptions, op: string): void {
  if (isTaskEndpoint(args.from) || isTaskEndpoint(args.to)) {
    throw new Error(
      `${op} at project-planner scope rejects task-to-task dependencies (from=${args.from}, to=${args.to}). Intra-feature ordering is feature-plan scope.`,
    );
  }
}

function addTaskTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'addTask'> {
  return {
    name: 'addTask',
    description:
      'Add a task to an existing feature. A task is a unit of work that runs in a worktree and squash-merges back into its feature branch. Do not use addTask to introduce a new work stream — use addFeature for that. Tasks must belong to a single feature; cross-feature dependencies are expressed at the feature level.',
    execute: (args: AddTaskOptions) => Promise.resolve(host.addTask(args)),
  };
}

function removeTaskTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'removeTask'> {
  return {
    name: 'removeTask',
    description: 'Remove a task from the proposal graph.',
    execute: (args: RemoveTaskOptions) => {
      host.removeTask(args);
      return Promise.resolve(undefined);
    },
  };
}

function editTaskTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'editTask'> {
  return {
    name: 'editTask',
    description: 'Edit an existing task in the proposal graph.',
    execute: (args: EditTaskOptions) => Promise.resolve(host.editTask(args)),
  };
}

function setFeatureObjectiveTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'setFeatureObjective'> {
  return {
    name: 'setFeatureObjective',
    description:
      'Record the planner-approved objective sentence for a feature in the proposal graph.',
    execute: (args: SetFeatureObjectiveOptions) =>
      Promise.resolve(host.setFeatureObjective(args)),
  };
}

function setFeatureDoDTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'setFeatureDoD'> {
  return {
    name: 'setFeatureDoD',
    description:
      'Record the planner-approved definition-of-done checklist for a feature in the proposal graph.',
    execute: (args: SetFeatureDoDOptions) =>
      Promise.resolve(host.setFeatureDoD(args)),
  };
}

function editFeatureSpecTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'editFeatureSpec'> {
  return {
    name: 'editFeatureSpec',
    description:
      'Edit a feature spec (description, featureObjective, featureDoD) without renaming it or changing milestone assignment. Use this when the feature spec needs sharpening but the feature identity stays the same.',
    execute: async (args: EditFeatureSpecOptions) => host.editFeatureSpec(args),
  };
}

function submitTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'submit'> {
  return {
    name: 'submit',
    description:
      'Submit the proposal graph for approval. May be called more than once: each submit() records a checkpoint of all proposal mutations made so far, replacing any prior pending submission. Subsequent mutations after a submit() accumulate into the next submission. Call submit() once initial proposal is ready; call again after any revisions made in response to chat or request_help feedback.',
    execute: (args: SubmitProposalOptions) => {
      host.submit(args);
      return Promise.resolve(undefined);
    },
  };
}

function intraFeatureAddDependencyTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'addDependency'> {
  return {
    name: 'addDependency',
    description:
      'Add a task-to-task dependency edge inside the current feature. Direction: addDependency({ from, to }) declares "from" depends on "to" — "to" runs first. Both endpoints must be tasks in the same feature; feature-to-feature edges are rejected at this scope.',
    execute: async (args: DependencyOptions) => {
      rejectFeatureToFeature(args, 'addDependency');
      host.addDependency(args);
      return undefined;
    },
  };
}

function intraFeatureRemoveDependencyTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'removeDependency'> {
  return {
    name: 'removeDependency',
    description:
      'Remove a task-to-task dependency edge inside the current feature. Feature-to-feature edges are rejected at this scope.',
    execute: async (args: DependencyOptions) => {
      rejectFeatureToFeature(args, 'removeDependency');
      host.removeDependency(args);
      return undefined;
    },
  };
}

function crossFeatureAddDependencyTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'addDependency'> {
  return {
    name: 'addDependency',
    description:
      'Add a feature-to-feature dependency edge. Direction: addDependency({ from, to }) declares "from" depends on "to" — "to" runs first. Both endpoints must be features; task-to-task edges are rejected at project-planner scope (intra-feature ordering belongs to feature-plan agents).',
    execute: async (args: DependencyOptions) => {
      rejectTaskToTask(args, 'addDependency');
      host.addDependency(args);
      return undefined;
    },
  };
}

function crossFeatureRemoveDependencyTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'removeDependency'> {
  return {
    name: 'removeDependency',
    description:
      'Remove a feature-to-feature dependency edge. Task-to-task edges are rejected at project-planner scope.',
    execute: async (args: DependencyOptions) => {
      rejectTaskToTask(args, 'removeDependency');
      host.removeDependency(args);
      return undefined;
    },
  };
}

function addMilestoneTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'addMilestone'> {
  return {
    name: 'addMilestone',
    description: 'Add a new milestone to the proposal graph.',
    execute: (args: AddMilestoneOptions) =>
      Promise.resolve(host.addMilestone(args)),
  };
}

function addFeatureTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'addFeature'> {
  return {
    name: 'addFeature',
    description:
      'Add a new feature under an existing milestone. A feature is an independent work stream with its own integration branch and lifecycle (discuss → research → plan → execute → verify → summarize). Use this to introduce a new work stream; use addTask to add a unit of work inside an existing feature.',
    execute: (args: AddFeatureOptions) =>
      Promise.resolve(host.addFeature(args)),
  };
}

function removeFeatureTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'removeFeature'> {
  return {
    name: 'removeFeature',
    description: 'Remove a feature from the proposal graph.',
    execute: (args: RemoveFeatureOptions) => {
      host.removeFeature(args);
      return Promise.resolve(undefined);
    },
  };
}

function editFeatureTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'editFeature'> {
  return {
    name: 'editFeature',
    description:
      'Edit a feature in the proposal graph including rename. Project-planner scope only; feature-plan agents must use editFeatureSpec for spec-only changes.',
    execute: (args: EditFeatureOptions) =>
      Promise.resolve(host.editFeature(args)),
  };
}

function unscopedAddDependencyTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'addDependency'> {
  return {
    name: 'addDependency',
    description:
      'Add a feature-to-feature or task-to-task dependency edge. The graph enforces same-feature constraints for task-to-task edges. Used by the TUI human-driven editor; agents use the scoped subsets.',
    execute: (args: DependencyOptions) => {
      host.addDependency(args);
      return Promise.resolve(undefined);
    },
  };
}

function unscopedRemoveDependencyTool(
  host: GraphProposalToolHost,
): PlannerToolDefinition<'removeDependency'> {
  return {
    name: 'removeDependency',
    description:
      'Remove a feature-to-feature or task-to-task dependency edge. Used by the TUI human-driven editor; agents use the scoped subsets.',
    execute: (args: DependencyOptions) => {
      host.removeDependency(args);
      return Promise.resolve(undefined);
    },
  };
}

export function createTuiPlannerToolset(
  host: GraphProposalToolHost,
): PlannerToolset {
  return {
    tools: [
      addMilestoneTool(host),
      addFeatureTool(host),
      removeFeatureTool(host),
      editFeatureTool(host),
      editFeatureSpecTool(host),
      addTaskTool(host),
      editTaskTool(host),
      removeTaskTool(host),
      setFeatureObjectiveTool(host),
      setFeatureDoDTool(host),
      unscopedAddDependencyTool(host),
      unscopedRemoveDependencyTool(host),
      submitTool(host),
    ] as readonly PlannerToolDefinition[],
  };
}

export function createFeaturePlanToolset(
  host: GraphProposalToolHost,
): PlannerToolset {
  return {
    tools: [
      addTaskTool(host),
      editTaskTool(host),
      removeTaskTool(host),
      setFeatureObjectiveTool(host),
      setFeatureDoDTool(host),
      editFeatureSpecTool(host),
      intraFeatureAddDependencyTool(host),
      intraFeatureRemoveDependencyTool(host),
      submitTool(host),
    ] as readonly PlannerToolDefinition[],
  };
}

export function createProjectPlannerToolset(
  host: GraphProposalToolHost,
): PlannerToolset {
  return {
    tools: [
      addMilestoneTool(host),
      addFeatureTool(host),
      removeFeatureTool(host),
      editFeatureTool(host),
      editFeatureSpecTool(host),
      crossFeatureAddDependencyTool(host),
      crossFeatureRemoveDependencyTool(host),
      submitTool(host),
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
    case 'editFeatureSpec': {
      const feature = result as Feature;
      return `Updated feature spec for ${feature.id}.`;
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
