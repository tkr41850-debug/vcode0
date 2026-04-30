import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { expect, Key, test } from '@microsoft/tui-test';
import { INITIALIZE_PROJECT_EXAMPLE_COMMAND } from '@tui/commands/index';

const tuiReadyTimeoutMs = 30_000;
const initializeProjectCommand = `/init ${INITIALIZE_PROJECT_EXAMPLE_COMMAND}`;
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

test('esc toggles composer/graph focus and preserves typed text', async ({
  terminal,
}) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  await expect(terminal.getByText('focus: composer')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });

  terminal.write('/he');

  terminal.keyEscape();
  await expect(terminal.getByText('focus: graph')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('focus: composer')).toBeVisible();

  terminal.submit('lp');
  await expect(terminal.getByText('Help [h/q/esc hide]')).toBeVisible();
});

test('autocompletes slash commands in composer', async ({ terminal }) => {
  const workspace = await createWorkspace();

  startTui(terminal, workspace);
  await waitForTuiReady(terminal);

  terminal.write('/task-r');
  terminal.keyPress(Key.Tab);

  await expect(
    terminal.getByText('/task-remove', { strict: false }),
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

async function createWorkspace(
  options: { withPlanningFeature?: boolean } = {},
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gvc0-tui-'));
  workspaces.push(workspace);
  await fs.mkdir(path.join(workspace, '.gvc0'), { recursive: true });

  if (options.withPlanningFeature === true) {
    await execFileAsync(
      'npx',
      [
        'tsx',
        '--eval',
        [
          "import * as path from 'node:path';",
          "import { openDatabase } from './src/persistence/db.ts';",
          "import { PersistentFeatureGraph } from './src/persistence/feature-graph.ts';",
          "import { initializeProjectGraph } from './src/compose.ts';",
          'const workspace = process.env.GVC0_TUI_WORKSPACE;',
          "if (workspace === undefined) throw new Error('missing GVC0_TUI_WORKSPACE');",
          "const db = openDatabase(path.join(workspace, '.gvc0', 'state.db'));",
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
        ].join(' '),
      ],
      {
        cwd: '/home/alpine/vcode0',
        env: { ...process.env, GVC0_TUI_WORKSPACE: workspace },
      },
    );
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
