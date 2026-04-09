import { QuerySerializer } from '@persistence/queries';
import { describe, expect, it } from 'vitest';

describe('query serializer', () => {
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
