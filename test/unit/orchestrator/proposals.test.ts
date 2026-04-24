// Plan 05-01 Task 2: Pin edge-case semantics on applyGraphProposal for the
// planner → proposal apply path (REQ-PLAN-02 threat register T-05-01-01..03).
//
// Each test locks the current behavior with a deterministic assertion so
// Phase 7 (top-level planner) can rely on the same contract.
import {
  applyGraphProposal,
  type GraphProposal,
  type GraphProposalOp,
} from '@core/proposals/index';
import { describe, expect, it } from 'vitest';

import {
  createGraphWithFeature,
  createGraphWithTask,
  updateFeature,
} from '../../helpers/graph-builders.js';

function buildProposal(
  mode: 'plan' | 'replan',
  ops: GraphProposalOp[],
): GraphProposal {
  return { version: 1, mode, aliases: {}, ops };
}

describe('applyGraphProposal edge cases', () => {
  it('rejects cycle-creating addDependency into skipped[] with a cycle reason (T-05-01-01)', () => {
    // Pre-populate a feature with tasks t-1 and t-2, with an existing
    // dependency t-2 -> t-1.
    const graph = createGraphWithTask({ id: 't-1', description: 'A' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'B' });
    graph.addDependency({ from: 't-2', to: 't-1' });
    updateFeature(graph, 'f-1', { workControl: 'planning' });

    // Proposal attempts to add the reverse edge (t-1 -> t-2), which closes
    // the cycle t-1 -> t-2 -> t-1.
    const proposal = buildProposal('plan', [
      {
        kind: 'add_dependency',
        fromId: 't-1',
        toId: 't-2',
      },
    ]);

    const result = applyGraphProposal(graph, proposal);

    // Cycle op lands in skipped[] — GraphValidationError ("Cycle detected …")
    // caught by applyGraphProposal per src/core/proposals/index.ts:269-283.
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      opIndex: 0,
      op: expect.objectContaining({
        kind: 'add_dependency',
        fromId: 't-1',
        toId: 't-2',
      }),
    });
    expect(result.skipped[0]?.reason).toMatch(/cycle/i);

    // Graph unchanged: pre-existing t-2 -> t-1 dep still present; no reverse edge.
    expect(graph.tasks.get('t-2')?.dependsOn).toEqual(['t-1']);
    expect(graph.tasks.get('t-1')?.dependsOn).toEqual([]);
  });

  it('applies duplicate addTask calls as distinct tasks (ids are auto-allocated; no description-level uniqueness)', () => {
    // Decision (locked here): Planner-emitted duplicate addTask with the same
    // description is NOT deduplicated. Each add_task op allocates a fresh
    // task id via InMemoryFeatureGraph.addTask, and both land in applied[].
    // This matches the intent of CONTEXT § H (planner toolset is lean; the
    // orchestrator graph layer is the authoritative uniqueness check — and
    // it keys uniqueness by id, not description).
    const graph = createGraphWithFeature();
    updateFeature(graph, 'f-1', { workControl: 'planning' });

    const proposal = buildProposal('plan', [
      {
        kind: 'add_task',
        taskId: 't-1',
        featureId: 'f-1',
        description: 'Same description',
      },
      {
        kind: 'add_task',
        taskId: 't-2',
        featureId: 'f-1',
        description: 'Same description',
      },
    ]);

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toEqual([]);

    const featureTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-1',
    );
    expect(featureTasks).toHaveLength(2);
    expect(new Set(featureTasks.map((task) => task.id)).size).toBe(2);
    expect(
      featureTasks.every((task) => task.description === 'Same description'),
    ).toBe(true);
  });

  it('rejects add_task with an already-existing concrete id into skipped[] (uniqueness-at-id convention)', () => {
    // Complementary pin: while description-level duplicates are allowed (test
    // above), the id-level uniqueness IS enforced via
    // applyGraphProposal → staleReasonForOp("add_task") guard
    // (src/core/proposals/index.ts:602-608). Lock that convention.
    const graph = createGraphWithTask({ id: 't-1', description: 'Original' });
    updateFeature(graph, 'f-1', { workControl: 'planning' });

    const proposal = buildProposal('plan', [
      {
        kind: 'add_task',
        taskId: 't-1',
        featureId: 'f-1',
        description: 'Collides with existing t-1',
      },
    ]);

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/already exists/i);

    // Original task preserved; no overwrite.
    expect(graph.tasks.get('t-1')?.description).toBe('Original');
  });

  it('applies submit-before-addTask as an empty proposal (applied[] empty, skipped[] empty)', () => {
    // T-05-01-03: submit on zero-task feature with no add_task ops produces
    // an empty apply result. The orchestrator-level approveFeatureProposal
    // then cancels the feature (see proposals.test.ts::'plan phase acceptance'
    // integration test). This unit test pins the lower-level truth:
    // applyGraphProposal does not synthesize anything from `submit` because
    // `submit` is a tool on the proposal host, not a proposal op — so the
    // "empty" plan really is an empty ops[].
    const graph = createGraphWithFeature();
    updateFeature(graph, 'f-1', { workControl: 'planning' });

    const proposal = buildProposal('plan', []);

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.summary).toBe('0 applied, 0 skipped, 0 warnings');
    // Feature not mutated at the apply level — cancellation is an
    // orchestrator-level concern handled by approveFeatureProposal.
    expect(graph.features.get('f-1')?.collabControl).toBe('none');
  });
});
