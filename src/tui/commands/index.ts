import type { GraphSnapshot } from '@core/graph/index';
import type {
  FeatureId,
  MilestoneId,
  TaskId,
  TaskWeight,
} from '@core/types/index';
import type { AutocompleteItem, SlashCommand } from '@mariozechner/pi-tui';

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

export interface InitializeProjectCommand {
  milestoneName: string;
  milestoneDescription: string;
  featureName: string;
  featureDescription: string;
}

export const INITIALIZE_PROJECT_EXAMPLE_COMMAND =
  '--milestone-name "Milestone 1" --milestone-description "Initial milestone" --feature-name "Project startup" --feature-description "Plan initial project work"';

export interface TuiCommand extends TuiKeybindHint {
  name: TuiCommandName;
  key: TuiCommandKey;
  execute(context: TuiCommandContext): Promise<void> | void;
}

export interface ComposerSelection {
  milestoneId?: MilestoneId;
  featureId?: FeatureId;
  taskId?: TaskId;
}

export interface BuildComposerSlashCommandsInput {
  snapshot: GraphSnapshot;
  selection?: ComposerSelection;
}

export interface ParsedSlashCommand {
  name: string;
  args: Record<string, string | boolean>;
  positionals?: string[];
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

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error('slash command must start with "/"');
  }

  const tokens = tokenizeShellLike(trimmed.slice(1));
  const [name, ...rest] = tokens;
  if (name === undefined || name.length === 0) {
    throw new Error('slash command name missing');
  }

  const args: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return {
    name,
    args,
    ...(positionals.length > 0 ? { positionals } : {}),
  };
}

export function buildComposerSlashCommands({
  snapshot,
  selection,
}: BuildComposerSlashCommandsInput): SlashCommand[] {
  const selectedFeatureId =
    selection?.featureId ??
    (selection?.taskId !== undefined
      ? snapshot.tasks.find((task) => task.id === selection.taskId)?.featureId
      : undefined);
  const selectedMilestoneId =
    selection?.milestoneId ??
    (selectedFeatureId !== undefined
      ? snapshot.features.find((feature) => feature.id === selectedFeatureId)
          ?.milestoneId
      : undefined) ??
    snapshot.milestones[0]?.id;
  const featureIds = snapshot.features
    .map((feature) => feature.id)
    .sort((left, right) => left.localeCompare(right));
  const milestoneIds = snapshot.milestones
    .map((milestone) => milestone.id)
    .sort((left, right) => left.localeCompare(right));
  const taskIds = snapshot.tasks
    .filter((task) => {
      return (
        selectedFeatureId === undefined || task.featureId === selectedFeatureId
      );
    })
    .map((task) => task.id)
    .sort((left, right) => left.localeCompare(right));

  const featureIdSuggestions = featureIds.map((featureId) => ({
    value: `--feature ${featureId}`,
    label: featureId,
    description: 'Feature id',
  }));
  const milestoneTemplates = milestoneIds.map((milestoneId) => ({
    value: `--milestone ${milestoneId} --name "" --description ""`,
    label: milestoneId,
    description: 'Add feature under milestone',
  }));
  const taskIdSuggestions = taskIds.map((taskId) => ({
    value: `--task ${taskId} --description ""`,
    label: taskId,
    description: 'Edit task in proposal draft',
  }));

  return [
    staticSlashCommand('auto', 'Toggle auto execution.'),
    staticSlashCommand('queue', 'Queue or dequeue selected milestone.'),
    staticSlashCommand('monitor', 'Show or hide worker monitor overlay.'),
    staticSlashCommand('worker-next', 'Cycle active worker selection.'),
    staticSlashCommand('help', 'Show keyboard help.'),
    staticSlashCommand('deps', 'Show dependency detail for selected feature.'),
    staticSlashCommand('cancel', 'Cancel selected feature.'),
    staticSlashCommand('quit', 'Quit TUI.'),
    {
      name: 'init',
      description: 'Create first milestone and planning feature.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: INITIALIZE_PROJECT_EXAMPLE_COMMAND,
            label: 'bootstrap',
            description: 'Create starter milestone and planning feature',
          },
        ]);
      },
    },
    {
      name: 'feature-add',
      description: 'Add feature to proposal draft.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, [
          ...(selectedMilestoneId !== undefined
            ? [
                {
                  value: `--milestone ${selectedMilestoneId} --name "" --description ""`,
                  label: selectedMilestoneId,
                  description: 'Selected milestone',
                },
              ]
            : []),
          ...milestoneTemplates,
        ]);
      },
    },
    {
      name: 'feature-remove',
      description: 'Remove feature from proposal draft.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, featureIdSuggestions);
      },
    },
    {
      name: 'feature-edit',
      description: 'Edit feature in proposal draft.',
      getArgumentCompletions: async (prefix) => {
        const suggestions = featureIds.map((featureId) => ({
          value: `--feature ${featureId} --name "" --description ""`,
          label: featureId,
          description: 'Edit feature',
        }));
        return filterSuggestions(prefix, suggestions);
      },
    },
    {
      name: 'task-add',
      description: 'Add task to proposal draft.',
      getArgumentCompletions: async (prefix) => {
        const featureId = selectedFeatureId ?? featureIds[0];
        return filterSuggestions(prefix, [
          ...(featureId !== undefined
            ? [
                {
                  value: `--feature ${featureId} --description "" --weight small`,
                  label: featureId,
                  description: 'Add task to selected feature',
                },
              ]
            : []),
          ...featureIds.map((id) => ({
            value: `--feature ${id} --description "" --weight small`,
            label: id,
            description: 'Add task',
          })),
        ]);
      },
    },
    {
      name: 'task-remove',
      description: 'Remove task from proposal draft.',
      getArgumentCompletions: async (prefix) => {
        const suggestions = taskIds.map((taskId) => ({
          value: `--task ${taskId}`,
          label: taskId,
          description: 'Remove task',
        }));
        return filterSuggestions(prefix, suggestions);
      },
    },
    {
      name: 'task-edit',
      description: 'Edit task in proposal draft.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, taskIdSuggestions);
      },
    },
    {
      name: 'dep-add',
      description: 'Add dependency in proposal draft.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, buildDependencySuggestions(snapshot));
      },
    },
    {
      name: 'dep-remove',
      description: 'Remove dependency in proposal draft.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, buildDependencySuggestions(snapshot));
      },
    },
    staticSlashCommand('submit', 'Submit proposal draft for approval.'),
    staticSlashCommand('discard', 'Discard current draft proposal.'),
    {
      name: 'approve',
      description: 'Approve pending proposal.',
    },
    {
      name: 'reject',
      description: 'Reject pending proposal.',
      getArgumentCompletions: async (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--comment ""',
            label: 'comment',
            description: 'Optional rejection comment',
          },
        ]);
      },
    },
    staticSlashCommand('rerun', 'Request planner rerun for pending proposal.'),
  ];
}

function staticSlashCommand(name: string, description: string): SlashCommand {
  return { name, description };
}

function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) {
      continue;
    }

    if (quote === undefined && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (char === '"') {
      if (quote === 'double') {
        quote = undefined;
        continue;
      }
      if (quote === undefined) {
        quote = 'double';
        continue;
      }
    }

    if (char === "'") {
      if (quote === 'single') {
        quote = undefined;
        continue;
      }
      if (quote === undefined) {
        quote = 'single';
        continue;
      }
    }

    if (char === '\\' && quote !== 'single') {
      const next = input[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
        continue;
      }
    }

    current += char;
  }

  if (quote !== undefined) {
    throw new Error('unterminated quoted string');
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function filterSuggestions(
  prefix: string,
  suggestions: readonly AutocompleteItem[],
): AutocompleteItem[] {
  const normalized = prefix.trim();
  if (normalized.length === 0) {
    return dedupeSuggestions(suggestions);
  }

  return dedupeSuggestions(
    suggestions.filter((suggestion) => {
      return suggestion.value.startsWith(normalized);
    }),
  );
}

function dedupeSuggestions(
  suggestions: readonly AutocompleteItem[],
): AutocompleteItem[] {
  const seen = new Set<string>();
  const deduped: AutocompleteItem[] = [];

  for (const suggestion of suggestions) {
    if (seen.has(suggestion.value)) {
      continue;
    }
    seen.add(suggestion.value);
    deduped.push(suggestion);
  }

  return deduped;
}

function buildDependencySuggestions(
  snapshot: GraphSnapshot,
): AutocompleteItem[] {
  const nodeIds = [
    ...snapshot.features.map((feature) => feature.id),
    ...snapshot.tasks.map((task) => task.id),
  ].sort((left, right) => left.localeCompare(right));
  const suggestions: AutocompleteItem[] = [];

  for (const fromId of nodeIds) {
    for (const toId of nodeIds) {
      if (fromId === toId) {
        continue;
      }
      if (sameNodeKind(fromId, toId)) {
        suggestions.push({
          value: `--from ${fromId} --to ${toId}`,
          label: `${fromId} -> ${toId}`,
          description: 'Dependency edge',
        });
      }
    }
  }

  return suggestions;
}

function sameNodeKind(left: string, right: string): boolean {
  return left.slice(0, 2) === right.slice(0, 2);
}

export function parseInitializeProjectCommand(
  parsed: ParsedSlashCommand,
): InitializeProjectCommand {
  return {
    milestoneName: readRequiredStringArg(parsed, 'milestone-name'),
    milestoneDescription: readRequiredStringArg(
      parsed,
      'milestone-description',
    ),
    featureName: readRequiredStringArg(parsed, 'feature-name'),
    featureDescription: readRequiredStringArg(parsed, 'feature-description'),
  };
}

export function isTaskWeight(value: string): value is TaskWeight {
  return ['trivial', 'small', 'medium', 'heavy'].includes(value);
}

function readRequiredStringArg(
  parsed: ParsedSlashCommand,
  key: string,
): string {
  const value = parsed.args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}
