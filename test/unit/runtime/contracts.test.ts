import type {
  DispatchRunResult,
  OrchestratorToWorkerMessage,
  PhaseOutput,
  RunScope,
  RuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { describe, expectTypeOf, it } from 'vitest';

/**
 * Compile-only tests for scope-aware dispatch envelope types.
 *
 * These types are introduced in Phase A.1 of the dispatch-unification plan.
 * They do not yet replace task-only `TaskRuntimeDispatch` / `DispatchTaskResult`
 * surface; later Phase A commits wire them through the runtime port.
 */
describe('scope-aware runtime contracts', () => {
  it('RunScope discriminates task vs feature_phase', () => {
    const asTask: RunScope = {
      kind: 'task',
      taskId: 't-1',
      featureId: 'f-1',
    };
    const asPhase: RunScope = {
      kind: 'feature_phase',
      featureId: 'f-1',
      phase: 'discuss',
    };
    expectTypeOf(asTask).toMatchTypeOf<RunScope>();
    expectTypeOf(asPhase).toMatchTypeOf<RunScope>();
  });

  it('RuntimeDispatch covers start and resume modes', () => {
    expectTypeOf<RuntimeDispatch>().toEqualTypeOf<
      | { mode: 'start'; agentRunId: string }
      | { mode: 'resume'; agentRunId: string; sessionId: string }
    >();
  });

  it('PhaseOutput covers every scope result shape', () => {
    // Discriminant must enumerate all phase output kinds. Narrowing on `kind`
    // should surface the phase-specific result field.
    const task: PhaseOutput = {
      kind: 'task',
      result: { summary: 'done', filesChanged: [] },
    };
    expectTypeOf(task).toMatchTypeOf<PhaseOutput>();

    const text: PhaseOutput = {
      kind: 'text_phase',
      phase: 'discuss',
      result: { summary: 'x' },
    };
    expectTypeOf(text).toMatchTypeOf<PhaseOutput>();

    const proposal: PhaseOutput = {
      kind: 'proposal',
      phase: 'plan',
      result: {
        summary: 's',
        proposal: { version: 1, mode: 'plan', aliases: {}, ops: [] },
        details: {
          summary: 's',
          chosenApproach: 'x',
          keyConstraints: [],
          decompositionRationale: [],
          orderingRationale: [],
          verificationExpectations: [],
          risksTradeoffs: [],
          assumptions: [],
        },
      },
    };
    expectTypeOf(proposal).toMatchTypeOf<PhaseOutput>();

    const verification: PhaseOutput = {
      kind: 'verification',
      verification: { ok: true, summary: 'ok', outcome: 'pass' },
    };
    expectTypeOf(verification).toMatchTypeOf<PhaseOutput>();

    const ci: PhaseOutput = {
      kind: 'ci_check',
      verification: { ok: true, summary: 'ok', outcome: 'pass' },
    };
    expectTypeOf(ci).toMatchTypeOf<PhaseOutput>();
  });

  it('DispatchRunResult covers started, resumed, completed_inline, awaiting_approval, not_resumable', () => {
    const started: DispatchRunResult = {
      kind: 'started',
      agentRunId: 'run-1',
      sessionId: 'run-1',
    };
    const resumed: DispatchRunResult = {
      kind: 'resumed',
      agentRunId: 'run-1',
      sessionId: 'run-1',
    };
    const completed: DispatchRunResult = {
      kind: 'completed_inline',
      agentRunId: 'run-1',
      sessionId: 'run-1',
      output: { kind: 'task', result: { summary: '', filesChanged: [] } },
    };
    const awaiting: DispatchRunResult = {
      kind: 'awaiting_approval',
      agentRunId: 'run-1',
      sessionId: 'run-1',
      output: {
        kind: 'proposal',
        phase: 'plan',
        result: {
          summary: '',
          proposal: { version: 1, mode: 'plan', aliases: {}, ops: [] },
          details: {
            summary: '',
            chosenApproach: '',
            keyConstraints: [],
            decompositionRationale: [],
            orderingRationale: [],
            verificationExpectations: [],
            risksTradeoffs: [],
            assumptions: [],
          },
        },
      },
    };
    const notResumable: DispatchRunResult = {
      kind: 'not_resumable',
      agentRunId: 'run-1',
      sessionId: 'sess-gone',
      reason: 'session_not_found',
    };

    expectTypeOf(started).toMatchTypeOf<DispatchRunResult>();
    expectTypeOf(resumed).toMatchTypeOf<DispatchRunResult>();
    expectTypeOf(completed).toMatchTypeOf<DispatchRunResult>();
    expectTypeOf(awaiting).toMatchTypeOf<DispatchRunResult>();
    expectTypeOf(notResumable).toMatchTypeOf<DispatchRunResult>();
  });

  it('OrchestratorToWorkerMessage carries optional scopeRef alongside legacy taskId', () => {
    // scopeRef is optional for now so construction sites can migrate
    // incrementally. Later commits populate it everywhere and make it required.
    const runWithScope: OrchestratorToWorkerMessage = {
      type: 'run',
      taskId: 't-1',
      agentRunId: 'run-1',
      scopeRef: { kind: 'task', taskId: 't-1', featureId: 'f-1' },
      dispatch: { mode: 'start', agentRunId: 'run-1' },
      task: {
        id: 't-1',
        featureId: 'f-1',
        orderInFeature: 0,
        description: '',
        dependsOn: [],
        status: 'ready',
        collabControl: 'none',
      },
      payload: {},
    };
    expectTypeOf(runWithScope).toMatchTypeOf<OrchestratorToWorkerMessage>();
    expectTypeOf<
      Extract<OrchestratorToWorkerMessage, { type: 'run' }>['scopeRef']
    >().toEqualTypeOf<RunScope | undefined>();
  });

  it('WorkerToOrchestratorMessage carries optional scopeRef alongside legacy taskId', () => {
    const progressWithScope: WorkerToOrchestratorMessage = {
      type: 'progress',
      taskId: 't-1',
      agentRunId: 'run-1',
      scopeRef: { kind: 'task', taskId: 't-1', featureId: 'f-1' },
      message: 'still running',
    };
    expectTypeOf(
      progressWithScope,
    ).toMatchTypeOf<WorkerToOrchestratorMessage>();
    expectTypeOf<
      Extract<WorkerToOrchestratorMessage, { type: 'progress' }>['scopeRef']
    >().toEqualTypeOf<RunScope | undefined>();
  });
});
