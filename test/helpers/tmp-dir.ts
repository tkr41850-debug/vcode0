import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach } from 'vitest';

export function useTmpDir(prefix: string): () => string {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join('/tmp', `${prefix}-`));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  return () => tmpDir;
}
