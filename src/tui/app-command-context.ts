import type { FeatureId, MilestoneId } from '@core/types/index';
import type { TuiCommandContext } from '@tui/commands/index';
import type { AgentMonitorOverlay } from '@tui/components/index';

import type { TuiDataSource } from './data-source.js';

interface CreateTuiCommandContextOptions {
  dataSource: TuiDataSource;
  monitorOverlay: Pick<AgentMonitorOverlay, 'cycleSelection'>;
  selectedMilestoneId: () => MilestoneId | undefined;
  selectedFeatureId: () => FeatureId | undefined;
  toggleAgentMonitor: () => void;
  toggleHelp: () => void;
  toggleDependencyDetail: () => void;
  setSelectedWorkerId: (workerId: string | undefined) => void;
  setNotice: (notice: string | undefined) => void;
  refresh: () => void;
}

export function createTuiCommandContext({
  dataSource,
  monitorOverlay,
  selectedMilestoneId,
  selectedFeatureId,
  toggleAgentMonitor,
  toggleHelp,
  toggleDependencyDetail,
  setSelectedWorkerId,
  setNotice,
  refresh,
}: CreateTuiCommandContextOptions): TuiCommandContext {
  return {
    toggleAutoExecution: () => {
      const enabled = dataSource.toggleAutoExecution();
      setNotice(enabled ? 'auto execution on' : 'auto execution paused');
      refresh();
    },
    toggleMilestoneQueue: () => {
      const milestoneId = selectedMilestoneId();
      if (milestoneId === undefined) {
        setNotice('select milestone first');
        refresh();
        return;
      }
      dataSource.toggleMilestoneQueue(milestoneId);
      setNotice(`toggled queue for ${milestoneId}`);
      refresh();
    },
    toggleAgentMonitor: () => {
      toggleAgentMonitor();
    },
    selectNextWorker: () => {
      const workerId = monitorOverlay.cycleSelection();
      setSelectedWorkerId(workerId);
      setNotice(
        workerId === undefined
          ? 'no workers yet'
          : `selected worker ${workerId}`,
      );
      refresh();
    },
    toggleHelp: () => {
      toggleHelp();
    },
    toggleDependencyDetail: () => {
      toggleDependencyDetail();
    },
    cancelSelectedFeature: async () => {
      const featureId = selectedFeatureId();
      if (featureId === undefined) {
        setNotice('select feature first');
        refresh();
        return;
      }
      await dataSource.cancelFeature(featureId);
      setNotice(`cancelled ${featureId}`);
      refresh();
    },
    requestQuit: () => {
      void dataSource.quit();
    },
  };
}
