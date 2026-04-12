import type {
  DagNodeViewModel,
  StatusBarViewModel,
} from '@tui/view-model/index';

export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

/** DagView renders the milestone → feature → task tree as indented text. */
export class DagView implements Component {
  private tree: DagNodeViewModel[] = [];

  setTree(tree: DagNodeViewModel[]): void {
    this.tree = tree;
  }

  render(_width: number): string[] {
    const lines: string[] = ['DAG'];
    if (this.tree.length === 0) {
      lines.push('  (no milestones yet)');
      return lines;
    }
    const walk = (node: DagNodeViewModel, depth: number): void => {
      const indent = '  '.repeat(depth + 1);
      lines.push(`${indent}${node.label} [${node.workStatus}]`);
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    for (const milestone of this.tree) {
      walk(milestone, 0);
    }
    return lines;
  }

  invalidate(): void {}
}

/** StatusBar renders worker / task counters and cost as a single line. */
export class StatusBar implements Component {
  private data: StatusBarViewModel = {
    runningWorkers: 0,
    idleWorkers: 0,
    completedTasks: 0,
    totalTasks: 0,
    totalUsd: 0,
  };

  setData(data: StatusBarViewModel): void {
    this.data = { ...data };
  }

  render(_width: number): string[] {
    const d = this.data;
    return [
      `status | running=${d.runningWorkers} idle=${d.idleWorkers} ` +
        `done=${d.completedTasks}/${d.totalTasks} ` +
        `cost=$${d.totalUsd.toFixed(2)}`,
    ];
  }

  invalidate(): void {}
}

/** Overlay is hidden until explicitly toggled — renders nothing for now. */
export class AgentMonitorOverlay implements Component {
  private visible = false;

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  render(_width: number): string[] {
    return this.visible ? ['[agent monitor]'] : [];
  }

  invalidate(): void {}
}
