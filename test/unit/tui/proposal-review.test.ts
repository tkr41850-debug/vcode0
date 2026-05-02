import type { GraphSnapshot } from '@core/graph/index';
import type { ProposalRebaseReason } from '@orchestrator/proposals/index';
import {
  diffProposalSnapshots,
  renderProposalDiff,
  renderProposalRebaseReason,
} from '@tui/proposal-review';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

const baseSnapshot = (): GraphSnapshot => ({
  milestones: [createMilestoneFixture()],
  features: [createFeatureFixture()],
  tasks: [],
});

describe('proposal-review · diffProposalSnapshots', () => {
  it('reports added milestone', () => {
    const before = baseSnapshot();
    const after: GraphSnapshot = {
      milestones: [
        ...before.milestones,
        createMilestoneFixture({ id: 'm-2', name: 'Milestone 2' }),
      ],
      features: [...before.features],
      tasks: [],
    };

    const diff = diffProposalSnapshots(before, after);
    expect(diff.addedMilestones.map((m) => m.id)).toEqual(['m-2']);
    expect(diff.removedMilestones).toHaveLength(0);
  });

  it('reports added feature', () => {
    const before = baseSnapshot();
    const after: GraphSnapshot = {
      milestones: [...before.milestones],
      features: [
        ...before.features,
        createFeatureFixture({ id: 'f-2', name: 'Feature 2' }),
      ],
      tasks: [],
    };

    const diff = diffProposalSnapshots(before, after);
    expect(diff.addedFeatures.map((f) => f.id)).toEqual(['f-2']);
    expect(diff.removedFeatures).toHaveLength(0);
  });

  it('reports removed feature', () => {
    const before: GraphSnapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture(),
        createFeatureFixture({ id: 'f-2', name: 'Feature 2' }),
      ],
      tasks: [],
    };
    const after: GraphSnapshot = {
      milestones: [...before.milestones],
      features: [createFeatureFixture()],
      tasks: [],
    };

    const diff = diffProposalSnapshots(before, after);
    expect(diff.removedFeatures.map((f) => f.id)).toEqual(['f-2']);
    expect(diff.addedFeatures).toHaveLength(0);
  });

  it('reports changed feature dependencies (edge add/remove)', () => {
    const before: GraphSnapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({ id: 'f-1', dependsOn: ['f-2'] }),
        createFeatureFixture({ id: 'f-2', name: 'F2' }),
        createFeatureFixture({ id: 'f-3', name: 'F3' }),
      ],
      tasks: [],
    };
    const after: GraphSnapshot = {
      milestones: [...before.milestones],
      features: [
        createFeatureFixture({ id: 'f-1', dependsOn: ['f-3'] }),
        createFeatureFixture({ id: 'f-2', name: 'F2' }),
        createFeatureFixture({ id: 'f-3', name: 'F3' }),
      ],
      tasks: [],
    };

    const diff = diffProposalSnapshots(before, after);
    expect(diff.changedFeatureEdges).toEqual([
      {
        featureId: 'f-1',
        addedDependencies: ['f-3'],
        removedDependencies: ['f-2'],
      },
    ]);
  });

  it('reports mixed diff', () => {
    const before: GraphSnapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({ id: 'f-1' }),
        createFeatureFixture({ id: 'f-2', name: 'F2' }),
      ],
      tasks: [],
    };
    const after: GraphSnapshot = {
      milestones: [
        createMilestoneFixture(),
        createMilestoneFixture({ id: 'm-2', name: 'M2' }),
      ],
      features: [
        createFeatureFixture({ id: 'f-1', dependsOn: ['f-3'] }),
        createFeatureFixture({ id: 'f-3', name: 'F3' }),
      ],
      tasks: [],
    };

    const diff = diffProposalSnapshots(before, after);
    expect(diff.addedMilestones.map((m) => m.id)).toEqual(['m-2']);
    expect(diff.addedFeatures.map((f) => f.id)).toEqual(['f-3']);
    expect(diff.removedFeatures.map((f) => f.id)).toEqual(['f-2']);
    expect(diff.changedFeatureEdges.map((c) => c.featureId)).toEqual(['f-1']);
  });
});

describe('proposal-review · renderProposalDiff', () => {
  it('renders empty diff with no-change marker', () => {
    const diff = diffProposalSnapshots(baseSnapshot(), baseSnapshot());
    const text = renderProposalDiff(diff);
    expect(text).toMatch(/no changes/i);
  });

  it('renders added milestones and features', () => {
    const before = baseSnapshot();
    const after: GraphSnapshot = {
      milestones: [
        ...before.milestones,
        createMilestoneFixture({ id: 'm-2', name: 'Milestone 2' }),
      ],
      features: [
        ...before.features,
        createFeatureFixture({ id: 'f-2', name: 'Feature 2' }),
      ],
      tasks: [],
    };
    const text = renderProposalDiff(diffProposalSnapshots(before, after));
    expect(text).toMatch(/\+ milestone m-2/);
    expect(text).toMatch(/\+ feature f-2/);
  });

  it('renders removed feature', () => {
    const before: GraphSnapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture(),
        createFeatureFixture({ id: 'f-2', name: 'F2' }),
      ],
      tasks: [],
    };
    const after = baseSnapshot();
    const text = renderProposalDiff(diffProposalSnapshots(before, after));
    expect(text).toMatch(/- feature f-2/);
  });

  it('renders edge changes', () => {
    const before: GraphSnapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({ id: 'f-1', dependsOn: ['f-2'] }),
        createFeatureFixture({ id: 'f-2', name: 'F2' }),
        createFeatureFixture({ id: 'f-3', name: 'F3' }),
      ],
      tasks: [],
    };
    const after: GraphSnapshot = {
      milestones: [...before.milestones],
      features: [
        createFeatureFixture({ id: 'f-1', dependsOn: ['f-3'] }),
        createFeatureFixture({ id: 'f-2', name: 'F2' }),
        createFeatureFixture({ id: 'f-3', name: 'F3' }),
      ],
      tasks: [],
    };
    const text = renderProposalDiff(diffProposalSnapshots(before, after));
    expect(text).toMatch(/f-1/);
    expect(text).toMatch(/\+ dep f-1 → f-3/);
    expect(text).toMatch(/- dep f-1 → f-2/);
  });
});

describe('proposal-review · renderProposalRebaseReason', () => {
  it('renders stale-baseline framing with versions', () => {
    const reason: ProposalRebaseReason = {
      kind: 'stale-baseline',
      details: { baseline: 3, current: 5 },
    };
    const text = renderProposalRebaseReason(reason);
    expect(text).toMatch(/stale/i);
    expect(text).toMatch(/baseline/i);
    expect(text).toMatch(/3/);
    expect(text).toMatch(/5/);
  });

  it('renders running-tasks-affected framing with feature ids', () => {
    const reason: ProposalRebaseReason = {
      kind: 'running-tasks-affected',
      details: { featureIds: ['f-1', 'f-2'] },
    };
    const text = renderProposalRebaseReason(reason);
    expect(text).toMatch(/running/i);
    expect(text).toMatch(/f-1/);
    expect(text).toMatch(/f-2/);
  });
});
