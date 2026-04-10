import type { TaskRow } from '@persistence/queries';
import { QuerySerializer } from '@persistence/queries';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('query serializer', () => {
  it('keeps authoritative persisted task state typed at the row boundary', () => {
    expectTypeOf<TaskRow['status']>().toEqualTypeOf<
      | 'pending'
      | 'ready'
      | 'running'
      | 'stuck'
      | 'done'
      | 'failed'
      | 'cancelled'
    >();
    expectTypeOf<TaskRow['suspend_reason']>().toEqualTypeOf<
      'same_feature_overlap' | 'cross_feature_overlap' | null
    >();
  });

  it('round-trips JSON payloads used for TEXT-backed support fields', () => {
    const serializer = new QuerySerializer();
    const value = {
      reservedWritePaths: ['src/core/types/index.ts'],
      blockedByFeatureId: 'feature-2',
    };

    const encoded = serializer.serializeJson(value);

    expect(serializer.parseJson<typeof value>(encoded)).toEqual(value);
  });
});
