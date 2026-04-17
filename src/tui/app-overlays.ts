import type { GraphSnapshot } from '@core/graph/index';
import type { FeatureId } from '@core/types/index';
import type { OverlayHandle, TUI } from '@mariozechner/pi-tui';
import type { TuiCommand, TuiKeybindHint } from '@tui/commands/index';
import type {
  AgentMonitorOverlay,
  DependencyDetailOverlay,
  HelpOverlay,
} from '@tui/components/index';
import type { TuiViewModelBuilder } from '@tui/view-model/index';

export interface OverlayState {
  monitorHandle: OverlayHandle | undefined;
  dependencyHandle: OverlayHandle | undefined;
  helpHandle: OverlayHandle | undefined;
}

export function hideAllOverlays(state: OverlayState): void {
  state.monitorHandle?.hide();
  state.monitorHandle = undefined;
  state.dependencyHandle?.hide();
  state.dependencyHandle = undefined;
  state.helpHandle?.hide();
  state.helpHandle = undefined;
}

export function hasVisibleOverlay(state: OverlayState): boolean {
  return (
    state.helpHandle !== undefined ||
    state.monitorHandle !== undefined ||
    state.dependencyHandle !== undefined
  );
}

export function hideTopOverlay(params: {
  state: OverlayState;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): boolean {
  const { state, refresh, setNotice } = params;
  if (state.helpHandle !== undefined) {
    state.helpHandle.hide();
    state.helpHandle = undefined;
    setNotice('help hidden');
    refresh();
    return true;
  }
  if (state.monitorHandle !== undefined) {
    state.monitorHandle.hide();
    state.monitorHandle = undefined;
    setNotice('monitor hidden');
    refresh();
    return true;
  }
  if (state.dependencyHandle !== undefined) {
    state.dependencyHandle.hide();
    state.dependencyHandle = undefined;
    setNotice('dependency detail hidden');
    refresh();
    return true;
  }

  return false;
}

export function toggleHelpOverlay(params: {
  state: OverlayState;
  tui: TUI;
  helpOverlay: HelpOverlay;
  navigationKeybinds: readonly TuiKeybindHint[];
  commandEntries: readonly TuiCommand[];
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    helpOverlay,
    navigationKeybinds,
    commandEntries,
    refresh,
    setNotice,
  } = params;
  if (state.helpHandle !== undefined) {
    state.helpHandle.hide();
    state.helpHandle = undefined;
    setNotice('help hidden');
    refresh();
    return;
  }

  helpOverlay.setModel('Help', [...navigationKeybinds, ...commandEntries]);
  state.helpHandle = tui.showOverlay(helpOverlay, {
    width: '70%',
    maxHeight: '60%',
    anchor: 'center',
  });
  setNotice('help shown');
  refresh();
}

export function toggleAgentMonitorOverlay(params: {
  state: OverlayState;
  tui: TUI;
  monitorOverlay: AgentMonitorOverlay;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const { state, tui, monitorOverlay, refresh, setNotice } = params;
  if (state.monitorHandle !== undefined) {
    state.monitorHandle.hide();
    state.monitorHandle = undefined;
    setNotice('monitor hidden');
    refresh();
    return;
  }

  state.monitorHandle = tui.showOverlay(monitorOverlay, {
    width: '85%',
    maxHeight: '55%',
    anchor: 'bottom-center',
    offsetY: -4,
  });
  setNotice('monitor shown');
  refresh();
}

export function toggleDependencyOverlay(params: {
  state: OverlayState;
  tui: TUI;
  dependencyOverlay: DependencyDetailOverlay;
  viewModels: TuiViewModelBuilder;
  snapshot: GraphSnapshot;
  selectedFeatureId: FeatureId | undefined;
  refresh: () => void;
  setNotice: (notice: string) => void;
}): void {
  const {
    state,
    tui,
    dependencyOverlay,
    viewModels,
    snapshot,
    selectedFeatureId,
    refresh,
    setNotice,
  } = params;
  if (state.dependencyHandle !== undefined) {
    state.dependencyHandle.hide();
    state.dependencyHandle = undefined;
    setNotice('dependency detail hidden');
    refresh();
    return;
  }

  dependencyOverlay.setDetail(
    selectedFeatureId === undefined
      ? undefined
      : viewModels.buildDependencyDetail(
          selectedFeatureId,
          snapshot.milestones,
          snapshot.features,
        ),
  );
  state.dependencyHandle = tui.showOverlay(dependencyOverlay, {
    width: '70%',
    maxHeight: '40%',
    anchor: 'center',
  });
  setNotice('dependency detail shown');
  refresh();
}

export function pushWorkerOutput(params: {
  monitorOverlay: Pick<
    AgentMonitorOverlay,
    'upsertLog' | 'getSelectedWorkerId'
  >;
  runId: string;
  taskId: string;
  text: string;
}): string | undefined {
  const lines = params.text.split(/\r?\n/).filter((line) => line.length > 0);
  const timestamp = Date.now();

  for (const line of lines) {
    params.monitorOverlay.upsertLog(
      params.runId,
      params.taskId,
      line,
      timestamp,
    );
  }

  return params.monitorOverlay.getSelectedWorkerId();
}
