# Phase 12: Integration & Polish - Pattern Map

**Mapped:** 2026-05-02
**Files analyzed:** 4 likely new/modified files
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `test/integration/prompt-to-main-e2e.test.ts` | test | event-driven request-response + file-I/O | `test/integration/feature-lifecycle-e2e.test.ts` + `test/integration/merge-train.test.ts` | exact composite |
| `test/integration/verify-flake-audit.test.ts` | test | batch request-response + file-I/O | `test/integration/feature-phase-agent-flow.test.ts` | exact |
| `test/helpers/feature-lifecycle-fixture.ts` | test utility | event-driven + file-I/O | `test/helpers/feature-lifecycle-fixture.ts` | exact self-extension |
| `package.json` | config | batch | `package.json` | exact |

## Pattern Assignments

### `test/integration/prompt-to-main-e2e.test.ts` (test, event-driven request-response + file-I/O)

**Primary analog:** `test/integration/feature-lifecycle-e2e.test.ts`

**Secondary analogs:**
- `test/integration/merge-train.test.ts` for merge-train drain assertions.
- `test/integration/worker-smoke.test.ts` for inbox/help-response assertions.
- `test/helpers/feature-lifecycle-fixture.ts` for reusable tmp git workspace + scheduler/worker wiring.

**Imports pattern** (`test/integration/feature-lifecycle-e2e.test.ts` lines 1-11):
```typescript
import type { AgentRun } from '@core/types/index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFeatureLifecycleFixture,
  type FeatureLifecycleFixture,
} from '../helpers/feature-lifecycle-fixture.js';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
```

**Fixture lifecycle pattern** (`test/integration/feature-lifecycle-e2e.test.ts` lines 35-47):
```typescript
describe('feature lifecycle e2e — happy path', () => {
  let fixture: FeatureLifecycleFixture;
  let originalCwd: string;

  beforeEach(() => {
    fixture = createFeatureLifecycleFixture();
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fixture.teardown();
  });
```

**Seed feature + tmp git worktree pattern** (`test/integration/feature-lifecycle-e2e.test.ts` lines 49-76):
```typescript
it('walks planning → executing → ci_check → verifying → awaiting_merge with real worker commits', async () => {
  const { faux, graph, store, scheduler, harness } = fixture;

  const feature = fixture.seedFeature('f-e2e', {
    workControl: 'planning',
    collabControl: 'none',
  });
  const featureWorktree = fixture.featureWorktreePath(feature.featureBranch);
  process.chdir(featureWorktree);

  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(featureWorktree, 'task-a.txt'), 'task-a\n');
  fs.writeFileSync(path.join(featureWorktree, 'task-b.txt'), 'task-b\n');
```

**Faux provider transcript pattern** (`test/integration/feature-lifecycle-e2e.test.ts` lines 78-158):
```typescript
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall('addTask', {
        featureId: feature.id,
        description: 'implement X',
      }),
      fauxToolCall('addTask', {
        featureId: feature.id,
        description: 'document X',
      }),
      fauxToolCall('submit', {
        summary: 'Two-task plan.',
        chosenApproach: 'Implement and document in parallel.',
        keyConstraints: [],
        decompositionRationale: ['Implement + doc are independent'],
        orderingRationale: ['Any order works'],
        verificationExpectations: ['feature ci green'],
        risksTradeoffs: [],
        assumptions: [],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Planning complete.')]),

  fauxAssistantMessage(
    [
      fauxToolCall('run_command', {
        command: 'git add task-a.txt',
      }),
      fauxToolCall('run_command', {
        command: 'git commit -m "feat: task-a"',
      }),
      fauxToolCall('submit', {
        summary: 'implemented X',
        filesChanged: ['task-a.txt'],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('task-a done')]),

  fauxAssistantMessage(
    [
      fauxToolCall('submitVerify', {
        outcome: 'pass',
        summary: 'happy-path verified',
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Verification complete.')]),
]);
```

Use this pattern but extend the transcript to cover the Plan 12-01 golden path: top-level prompt or feature planning, approval, worker execution, one help/inbox interaction, verify pass, merge-train integration, and summarize/work-complete if required.

**Scheduler step + approval pattern** (`test/integration/feature-lifecycle-e2e.test.ts` lines 160-191):
```typescript
await scheduler.step(100);
await harness.drain();

const planRun = store.getAgentRun('run-feature:f-e2e:plan');
expect(planRun).toMatchObject({
  runStatus: 'await_approval',
  owner: 'manual',
});
expect(planRun?.payloadJson).toBeDefined();

scheduler.enqueue({
  type: 'feature_phase_approval_decision',
  featureId: feature.id,
  phase: 'plan',
  decision: 'approved',
});
await scheduler.step(200);
await harness.drain();

expect(graph.features.get(feature.id)).toMatchObject({
  workControl: 'executing',
  collabControl: 'branch_open',
});
expect(store.getAgentRun('run-feature:f-e2e:plan')).toMatchObject({
  runStatus: 'completed',
});
```

**Scheduler loop-until pattern** (`test/integration/feature-lifecycle-e2e.test.ts` lines 193-223):
```typescript
await fixture.stepUntil(
  () => {
    const feat = graph.features.get(feature.id);
    if (feat === undefined) return false;
    return (
      feat.workControl === 'awaiting_merge' ||
      feat.workControl === 'verifying'
    );
  },
  { maxTicks: 40 },
);

await fixture.stepUntil(
  () => graph.features.get(feature.id)?.workControl === 'awaiting_merge',
  { maxTicks: 10 },
);
```

**Task commit/trailer assertions** (`test/integration/feature-lifecycle-e2e.test.ts` lines 241-268):
```typescript
for (const phase of ['plan', 'ci_check', 'verify'] as const) {
  const run = store.getAgentRun(`run-feature:f-e2e:${phase}`) as
    | AgentRun
    | undefined;
  expect(run, `expected run-feature:f-e2e:${phase} to exist`).toBeDefined();
  expect(run?.runStatus).toBe('completed');
}

const commitFrames = fixture.workerMessages.filter(
  (m): m is typeof m & { type: 'commit_done' } => m.type === 'commit_done',
);
expect(commitFrames.length).toBeGreaterThanOrEqual(2);
for (const frame of commitFrames) {
  expect(frame.trailerOk).toBe(true);
  expect(frame.sha).toMatch(/^[0-9a-f]{7,}$/);
}
```

**Inbox/help-response pattern** (`test/integration/worker-smoke.test.ts` lines 144-208):
```typescript
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall('request_help', { query: 'Need operator guidance' }),
      fauxToolCall('submit', {
        summary: 'completed after help',
        filesChanged: ['src/help.ts'],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('done after help')]),
]);

const helpRequest = completions.find(
  (
    message,
  ): message is WorkerToOrchestratorMessage & { type: 'request_help' } =>
    message.type === 'request_help' && message.taskId === task.id,
);
expect(helpRequest).toMatchObject({
  query: 'Need operator guidance',
  toolCallId: expect.any(String),
});

await expect(
  pool.respondToHelp(task.id, {
    kind: 'answer',
    text: 'Use option B',
  }),
).resolves.toMatchObject({ kind: 'delivered', taskId: task.id });
await expect(
  pool.sendManualInput(task.id, 'Continue with option B.'),
).resolves.toMatchObject({ kind: 'delivered', taskId: task.id });

await harness.drain();

const result = completions.find(
  (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
    message.type === 'result' && message.taskId === task.id,
);
expect(result).toMatchObject({
  agentRunId: 'run-help',
  completionKind: 'submitted',
  result: {
    summary: 'completed after help',
    filesChanged: ['src/help.ts'],
  },
});
```

For a scheduler-level inbox answer, copy the unresolved inbox lookup and `respondToInboxHelp` assertion from `test/integration/worker-smoke.test.ts` lines 421-439:
```typescript
const inboxItem = store.listInboxItems({
  unresolvedOnly: true,
  kind: 'agent_help',
})[0];
expect(inboxItem).toBeDefined();
if (inboxItem === undefined) {
  throw new Error('expected unresolved checkpointed help inbox item');
}

await expect(
  respondToInboxHelp(
    { store, runtime: pool, graph, projectRoot: os.tmpdir() },
    inboxItem.id,
    {
      kind: 'answer',
      text: 'Use option B',
    },
  ),
).resolves.toBe('Sent help response to t-help-checkpointed.');
```

**Merge-train queue/drain assertions** (`test/integration/merge-train.test.ts` lines 90-106):
```typescript
coord.enqueueFeatureMerge('f-a', graph);
coord.enqueueFeatureMerge('f-b', graph);

coord.beginIntegration('f-a', graph);
coord.completeIntegration('f-a', graph);

expect(graph.features.get('f-a')?.collabControl).toBe('merged');
expect(coord.nextToIntegrate(graph)).toBe('f-b');

coord.beginIntegration('f-b', graph);
expect(graph.features.get('f-b')?.collabControl).toBe('integrating');
```

**Integration-runner happy path assertions** (`test/integration/merge-train.test.ts` lines 446-469):
```typescript
const loop = new SchedulerLoop(graph, ports);
await loop.step(100);

const feature = graph.features.get('f-1');
expect(feature?.collabControl).toBe('merged');

expect(verifyFeatureMock).toHaveBeenCalledOnce();
expect(verifyFeatureMock).toHaveBeenCalledWith(
  expect.objectContaining({ id: 'f-1' }),
);

expect(agentVerifyMock).toHaveBeenCalledOnce();
expect(agentVerifyMock).toHaveBeenCalledWith(
  expect.objectContaining({ id: 'f-1' }),
  expect.objectContaining({ agentRunId: 'run-integration:f-1' }),
);

expect(simpleGitMock).toHaveBeenCalled();
```

**State/event assertions** (`test/integration/feature-lifecycle-e2e.test.ts` lines 249-256):
```typescript
const events = store.listEvents({ entityId: feature.id });
const completedPhases = events
  .filter((event) => event.eventType === 'feature_phase_completed')
  .map((event) => (event.payload as { phase?: string }).phase);
expect(completedPhases).toEqual(
  expect.arrayContaining(['plan', 'ci_check', 'verify']),
);
```

---

### `test/integration/verify-flake-audit.test.ts` (test, batch request-response + file-I/O)

**Primary analog:** `test/integration/feature-phase-agent-flow.test.ts`

Use a deterministic batch loop around the existing faux-backed verify-agent path. The audit should run 5 known-good verify reviews, collect pass/fail results, and assert 5/5 if using only five repeats.

**Imports for verify-agent + tmp git workspace** (`test/integration/feature-phase-agent-flow.test.ts` lines 1-33):
```typescript
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  ProposalPhaseDetails,
  Task,
} from '@core/types/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';
```

**Faux provider setup/teardown** (`test/integration/feature-phase-agent-flow.test.ts` lines 336-349):
```typescript
describe('feature-phase agent flow', () => {
  let faux: FauxProviderRegistration;

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-6' }],
    });
  });

  afterEach(() => {
    faux.unregister();
  });
```

**Reusable config/runtime fixture** (`test/integration/feature-phase-agent-flow.test.ts` lines 285-334):
```typescript
function createFixture({
  featureOverrides = {},
  tasks = [],
  configOverrides = {},
  verification,
  projectRoot = '/repo',
}: {
  featureOverrides?: Partial<Feature>;
  tasks?: Task[];
  configOverrides?: Partial<GvcConfig>;
  verification?: OrchestratorPorts['verification'];
  projectRoot?: string;
} = {}) {
  const graph = createSingleFeatureGraph(featureOverrides, tasks);
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const config = createConfig(configOverrides);
  const agents = new PiFeatureAgentRuntime({
    modelId: 'claude-sonnet-4-6',
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot,
  });
  const resolvedVerification: OrchestratorPorts['verification'] =
    verification ??
    ({
      verifyFeature: () => Promise.resolve({ ok: true, summary: 'ok' }),
    } as unknown as OrchestratorPorts['verification']);
  const ports: OrchestratorPorts = {
    store,
    runtime: createRuntimeStub(),
    sessionStore,
    agents,
    verification: resolvedVerification,
    worktree: createWorktreeStub(projectRoot),
    ui: createUiStub(),
    config,
  };

  return {
    graph,
    store,
    sessionStore,
    config,
    loop: new SchedulerLoop(graph, ports),
  };
}
```

**Known-good verify transcript pattern** (`test/integration/feature-phase-agent-flow.test.ts` lines 1486-1500):
```typescript
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall('listFeatureEvents', { phase: 'ci_check' }),
      fauxToolCall('submitVerify', {
        outcome: 'repair_needed',
        summary: 'Repair needed: integrated flow not proven.',
        failedChecks: ['integrated flow not proven'],
        repairFocus: ['add proof for integrated flow'],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Verification complete.')]),
]);
```

For the flake audit, replace the verdict with `outcome: 'pass'` and a stable known-good summary. Append 10 faux messages for five repeats: each repeat needs a tool-use assistant turn with `submitVerify({ outcome: 'pass', ... })` and a final text turn.

**Tmpdir git workspace setup with committed feature diff** (`test/integration/feature-phase-agent-flow.test.ts` lines 1503-1529):
```typescript
const projectRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'gvc0-feature-verify-repair-'),
);

try {
  const { graph, store, loop } = createFixture({
    featureOverrides: {
      status: 'in_progress',
      workControl: 'verifying',
      collabControl: 'branch_open',
    },
    projectRoot,
  });
  const feature = graph.features.get('f-1');
  if (feature === undefined) {
    throw new Error('missing feature fixture');
  }
  await initFeatureWorktreeRepo(projectRoot, feature, [
    {
      filePath: 'src/feature.ts',
      content: 'export const feature = true;\n',
    },
  ]);
  appendFeaturePhaseEvent(store, 'f-1', 'ci_check', 'feature ci green', {
    ok: true,
    summary: 'feature ci green',
  });
```

**Cleanup pattern** (`test/integration/feature-phase-agent-flow.test.ts` lines 1571-1573):
```typescript
} finally {
  await fs.rm(projectRoot, { recursive: true, force: true });
}
```

**Pass verification assertions**: invert the repair-needed assertions at `test/integration/feature-phase-agent-flow.test.ts` lines 1531-1569. For a known-good repeat, assert:
```typescript
await loop.step(100);

expect(graph.features.get('f-1')).toEqual(
  expect.objectContaining({
    workControl: 'awaiting_merge',
    status: 'pending',
    collabControl: expect.stringMatching(/^(branch_open|merge_queued|integrating)$/),
  }),
);
const verifyRun = store.getAgentRun('run-feature:f-1:verify');
expect(verifyRun).toEqual(
  expect.objectContaining({
    runStatus: 'completed',
    owner: 'system',
  }),
);
expect(JSON.parse(verifyRun?.payloadJson ?? '{}')).toMatchObject({
  ok: true,
  outcome: 'pass',
});
```

**Batch audit structure to copy:** use a plain loop in one test, creating a fresh fixture/worktree per repeat to avoid cross-run state bleed:
```typescript
const results: boolean[] = [];
for (let attempt = 0; attempt < 5; attempt += 1) {
  // create fresh tmp projectRoot + fixture
  // run one known-good verify pass
  results.push(JSON.parse(verifyRun?.payloadJson ?? '{}').ok === true);
}
const passCount = results.filter(Boolean).length;
expect(passCount).toBe(5);
```

---

### `test/helpers/feature-lifecycle-fixture.ts` (test utility, event-driven + file-I/O)

**Analog:** `test/helpers/feature-lifecycle-fixture.ts` itself. If Plan 12-01 needs a broader reusable scenario helper, extend this fixture rather than duplicating setup inside a new integration test.

**Tmp git repo initialization pattern** (`test/helpers/feature-lifecycle-fixture.ts` lines 133-158):
```typescript
function initGitRepo(tmpDir: string): void {
  const env = { cwd: tmpDir };
  spawnSync('git', ['init', '-q'], env);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], env);
  spawnSync('git', ['config', 'user.name', 'Test Runner'], env);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], env);
  fs.writeFileSync(path.join(tmpDir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['add', 'seed.txt'], env);
  spawnSync('git', ['commit', '-q', '-m', 'seed'], env);
}

function initFeatureWorktreeRepo(
  worktreeDir: string,
  featureBranch: string,
): void {
  const env = { cwd: worktreeDir };
  spawnSync('git', ['init', '-q'], env);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], env);
  spawnSync('git', ['config', 'user.name', 'Test Runner'], env);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], env);
  fs.writeFileSync(path.join(worktreeDir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['add', 'seed.txt'], env);
  spawnSync('git', ['commit', '-q', '-m', 'seed'], env);
  spawnSync('git', ['branch', '-M', 'main'], env);
  spawnSync('git', ['checkout', '-q', '-b', featureBranch], env);
}
```

**Model/config/faux provider wiring** (`test/helpers/feature-lifecycle-fixture.ts` lines 189-222):
```typescript
export function createFeatureLifecycleFixture(
  options: CreateFeatureLifecycleFixtureOptions = {},
): FeatureLifecycleFixture {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc0-lifecycle-e2e-'));
  initGitRepo(tmpDir);

  const faux = createFauxProvider({
    api: 'anthropic-messages',
    provider: 'anthropic',
    models: [{ id: modelId }],
  });

  const graph = new InMemoryFeatureGraph();
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();

  const baseConfig = testGvcConfigDefaults();
  const config: GvcConfig = {
    ...baseConfig,
    tokenProfile: 'balanced',
    models: {
      topPlanner: { provider: 'anthropic', model: modelId },
      featurePlanner: { provider: 'anthropic', model: modelId },
      taskWorker: { provider: 'anthropic', model: modelId },
      verifier: { provider: 'anthropic', model: modelId },
    },
    ...(options.configOverrides ?? {}),
  };
```

**Worker pool event forwarding pattern** (`test/helpers/feature-lifecycle-fixture.ts` lines 241-270):
```typescript
let schedulerRef: SchedulerLoop | undefined;
const workerMessages: WorkerToOrchestratorMessage[] = [];

const harness = new InProcessHarness(sessionStore, {
  modelId,
  projectRoot: tmpDir,
});

const pool = new LocalWorkerPool(
  harness,
  options.maxConcurrency ?? 1,
  (message) => {
    if (message.type === 'health_pong') return;
    workerMessages.push(message);
    schedulerRef?.enqueue({ type: 'worker_message', message });
  },
  {
    store,
    config: {
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 50,
      transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
    },
  },
);
```

**Seed feature pattern** (`test/helpers/feature-lifecycle-fixture.ts` lines 289-365):
```typescript
function seedFeature(
  featureId: string,
  seedOptions: SeedFeatureOptions = {},
): Feature {
  const brandedFeatureId = featureId as FeatureId;
  const featureBranch =
    seedOptions.featureBranch ??
    `feat-${featureId.replace(/[^a-z0-9-]/gi, '-')}`;
  const milestoneId = 'm-1' as MilestoneId;
  const existingMilestones = [...graph.milestones.values()];
  const initialSnapshot = graph.snapshot();
  const milestones =
    existingMilestones.length === 0
      ? [
          ...initialSnapshot.milestones,
          {
            id: milestoneId,
            name: 'Milestone 1',
            description: 'Milestone for lifecycle fixture',
            status: 'pending' as const,
            order: 0,
          },
        ]
      : initialSnapshot.milestones;

  const feature: Feature = {
    id: brandedFeatureId,
    milestoneId,
    orderInMilestone: initialSnapshot.features.length,
    name: `Feature ${featureId}`,
    description: seedOptions.description ?? `Feature ${featureId}`,
    dependsOn: [],
    status: 'pending',
    workControl: seedOptions.workControl ?? 'planning',
    collabControl: seedOptions.collabControl ?? 'none',
    featureBranch,
  };

  const worktreeDir = featureWorktreePath(featureBranch);
  fs.mkdirSync(worktreeDir, { recursive: true });
  initFeatureWorktreeRepo(worktreeDir, featureBranch);

  return feature;
}
```

**Drive-until + teardown pattern** (`test/helpers/feature-lifecycle-fixture.ts` lines 368-391):
```typescript
async function stepUntil(
  predicate: () => boolean,
  stepOptions: { maxTicks?: number; now?: number } = {},
): Promise<number> {
  const maxTicks = stepOptions.maxTicks ?? 50;
  let now = stepOptions.now ?? 100;
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return i;
    await scheduler.step(now);
    now += 100;
    await harness.drain();
    if (predicate()) return i + 1;
  }
  throw new Error(
    `stepUntil: predicate never satisfied after ${maxTicks} ticks`,
  );
}

async function teardown(): Promise<void> {
  await pool.stopAll();
  await harness.drain();
  faux.unregister();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
```

---

### `package.json` (config, batch)

**Analog:** `package.json`

If the flake audit needs a dedicated command, follow existing npm script naming and Vitest conventions rather than introducing a new runner.

**Existing script conventions** (`package.json` lines 10-28):
```json
"scripts": {
  "check": "npm run check:fix; npm run format:check && npm run lint && npm run typecheck && npm run test",
  "check:fix": "biome check --write .",
  "fix": "npm run check:fix",
  "format": "biome format --write .",
  "format:check": "biome check --formatter-enabled=true --linter-enabled=false .",
  "lint": "biome check --formatter-enabled=false --linter-enabled=true .",
  "lint:fix": "npm run check:fix",
  "lint:ci": "eslint \"src/**/*.ts\" \"test/**/*.ts\" \"vitest.config.ts\" --max-warnings=0 --no-error-on-unmatched-pattern --cache",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:unit": "vitest run test/unit",
  "test:unit:watch": "vitest test/unit",
  "test:integration": "vitest run test/integration",
  "test:integration:watch": "vitest test/integration",
  "test:tui:e2e": "command npx tui-test",
  "tui": "tsx src/main.ts",
  "typecheck": "tsc --noEmit",
  "verify": "npm run check && npm run lint:ci"
}
```

Suggested convention if needed: `"test:verify-flake-audit": "vitest run test/integration/verify-flake-audit.test.ts"`. Keep default `test` green and deterministic; only add a special script if runtime cost or traceability warrants it.

## Shared Patterns

### Faux provider registration and cleanup

**Source:** `test/integration/harness/faux-stream.ts` lines 12-30

**Apply to:** all deterministic agent integration tests.
```typescript
/**
 * Thin wrapper around pi-ai's `registerFauxProvider` for integration
 * tests. Registration is global to the pi-ai api-registry, so callers
 * MUST call `unregister()` in an afterEach (or similar) to avoid
 * cross-test bleed.
 */
export function createFauxProvider(
  options?: RegisterFauxProviderOptions,
): FauxProviderRegistration {
  return registerFauxProvider(options);
}

export type { FauxProviderRegistration, FauxResponseStep };
export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };
```

### In-process worker harness instead of forked child

**Source:** `test/integration/harness/in-process-harness.ts` lines 25-35 and 79-83

**Apply to:** prompt-to-main e2e and any worker-backed deterministic test.
```typescript
/**
 * `SessionHarness` that runs `WorkerRuntime` inside the current process
 * using a loopback IPC transport instead of `child_process.fork`. Designed
 * for integration tests that want to exercise the real agent loop against
 * pi-ai's faux provider without paying the cost (or flakiness) of a
 * forked child.
 */
export class InProcessHarness implements SessionHarness {
  /** Wait for every currently-running runtime to settle. */
  async drain(): Promise<void> {
    const pending = [...this.runtimes.values()].map((entry) => entry.done);
    await Promise.allSettled(pending);
  }
```

### In-memory session store

**Source:** `test/integration/harness/in-memory-session-store.ts` lines 4-32

**Apply to:** all faux-backed tests needing message persistence assertions.
```typescript
/**
 * Map-backed `SessionStore` for integration tests — avoids `.gvc0/sessions`
 * filesystem writes that `FileSessionStore` would produce and lets tests
 * inspect saved message streams directly.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentMessage[]>();

  save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    this.sessions.set(sessionId, [...messages]);
    return Promise.resolve();
  }

  load(sessionId: string): Promise<AgentMessage[] | null> {
    const messages = this.sessions.get(sessionId);
    return Promise.resolve(messages === undefined ? null : [...messages]);
  }
```

### In-memory store assertions

**Source:** `test/integration/harness/store-memory.ts` lines 60-85, 102-124, 171-207, 216-235

**Apply to:** agent run, event, inbox, and commit-trailer assertions.
```typescript
getAgentRun(id: string): AgentRun | undefined {
  return this.runs.get(id);
}

listAgentRuns(query?: AgentRunQuery): AgentRun[] {
  const out: AgentRun[] = [];
  for (const run of this.runs.values()) {
    if (query?.scopeType !== undefined && run.scopeType !== query.scopeType) {
      continue;
    }
    if (query?.scopeId !== undefined && run.scopeId !== query.scopeId) {
      continue;
    }
    if (query?.phase !== undefined && run.phase !== query.phase) {
      continue;
    }
    out.push(run);
  }
  return out;
}

listEvents(query?: EventQuery): EventRecord[] {
  return this.events.filter((event) => {
    if (query?.eventType !== undefined && event.eventType !== query.eventType) {
      return false;
    }
    if (query?.entityId !== undefined && event.entityId !== query.entityId) {
      return false;
    }
    return true;
  });
}

listInboxItems(query?: InboxQuery): InboxItemRecord[] {
  return this.inboxItems
    .filter((item) => {
      if (query?.unresolvedOnly && item.resolution !== undefined) {
        return false;
      }
      if (query?.kind !== undefined && item.kind !== query.kind) {
        return false;
      }
      return true;
    })
    .sort((left, right) =>
      left.ts === right.ts
        ? right.id.localeCompare(left.id)
        : right.ts - left.ts,
    )
    .map((entry) => ({ ...entry }));
}

getLastCommitSha(agentRunId: string): string | undefined {
  return this.lastCommitShas.get(agentRunId);
}
```

### Verify-agent submit semantics

**Source:** `src/agents/tools/feature-phase-host.ts` lines 156-195

**Apply to:** verify flake audit and prompt-to-main verify phase assertions.
```typescript
submitVerify(args: SubmitVerifyOptions): VerificationSummary {
  if (this.verification !== undefined) {
    throw new Error('verify phase already submitted');
  }
  const hasIssues = this.verifyIssues.length > 0;
  const blockingIssues = this.verifyIssues.filter(
    (issue) => issue.severity !== 'nit',
  );
  const hasBlocking = blockingIssues.length > 0;
  const ok = args.outcome === 'pass' && !hasBlocking;
  const outcome: 'pass' | 'repair_needed' = ok ? 'pass' : 'repair_needed';
  const verification: VerificationSummary = {
    ok,
    summary: args.summary,
    outcome,
    ...(fallbackFailedChecks !== undefined
      ? { failedChecks: fallbackFailedChecks }
      : {}),
    ...(args.criteriaEvidence !== undefined &&
    args.criteriaEvidence.length > 0
      ? { criteriaEvidence: args.criteriaEvidence }
      : {}),
    ...(args.repairFocus !== undefined && args.repairFocus.length > 0
      ? { repairFocus: args.repairFocus }
      : {}),
    ...(hasIssues ? { issues: [...this.verifyIssues] } : {}),
  };
  this.verification = verification;
  return verification;
}
```

### Verify-agent runtime persistence

**Source:** `src/agents/runtime.ts` lines 257-304

**Apply to:** assertions over `run-feature:*:verify` payloadJson, event payload, and session persistence.
```typescript
private async runVerifyPhase(
  feature: Feature,
  run: FeaturePhaseRunContext,
): Promise<VerificationSummary> {
  const prompt = await this.renderPrompt({ feature, run, phase: 'verify' });
  const host = createFeaturePhaseToolHost(
    feature.id,
    this.deps.graph,
    this.deps.store,
    this.deps.projectRoot,
  );
  const tools = buildFeaturePhaseAgentToolset(host, 'verify');
  const messages = await this.loadMessages(run.sessionId);
  const { agent, model } = this.createAgent(
    'verify',
    prompt,
    tools,
    run,
    messages,
  );

  await this.executeAgent(agent, feature.description);
  if (!host.wasVerifySubmitted()) {
    throw new Error('verify phase must call submitVerify before completion');
  }

  const finalMessages = agent.state.messages;
  const sessionId = await this.persistMessages(
    run,
    finalMessages,
    model.provider,
    model.id,
  );
  const verification = host.getVerificationSummary();
  const summary = verification.summary ?? 'Verification complete.';
  this.deps.store.updateAgentRun(run.agentRunId, {
    payloadJson: JSON.stringify(verification),
  });

  this.recordPhaseCompletion(
    feature.id,
    'verify',
    summary,
    sessionId,
    verification,
  );

  return verification;
}
```

### Verify prompt fail-closed behavior

**Source:** `src/agents/prompts/verify.ts` lines 12-51

**Apply to:** audit expectations and known-good transcript design.
```typescript
const VERIFY_PROMPT = `You are gvc0's feature verification agent.

Your job is to verify real outcome, not to admire effort.
Use discussion goals, research context, planning intent, execution evidence, and verification outputs to decide whether feature is truly ready to advance.

Verification stance:
- inspect persisted feature state, task results, changed files, and prior phase events with available tools before deciding
- evidence over optimism
- fail closed when promised outcome is not demonstrated
- distinguish implementation progress from user-visible capability
- classify failures as repair work, not immediate replanning
- report only high-signal problems

Issue raising:
- call `raiseIssue({severity, description, location?, suggestedFix?})` for each high-signal problem found
- severity: 'blocking' (must fix before merge), 'concern' (should fix), 'nit' (optional polish)
- raising any 'blocking' or 'concern' issue forces verdict to repair_needed regardless of submitVerify outcome
- 'nit' issues are non-blocking: they still surface in the verification summary and persisted issue list, but do not force repair
- if 'Changed Files' shows 'No changes on feature branch vs base.', submit verdict `repair_needed` with a blocking raiseIssue naming the missing implementation

Output should use `submitVerify(...)` exactly once after all issues raised, and include:
- verification result: pass or repair needed
- evidence for each success criterion
- missing proof or failed checks
- concise repair focus when verdict is repair needed

Do not:
- devolve into generic style review
- report low-confidence nits via raiseIssue
- treat partial implementation as feature success
- return free-text verdict instead of `submitVerify(...)``;
```

### Shell verification service

**Source:** `src/orchestrator/services/verification-service.ts` lines 24-79

**Apply to:** ci_check setup and integration-runner shell verification stubs.
```typescript
async verifyFeature(feature: Feature): Promise<VerificationSummary> {
  const config = resolveVerificationLayerConfig(this.ports.config, 'feature');
  const cwd = await this.resolveFeatureWorktree(feature);
  return this.runLayerChecks(
    'Feature verification',
    'No feature verification checks configured.',
    config,
    cwd,
  );
}

private async runLayerChecks(
  label: string,
  emptySummary: string,
  config: VerificationLayerConfig,
  cwd: string,
): Promise<VerificationSummary> {
  const checks = config.checks;

  if (checks.length === 0) {
    return {
      ok: true,
      summary: emptySummary,
    };
  }

  const failedChecks: string[] = [];
  const failureDetails: string[] = [];

  for (const check of checks) {
    const result = await runShell(check.command, cwd, timeoutMs);
    if (result.timedOut || result.exitCode !== 0) {
      failedChecks.push(check.description);
      failureDetails.push(formatVerificationResult(check, result, timeoutMs));
      if (config.continueOnFail !== true) {
        break;
      }
    }
  }

  if (failedChecks.length === 0) {
    return {
      ok: true,
      summary: `${label} passed (${checks.length}/${checks.length} checks).`,
    };
  }
```

### Integration runner semantics

**Source:** `src/orchestrator/scheduler/integration-runner.ts` lines 33-89

**Apply to:** prompt-to-main merge-train drain proof.
```typescript
// 2. Rebase onto main.
const rebase = await rebaseGitDir(featureDir, 'main');
if (rebase.kind !== 'clean') {
  const error =
    rebase.kind === 'blocked'
      ? 'worktree missing during integration rebase'
      : `rebase conflict: ${rebase.conflictedFiles.join(', ')}`;
  await params.handleEvent({
    type: 'feature_integration_failed',
    featureId: feature.id,
    error,
  });
  return;
}

// 3. Shell verification.
const shellResult = await params.ports.verification.verifyFeature(feature);
if (!shellResult.ok) {
  await params.handleEvent({
    type: 'feature_integration_failed',
    featureId: feature.id,
    error: shellResult.summary ?? 'merge-train shell verification failed',
  });
  return;
}

// 4. Agent review (REQ-MERGE-04). Run ID prefix distinguishes from
//    feature-phase verify runs (run-feature:${id}:verify).
const run = { agentRunId: `run-integration:${feature.id}` };
const agentResult = await params.ports.agents.verifyFeature(feature, run);
if (!agentResult.ok) {
  await params.handleEvent({
    type: 'feature_integration_failed',
    featureId: feature.id,
    error: agentResult.summary ?? 'merge-train agent review failed',
  });
  return;
}

// 5. Fast-forward merge onto main (only reached after all checks pass).
try {
  const mainRepo = simpleGit(cwd);
  await mainRepo.merge([feature.featureBranch, '--ff-only']);
} catch (err) {
  await params.handleEvent({
    type: 'feature_integration_failed',
    featureId: feature.id,
    error: `fast-forward merge failed: ${err instanceof Error ? err.message : String(err)}`,
  });
  return;
}

// 6. Emit complete — main has advanced.
await params.handleEvent({
  type: 'feature_integration_complete',
  featureId: feature.id,
});
```

## No Analog Found

None. All likely Plan 12-01 files have close in-repo analogs.

## Metadata

**Analog search scope:**
- `/home/alpine/vcode0/test/integration/*.test.ts`
- `/home/alpine/vcode0/test/integration/harness/*`
- `/home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts`
- `/home/alpine/vcode0/src/agents/*`
- `/home/alpine/vcode0/src/orchestrator/*`
- `/home/alpine/vcode0/package.json`

**Files scanned:** 17 read directly plus directory listings for harness/agents/orchestrator.
**Pattern extraction date:** 2026-05-02
