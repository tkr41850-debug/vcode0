import type { ComposerSelection, TuiCommandContext } from '@tui/commands/index';
import {
  parseInitializeProjectCommand,
  parseSlashCommand,
} from '@tui/commands/index';
import type { ComposerProposalController } from '@tui/proposal-controller';

import { formatUnknownError } from './app-state.js';
import type { TuiDataSource } from './data-source.js';

export async function handleComposerSubmit(params: {
  text: string;
  executeSlashCommand: (input: string) => Promise<string>;
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

  if (!trimmed.startsWith('/')) {
    params.setNotice('planner chat not wired yet');
    params.refresh();
    return;
  }

  try {
    const message = await params.executeSlashCommand(trimmed);
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
  dataSource: TuiDataSource;
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
    case 'deps':
      params.commandContext.toggleDependencyDetail();
      return params.notice ?? 'toggled dependency detail';
    case 'cancel':
      await params.commandContext.cancelSelectedFeature();
      return params.notice ?? 'cancelled feature';
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
    default: {
      const run = params.currentSelection.taskId
        ? params.dataSource.getTaskRun(params.currentSelection.taskId)
        : undefined;
      if (
        parsed.name === 'approve' &&
        params.currentSelection.taskId !== undefined
      ) {
        if (run?.runStatus === 'await_approval') {
          return params.dataSource.decideTaskApproval(
            params.currentSelection.taskId,
            { kind: 'approved' },
          );
        }
        if (run !== undefined) {
          throw new Error(
            `task "${params.currentSelection.taskId}" is not waiting for approval`,
          );
        }
      }
      if (
        parsed.name === 'reject' &&
        params.currentSelection.taskId !== undefined
      ) {
        if (run?.runStatus === 'await_approval') {
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
      }

      const result = await params.proposalController.execute(
        params.input,
        params.currentSelection,
      );
      return result.message;
    }
  }
}
