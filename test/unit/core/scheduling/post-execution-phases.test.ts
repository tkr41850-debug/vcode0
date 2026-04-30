import { featurePhaseCategory } from '@core/scheduling/index';
import type { FeatureWorkControl } from '@core/types/index';
import { describe, expect, it } from 'vitest';

describe('featurePhaseCategory', () => {
  it('classifies pre-execution phases as "pre"', () => {
    const phases: FeatureWorkControl[] = [
      'discussing',
      'researching',
      'planning',
      'replanning',
    ];
    for (const phase of phases) {
      expect(featurePhaseCategory(phase)).toBe('pre');
    }
  });

  it('classifies executing as "executing"', () => {
    expect(featurePhaseCategory('executing')).toBe('executing');
  });

  it('classifies post-execution phases (including awaiting_merge) as "post"', () => {
    const phases: FeatureWorkControl[] = [
      'ci_check',
      'verifying',
      'summarizing',
      'awaiting_merge',
    ];
    for (const phase of phases) {
      expect(featurePhaseCategory(phase)).toBe('post');
    }
  });

  it('classifies work_complete as "done"', () => {
    expect(featurePhaseCategory('work_complete')).toBe('done');
  });
});
