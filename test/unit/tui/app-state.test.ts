import type { GraphSnapshot } from '@core/graph/index';
import { displayedSnapshot } from '@tui/app-state';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function snapshotWithLabel(label: string): GraphSnapshot {
  return {
    milestones: [createMilestoneFixture()],
    features: [createFeatureFixture({ name: label })],
    tasks: [],
  };
}

describe('displayedSnapshot precedence', () => {
  const authoritative = snapshotWithLabel('authoritative');
  const livePlanner = snapshotWithLabel('livePlanner');
  const manualDraft = snapshotWithLabel('manualDraft');

  it('returns authoritative when no draft and no live planner', () => {
    expect(displayedSnapshot(authoritative, undefined, undefined)).toBe(
      authoritative,
    );
  });

  it('returns live planner when no manual draft', () => {
    expect(displayedSnapshot(authoritative, undefined, livePlanner)).toBe(
      livePlanner,
    );
  });

  it('returns manual draft when both manual draft and live planner present', () => {
    expect(displayedSnapshot(authoritative, manualDraft, livePlanner)).toBe(
      manualDraft,
    );
  });

  it('returns manual draft when only manual draft present', () => {
    expect(displayedSnapshot(authoritative, manualDraft, undefined)).toBe(
      manualDraft,
    );
  });
});
