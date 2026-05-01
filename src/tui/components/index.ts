import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@mariozechner/pi-tui';
import type { TuiKeybindHint } from '@tui/commands/index';
import type {
  ComposerViewModel,
  ConfigOverlayViewModel,
  DagNodeViewModel,
  DependencyDetailViewModel,
  EmptyStateViewModel,
  InboxOverlayViewModel,
  MergeTrainOverlayViewModel,
  StatusBarViewModel,
  TaskTranscriptViewModel,
  WorkerLogViewModel,
} from '@tui/view-model/index';

export type { Component };

export class DagView implements Component {
  private nodes: DagNodeViewModel[] = [];
  private selectedNodeId: string | undefined;
  private title = 'gvc0';
  private emptyState: EmptyStateViewModel | undefined;

  setModel(
    nodes: DagNodeViewModel[],
    selectedNodeId?: string,
    title = 'gvc0',
    emptyState?: EmptyStateViewModel,
  ): void {
    this.nodes = nodes;
    this.selectedNodeId = selectedNodeId;
    this.title = title;
    this.emptyState = emptyState;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = [truncateToWidth(this.title, safeWidth, '...', true)];

    if (this.nodes.length === 0) {
      const emptyState = this.emptyState;
      if (emptyState === undefined) {
        lines.push(
          truncateToWidth('No milestones yet.', safeWidth, '...', true),
        );
        return lines;
      }
      lines.push(truncateToWidth(emptyState.title, safeWidth, '...', true));
      for (const line of emptyState.lines) {
        lines.push(...padWrapped(line, safeWidth));
      }
      return lines;
    }

    const renderNode = (node: DagNodeViewModel, depth: number): void => {
      const indent = '  '.repeat(depth);
      const selected = node.id === this.selectedNodeId ? '>' : ' ';
      const meta = node.meta.length > 0 ? ` [${node.meta.join('] [')}]` : '';
      const line = `${selected} ${indent}${node.icon} ${node.label}${meta}`;
      lines.push(truncateToWidth(line, safeWidth, '...', true));
      for (const child of node.children) {
        renderNode(child, depth + 1);
      }
    };

    for (const node of this.nodes) {
      renderNode(node, 0);
    }

    return lines;
  }

  invalidate(): void {}
}

export class StatusBar implements Component {
  private model: StatusBarViewModel = {
    autoExecutionEnabled: false,
    runningWorkers: 0,
    idleWorkers: 0,
    totalWorkers: 0,
    completedTasks: 0,
    totalTasks: 0,
    totalUsd: 0,
    keybindHints: [],
  };

  setModel(model: StatusBarViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const mode = this.model.autoExecutionEnabled ? 'auto' : 'paused';
    const top = [
      `mode: ${mode}`,
      `workers: ${this.model.runningWorkers}/${this.model.totalWorkers} running`,
      `tasks: ${this.model.completedTasks}/${this.model.totalTasks} done`,
      `cost: $${this.model.totalUsd.toFixed(2)}`,
      ...(this.model.dataMode !== undefined
        ? [`view: ${this.model.dataMode}`]
        : []),
      ...(this.model.focusMode !== undefined
        ? [`focus: ${this.model.focusMode}`]
        : []),
    ].join('  ');
    const keybindSummary = this.model.keybindHints
      .map((hint) => `${hint.key} ${hint.label}`)
      .join('  ');
    const bottom = this.model.notice
      ? `notice: ${this.model.notice}`
      : this.model.pendingProposalPhase !== undefined
        ? `approval: ${this.model.pendingProposalPhase}${this.model.pendingProposalHint !== undefined ? ` (${this.model.pendingProposalHint})` : ''}`
        : this.model.selectedLabel
          ? `selected: ${this.model.selectedLabel}`
          : `keys: ${keybindSummary}`;

    return [...padWrapped(top, safeWidth), ...padWrapped(bottom, safeWidth)];
  }

  invalidate(): void {}
}

export class HelpOverlay implements Component {
  private title = 'Help';
  private keybinds: readonly TuiKeybindHint[] = [];

  setModel(title: string, keybinds: readonly TuiKeybindHint[]): void {
    this.title = title;
    this.keybinds = keybinds;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body = this.keybinds.map((hint) => {
      return `${hint.key.padEnd(5, ' ')} ${hint.label} — ${hint.description}`;
    });

    return drawBox(
      ` ${this.title} [h/q/esc hide] `,
      body.length === 0 ? ['No keybinds available.'] : body,
      safeWidth,
    );
  }

  invalidate(): void {}
}

export class AgentMonitorOverlay implements Component {
  private readonly logs = new Map<string, WorkerLogViewModel>();
  private selectedWorkerId: string | undefined;
  private readonly maxLines = 200;

  upsertLog(
    agentRunId: string,
    taskId: string,
    line: string,
    updatedAt: number,
  ): void {
    const existing = this.logs.get(agentRunId);
    const lines = [...(existing?.lines ?? []), line];
    while (lines.length > this.maxLines) {
      lines.shift();
    }

    this.logs.set(agentRunId, {
      id: agentRunId,
      label: `${taskId}`,
      taskId,
      agentRunId,
      lines,
      updatedAt,
    });

    if (this.selectedWorkerId === undefined) {
      this.selectedWorkerId = agentRunId;
    }
  }

  getLogs(): WorkerLogViewModel[] {
    return [...this.logs.values()].sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return left.id.localeCompare(right.id);
    });
  }

  setSelectedWorker(workerId?: string): void {
    this.selectedWorkerId = workerId;
  }

  getSelectedWorkerId(): string | undefined {
    return this.selectedWorkerId;
  }

  cycleSelection(step = 1): string | undefined {
    const logs = this.getLogs();
    if (logs.length === 0) {
      this.selectedWorkerId = undefined;
      return undefined;
    }

    const currentIndex = logs.findIndex(
      (entry) => entry.id === this.selectedWorkerId,
    );
    const nextIndex =
      currentIndex < 0 ? 0 : (currentIndex + step + logs.length) % logs.length;
    this.selectedWorkerId = logs[nextIndex]?.id;
    return this.selectedWorkerId;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const logs = this.getLogs();
    const selected =
      logs.find((entry) => entry.id === this.selectedWorkerId) ?? logs[0];

    if (safeWidth < 20) {
      const body =
        selected === undefined
          ? ['Waiting for worker progress...']
          : [
              `Task: ${selected.taskId}`,
              `Run: ${selected.agentRunId}`,
              ...selected.lines.slice(-6),
            ];
      return drawBox(
        ` Agent Monitor [${logs.length} active] [m/q/esc hide] `,
        body,
        safeWidth,
      );
    }

    const innerWidth = Math.max(1, safeWidth - 2);
    const listWidth = Math.min(24, Math.max(6, Math.floor(innerWidth * 0.28)));
    const detailWidth = Math.max(1, innerWidth - listWidth - 3);
    const leftLines =
      logs.length === 0
        ? ['No worker output yet.']
        : logs.map((entry) => {
            const prefix = entry.id === selected?.id ? '> ' : '  ';
            return truncateToWidth(
              `${prefix}${entry.label}`,
              listWidth,
              '...',
              true,
            );
          });
    const rightLines =
      selected === undefined
        ? ['Waiting for worker progress...']
        : [
            `Task: ${selected.taskId}`,
            `Run: ${selected.agentRunId}`,
            '────────────────────',
            ...selected.lines.slice(-12),
          ];
    const height = Math.max(leftLines.length, rightLines.length);
    const rows: string[] = [];

    for (let index = 0; index < height; index++) {
      const left = padVisible(leftLines[index] ?? '', listWidth);
      const right = padVisible(
        truncateToWidth(rightLines[index] ?? '', detailWidth, '...', false),
        detailWidth,
      );
      rows.push(`${left} │ ${right}`);
    }

    return drawBox(
      ` Agent Monitor [${logs.length} active] [m/q/esc hide] `,
      rows,
      safeWidth,
    );
  }

  invalidate(): void {}
}

export class ComposerStatus implements Component {
  private model: ComposerViewModel = {
    mode: 'command',
    focusMode: 'composer',
    text: '',
    detail: 'composer',
  };

  setModel(model: ComposerViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const top = truncateToWidth(
      `[${this.model.mode}] [${this.model.focusMode}] ${this.model.detail}`,
      safeWidth,
      '...',
      true,
    );
    const body = truncateToWidth(
      this.model.text.length > 0 ? this.model.text : '/',
      safeWidth,
      '...',
      false,
    );
    return [...padWrapped(top, safeWidth), ...padWrapped(body, safeWidth)];
  }

  invalidate(): void {}
}

export class DependencyDetailOverlay implements Component {
  private detail: DependencyDetailViewModel | undefined;

  setDetail(detail?: DependencyDetailViewModel): void {
    this.detail = detail;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body =
      this.detail === undefined
        ? ['No feature selected.']
        : [
            this.detail.featureLabel,
            this.detail.description,
            `milestone: ${this.detail.milestoneLabel}`,
            `depends on: ${this.detail.dependsOn.join(', ') || 'none'}`,
            `dependents: ${this.detail.dependents.join(', ') || 'none'}`,
          ];

    return drawBox(' Dependency Detail [d/q/esc hide] ', body, safeWidth);
  }

  invalidate(): void {}
}

export class InboxOverlay implements Component {
  private model: InboxOverlayViewModel = {
    items: [],
    unresolvedCount: 0,
  };

  setModel(model: InboxOverlayViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body =
      this.model.items.length === 0
        ? ['No pending inbox items.']
        : this.model.items.map((item) => {
            return `${item.id} [${item.kind}] ${item.summary}`;
          });

    return drawBox(
      ` Inbox [${this.model.unresolvedCount} pending] [i/q/esc hide] `,
      body,
      safeWidth,
    );
  }

  invalidate(): void {}
}

export class MergeTrainOverlay implements Component {
  private model: MergeTrainOverlayViewModel = {
    items: [],
    integratingCount: 0,
    queuedCount: 0,
  };

  setModel(model: MergeTrainOverlayViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body =
      this.model.items.length === 0
        ? ['No integrating or queued features.']
        : this.model.items.map((item) => {
            return `${item.label} [${item.state}] ${item.summary}`;
          });

    return drawBox(
      ` Merge Train [${this.model.integratingCount} active, ${this.model.queuedCount} queued] [t/q/esc hide] `,
      body,
      safeWidth,
    );
  }

  invalidate(): void {}
}

export class ConfigOverlay implements Component {
  private model: ConfigOverlayViewModel = {
    entries: [],
  };

  setModel(model: ConfigOverlayViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body =
      this.model.entries.length === 0
        ? ['No editable config values.']
        : [
            ...this.model.entries.map(
              (entry) => `${entry.key} = ${entry.value}`,
            ),
            'Use /config-set --key <path> --value "..." to update a value.',
          ];

    return drawBox(' Config [c/q/esc hide] ', body, safeWidth);
  }

  invalidate(): void {}
}

export class TaskTranscriptOverlay implements Component {
  private model: TaskTranscriptViewModel = {
    taskId: undefined,
    label: 'no task selected',
    lines: [],
  };
  private readonly maxVisibleLines = 12;

  setModel(model: TaskTranscriptViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body =
      this.model.taskId === undefined
        ? ['No task selected.']
        : this.model.lines.length === 0
          ? ['No output yet.']
          : this.model.lines.slice(-this.maxVisibleLines);

    return drawBox(
      ` Transcript: ${this.model.label} [r/q/esc hide] `,
      body,
      safeWidth,
    );
  }

  invalidate(): void {}
}

function drawBox(title: string, lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (safeWidth < 3) {
    return [truncateToWidth(title, safeWidth, '...', true)];
  }

  const innerWidth = Math.max(1, safeWidth - 2);
  const titleLine = `┌${truncateToWidth(title, innerWidth, '...', true)}┐`;
  const body = lines.flatMap((line) => {
    return padWrapped(line, innerWidth).map((entry) => `│${entry}│`);
  });
  return [titleLine, ...body, `└${'─'.repeat(innerWidth)}┘`];
}

function padWrapped(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const wrapped = wrapTextWithAnsi(text, safeWidth);
  const lines = wrapped.length === 0 ? [''] : wrapped;
  return lines.map((line) => padVisible(line, safeWidth));
}

function padVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, '...', false);
  const remaining = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${' '.repeat(remaining)}`;
}
