import type { GvcConfig } from '@config';
import type { FeatureId, TaskId } from '@core/types/index';
import type {
  ComposerSelection,
  ConfigEditableKey,
  TuiCommandContext,
} from '@tui/commands/index';
import {
  CONFIG_EDITABLE_KEYS,
  parseInitializeProjectCommand,
  parseSlashCommand,
} from '@tui/commands/index';
import type { ComposerProposalController } from '@tui/proposal-controller';
import type { TuiAppDeps } from './app-deps.js';
import { formatUnknownError } from './app-state.js';

export async function handleComposerSubmit(params: {
  text: string;
  executeSlashCommand: (input: string) => Promise<string>;
  requestTopLevelPlan: (
    prompt: string,
    options?: { sessionMode?: 'continue' | 'fresh' },
  ) => string;
  addToHistory: (input: string) => void;
  setNotice: (notice: string | undefined) => void;
  refresh: () => void;
}): Promise<void> {
  const trimmed = params.text.trim();
  if (trimmed.length === 0) {
    params.setNotice(undefined);
    params.refresh();
    return;
  }

  try {
    const message = trimmed.startsWith('/')
      ? await params.executeSlashCommand(trimmed)
      : params.requestTopLevelPlan(trimmed);
    params.addToHistory(trimmed);
    params.setNotice(message);
  } catch (error) {
    params.setNotice(formatUnknownError(error));
  }
  params.refresh();
}

export async function executeSlashCommand(params: {
  input: string;
  commandContext: TuiCommandContext;
  notice: string | undefined;
  dataSource: TuiAppDeps;
  proposalController: ComposerProposalController;
  currentSelection: ComposerSelection;
  setSelectedNodeId: (nodeId: string) => void;
}): Promise<string> {
  const parsed = parseSlashCommand(params.input);

  switch (parsed.name) {
    case 'auto':
      params.commandContext.toggleAutoExecution();
      return params.notice ?? 'toggled auto execution';
    case 'queue':
      params.commandContext.toggleMilestoneQueue();
      return params.notice ?? 'toggled milestone queue';
    case 'monitor':
      params.commandContext.toggleAgentMonitor();
      return params.notice ?? 'toggled monitor';
    case 'worker-next':
      params.commandContext.selectNextWorker();
      return params.notice ?? 'selected next worker';
    case 'help':
      params.commandContext.toggleHelp();
      return params.notice ?? 'toggled help';
    case 'inbox':
      params.commandContext.toggleInbox();
      return params.notice ?? 'toggled inbox';
    case 'merge-train':
      params.commandContext.toggleMergeTrain();
      return params.notice ?? 'toggled merge train';
    case 'transcript':
      params.commandContext.toggleTranscript();
      return params.notice ?? 'toggled transcript';
    case 'config':
      params.commandContext.toggleConfig();
      return params.notice ?? 'toggled config';
    case 'deps':
      params.commandContext.toggleDependencyDetail();
      return params.notice ?? 'toggled dependency detail';
    case 'cancel':
      await params.commandContext.cancelSelectedFeature();
      return params.notice ?? 'cancelled feature';
    case 'task-cancel-preserve': {
      const taskId = parsed.args.task;
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error('--task is required');
      }
      const typedTaskId = taskId as TaskId;
      await params.dataSource.cancelTaskPreserveWorktree(typedTaskId);
      return `Cancelled ${taskId} and preserved its worktree.`;
    }
    case 'task-cancel-clean': {
      const taskId = parsed.args.task;
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error('--task is required');
      }
      const typedTaskId = taskId as TaskId;
      await params.dataSource.cancelTaskCleanWorktree(typedTaskId);
      return `Cancelled ${taskId} and removed its worktree.`;
    }
    case 'feature-abandon': {
      const featureId = parsed.args.feature;
      if (typeof featureId !== 'string' || featureId.length === 0) {
        throw new Error('--feature is required');
      }
      await params.dataSource.abandonFeatureBranch(featureId as FeatureId);
      return `Abandoned ${featureId} and removed its branches/worktrees.`;
    }
    case 'config-set': {
      const key = parsed.args.key;
      const value = parsed.args.value;
      if (!isConfigEditableKey(key)) {
        throw new Error(
          `--key must be one of: ${CONFIG_EDITABLE_KEYS.join(', ')}`,
        );
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('--value is required');
      }
      const currentConfig = params.dataSource.getConfig();
      const nextConfig = applyConfigValue(currentConfig, key, value);
      await params.dataSource.updateConfig(nextConfig);
      return `Updated ${key} to ${formatConfigValueForNotice(nextConfig, key)}.`;
    }
    case 'quit':
      params.commandContext.requestQuit();
      return 'quitting';
    case 'init': {
      const created = params.dataSource.initializeProject(
        parseInitializeProjectCommand(parsed),
      );
      params.setSelectedNodeId(created.featureId);
      return `Initialized ${created.milestoneId} and ${created.featureId}.`;
    }
    case 'reply': {
      const taskId = params.currentSelection.taskId;
      if (taskId === undefined) {
        throw new Error('select task waiting for help first');
      }
      const text = parsed.args.text;
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('--text is required');
      }
      return params.dataSource.respondToTaskHelp(taskId, {
        kind: 'answer',
        text,
      });
    }
    case 'input': {
      const taskId = params.currentSelection.taskId;
      if (taskId === undefined) {
        throw new Error('select task first');
      }
      const text = parsed.args.text;
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('--text is required');
      }
      return params.dataSource.sendTaskManualInput(taskId, text);
    }
    case 'inbox-reply': {
      const inboxItemId = parsed.args.id;
      const text = parsed.args.text;
      if (typeof inboxItemId !== 'string' || inboxItemId.length === 0) {
        throw new Error('--id is required');
      }
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('--text is required');
      }
      return params.dataSource.respondToInboxHelp(inboxItemId, {
        kind: 'answer',
        text,
      });
    }
    case 'inbox-approve': {
      const inboxItemId = parsed.args.id;
      if (typeof inboxItemId !== 'string' || inboxItemId.length === 0) {
        throw new Error('--id is required');
      }
      return params.dataSource.decideInboxApproval(inboxItemId, {
        kind: 'approved',
      });
    }
    case 'inbox-reject': {
      const inboxItemId = parsed.args.id;
      if (typeof inboxItemId !== 'string' || inboxItemId.length === 0) {
        throw new Error('--id is required');
      }
      const comment = parsed.args.comment;
      return params.dataSource.decideInboxApproval(
        inboxItemId,
        typeof comment === 'string'
          ? { kind: 'reject', comment }
          : { kind: 'reject' },
      );
    }
    case 'merge-train-position': {
      const featureId = parsed.args.feature;
      if (typeof featureId !== 'string' || featureId.length === 0) {
        throw new Error('--feature is required');
      }
      const typedFeatureId = featureId as FeatureId;
      const rawPosition = parsed.args.position;
      if (rawPosition === undefined) {
        params.dataSource.setMergeTrainManualPosition(
          typedFeatureId,
          undefined,
        );
        return `Cleared merge-train position for ${featureId}.`;
      }
      if (typeof rawPosition !== 'string' || rawPosition.length === 0) {
        throw new Error('--position must be a positive integer');
      }
      const position = Number.parseInt(rawPosition, 10);
      if (!Number.isInteger(position) || position < 1) {
        throw new Error('--position must be a positive integer');
      }
      params.dataSource.setMergeTrainManualPosition(typedFeatureId, position);
      return `Set merge-train position for ${featureId} to ${position}.`;
    }
    default: {
      if (
        (parsed.name === 'approve' || parsed.name === 'reject') &&
        params.currentSelection.taskId !== undefined
      ) {
        try {
          const result = await params.proposalController.execute(
            params.input,
            params.currentSelection,
          );
          return result.message;
        } catch (error) {
          if (
            !isProposalSelectionMiss(error, params.currentSelection.featureId)
          ) {
            throw error;
          }

          const run = params.dataSource.getTaskRun(
            params.currentSelection.taskId,
          );
          if (run?.runStatus === 'await_approval') {
            if (parsed.name === 'approve') {
              return params.dataSource.decideTaskApproval(
                params.currentSelection.taskId,
                { kind: 'approved' },
              );
            }

            const comment = parsed.args.comment;
            return params.dataSource.decideTaskApproval(
              params.currentSelection.taskId,
              typeof comment === 'string'
                ? { kind: 'reject', comment }
                : { kind: 'reject' },
            );
          }
          if (run !== undefined) {
            throw new Error(
              `task "${params.currentSelection.taskId}" is not waiting for approval`,
            );
          }
          throw error;
        }
      }

      const result = await params.proposalController.execute(
        params.input,
        params.currentSelection,
      );
      return result.message;
    }
  }
}

function isProposalSelectionMiss(
  error: unknown,
  featureId: string | undefined,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message === 'select feature with pending proposal first') {
    return true;
  }
  if (featureId === undefined) {
    return false;
  }
  return (
    error.message === `feature "${featureId}" has no pending proposal` ||
    error.message === `feature "${featureId}" is not in planning or replanning`
  );
}

function isConfigEditableKey(value: unknown): value is ConfigEditableKey {
  return (
    typeof value === 'string' &&
    (CONFIG_EDITABLE_KEYS as readonly string[]).includes(value)
  );
}

function applyConfigValue(
  config: GvcConfig,
  key: ConfigEditableKey,
  rawValue: string,
): GvcConfig {
  switch (key) {
    case 'workerCap':
      return { ...config, workerCap: parsePositiveInt(rawValue, key) };
    case 'retryCap':
      return { ...config, retryCap: parsePositiveInt(rawValue, key) };
    case 'reentryCap':
      return { ...config, reentryCap: parsePositiveInt(rawValue, key) };
    case 'pauseTimeouts.hotWindowMs':
      return {
        ...config,
        pauseTimeouts: {
          ...config.pauseTimeouts,
          hotWindowMs: parsePositiveInt(rawValue, key),
        },
      };
    case 'models.topPlanner.provider':
      return {
        ...config,
        models: {
          ...config.models,
          topPlanner: { ...config.models.topPlanner, provider: rawValue },
        },
      };
    case 'models.topPlanner.model':
      return {
        ...config,
        models: {
          ...config.models,
          topPlanner: { ...config.models.topPlanner, model: rawValue },
        },
      };
    case 'models.featurePlanner.provider':
      return {
        ...config,
        models: {
          ...config.models,
          featurePlanner: {
            ...config.models.featurePlanner,
            provider: rawValue,
          },
        },
      };
    case 'models.featurePlanner.model':
      return {
        ...config,
        models: {
          ...config.models,
          featurePlanner: { ...config.models.featurePlanner, model: rawValue },
        },
      };
    case 'models.taskWorker.provider':
      return {
        ...config,
        models: {
          ...config.models,
          taskWorker: { ...config.models.taskWorker, provider: rawValue },
        },
      };
    case 'models.taskWorker.model':
      return {
        ...config,
        models: {
          ...config.models,
          taskWorker: { ...config.models.taskWorker, model: rawValue },
        },
      };
    case 'models.verifier.provider':
      return {
        ...config,
        models: {
          ...config.models,
          verifier: { ...config.models.verifier, provider: rawValue },
        },
      };
    case 'models.verifier.model':
      return {
        ...config,
        models: {
          ...config.models,
          verifier: { ...config.models.verifier, model: rawValue },
        },
      };
  }
}

function parsePositiveInt(rawValue: string, key: ConfigEditableKey): number {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function formatConfigValueForNotice(
  config: GvcConfig,
  key: ConfigEditableKey,
): string {
  switch (key) {
    case 'workerCap':
      return String(config.workerCap);
    case 'retryCap':
      return String(config.retryCap);
    case 'reentryCap':
      return String(config.reentryCap);
    case 'pauseTimeouts.hotWindowMs':
      return String(config.pauseTimeouts.hotWindowMs);
    case 'models.topPlanner.provider':
      return config.models.topPlanner.provider;
    case 'models.topPlanner.model':
      return config.models.topPlanner.model;
    case 'models.featurePlanner.provider':
      return config.models.featurePlanner.provider;
    case 'models.featurePlanner.model':
      return config.models.featurePlanner.model;
    case 'models.taskWorker.provider':
      return config.models.taskWorker.provider;
    case 'models.taskWorker.model':
      return config.models.taskWorker.model;
    case 'models.verifier.provider':
      return config.models.verifier.provider;
    case 'models.verifier.model':
      return config.models.verifier.model;
  }
}
