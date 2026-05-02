import type { GraphSnapshot } from '@core/graph/index';
import type { ComposerSelection, TuiCommandContext } from '@tui/commands/index';
import {
  parseInitializeProjectCommand,
  parseSlashCommand,
} from '@tui/commands/index';
import type { ProjectPlannerController } from '@tui/project-planner-controller';
import type { ComposerProposalController } from '@tui/proposal-controller';
import type { TuiAppDeps } from './app-deps.js';
import { formatUnknownError, phaseForFeature } from './app-state.js';

export async function handleComposerSubmit(params: {
  text: string;
  executeSlashCommand: (input: string) => Promise<string>;
  executePlainText?: (input: string) => Promise<string>;
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
    if (params.executePlainText === undefined) {
      params.setNotice('planner chat not wired yet');
      params.refresh();
      return;
    }
    try {
      const message = await params.executePlainText(trimmed);
      params.addToHistory(trimmed);
      params.setNotice(message);
    } catch (error) {
      params.setNotice(formatUnknownError(error));
    }
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

/**
 * Route a non-slash composer submission. If the selected feature is in
 * planning or replanning AND has a running plan/replan agent_run, the text
 * lands on the running planner as a follow-up turn via
 * {@link TuiAppDeps.sendPlannerChatInput}. Otherwise returns a helpful
 * notice without touching runtime state.
 *
 * When `draftActive` is true (a manual proposal draft is in flight), plain
 * text is rejected with a notice so the operator does not accidentally send
 * follow-up turns to the background planner while editing locally — that
 * would create two competing proposal sources.
 */
export async function routePlainTextInput(params: {
  text: string;
  selection: ComposerSelection;
  snapshot: GraphSnapshot;
  dataSource: TuiAppDeps;
  draftActive: boolean;
}): Promise<string> {
  const { selection, snapshot, dataSource, text, draftActive } = params;
  if (draftActive) {
    return 'discard manual draft (/discard) before chatting with planner';
  }
  if (selection.featureId === undefined) {
    return 'select a feature in planning or replanning to chat with planner';
  }
  const feature = snapshot.features.find(
    (entry) => entry.id === selection.featureId,
  );
  if (feature === undefined) {
    return `feature "${selection.featureId}" not found`;
  }
  const phase = phaseForFeature(feature);
  if (phase === undefined) {
    return 'planner not running for this feature (not in planning/replanning)';
  }
  const run = dataSource.getFeatureRun(selection.featureId, phase);
  if (run === undefined || run.runStatus !== 'running') {
    return 'planner not running for this feature';
  }
  return dataSource.sendPlannerChatInput(selection.featureId, phase, text);
}

export async function executeSlashCommand(params: {
  input: string;
  commandContext: TuiCommandContext;
  notice: string | undefined;
  dataSource: TuiAppDeps;
  proposalController: ComposerProposalController;
  projectPlannerController?: ProjectPlannerController;
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
    case 'attach': {
      const featureId = params.currentSelection.featureId;
      if (featureId === undefined) {
        throw new Error('select a feature in planning or replanning to attach');
      }
      const snapshot = params.dataSource.snapshot();
      const feature = snapshot.features.find((entry) => entry.id === featureId);
      if (feature === undefined) {
        throw new Error(`feature "${featureId}" not found`);
      }
      const phase = phaseForFeature(feature);
      if (phase === undefined) {
        throw new Error(
          `feature "${featureId}" is not in planning or replanning`,
        );
      }
      return params.dataSource.attachFeaturePhaseRun(featureId, phase);
    }
    case 'release-to-scheduler': {
      const featureId = params.currentSelection.featureId;
      if (featureId === undefined) {
        throw new Error('select a feature with attached planner to release');
      }
      const snapshot = params.dataSource.snapshot();
      const feature = snapshot.features.find((entry) => entry.id === featureId);
      if (feature === undefined) {
        throw new Error(`feature "${featureId}" not found`);
      }
      const phase = phaseForFeature(feature);
      if (phase === undefined) {
        throw new Error(
          `feature "${featureId}" is not in planning or replanning`,
        );
      }
      return params.dataSource.releaseFeaturePhaseToScheduler(featureId, phase);
    }
    case 'quit':
      params.commandContext.requestQuit();
      return 'quitting';
    case 'project': {
      if (params.projectPlannerController === undefined) {
        throw new Error('project-planner controller not wired');
      }
      const positional = parsed.positionals?.[0];
      if (positional === 'detach') {
        const result = await params.projectPlannerController.execute({
          name: 'project',
          args: {},
          positionals: ['detach'],
        });
        return result.message;
      }
      if (positional === 'new') {
        await params.projectPlannerController.selectOption({
          kind: 'start-new',
        });
        const sessionId =
          params.projectPlannerController.getAttachedSessionId();
        return sessionId !== undefined
          ? `Started project-planner session ${sessionId}.`
          : 'Failed to start project-planner session.';
      }
      if (positional === 'resume') {
        const sessionId = parsed.positionals?.[1];
        if (sessionId === undefined) {
          throw new Error('--id (positional) required for /project resume');
        }
        await params.projectPlannerController.selectOption({
          kind: 'resume',
          sessionId,
        });
        return `Resumed project-planner session ${sessionId}.`;
      }
      const result = await params.projectPlannerController.execute({
        name: 'project',
        args: {},
      });
      const picker = params.projectPlannerController.getState().picker;
      if (picker === undefined) {
        return result.message;
      }
      const summary = picker.options
        .map((option) =>
          option.kind === 'start-new'
            ? '/project new'
            : `/project resume ${option.sessionId}`,
        )
        .join(' · ');
      return `${result.message} ${summary}`;
    }
    case 'init': {
      // parseInitializeProjectCommand still validates legacy /init args; the
      // synthetic milestone/feature naming is no longer applied. Phase 6 may
      // remove this parse step once the bootstrap UX is finalized.
      parseInitializeProjectCommand(parsed);
      const bootstrap = await params.dataSource.initializeProject();
      if (bootstrap.kind === 'greenfield-bootstrap') {
        return `Started project planning session ${bootstrap.sessionId}.`;
      }
      return 'Project already initialized.';
    }
    case 'reply': {
      const text = parsed.args.text;
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('--text is required');
      }
      const taskId = params.currentSelection.taskId;
      if (taskId !== undefined) {
        return params.dataSource.respondToTaskHelp(taskId, {
          kind: 'answer',
          text,
        });
      }
      const featureId = params.currentSelection.featureId;
      if (featureId !== undefined) {
        const snapshot = params.dataSource.snapshot();
        const feature = snapshot.features.find(
          (entry) => entry.id === featureId,
        );
        if (feature === undefined) {
          throw new Error(`feature "${featureId}" not found`);
        }
        const phase = phaseForFeature(feature);
        if (phase === undefined) {
          throw new Error(
            `feature "${featureId}" is not in planning or replanning`,
          );
        }
        return params.dataSource.respondToFeaturePhaseHelp(featureId, phase, {
          kind: 'answer',
          text,
        });
      }
      throw new Error('select task or feature waiting for help first');
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
