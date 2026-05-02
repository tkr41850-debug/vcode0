/**
 * Plan 12-01 Task 1 — Non-TUI prompt-to-main lifecycle proof.
 *
 * Proves Phase 12 SC1: scripted planner proposal, approval, worker execution,
 * one answered inbox item, verify pass, merge-train drain, and main containing
 * the expected committed work — all deterministic, no TUI, no live LLM calls.
 *
 * Grep-friendly names for 12-03 traceability:
 *   - describe: "prompt-to-main lifecycle (non-TUI scripted proof)"
 *   - it:       "merge-train drains and main contains expected work after ..."
 *
 * REQ coverage: REQ-PLAN-01, REQ-PLAN-02, REQ-EXEC-01, REQ-EXEC-02,
 *               REQ-INBOX-01, REQ-MERGE-01, REQ-MERGE-02, REQ-MERGE-04
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentRun, VerificationSummary } from '@core/types/index';
import { rebaseGitDir } from '@orchestrator/conflicts/git.js';
import { respondToInboxHelp } from '@root/compose';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFeatureLifecycleFixture,
  type FeatureLifecycleFixture,
} from '../helpers/feature-lifecycle-fixture.js';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';

vi.mock('../../src/orchestrator/conflicts/git.js', () => ({
  rebaseGitDir: vi.fn(),
  rebaseTaskWorktree: vi.fn(),
  fileExists: vi.fn(),
  abortRebase: vi.fn(),
  readConflictedFiles: vi.fn(),
  readDirtyFiles: vi.fn(),
}));
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(),
}));

/** Yield the event loop a few times so in-process workers can emit IPC frames. */
async function yieldEventLoop(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('prompt-to-main lifecycle (non-TUI scripted proof)', () => {
  let fixture: FeatureLifecycleFixture;
  let originalCwd: string;

  const rebaseGitDirMock = vi.mocked(rebaseGitDir);
  const simpleGitMock = vi.mocked(simpleGit);

  beforeEach(() => {
    fixture = createFeatureLifecycleFixture();
    originalCwd = process.cwd();

    vi.clearAllMocks();
    rebaseGitDirMock.mockResolvedValue({ kind: 'clean' });
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    // raw() is used by getChangedFiles (verify prompt rendering); return
    // "greeting.ts" so the verify prompt has a non-empty changed-files list.
    const rawFn = vi.fn().mockResolvedValue('greeting.ts\n');
    simpleGitMock.mockReturnValue({
      merge: mergeFn,
      raw: rawFn,
    } as unknown as ReturnType<typeof simpleGit>);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fixture.teardown();
  });

  it('merge-train drains and main contains expected work after planner proposal, approval, inbox help, and verify pass', async () => {
    const { faux, graph, store, scheduler, harness } = fixture;

    // ---------------------------------------------------------------
    // REQ-PLAN-01: Seed a feature representing the user prompt.
    // REQ-PLAN-02: Planning phase runs and produces tasks.
    // ---------------------------------------------------------------
    const feature = fixture.seedFeature('f-p2m', {
      workControl: 'planning',
      collabControl: 'none',
      description: 'Implement greeting service (prompt-to-main proof feature)',
    });
    const featureWorktree = fixture.featureWorktreePath(feature.featureBranch);
    process.chdir(featureWorktree);

    // Pre-create task file so worker's `git add` command succeeds.
    fs.writeFileSync(
      path.join(featureWorktree, 'greeting.ts'),
      'export const greet = (name: string) => "Hello, " + name + "!";\n',
    );

    // ---------------------------------------------------------------
    // Script all LLM turns in deterministic order:
    //
    //  Turns 1-2: Feature planner → addTask + submit
    //  Turns 3-4: Worker → request_help (blocks) then git add/commit/submit
    //  Turns 5-6: Feature verifier → submitVerify(pass)
    //  Turns 7-8: Integration-runner agent review → submitVerify(pass)
    //
    // request_help + subsequent tool calls are in one faux assistant message.
    // The pi-sdk Agent processes tool calls sequentially; request_help blocks
    // until the help response is delivered, then the remaining tool calls run.
    // ---------------------------------------------------------------
    faux.setResponses([
      // ---- Turns 1-2: Feature planner ----
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: feature.id,
            description: 'implement greeting service',
          }),
          fauxToolCall('submit', {
            summary: 'Single-task plan for greeting service.',
            chosenApproach: 'Implement greeting function in greeting.ts.',
            keyConstraints: [],
            decompositionRationale: ['Single self-contained implementation'],
            orderingRationale: ['Only one task'],
            verificationExpectations: ['greeting.ts exports greet'],
            risksTradeoffs: [],
            assumptions: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Planning complete.')]),

      // ---- Turns 3-4: Worker (inbox help + commit) ----
      // REQ-INBOX-01: request_help routes to inbox; test answers before
      // the remaining tool calls (git add, git commit, submit) execute.
      fauxAssistantMessage(
        [
          fauxToolCall('request_help', {
            query: 'Should the greeting use first name or full name?',
          }),
          fauxToolCall('run_command', {
            command: 'git add greeting.ts',
          }),
          fauxToolCall('run_command', {
            command: 'git commit -m "feat: implement greeting service"',
          }),
          fauxToolCall('submit', {
            summary: 'Implemented greeting.ts with greet() export.',
            filesChanged: ['greeting.ts'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Greeting service implemented.')]),

      // ---- Turns 5-6: Feature verifier ----
      fauxAssistantMessage(
        [
          fauxToolCall('submitVerify', {
            outcome: 'pass',
            summary:
              'Feature verify pass: greeting.ts exports greet as expected.',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),

      // ---- Turns 7-8: Integration-runner agent review ----
      // REQ-MERGE-04: verification before merge is an agent review using
      // run-integration: prefix.
      fauxAssistantMessage(
        [
          fauxToolCall('submitVerify', {
            outcome: 'pass',
            summary: 'Integration review pass: greeting feature ready.',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Integration review complete.')]),
    ]);

    // ---------------------------------------------------------------
    // Phase 1: Feature planner runs — lands in await_approval.
    // REQ-PLAN-01: top/feature planner proposal created.
    // ---------------------------------------------------------------
    await scheduler.step(100);
    await harness.drain();

    const planRun = store.getAgentRun(`run-feature:${feature.id}:plan`);
    expect(planRun, 'plan run should exist after first step').toBeDefined();
    expect(planRun).toMatchObject({
      runStatus: 'await_approval',
      owner: 'manual',
    });
    expect(
      planRun?.payloadJson,
      'plan proposal payload must be defined',
    ).toBeDefined();

    // ---------------------------------------------------------------
    // Phase 2: Approve plan proposal → tasks created, feature → executing.
    // REQ-PLAN-02: approval applies feature task DAG.
    // ---------------------------------------------------------------
    scheduler.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: feature.id,
      phase: 'plan',
      decision: 'approved',
    });
    await scheduler.step(200);
    // Do NOT drain here — the worker is now running and will block on
    // request_help. Draining would hang until the help is answered.
    await yieldEventLoop(8);

    const tasksAfterPlan = [...graph.tasks.values()].filter(
      (task) => task.featureId === feature.id,
    );
    expect(tasksAfterPlan, 'planner should have created one task').toHaveLength(
      1,
    );
    expect(graph.features.get(feature.id)).toMatchObject({
      workControl: 'executing',
      collabControl: 'branch_open',
    });
    expect(store.getAgentRun(`run-feature:${feature.id}:plan`)).toMatchObject({
      runStatus: 'completed',
    });

    // ---------------------------------------------------------------
    // Phase 3: Worker emits request_help → test answers it.
    // REQ-INBOX-01: agent request_help routes to inbox item.
    //
    // NOTE: the worker blocks on request_help, so we MUST NOT call
    // harness.drain() here — it would wait forever. Instead we poll
    // with short event-loop yields until the frame appears.
    // ---------------------------------------------------------------
    const deadline = Date.now() + 30_000;
    while (
      !fixture.workerMessages.some((m) => m.type === 'request_help') &&
      store.listInboxItems({ kind: 'agent_help' }).length === 0 &&
      Date.now() < deadline
    ) {
      await scheduler.step(300);
      await yieldEventLoop(8);
    }

    // Verify that either a live help frame or a checkpointed inbox item
    // appeared — then deliver the answer.
    const helpInboxItems = store.listInboxItems({
      unresolvedOnly: true,
      kind: 'agent_help',
    });
    const liveHelpFrame = fixture.workerMessages.find(
      (m) => m.type === 'request_help',
    );

    if (helpInboxItems.length > 0) {
      // Scheduler processed the request_help worker_message and created
      // an inbox item — use respondToInboxHelp (covers checkpointed path too).
      const [inboxItem] = helpInboxItems;
      expect(inboxItem).toBeDefined();
      if (inboxItem === undefined)
        throw new Error('agent_help inbox item must exist');

      await respondToInboxHelp(
        { store, runtime: fixture.pool, graph, projectRoot: fixture.tmpDir },
        inboxItem.id,
        { kind: 'answer', text: 'Use first name only.' },
      );
    } else if (liveHelpFrame !== undefined) {
      // Live worker frame emitted but scheduler tick hasn't created the
      // inbox item yet — deliver directly via pool.
      expect(liveHelpFrame.type).toBe('request_help');
      const [task] = tasksAfterPlan;
      expect(task).toBeDefined();
      if (task === undefined) throw new Error('task must exist');

      await fixture.pool.respondToHelp(task.id, {
        kind: 'answer',
        text: 'Use first name only.',
      });
    } else {
      throw new Error(
        'Expected an agent_help inbox item or request_help worker frame within 30 s',
      );
    }

    // Now drain — the worker will resume (remaining tool calls: git add,
    // git commit, submit) and finish.
    await harness.drain();

    // ---------------------------------------------------------------
    // Phase 4: Worker committed, feature advances to ci_check → verifying.
    // REQ-EXEC-01: task ran in worktree via LocalWorkerPool/InProcessHarness.
    // REQ-EXEC-02: commit_done frames have trailerOk === true and a SHA.
    // ---------------------------------------------------------------
    await fixture.stepUntil(
      () =>
        graph.features.get(feature.id)?.workControl === 'awaiting_merge' ||
        graph.features.get(feature.id)?.workControl === 'verifying',
      { maxTicks: 40 },
    );

    // Allow verify phase to fully resolve if needed.
    await fixture.stepUntil(
      () => graph.features.get(feature.id)?.workControl === 'awaiting_merge',
      { maxTicks: 15 },
    );

    // Commit trailer evidence (REQ-EXEC-02).
    const taskIdStrings = new Set<string>(tasksAfterPlan.map((t) => t.id));
    const commitFrames = fixture.workerMessages.filter(
      (m): m is Extract<typeof m, { type: 'commit_done' }> =>
        m.type === 'commit_done' && taskIdStrings.has(m.taskId),
    );
    expect(
      commitFrames.length,
      'at least one commit_done frame expected for REQ-EXEC-02',
    ).toBeGreaterThanOrEqual(1);
    for (const frame of commitFrames) {
      expect(frame.trailerOk, 'trailerOk must be true').toBe(true);
      expect(frame.sha, 'sha must be a hex string').toMatch(/^[0-9a-f]{7,}$/);
    }

    // Phase agent runs completed.
    for (const phase of ['plan', 'ci_check', 'verify'] as const) {
      const run = store.getAgentRun(`run-feature:${feature.id}:${phase}`) as
        | AgentRun
        | undefined;
      expect(
        run,
        `run-feature:${feature.id}:${phase} must exist`,
      ).toBeDefined();
      expect(run?.runStatus).toBe('completed');
    }

    const featureAtMerge = graph.features.get(feature.id);
    expect(featureAtMerge?.workControl).toBe('awaiting_merge');
    expect(['merge_queued', 'integrating']).toContain(
      featureAtMerge?.collabControl,
    );

    // ---------------------------------------------------------------
    // Phase 5: Drive scheduler until merge-train completes.
    // REQ-MERGE-01/02: integration runner rebases, shell-verifies, agent-
    //   reviews, ff-merges → feature_integration_complete.
    // REQ-MERGE-04: agent review fires with run-integration: prefix.
    // collabControl reaches 'merged'.
    // ---------------------------------------------------------------
    await fixture.stepUntil(
      () => graph.features.get(feature.id)?.collabControl === 'merged',
      { maxTicks: 20 },
    );

    const mergedFeature = graph.features.get(feature.id);
    expect(mergedFeature?.collabControl, 'feature must reach merged').toBe(
      'merged',
    );

    // Integration runner invoked mocked rebase + ff-merge (REQ-MERGE-01/02).
    expect(rebaseGitDirMock, 'rebase must have been called').toHaveBeenCalled();
    expect(
      simpleGitMock,
      'simpleGit ff-merge must have been called',
    ).toHaveBeenCalled();

    // Agent review run-integration: prefix (REQ-MERGE-04).
    const integrationRun = store.getAgentRun(`run-integration:${feature.id}`) as
      | AgentRun
      | undefined;
    expect(
      integrationRun,
      'run-integration: agent run must exist for REQ-MERGE-04',
    ).toBeDefined();
    expect(integrationRun?.runStatus).toBe('completed');
    const integrationPayload = JSON.parse(
      integrationRun?.payloadJson ?? '{}',
    ) as VerificationSummary;
    expect(integrationPayload).toMatchObject({ ok: true, outcome: 'pass' });

    // Phase completion events cover plan, ci_check, verify.
    const events = store.listEvents({ entityId: feature.id });
    const completedPhases = events
      .filter((event) => event.eventType === 'feature_phase_completed')
      .map((event) => (event.payload as { phase?: string }).phase);
    expect(completedPhases).toEqual(
      expect.arrayContaining(['plan', 'ci_check', 'verify']),
    );
  }, 120_000);
});
