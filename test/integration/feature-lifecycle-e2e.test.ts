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

/**
 * Plan 05-02 Task 2 — End-to-end happy-path walk.
 *
 * Drives a single feature through:
 *   planning → executing → ci_check → verifying → awaiting_merge
 * using the shared fixture (real LocalWorkerPool + faux planner + faux
 * executor + real VerificationService + faux verifier). Proves:
 *
 *   1. FSM guards hold under real event-queue traffic (not just unit
 *      isolation): the `verifying → awaiting_merge` boundary advances
 *      only once ci_check and verify have both succeeded.
 *   2. Per-phase `AgentRun` rows land in `runStatus='completed'` (plan,
 *      ci_check, verify).
 *   3. Each worker task produces a real git commit with both gvc0
 *      trailers — the executor path is the real pi-agent Agent loop,
 *      not a scripted `worker_message` emitter.
 *
 * Scope fences (NOT tested here — per plan):
 *   - Repair loop (05-04).
 *   - Empty-diff verify (05-03).
 *   - Merge-train (awaiting_merge → integrating → merged) — Phase 6.
 */
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

  it('walks planning → executing → ci_check → verifying → awaiting_merge with real worker commits', async () => {
    const { faux, graph, store, scheduler, harness } = fixture;

    // Seed one feature on the graph. Tasks will be created by the
    // planner agent through the plan proposal, so we do NOT pre-seed
    // task descriptions here — the full planning phase runs for real.
    const feature = fixture.seedFeature('f-e2e', {
      workControl: 'planning',
      collabControl: 'none',
    });
    const featureWorktree = fixture.featureWorktreePath(feature.featureBranch);
    process.chdir(featureWorktree);

    // --- Script every LLM turn the run will consume, in order ----------
    //
    // Each Agent invocation emits two assistant turns (tool-use turn
    // followed by a short text turn that closes the stream). The
    // planner + two executor tasks + verifier therefore consume
    // 8 assistant messages from the faux queue.
    //
    // Stage files with `git add` up-front so the executor's `git commit`
    // call is a bare `git commit` invocation — only commands that start
    // with `git commit` trigger the worker's trailer-injection and
    // `commit_done` emission (see `isGitCommitCommand`).
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(featureWorktree, 'task-a.txt'), 'task-a\n');
    fs.writeFileSync(path.join(featureWorktree, 'task-b.txt'), 'task-b\n');

    faux.setResponses([
      // ---- Planner: emit two independent tasks + submit.
      // No addDependency between the two — pending→ready promotion for
      // intra-feature task deps is currently a proposal-apply-time op
      // (see `promoteReadyTasks`) and isn't re-evaluated when an
      // upstream task lands. Two independent tasks both land `ready` on
      // proposal-apply and serialize through the fixture's single-worker
      // pool so the shared faux queue feeds each executor turn in order.
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

      // ---- Executor: first ready task ----
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

      // ---- Executor: second ready task ----
      fauxAssistantMessage(
        [
          fauxToolCall('run_command', {
            command: 'git add task-b.txt',
          }),
          fauxToolCall('run_command', {
            command: 'git commit -m "docs: task-b"',
          }),
          fauxToolCall('submit', {
            summary: 'documented X',
            filesChanged: ['task-b.txt'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('task-b done')]),

      // ---- Verifier: submitVerify(pass) ----
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

    // ---- Phase 1: plan runs, lands in await_approval. -----------------
    await scheduler.step(100);
    await harness.drain();

    const planRun = store.getAgentRun('run-feature:f-e2e:plan');
    expect(planRun).toMatchObject({
      runStatus: 'await_approval',
      owner: 'manual',
    });
    expect(planRun?.payloadJson).toBeDefined();

    // ---- Phase 2: approve proposal → tasks created, feature → executing.
    scheduler.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: feature.id,
      phase: 'plan',
      decision: 'approved',
    });
    await scheduler.step(200);
    await harness.drain();

    const tasksAfterPlan = [...graph.tasks.values()].filter(
      (task) => task.featureId === feature.id,
    );
    expect(tasksAfterPlan).toHaveLength(2);
    expect(graph.features.get(feature.id)).toMatchObject({
      workControl: 'executing',
      collabControl: 'branch_open',
    });
    expect(store.getAgentRun('run-feature:f-e2e:plan')).toMatchObject({
      runStatus: 'completed',
    });

    // ---- Phase 3: drive the scheduler until every task is done+merged.
    // Task execution produces real git commits through the in-process
    // worker runtime. Each step() drains worker_message events and
    // dispatches the next ready task as workers free up.
    await fixture.stepUntil(
      () => {
        const feat = graph.features.get(feature.id);
        if (feat === undefined) return false;
        // ci_check dispatched and completed → verifying (then awaiting_merge)
        return (
          feat.workControl === 'awaiting_merge' ||
          feat.workControl === 'verifying'
        );
      },
      { maxTicks: 40 },
    );

    // All tasks done+merged (task.onTaskLanded bumps feature out of executing).
    for (const task of tasksAfterPlan) {
      const current = graph.tasks.get(task.id);
      expect(current).toMatchObject({
        status: 'done',
        collabControl: 'merged',
      });
    }

    // ---- Phase 4: continue driving until verify phase completes. ------
    await fixture.stepUntil(
      () => graph.features.get(feature.id)?.workControl === 'awaiting_merge',
      { maxTicks: 10 },
    );

    const finalFeature = graph.features.get(feature.id);
    expect(finalFeature?.workControl).toBe('awaiting_merge');

    // markAwaitingMerge → enqueueFeatureMerge advances collabControl
    // past `branch_open` to `merge_queued` (and `beginNextIntegration`
    // in the following tick may further advance it to `integrating`).
    // Both are legitimate post-verify states; what matters for this
    // plan is that the feature REACHED awaiting_merge cleanly. Merge-
    // train promotion (awaiting_merge → integrating → merged) belongs
    // to Phase 6; we assert only that collabControl is no longer
    // `branch_open` and is not in any failure/repair lane.
    expect(['merge_queued', 'integrating']).toContain(
      finalFeature?.collabControl,
    );

    // ---- Phase-agent runs are each `completed`. -----------------------
    for (const phase of ['plan', 'ci_check', 'verify'] as const) {
      const run = store.getAgentRun(`run-feature:f-e2e:${phase}`) as
        | AgentRun
        | undefined;
      expect(run, `expected run-feature:f-e2e:${phase} to exist`).toBeDefined();
      expect(run?.runStatus).toBe('completed');
    }

    // ---- Event log: ci_check + verify phase-complete events landed. --
    const events = store.listEvents({ entityId: feature.id });
    const completedPhases = events
      .filter((event) => event.eventType === 'feature_phase_completed')
      .map((event) => (event.payload as { phase?: string }).phase);
    expect(completedPhases).toEqual(
      expect.arrayContaining(['plan', 'ci_check', 'verify']),
    );

    // ---- Each task produced a real commit whose trailers round-tripped.
    // The fixture's workerMessages array captures every pool frame; one
    // commit_done(trailerOk=true) per task.
    const commitFrames = fixture.workerMessages.filter(
      (m): m is typeof m & { type: 'commit_done' } => m.type === 'commit_done',
    );
    expect(commitFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of commitFrames) {
      expect(frame.trailerOk).toBe(true);
      expect(frame.sha).toMatch(/^[0-9a-f]{7,}$/);
    }
  }, 30_000);
});

describe('feature lifecycle e2e — repair loop', () => {
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

  it('re-runs execute → ci_check → verify after a verify repair task lands', async () => {
    const { faux, graph, store } = fixture;
    const feature = fixture.seedFeature('f-repair', {
      workControl: 'executing',
      collabControl: 'branch_open',
      tasks: ['implement X'],
    });
    const featureWorktree = fixture.featureWorktreePath(feature.featureBranch);
    process.chdir(featureWorktree);

    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(featureWorktree, 'task-a.txt'), 'task-a\n');
    fs.writeFileSync(path.join(featureWorktree, 'repair.txt'), 'repair\n');

    faux.setResponses([
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
            outcome: 'repair_needed',
            summary: 'Repair needed: integrated flow not proven.',
            failedChecks: ['integrated flow not proven'],
            repairFocus: ['add proof for integrated flow'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),
      fauxAssistantMessage(
        [
          fauxToolCall('run_command', {
            command: 'git add repair.txt',
          }),
          fauxToolCall('run_command', {
            command: 'git commit -m "fix: verify repair"',
          }),
          fauxToolCall('submit', {
            summary: 'repaired verify issues',
            filesChanged: ['repair.txt'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('verify repair done')]),
      fauxAssistantMessage(
        [
          fauxToolCall('submitVerify', {
            outcome: 'pass',
            summary: 'repair verified',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),
    ]);

    await fixture.stepUntil(
      () => graph.features.get(feature.id)?.workControl === 'executing_repair',
      { maxTicks: 40 },
    );

    const midFeature = graph.features.get(feature.id);
    expect(midFeature).toMatchObject({
      workControl: 'executing_repair',
      collabControl: 'branch_open',
    });
    const repairTask = [...graph.tasks.values()].find(
      (task) => task.featureId === feature.id && task.repairSource === 'verify',
    );
    expect(repairTask).toBeDefined();
    expect(repairTask?.description).toContain(
      'Repair feature verification issues',
    );

    const firstVerifyEvents = store
      .listEvents({ entityId: feature.id })
      .filter(
        (event) =>
          event.eventType === 'feature_phase_completed' &&
          (event.payload as { phase?: string }).phase === 'verify',
      );
    expect(firstVerifyEvents).toHaveLength(1);
    expect(firstVerifyEvents[0]?.payload).toMatchObject({
      phase: 'verify',
      extra: {
        outcome: 'repair_needed',
        failedChecks: ['integrated flow not proven'],
      },
    });

    await fixture.stepUntil(
      () => graph.features.get(feature.id)?.workControl === 'awaiting_merge',
      { maxTicks: 40 },
    );

    const finalFeature = graph.features.get(feature.id);
    expect(finalFeature?.workControl).toBe('awaiting_merge');
    expect(['merge_queued', 'integrating']).toContain(
      finalFeature?.collabControl,
    );

    const featureTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === feature.id,
    );
    expect(featureTasks).toHaveLength(2);
    for (const task of featureTasks) {
      expect(task).toMatchObject({
        status: 'done',
        collabControl: 'merged',
      });
    }

    const verifyEvents = store
      .listEvents({ entityId: feature.id })
      .filter(
        (event) =>
          event.eventType === 'feature_phase_completed' &&
          (event.payload as { phase?: string }).phase === 'verify',
      );
    expect(verifyEvents).toHaveLength(2);
    expect(verifyEvents[0]?.payload).toMatchObject({
      phase: 'verify',
      extra: {
        outcome: 'repair_needed',
        failedChecks: ['integrated flow not proven'],
      },
    });
    expect(verifyEvents[1]?.payload).toMatchObject({
      phase: 'verify',
      extra: {
        ok: true,
        outcome: 'pass',
        summary: 'repair verified',
      },
    });

    const verifyRun = store.getAgentRun('run-feature:f-repair:verify');
    expect(verifyRun).toMatchObject({
      runStatus: 'completed',
      owner: 'system',
    });
    expect(JSON.parse(verifyRun?.payloadJson ?? '{}')).toMatchObject({
      ok: true,
      outcome: 'pass',
      summary: 'repair verified',
    });

    const featureTaskIds = new Set<string>(featureTasks.map((task) => task.id));
    const commitFrames = fixture.workerMessages.filter(
      (message): message is Extract<typeof message, { type: 'commit_done' }> =>
        message.type === 'commit_done' && featureTaskIds.has(message.taskId),
    );
    expect(commitFrames).toHaveLength(2);
    for (const frame of commitFrames) {
      expect(frame.trailerOk).toBe(true);
      expect(frame.sha).toMatch(/^[0-9a-f]{7,}$/);
    }
  }, 30_000);
});
