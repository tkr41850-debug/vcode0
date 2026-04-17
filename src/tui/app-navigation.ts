import type { GraphSnapshot } from '@core/graph/index';
import type { AgentRun } from '@core/types/index';
import { Key, matchesKey } from '@mariozechner/pi-tui';
import type {
  ComposerSelection,
  TuiCommand,
  TuiCommandContext,
  TuiCommandKey,
} from '@tui/commands/index';
import type {
  DagNodeViewModel,
  TuiViewModelBuilder,
} from '@tui/view-model/index';

import {
  buildFlattenedNodes,
  currentSelectionFromNode,
  findSelectedNode,
} from './app-state.js';

export function matchCommandKey(
  data: string,
  commands: readonly TuiCommand[],
): TuiCommandKey | undefined {
  for (const command of commands) {
    if (
      (command.key === 'space' && matchesKey(data, Key.space)) ||
      matchesKey(data, command.key)
    ) {
      return command.key;
    }
  }

  return undefined;
}

export function moveSelection(params: {
  viewModels: TuiViewModelBuilder;
  snapshot: GraphSnapshot;
  runs: AgentRun[];
  selectedNodeId: string | undefined;
  step: number;
}): { selectedNodeId: string | undefined; notice: string | undefined } {
  const nodes = buildFlattenedNodes(
    params.viewModels,
    params.snapshot,
    params.runs,
  );
  if (nodes.length === 0) {
    return { selectedNodeId: undefined, notice: 'nothing to select' };
  }

  const currentIndex = nodes.findIndex(
    (node) => node.id === params.selectedNodeId,
  );
  const nextIndex =
    currentIndex < 0
      ? 0
      : (currentIndex + params.step + nodes.length) % nodes.length;
  return {
    selectedNodeId: nodes[nextIndex]?.id,
    notice: undefined,
  };
}

export function selectedNode(params: {
  viewModels: TuiViewModelBuilder;
  snapshot: GraphSnapshot;
  runs: AgentRun[];
  selectedNodeId: string | undefined;
}): DagNodeViewModel | undefined {
  return findSelectedNode(
    buildFlattenedNodes(params.viewModels, params.snapshot, params.runs),
    params.selectedNodeId,
  );
}

export function currentSelection(params: {
  viewModels: TuiViewModelBuilder;
  snapshot: GraphSnapshot;
  runs: AgentRun[];
  selectedNodeId: string | undefined;
}): ComposerSelection {
  return currentSelectionFromNode(selectedNode(params));
}

export function handleGraphInput(params: {
  data: string;
  focusMode: 'composer' | 'graph';
  composerText: string;
  hasVisibleOverlay: boolean;
  hideTopOverlay: () => boolean;
  focusGraph: () => void;
  focusComposer: (seedText?: string) => void;
  moveSelection: (step: number) => void;
  commands: readonly TuiCommand[];
  commandContext: TuiCommandContext;
  executeByKey: (
    key: TuiCommandKey,
    context: TuiCommandContext,
  ) => Promise<boolean>;
}): boolean {
  if (matchesKey(params.data, Key.escape) || matchesKey(params.data, Key.esc)) {
    if (params.hideTopOverlay()) {
      return true;
    }
    if (
      params.focusMode === 'composer' &&
      params.composerText.trim().length === 0
    ) {
      params.focusGraph();
      return true;
    }
    if (params.focusMode === 'graph') {
      params.focusComposer();
      return true;
    }
    return false;
  }
  if (matchesKey(params.data, 'q') && params.hasVisibleOverlay) {
    return params.hideTopOverlay();
  }

  if (params.focusMode === 'composer') {
    return false;
  }

  if (matchesKey(params.data, '/')) {
    params.focusComposer('/');
    return true;
  }
  if (matchesKey(params.data, Key.up)) {
    params.moveSelection(-1);
    return true;
  }
  if (matchesKey(params.data, Key.down)) {
    params.moveSelection(1);
    return true;
  }

  const commandKey = matchCommandKey(params.data, params.commands);
  if (commandKey === undefined) {
    return false;
  }

  void params.executeByKey(commandKey, params.commandContext);
  return true;
}
