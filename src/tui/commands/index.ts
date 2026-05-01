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
  | 'toggle_inbox'
  | 'toggle_merge_train'
  | 'toggle_transcript'
  | 'toggle_config'
  | 'cancel_feature'
  | 'show_feature_dependencies'
  | 'quit';

export type TuiCommandKey =
  | 'space'
  | 'g'
  | 'm'
  | 'w'
  | 'h'
  | 'i'
  | 't'
  | 'r'
  | 'c'
  | 'd'
  | 'x'
  | 'q';

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
  toggleInbox(): void;
  toggleMergeTrain(): void;
  toggleTranscript(): void;
  toggleConfig(): void;
  toggleDependencyDetail(): void;
  cancelSelectedFeature(): Promise<void>;
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

export const CONFIG_EDITABLE_KEYS = [
  'workerCap',
  'retryCap',
  'reentryCap',
  'pauseTimeouts.hotWindowMs',
  'models.topPlanner.provider',
  'models.topPlanner.model',
  'models.featurePlanner.provider',
  'models.featurePlanner.model',
  'models.taskWorker.provider',
  'models.taskWorker.model',
  'models.verifier.provider',
  'models.verifier.model',
] as const;

export type ConfigEditableKey = (typeof CONFIG_EDITABLE_KEYS)[number];

const CONFIG_SET_TEMPLATES: readonly {
  key: ConfigEditableKey;
  value: string;
  description: string;
}[] = [
  { key: 'workerCap', value: '8', description: 'Worker concurrency cap' },
  { key: 'retryCap', value: '7', description: 'Retry attempt cap' },
  { key: 'reentryCap', value: '3', description: 'Merge-train reentry cap' },
  {
    key: 'pauseTimeouts.hotWindowMs',
    value: '600000',
    description: 'Hot wait window in milliseconds',
  },
  {
    key: 'models.topPlanner.provider',
    value: 'anthropic',
    description: 'Top planner provider',
  },
  {
    key: 'models.topPlanner.model',
    value: 'claude-sonnet-4-6',
    description: 'Top planner model',
  },
  {
    key: 'models.featurePlanner.provider',
    value: 'anthropic',
    description: 'Feature planner provider',
  },
  {
    key: 'models.featurePlanner.model',
    value: 'claude-sonnet-4-6',
    description: 'Feature planner model',
  },
  {
    key: 'models.taskWorker.provider',
    value: 'anthropic',
    description: 'Task worker provider',
  },
  {
    key: 'models.taskWorker.model',
    value: 'claude-haiku-4-5',
    description: 'Task worker model',
  },
  {
    key: 'models.verifier.provider',
    value: 'anthropic',
    description: 'Verifier provider',
  },
  {
    key: 'models.verifier.model',
    value: 'claude-opus-4-7',
    description: 'Verifier model',
  },
] as const;

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
    name: 'toggle_inbox',
    key: 'i',
    label: 'inbox',
    description: 'Show or hide inbox overlay.',
    execute: (context) => {
      context.toggleInbox();
    },
  },
  {
    name: 'toggle_merge_train',
    key: 't',
    label: 'train',
    description: 'Show or hide merge-train overlay.',
    execute: (context) => {
      context.toggleMergeTrain();
    },
  },
  {
    name: 'toggle_transcript',
    key: 'r',
    label: 'transcript',
    description: 'Show or hide task transcript overlay.',
    execute: (context) => {
      context.toggleTranscript();
    },
  },
  {
    name: 'toggle_config',
    key: 'c',
    label: 'config',
    description: 'Show or hide config overlay.',
    execute: (context) => {
      context.toggleConfig();
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
    execute: (context) => context.cancelSelectedFeature(),
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
  const mergeQueuedFeatureIds = snapshot.features
    .filter((feature) => feature.collabControl === 'merge_queued')
    .map((feature) => feature.id)
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
  const selectedTaskId = selection?.taskId ?? taskIds[0];

  return [
    staticSlashCommand('auto', 'Toggle auto execution.'),
    staticSlashCommand('queue', 'Queue or dequeue selected milestone.'),
    staticSlashCommand('monitor', 'Show or hide worker monitor overlay.'),
    staticSlashCommand('worker-next', 'Cycle active worker selection.'),
    staticSlashCommand('help', 'Show keyboard help.'),
    staticSlashCommand('inbox', 'Show or hide inbox overlay.'),
    staticSlashCommand('merge-train', 'Show or hide merge-train overlay.'),
    staticSlashCommand('transcript', 'Show or hide task transcript overlay.'),
    staticSlashCommand('config', 'Show or hide config overlay.'),
    staticSlashCommand('deps', 'Show dependency detail for selected feature.'),
    staticSlashCommand('cancel', 'Cancel selected feature.'),
    staticSlashCommand('quit', 'Quit TUI.'),
    {
      name: 'task-cancel-preserve',
      description: 'Cancel a task while preserving its worktree.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(
          prefix,
          selectedTaskId !== undefined
            ? [
                {
                  value: `--task ${selectedTaskId}`,
                  label: selectedTaskId,
                  description: 'Cancel selected task and keep worktree',
                },
              ]
            : taskIds.map((taskId) => ({
                value: `--task ${taskId}`,
                label: taskId,
                description: 'Cancel task and keep worktree',
              })),
        );
      },
    },
    {
      name: 'task-cancel-clean',
      description: 'Cancel a task and remove its worktree.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(
          prefix,
          selectedTaskId !== undefined
            ? [
                {
                  value: `--task ${selectedTaskId}`,
                  label: selectedTaskId,
                  description: 'Cancel selected task and remove worktree',
                },
              ]
            : taskIds.map((taskId) => ({
                value: `--task ${taskId}`,
                label: taskId,
                description: 'Cancel task and remove worktree',
              })),
        );
      },
    },
    {
      name: 'feature-abandon',
      description: 'Cancel a feature and remove its worktrees and branches.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(
          prefix,
          selectedFeatureId !== undefined
            ? [
                {
                  value: `--feature ${selectedFeatureId}`,
                  label: selectedFeatureId,
                  description: 'Abandon selected feature',
                },
              ]
            : featureIds.map((featureId) => ({
                value: `--feature ${featureId}`,
                label: featureId,
                description: 'Abandon feature branch',
              })),
        );
      },
    },
    {
      name: 'init',
      description: 'Create first milestone and planning feature.',
      getArgumentCompletions: (prefix) => {
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
      name: 'milestone-add',
      description: 'Add milestone to proposal draft.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--name "" --description ""',
            label: 'milestone',
            description: 'Add milestone',
          },
        ]);
      },
    },
    {
      name: 'feature-add',
      description: 'Add feature to proposal draft.',
      getArgumentCompletions: (prefix) => {
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
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, featureIdSuggestions);
      },
    },
    {
      name: 'feature-edit',
      description: 'Edit feature in proposal draft.',
      getArgumentCompletions: (prefix) => {
        const suggestions = featureIds.map((featureId) => ({
          value: `--feature ${featureId} --name "" --description ""`,
          label: featureId,
          description: 'Edit feature',
        }));
        return filterSuggestions(prefix, suggestions);
      },
    },
    {
      name: 'feature-move',
      description: 'Move feature to a different milestone in proposal draft.',
      getArgumentCompletions: (prefix) => {
        const suggestions = featureIds.flatMap((featureId) =>
          milestoneIds.map((milestoneId) => ({
            value: `--feature ${featureId} --milestone ${milestoneId}`,
            label: `${featureId} → ${milestoneId}`,
            description: 'Move feature',
          })),
        );
        return filterSuggestions(prefix, suggestions);
      },
    },
    {
      name: 'feature-split',
      description:
        'Split feature into multiple proposal-backed draft features.',
      getArgumentCompletions: (prefix) => {
        const suggestions = featureIds.map((featureId) => ({
          value: `--feature ${featureId} "api|API feature|API work" "ui|UI feature|UI work|api"`,
          label: featureId,
          description: 'Split feature',
        }));
        return filterSuggestions(prefix, suggestions);
      },
    },
    {
      name: 'feature-merge',
      description:
        'Merge multiple features into one proposal-backed draft feature.',
      getArgumentCompletions: (prefix) => {
        const suggestions = featureIds.flatMap((featureId, index) =>
          featureIds.slice(index + 1).map((otherId) => ({
            value: `--name "Merged feature" ${featureId} ${otherId}`,
            label: `${featureId} + ${otherId}`,
            description: 'Merge features',
          })),
        );
        return filterSuggestions(prefix, suggestions);
      },
    },
    {
      name: 'task-add',
      description: 'Add task to proposal draft.',
      getArgumentCompletions: (prefix) => {
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
      getArgumentCompletions: (prefix) => {
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
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, taskIdSuggestions);
      },
    },
    {
      name: 'task-reorder',
      description: 'Reorder all tasks in a feature in proposal draft.',
      getArgumentCompletions: (prefix) => {
        const featureId = selectedFeatureId ?? featureIds[0];
        if (featureId === undefined) {
          return [];
        }
        const featureTaskIds = snapshot.tasks
          .filter((task) => task.featureId === featureId)
          .sort((left, right) => left.orderInFeature - right.orderInFeature)
          .map((task) => task.id);
        return filterSuggestions(prefix, [
          {
            value: `--feature ${featureId} ${featureTaskIds.join(' ')}`.trim(),
            label: featureId,
            description: 'Reorder tasks',
          },
        ]);
      },
    },
    {
      name: 'dep-add',
      description: 'Add dependency in proposal draft.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, buildDependencySuggestions(snapshot));
      },
    },
    {
      name: 'dep-remove',
      description: 'Remove dependency in proposal draft.',
      getArgumentCompletions: (prefix) => {
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
      getArgumentCompletions: (prefix) => {
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
    {
      name: 'reply',
      description: 'Answer selected task help request.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--text ""',
            label: 'text',
            description: 'Reply text',
          },
        ]);
      },
    },
    {
      name: 'input',
      description: 'Send manual input to selected task run.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--text ""',
            label: 'text',
            description: 'Manual input text',
          },
        ]);
      },
    },
    {
      name: 'merge-train-position',
      description: 'Set or clear manual merge-train position for feature.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(
          prefix,
          mergeQueuedFeatureIds.flatMap((featureId) => [
            {
              value: `--feature ${featureId} --position 1`,
              label: `${featureId} set`,
              description: 'Set manual queue position',
            },
            {
              value: `--feature ${featureId}`,
              label: `${featureId} clear`,
              description: 'Clear manual queue position',
            },
          ]),
        );
      },
    },
    {
      name: 'inbox-reply',
      description: 'Answer inbox help request by inbox item id.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--id "" --text ""',
            label: 'id + text',
            description: 'Inbox item id and reply text',
          },
        ]);
      },
    },
    {
      name: 'inbox-approve',
      description: 'Approve inbox approval request by inbox item id.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--id ""',
            label: 'id',
            description: 'Inbox item id',
          },
        ]);
      },
    },
    {
      name: 'inbox-reject',
      description: 'Reject inbox approval request by inbox item id.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(prefix, [
          {
            value: '--id "" --comment ""',
            label: 'id + comment',
            description: 'Inbox item id and optional comment',
          },
        ]);
      },
    },
    {
      name: 'config-set',
      description: 'Persist and live-apply one config field update.',
      getArgumentCompletions: (prefix) => {
        return filterSuggestions(
          prefix,
          CONFIG_SET_TEMPLATES.map((entry) => ({
            value: `--key ${entry.key} --value "${entry.value}"`,
            label: entry.key,
            description: entry.description,
          })),
        );
      },
    },
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
