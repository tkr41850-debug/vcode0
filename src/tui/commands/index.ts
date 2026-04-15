export type TuiCommandName =
  | 'toggle_auto'
  | 'queue_milestone'
  | 'toggle_agent_monitor'
  | 'select_worker'
  | 'toggle_help'
  | 'cancel_feature'
  | 'show_feature_dependencies'
  | 'quit';

export type TuiCommandKey = 'space' | 'g' | 'm' | 'w' | 'h' | 'd' | 'x' | 'q';

export interface TuiKeybindHint {
  key: string;
  label: string;
  description: string;
}

export const NAVIGATION_KEYBINDS: readonly TuiKeybindHint[] = [
  {
    key: '↑↓',
    label: 'move',
    description: 'Move DAG selection.',
  },
  {
    key: 'esc',
    label: 'close',
    description: 'Hide active overlay.',
  },
];

export interface TuiCommandContext {
  toggleAutoExecution(): void;
  toggleMilestoneQueue(): void;
  toggleAgentMonitor(): void;
  selectNextWorker(): void;
  toggleHelp(): void;
  toggleDependencyDetail(): void;
  cancelSelectedFeature(): void;
  requestQuit(): void;
}

export interface TuiCommand extends TuiKeybindHint {
  name: TuiCommandName;
  key: TuiCommandKey;
  execute(context: TuiCommandContext): Promise<void> | void;
}

const DEFAULT_COMMANDS: readonly TuiCommand[] = [
  {
    name: 'toggle_auto',
    key: 'space',
    label: 'auto',
    description: 'Start or pause auto-execution.',
    execute: (context) => {
      context.toggleAutoExecution();
    },
  },
  {
    name: 'queue_milestone',
    key: 'g',
    label: 'queue',
    description: 'Queue or dequeue selected milestone.',
    execute: (context) => {
      context.toggleMilestoneQueue();
    },
  },
  {
    name: 'toggle_agent_monitor',
    key: 'm',
    label: 'monitor',
    description: 'Show or hide worker monitor overlay.',
    execute: (context) => {
      context.toggleAgentMonitor();
    },
  },
  {
    name: 'select_worker',
    key: 'w',
    label: 'worker',
    description: 'Cycle active worker selection.',
    execute: (context) => {
      context.selectNextWorker();
    },
  },
  {
    name: 'toggle_help',
    key: 'h',
    label: 'help',
    description: 'Show or hide keyboard help.',
    execute: (context) => {
      context.toggleHelp();
    },
  },
  {
    name: 'show_feature_dependencies',
    key: 'd',
    label: 'deps',
    description: 'Show dependency detail for selected feature.',
    execute: (context) => {
      context.toggleDependencyDetail();
    },
  },
  {
    name: 'cancel_feature',
    key: 'x',
    label: 'cancel',
    description: 'Cancel selected feature.',
    execute: (context) => {
      context.cancelSelectedFeature();
    },
  },
  {
    name: 'quit',
    key: 'q',
    label: 'quit',
    description: 'Quit TUI.',
    execute: (context) => {
      context.requestQuit();
    },
  },
];

export class CommandRegistry {
  private readonly commands: readonly TuiCommand[];

  constructor(commands: readonly TuiCommand[] = DEFAULT_COMMANDS) {
    this.commands = [...commands];
  }

  getAll(): TuiCommand[] {
    return [...this.commands];
  }

  getByKey(key: string): TuiCommand | undefined {
    return this.commands.find((command) => command.key === key);
  }

  async executeByKey(
    key: string,
    context: TuiCommandContext,
  ): Promise<boolean> {
    const command = this.getByKey(key);
    if (command === undefined) {
      return false;
    }

    await command.execute(context);
    return true;
  }
}
