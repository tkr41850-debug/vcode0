import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { expect, Key, test } from '@microsoft/tui-test';

const tuiReadyTimeoutMs = 60_000;
const initializeProjectCommand =
  '/init --milestone-name "Milestone 1" --milestone-description "Initial milestone" --feature-name "Project startup" --feature-description "Plan initial project work"';
const execFileAsync = promisify(execFile);
const workspaces: string[] = [];

test.afterEach(async ({ terminal }) => {
  terminal.kill();
  await Promise.all(
    workspaces.splice(0).map((workspace) => {
      return fs.rm(workspace, { recursive: true, force: true });
    }),
  );
});

test('starts with composer focus and runs help from composer', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  await expect(terminal.getByText('[command] [composer]')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('gvc0 startup')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(
    terminal.getByText(
      'Run /init to create first milestone and planning feature.',
    ),
  ).toBeVisible({ timeout: tuiReadyTimeoutMs });

  terminal.submit('/help');
  await expect(terminal.getByText('Help [h/q/esc hide]')).toBeVisible();
  await expect(terminal.getByText('Show or hide keyboard help.')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Help [h/q/esc hide]')).not.toBeVisible();
});

test('opens monitor overlay from composer command', async ({ terminal }) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.submit('/monitor');
  await expect(terminal.getByText('Agent Monitor')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Agent Monitor')).not.toBeVisible();
});

test('opens inbox overlay from composer command and graph keybind', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.submit('/inbox');
  await expect(terminal.getByText('Inbox [0 pending]')).toBeVisible();
  await expect(terminal.getByText('No pending inbox items.')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Inbox [0 pending]')).not.toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('focus: graph')).toBeVisible();

  terminal.write('i');
  await expect(terminal.getByText('Inbox [0 pending]')).toBeVisible();
});

test('opens merge-train overlay from composer command and graph keybind', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.submit('/merge-train');
  await expect(
    terminal.getByText('Merge Train [0 active, 0 queued]'),
  ).toBeVisible();
  await expect(
    terminal.getByText('No integrating or queued features.'),
  ).toBeVisible();

  terminal.keyEscape();
  await expect(
    terminal.getByText('Merge Train [0 active, 0 queued]'),
  ).not.toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('focus: graph')).toBeVisible();

  terminal.write('t');
  await expect(
    terminal.getByText('Merge Train [0 active, 0 queued]'),
  ).toBeVisible();
});

test('opens config overlay from composer command and graph keybind', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.submit('/config');
  await expect(terminal.getByText('Config [c/q/esc hide]')).toBeVisible();
  await expect(terminal.getByText('workerCap = 4')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Config [c/q/esc hide]')).not.toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('focus: graph')).toBeVisible();

  terminal.write('c');
  await expect(terminal.getByText('Config [c/q/esc hide]')).toBeVisible();
});

test('initializes starter milestone and planning feature from empty workspace', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.submit(initializeProjectCommand);

  await expect(terminal.getByText('m-1: Milestone 1')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('f-1: Project startup')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('queue: 1')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('work: planning')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
});

test('autocompletes slash commands in composer', async ({ terminal }) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.write('/task-r');
  terminal.keyPress(Key.Tab);

  // Autocomplete dropdown shows the command name without a leading slash.
  await expect(
    terminal.getByText('task-remove', { strict: false }),
  ).toBeVisible();
});

test('creates planner draft and reaches approval-ready state', async ({
  terminal,
}) => {
  const workspace = await createWorkspace({ withPlanningFeature: true });

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);
  await expect(terminal.getByText('f-1: Planner feature')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });

  terminal.keyEscape();
  await expect(terminal.getByText('focus: graph')).toBeVisible();

  terminal.keyDown();
  await expect(
    terminal.getByText('selected: f-1: Planner feature'),
  ).toBeVisible();

  terminal.keyPress('/');
  await expect(terminal.getByText('focus: composer')).toBeVisible();

  terminal.submit('task-add --description "Draft task" --weight small');
  await expect(terminal.getByText('gvc0 progress [draft]')).toBeVisible();
  await expect(terminal.getByText('t-1: Draft task')).toBeVisible();
  await expect(terminal.getByText('view: draft')).toBeVisible();

  terminal.submit('/submit');
  await expect(
    terminal.getByText(
      '[approval] [composer] approval plan f-1 /approve /reject /rerun',
    ),
  ).toBeVisible();
});

test('golden path tui e2e smoke: init, steer, draft, submit, and quit', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  await expect(terminal.getByText('[command] [composer]')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('gvc0 startup')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(
    terminal.getByText(
      'Run /init to create first milestone and planning feature.',
    ),
  ).toBeVisible({ timeout: tuiReadyTimeoutMs });

  terminal.submit(initializeProjectCommand);

  await expect(terminal.getByText('m-1: Milestone 1')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('f-1: Project startup')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('queue: 1')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('work: planning')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });

  terminal.submit('/help');
  await expect(terminal.getByText('Help [h/q/esc hide]')).toBeVisible();
  await expect(terminal.getByText('Show or hide keyboard help.')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Help [h/q/esc hide]')).not.toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('focus: graph')).toBeVisible();

  terminal.keyDown();
  terminal.keyDown();
  await expect(
    terminal.getByText('selected: f-1: Project startup'),
  ).toBeVisible();

  terminal.keyPress('/');
  await expect(terminal.getByText('focus: composer')).toBeVisible();

  terminal.submit(
    'task-add --feature f-1 --description "Golden path task" --weight small',
  );
  await expect(terminal.getByText('gvc0 progress [draft]')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('t-1: Golden path task')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('view: draft')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });

  terminal.submit('/submit');
  await expect(
    terminal.getByText(
      '[approval] [composer] approval plan f-1 /approve /reject /rerun',
    ),
  ).toBeVisible({ timeout: tuiReadyTimeoutMs });

  terminal.submit('/quit');
});

const MINIMAL_CONFIG = JSON.stringify(
  {
    models: {
      topPlanner: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      featurePlanner: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      taskWorker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      verifier: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    },
  },
  null,
  2,
);

async function createWorkspace(
  options: { withPlanningFeature?: boolean } = {},
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gvc0-tui-'));
  workspaces.push(workspace);
  await fs.mkdir(path.join(workspace, '.gvc0'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'gvc0.config.json'),
    `${MINIMAL_CONFIG}\n`,
    'utf-8',
  );

  if (options.withPlanningFeature === true) {
    const seedScript = path.join(workspace, '.gvc0', 'seed.mts');
    const repoRoot = path.resolve(
      new URL(import.meta.url).pathname,
      '../../../../../..',
    );
    await fs.writeFile(
      seedScript,
      [
        "import * as path from 'node:path';",
        `import { openDatabase } from ${JSON.stringify(path.join(repoRoot, 'src/persistence/db.ts'))};`,
        `import { PersistentFeatureGraph } from ${JSON.stringify(path.join(repoRoot, 'src/persistence/feature-graph.ts'))};`,
        `import { initializeProjectGraph } from ${JSON.stringify(path.join(repoRoot, 'src/compose.ts'))};`,
        `const db = openDatabase(path.join(${JSON.stringify(workspace)}, '.gvc0', 'state.db'));`,
        'try {',
        '  const graph = new PersistentFeatureGraph(db);',
        '  initializeProjectGraph(graph, {',
        "    milestoneName: 'Milestone 1',",
        "    milestoneDescription: 'desc',",
        "    featureName: 'Planner feature',",
        "    featureDescription: 'desc',",
        '  });',
        '} finally {',
        '  db.close();',
        '}',
      ].join('\n'),
      'utf-8',
    );
    await execFileAsync('npx', ['tsx', seedScript], {
      cwd: repoRoot,
    });
  }

  return workspace;
}

function startTui(
  terminal: { submit(data?: string): void },
  workspace: string,
): void {
  terminal.submit(`npm run tui -- --cwd ${shellQuote(workspace)}`);
}

type TuiTerminal = Parameters<Parameters<typeof test>[1]>[0]['terminal'];

async function waitForTuiReady(
  terminal: Pick<TuiTerminal, 'getByText'>,
): Promise<void> {
  await expect(terminal.getByText('gvc0 progress')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
