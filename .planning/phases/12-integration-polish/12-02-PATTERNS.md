# Phase 12: Integration Polish - Plan 12-02 Pattern Map

**Mapped:** 2026-05-02
**Files analyzed:** 3 likely new/modified files
**Analogs found:** 3 / 3

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `test/integration/tui/smoke.test.ts` | test | request-response / event-driven PTY | `test/integration/tui/smoke.test.ts` | exact |
| `test/integration/tui/golden-path.test.ts` (optional alternative to extending smoke) | test | request-response / event-driven PTY | `test/integration/tui/smoke.test.ts` | exact |
| `tui-test.config.ts` | config | batch test-runner config | `tui-test.config.ts` | exact |
| `package.json` | config | command script | `package.json` | exact |

## Scope Derived From Context

12-02 should cover only the TUI E2E smoke lane using `@microsoft/tui-test`. The implementation should not add README/source-install dry-run work or final traceability tables; those remain 12-03.

Likely implementation shape:

1. Prefer extending `test/integration/tui/smoke.test.ts` with a grep-friendly test name containing `golden path` and `tui e2e smoke`.
2. If the existing file becomes too broad, create `test/integration/tui/golden-path.test.ts` and copy the existing helpers from `smoke.test.ts`.
3. Stabilize/isolate the lane in `tui-test.config.ts` only if needed.
4. Keep `package.json` script shape as-is unless a runner-level fix requires a script tweak.
5. Do not modify `src/main.ts` or `src/tui/**` just to make tests easier unless the golden-path smoke exposes a real user-visible bug.

## Pattern Assignments

### `test/integration/tui/smoke.test.ts` (test, PTY event-driven request-response)

**Analog:** `test/integration/tui/smoke.test.ts`

This is the primary file to copy patterns from. It already contains the lane imports, workspace isolation, real TUI launch, keypress helpers, visible-text assertions, fixture seeding, and teardown.

**Imports pattern** (lines 1-8):

```typescript
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { expect, Key, test } from '@microsoft/tui-test';
```

Copy this exact import style for any new TUI E2E file. This lane does not use Vitest imports.

**Timeout and shared command pattern** (lines 9-13):

```typescript
const tuiReadyTimeoutMs = 30_000;
const initializeProjectCommand =
  '/init --milestone-name "Milestone 1" --milestone-description "Initial milestone" --feature-name "Project startup" --feature-description "Plan initial project work"';
const execFileAsync = promisify(execFile);
const workspaces: string[] = [];
```

Use a single lane timeout constant for startup/slow first render. Put long slash commands in constants so the test body reads like an operator flow.

**Setup/teardown pattern** (lines 15-22):

```typescript
test.afterEach(async ({ terminal }) => {
  terminal.kill();
  await Promise.all(
    workspaces.splice(0).map((workspace) => {
      return fs.rm(workspace, { recursive: true, force: true });
    }),
  );
});
```

Always kill the PTY and remove all tmp workspaces after each test. Do not reuse workspaces across TUI E2E cases; the app writes `.gvc0/state.db`, config, sessions, and worktrees under the workspace.

**Launch + readiness pattern** (lines 27-35, 256-271):

```typescript
const workspace = await createWorkspace();

startTui(terminal, workspace);
await waitForTuiReady(terminal);

await expect(terminal.getByText('[command] [composer]')).toBeVisible({
  timeout: tuiReadyTimeoutMs,
});
await expect(terminal.getByText('gvc0 startup')).toBeVisible({
  timeout: tuiReadyTimeoutMs,
});
```

```typescript
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
```

The golden-path smoke should launch the real `src/main.ts` through `npm run tui -- --cwd <tmp>`, then wait for durable UI text (`gvc0 progress`) rather than sleeping or asserting cursor positions.

**Shell quoting pattern** (lines 273-275):

```typescript
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

Use this when passing tmp paths into the shell command submitted to the PTY.

**Empty-workspace startup assertions** (lines 32-42):

```typescript
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
```

These are durable golden-path startup strings: composer focus, startup notice, and empty-state operator guidance.

**Slash command + overlay assertion pattern** (lines 44-49):

```typescript
terminal.submit('/help');
await expect(terminal.getByText('Help [h/q/esc hide]')).toBeVisible();
await expect(terminal.getByText('Show or hide keyboard help.')).toBeVisible();

terminal.keyEscape();
await expect(terminal.getByText('Help [h/q/esc hide]')).not.toBeVisible();
```

Use `terminal.submit('/command')` for composer commands. Assert durable visible text from overlay title/body, then close with `terminal.keyEscape()` and assert disappearance.

**Graph-focus keybind pattern** (lines 77-85):

```typescript
terminal.keyEscape();
await expect(terminal.getByText('Inbox [0 pending]')).not.toBeVisible();

terminal.keyEscape();
await expect(terminal.getByText('focus: graph')).toBeVisible();

terminal.write('i');
await expect(terminal.getByText('Inbox [0 pending]')).toBeVisible();
```

Important focus rule: press `esc` once to hide an overlay, then press `esc` again from an empty composer to switch to graph focus. Single-key hotkeys such as `i`, `t`, `c`, `h`, `m`, `q` only work in graph focus.

**Initialize golden-path graph pattern** (lines 139-160):

```typescript
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
```

This is the best exact pattern for the 12-02 surface-level golden path. Extend this flow with visible operator steering surfaces and clean quit.

**Autocomplete/key press pattern** (lines 163-175):

```typescript
terminal.write('/task-r');
terminal.keyPress(Key.Tab);

await expect(
  terminal.getByText('/task-remove', { strict: false }),
).toBeVisible();
```

Use `Key.Tab` for autocomplete assertions. Use `{ strict: false }` when asserting partial command text rendered inside the composer/autocomplete UI.

**Draft approval state pattern** (lines 177-210):

```typescript
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
```

This is the strongest analog for a golden-path smoke that proves command entry, graph selection, draft mutation, submit, and approval-ready state without running live agents.

**Fixture seeding pattern** (lines 212-254):

```typescript
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
```

Use this for deterministic local setup instead of driving every setup step through the PTY. It avoids live LLM calls and keeps TUI E2E focused on user-visible shell behavior.

**Clean quit pattern to add for 12-02**:

The existing file already documents quit behavior in docs but does not show a dedicated excerpt. Copy the focus/keybind approach above and use `q` only in graph focus with no overlay open:

```typescript
terminal.keyEscape();
await expect(terminal.getByText('focus: graph')).toBeVisible();
terminal.write('q');
```

If using the composer command path instead, submit `/quit` from composer and assert the terminal process exits only if `@microsoft/tui-test` exposes a stable process-exit assertion. Otherwise keep quit as a final smoke action and rely on `afterEach` kill for teardown.

---

### `test/integration/tui/golden-path.test.ts` (optional new test, PTY event-driven request-response)

**Analog:** `test/integration/tui/smoke.test.ts`

Create this only if planner decides not to keep all smoke tests in `smoke.test.ts`. Copy these exact patterns:

- imports from `smoke.test.ts` lines 1-8
- `tuiReadyTimeoutMs`, `execFileAsync`, `workspaces` from lines 9-13
- `test.afterEach` from lines 15-22
- `createWorkspace`, `startTui`, `waitForTuiReady`, and `shellQuote` from lines 212-275

Recommended test name:

```typescript
test('golden path tui e2e smoke: init, steer, draft, submit, and quit', async ({ terminal }) => {
  // copy launch + visible assertion patterns from smoke.test.ts
});
```

Recommended surface-level sequence:

1. `createWorkspace()`
2. `startTui(terminal, workspace)`
3. `await waitForTuiReady(terminal)`
4. assert `[command] [composer]`, `gvc0 startup`, empty-state init guidance
5. `terminal.submit(initializeProjectCommand)`
6. assert `m-1: Milestone 1`, `f-1: Project startup`, `queue: 1`, `work: planning`
7. open `/help`, assert `Help [h/q/esc hide]` and `Show or hide keyboard help.`
8. close overlay with `terminal.keyEscape()`
9. switch to graph focus with `terminal.keyEscape()`, assert `focus: graph`
10. use one graph hotkey such as `terminal.write('c')`, assert `Config [c/q/esc hide]`, close it
11. return to composer with `terminal.keyPress('/')`, assert `focus: composer`
12. submit `task-add --description "Golden path task" --weight small` if selected feature context is stable, otherwise use the seeded `withPlanningFeature` fixture pattern
13. assert `gvc0 progress [draft]`, `t-1: Golden path task`, `view: draft`
14. submit `/submit`, assert `[approval] [composer] approval plan f-1 /approve /reject /rerun`
15. clean quit with graph `q` or `/quit` if runner supports stable exit assertion

Pitfall: after `/init`, the app sets selected node to the created feature. That makes a subsequent `task-add --description ... --weight small` feasible without `--feature`, matching the existing draft test lines 196-200.

---

### `tui-test.config.ts` (config, batch test-runner config)

**Analog:** `tui-test.config.ts`

**Runner config pattern** (lines 1-21):

```typescript
import { defineConfig, Shell } from '@microsoft/tui-test';

export default defineConfig({
  reporter: 'list',
  testMatch: 'test/integration/tui/**/*.test.ts',
  timeout: 60_000,
  expect: {
    timeout: 30_000,
  },
  shellReadyTimeout: 30_000,
  workers: 1,
  trace: false,
  use: {
    shell: Shell.Bash,
    rows: 30,
    columns: 100,
    env: {
      TERM: 'xterm-256color',
    },
  },
});
```

Keep these stabilization choices unless the current `SIGSEGV` history is still reproducible:

- `workers: 1` isolates the pre-1.0 runner from parallel PTY pressure.
- `Shell.Bash` matters because tests submit `npm run tui -- --cwd '<path>'` strings.
- fixed `rows: 30`, `columns: 100` reduces layout variance.
- `expect.timeout` and `shellReadyTimeout` align with `tuiReadyTimeoutMs = 30_000` in tests.
- `testMatch` already picks up either `smoke.test.ts` or a new `golden-path.test.ts` under `test/integration/tui/`.

Only modify this file if a narrow runner stabilization is required. Do not broaden the lane into default Vitest.

---

### `package.json` (config, command script)

**Analog:** `package.json`

**Script pattern** (lines 19-27):

```json
"test": "vitest run",
"test:watch": "vitest",
"test:unit": "vitest run test/unit",
"test:unit:watch": "vitest test/unit",
"test:integration": "vitest run test/integration",
"test:integration:watch": "vitest test/integration",
"test:tui:e2e": "command npx tui-test",
"tui": "tsx src/main.ts",
"typecheck": "tsc --noEmit"
```

Use `npm run test:tui:e2e` or `npx tui-test` for this plan. `npm run test` intentionally does not run `test/integration/tui/**`.

**Dependency pattern** (lines 30-41):

```json
"devDependencies": {
  "@biomejs/biome": "^2.4.10",
  "@microsoft/tui-test": "^0.0.4",
  "@types/better-sqlite3": "^7.6.13",
  "@types/node": "^25.5.2",
  "eslint": "^10.2.0",
  "json-schema-traverse": "^0.4.1",
  "tsx": "^4.21.0",
  "typescript": "^5.9.3",
  "typescript-eslint": "^8.58.1",
  "vite": "^8.0.8",
  "vitest": "^4.1.4"
}
```

Do not add another TUI E2E runner. `@microsoft/tui-test` is already present and is the explicit success criterion.

---

## Source Patterns That Tests Should Assert Against

### CLI startup and `--cwd` behavior

**Source:** `src/main.ts`

**Startup sequence** (lines 30-41):

```typescript
applyWorkingDirectory(argv);
const explainTarget = parseExplainTarget(argv);
if (explainTarget !== undefined) {
  process.stdout.write(`${await explainFactory(explainTarget)}\n`);
  return;
}

writeStartupNotice();
app = await appFactory();
const mode = parseAppMode(argv);
await app.start(mode);
```

**Working directory option** (lines 57-70):

```typescript
function applyWorkingDirectory(argv: readonly string[]): void {
  const cwd = resolveWorkingDirectory(argv);
  if (cwd !== undefined) {
    process.chdir(cwd);
  }
}

function resolveWorkingDirectory(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--cwd');
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}
```

**Startup notice** (lines 72-74):

```typescript
function writeStartupNotice(): void {
  process.stdout.write('loading...\n');
}
```

Tests should keep launching through `npm run tui -- --cwd <workspace>` so the app writes state under the temp workspace. Prefer asserting TUI-rendered `gvc0 progress` over raw `loading...`, because the raw notice may scroll away after the TUI starts.

### TUI focus and render model

**Source:** `src/tui/app.ts`

**Interactive TTY guard and startup focus** (lines 209-230):

```typescript
show(): Promise<void> {
  if (this.started) {
    this.refresh();
    return Promise.resolve();
  }

  if (!this.interactiveTerminal) {
    throw new Error('gvc0 TUI requires an interactive TTY on stdin/stdout');
  }

  this.tui.addChild(this.dagView);
  this.tui.addChild(this.statusBar);
  this.tui.addChild(this.composerStatus);
  this.tui.addChild(this.composer);
  this.tui.addInputListener((data) => {
    return this.handleInput(data) ? { consume: true } : undefined;
  });
  this.tui.start();
  this.tui.setFocus(this.composer);
  this.started = true;
  this.refresh();
  return Promise.resolve();
}
```

This is why PTY E2E is needed: non-TTY Vitest cannot exercise `show()` without hitting the interactive terminal guard.

**Durable title/status strings** (lines 262-280):

```typescript
this.dagView.setModel(
  nodes,
  this.selectedNodeId,
  draftState !== undefined ? 'gvc0 progress [draft]' : 'gvc0 progress',
  nodes.length === 0 ? this.viewModels.buildEmptyState() : undefined,
);
this.statusBar.setModel(
  this.viewModels.buildStatusBar({
    tasks: snapshot.tasks,
    workerCounts: this.deps.getWorkerCounts(),
    autoExecutionEnabled: this.deps.isAutoExecutionEnabled(),
    keybindHints: [...NAVIGATION_KEYBINDS, ...this.commands.getAll()],
    ...(selectedNode !== undefined
      ? { selectedLabel: selectedNode.label }
      : {}),
    ...(this.notice !== undefined ? { notice: this.notice } : {}),
    dataMode: draftState !== undefined ? 'draft' : 'live',
    focusMode: this.focusMode,
```

Assert `gvc0 progress`, `gvc0 progress [draft]`, `view: draft`, `focus: composer`, and `focus: graph` instead of exact screen coordinates.

**Autocomplete provider** (lines 406-413):

```typescript
this.composer.setAutocompleteProvider(
  new CombinedAutocompleteProvider(
    buildComposerSlashCommands({
      snapshot,
      selection: this.currentSelection(),
    }),
  ),
);
```

Autocomplete is tied to current graph selection. If a completion test becomes flaky, assert broader command text with `{ strict: false }` as in the existing smoke test.

### Composer slash command execution

**Source:** `src/tui/app-composer.ts`

**Submit branch** (lines 34-53):

```typescript
const trimmed = params.text.trim();
if (trimmed.length === 0) {
  params.setNotice(undefined);
  params.refresh();
  return;
}

try {
  const message = trimmed.startsWith('/')
    ? await params.executeSlashCommand(trimmed)
    : (params.requestTopPlannerSessionSelection?.({
        kind: 'submit',
        prompt: trimmed,
      }) ?? params.requestTopLevelPlan(trimmed));
  params.addToHistory(trimmed);
  params.setNotice(message);
} catch (error) {
  params.setNotice(formatUnknownError(error));
}
params.refresh();
```

In tests, submit slash commands with a leading `/` when using composer. The existing draft test intentionally enters `task-add ...` without a leading slash after focusing composer with `/`; the composer text already contains the seeded slash from graph focus.

**Operational commands** (lines 70-105):

```typescript
switch (parsed.name) {
  case 'auto':
    params.commandContext.toggleAutoExecution();
    return params.notice ?? 'toggled auto execution';
  case 'queue':
    params.commandContext.toggleMilestoneQueue();
    return params.notice ?? 'toggled milestone queue';
  case 'monitor':
    params.commandContext.toggleAgentMonitor();
    return params.notice ?? 'toggled monitor';
  case 'worker-next':
    params.commandContext.selectNextWorker();
    return params.notice ?? 'selected next worker';
  case 'help':
    params.commandContext.toggleHelp();
    return params.notice ?? 'toggled help';
  case 'inbox':
    params.commandContext.toggleInbox();
    return params.notice ?? 'toggled inbox';
  case 'planner-audit':
    params.commandContext.togglePlannerAudit();
    return params.notice ?? 'toggled planner audit';
  case 'proposal-review':
    params.commandContext.toggleProposalReview();
    return params.notice ?? 'toggled proposal review';
  case 'merge-train':
    params.commandContext.toggleMergeTrain();
    return params.notice ?? 'toggled merge train';
  case 'transcript':
    params.commandContext.toggleTranscript();
    return params.notice ?? 'toggled transcript';
  case 'config':
    params.commandContext.toggleConfig();
    return params.notice ?? 'toggled config';
  case 'deps':
    params.commandContext.toggleDependencyDetail();
```

Use these command names for visible steering smoke coverage: `/help`, `/monitor`, `/inbox`, `/merge-train`, `/config`, `/deps`.

**Init command** (lines 152-160):

```typescript
case 'quit':
  params.commandContext.requestQuit();
  return 'quitting';
case 'init': {
  const created = params.dataSource.initializeProject(
    parseInitializeProjectCommand(parsed),
  );
  params.setSelectedNodeId(created.featureId);
  return `Initialized ${created.milestoneId} and ${created.featureId}.`;
}
```

After `/init`, selected node becomes the feature. This supports immediately adding a task draft in the golden path.

### Graph-focus key handling

**Source:** `src/tui/app-navigation.ts`

**Esc and overlay behavior** (lines 103-119):

```typescript
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
```

Use `esc` to close overlays first. Only after overlays are closed does `esc` toggle focus.

**Graph input branch** (lines 124-147):

```typescript
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
```

Pitfall: if a test writes `i`, `t`, `c`, `h`, or `q` while composer focus is active, it will type text instead of executing a hotkey. Assert `focus: graph` before graph hotkeys.

### Overlay text to assert

**Source:** `src/tui/components/index.ts`

Prefer these durable overlay titles/body strings:

**Help overlay** (lines 141-151):

```typescript
return drawBox(
  ` ${this.title} [h/q/esc hide] `,
  body.length === 0 ? ['No keybinds available.'] : body,
  safeWidth,
);
```

Existing tests assert `Help [h/q/esc hide]` and `Show or hide keyboard help.`.

**Agent monitor overlay** (lines 301-305):

```typescript
return drawBox(
  ` Agent Monitor [${logs.length} active] [m/q/esc hide] `,
  rows,
  safeWidth,
);
```

Assert `Agent Monitor`, not a specific active count unless the fixture controls worker logs.

**Inbox overlay** (lines 379-392):

```typescript
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
```

For empty local workspaces, assert `Inbox [0 pending]` and `No pending inbox items.`.

**Merge-train overlay** (lines 467-480):

```typescript
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
```

For empty local workspaces, assert `Merge Train [0 active, 0 queued]` and `No integrating or queued features.`.

**Config overlay** (lines 495-507):

```typescript
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
```

Existing tests assert `Config [c/q/esc hide]` and `workerCap = 4`.

**Composer status** (lines 323-337):

```typescript
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
```

Assert status substrings like `[command] [composer]` or `[approval] [composer] approval plan f-1 /approve /reject /rerun`.

## Shared Patterns

### Test lane separation

**Source:** `docs/operations/testing.md`

**Lane docs** (lines 160-179):

```markdown
## Terminal E2E lane

Run PTY-driven TUI coverage with:

```bash
npm run test:tui:e2e
```

Or directly with:

```bash
npx tui-test
```

Lane split:

- `npm run test` / `vitest run` — Vitest only; excludes `test/integration/tui/**`
- `npm run test:tui:e2e` / `npx tui-test` — `@microsoft/tui-test` only; runs `test/integration/tui/**`

This lane is separate from Vitest. It uses `@microsoft/tui-test` to launch the real `src/main.ts` entrypoint inside a pseudo-terminal, then sends keypresses and asserts visible terminal text. Keep it focused on user-visible shell behavior; pure rendering and state-mapping assertions should stay in Vitest unit tests. CLI/bootstrap checks like `parseAppMode()` and startup error handling stay in Vitest, while live keyboard flows like help, monitor, and quit belong in the TUI lane.
```

Apply to all 12-02 implementation decisions. Do not try to make Vitest run `test/integration/tui/**`.

### TUI entrypoints and command surface

**Source:** `docs/reference/tui.md`

**Entrypoints** (lines 64-82):

```markdown
## Entry Points

```bash
gvc0
gvc0 --auto
gvc0 --cwd <path>
gvc0 explain feature <id>
gvc0 explain task <id>
gvc0 explain run <id>
```

- `gvc0` starts interactive mode
- `gvc0 --auto` starts with auto-execution enabled
- `--cwd <path>` changes working directory before explain resolution or composition/startup
- `gvc0 explain feature <id>` renders feature DAG/status context from `.gvc0/state.db`
- `gvc0 explain task <id>` renders task/run/context details from `.gvc0/state.db`
- `gvc0 explain run <id>` renders persisted run facts and recorded activity from `.gvc0/state.db`

The `explain` entrypoints are read-only diagnostic branches that run before TUI startup, scheduler startup, and runtime worker composition.
```

For 12-02, use the interactive `gvc0 --cwd <path>` equivalent via `npm run tui -- --cwd <path>`. Do not test `explain`; that belongs to CLI/bootstrap diagnostics, not the TUI golden path.

**Focus and keyboard docs** (lines 100-143):

```markdown
Focus changes:

- startup begins in composer focus
- `esc` hides top overlay first
- `esc` from empty composer switches to graph focus
- `esc` from graph focus switches back to composer focus
- `/` from graph focus switches to composer focus and seeds input with `/`

Most single-key commands only work in graph focus. While composer is focused, regular keypresses go to text entry instead.
```

```markdown
| `↑` / `↓` | Move DAG selection. |
| `space` | Start or pause auto-execution. |
| `g` | Queue or dequeue selected node's milestone. |
| `m` | Show or hide agent monitor overlay. |
| `w` | Cycle active worker selection in agent monitor. |
| `h` | Show or hide keyboard help. |
| `i` | Show or hide inbox overlay. |
| `t` | Show or hide merge-train overlay. |
| `r` | Show or hide task transcript overlay. |
| `c` | Show or hide config overlay. |
| `d` | Show dependency detail for selected feature. Task selection resolves to its feature. |
| `x` | Cancel selected feature and abort its running task work. Task selection resolves to its feature. |
| `q` | Quit TUI when no overlay is open. |
```

These docs match `app-navigation.ts` and should drive the test sequence.

**Slash commands for smoke flow** (lines 161-177, 184-200, 230):

```markdown
- `/auto` — toggle auto execution
- `/queue` — queue or dequeue selected node's milestone
- `/monitor` — show or hide agent monitor overlay
- `/worker-next` — cycle active worker selection
- `/help` — show or hide keyboard help
- `/inbox` — show or hide inbox overlay
- `/planner-audit` — show or hide planner audit overlay
- `/proposal-review` — show or hide proposal review overlay
- `/merge-train` — show or hide merge-train overlay
- `/transcript` — show or hide task transcript overlay
- `/config` — show or hide config overlay
- `/deps` — show dependency detail for selected feature
- `/cancel` — cancel selected feature and abort any running task work for it
- `/quit` — quit TUI
```

```markdown
- `/init --milestone-name "" --milestone-description "" --feature-name "" --feature-description ""`
- `/milestone-add --name "" --description ""`
- `/feature-add`
- `/feature-remove`
- `/feature-edit`
- `/feature-move`
- `/feature-split`
- `/feature-merge`
- `/task-add`
- `/task-remove`
- `/task-edit`
- `/task-reorder`
- `/dep-add`
- `/dep-remove`
- `/submit`
- `/discard`
- `/planner-continue`
- `/planner-fresh`
```

```markdown
`/submit` stores pending proposal for approval. `/discard` drops current draft. Both restore previous auto-execution setting.
```

### Assertion style

**Source:** `docs/operations/testing.md`

**TUI assertion principle** (lines 179):

```markdown
Keep it focused on user-visible shell behavior; pure rendering and state-mapping assertions should stay in Vitest unit tests.
```

**General assertion style** (lines 105-132):

```markdown
Use inline `assert(...)` from `node:assert/strict` when test code needs type narrowing before later assertions or setup steps.
...
Rule:

- use `assert(...)` for local preconditions and type narrowing
- use `expect(...)` for behavioral checks, rich diffs, and payload matching after value is narrowed
- include explicit failure messages on asserts so fixture/setup failures stay readable
```

For `@microsoft/tui-test`, visible behavior assertions use its `expect`. If helper setup needs narrowing, use Node `assert` with explicit messages.

## Pitfalls and Stabilization Notes

1. **Known `@microsoft/tui-test` SIGSEGV history.** Project state records a pre-existing workerpool `SIGSEGV` crash across the smoke lane. Keep 12-02 smoke-level and isolated; do not grow it into a large brittle suite. If still reproducible, plan a narrow stabilization task around `tui-test.config.ts` before adding assertions.

2. **Do not run TUI E2E under Vitest.** `npm run test` excludes `test/integration/tui/**`; use `npm run test:tui:e2e` or `npx tui-test`.

3. **Avoid live LLM calls.** Use local workspace setup and command/draft paths. If full autonomous execution through the TUI is slow or unstable, cite 12-01 for backend lifecycle proof and keep 12-02 to operator-visible golden path.

4. **Do not assert cursor coordinates or exact box geometry.** Assert durable visible text: `gvc0 progress`, `m-1: ...`, `f-1: ...`, `Help [h/q/esc hide]`, `Config [c/q/esc hide]`, `focus: graph`, `view: draft`, approval status text.

5. **Respect focus mode.** Single-key hotkeys only work in graph focus. Use `terminal.keyEscape()` and assert `focus: graph` before writing hotkeys.

6. **Close overlays before switching focus or quitting.** `esc` hides top overlay first. `q` hides overlay if one is open; it quits only when no overlay is open and graph key handling receives it.

7. **Use temp workspaces and `--cwd`.** The app writes `.gvc0/state.db`, config, sessions, and worktrees under the project cwd. Never point smoke tests at the repo root state.

8. **Teardown must kill PTY.** Keep `terminal.kill()` in `afterEach` even when the test attempts `/quit` or graph `q`, so failures do not leave processes running.

9. **Use 30s readiness timeouts for first render.** Existing tests use `tuiReadyTimeoutMs = 30_000` and runner `expect.timeout = 30_000`.

10. **If adding a new test file, duplicate helpers carefully.** `tui-test` files are not Vitest modules; avoid cross-file helper imports unless confirmed stable under the runner's transform behavior.

## No Analog Found

No target file lacks an analog. The repo already has exact TUI E2E, runner config, command script, TUI command/composer/overlay, and CLI entrypoint patterns.

## Metadata

**Analog search scope:** `/home/alpine/vcode0/test/integration/tui/**`, `/home/alpine/vcode0/src/main.ts`, `/home/alpine/vcode0/src/tui/**`, `/home/alpine/vcode0/tui-test.config.ts`, `/home/alpine/vcode0/package.json`, `/home/alpine/vcode0/docs/operations/testing.md`, `/home/alpine/vcode0/docs/reference/tui.md`, `/home/alpine/vcode0/.planning/**`

**Files scanned:** 32 integration-test files counted; TUI source file list scanned; key analog files read: 12

**Pattern extraction date:** 2026-05-02
