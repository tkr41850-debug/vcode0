import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = 'src/core';
const DISALLOWED_ALIASES = [
  '@runtime',
  '@persistence',
  '@tui',
  '@orchestrator',
  '@agents',
  '@app',
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkTsFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('src/core architectural boundary', () => {
  const files = walkTsFiles(CORE_ROOT);

  it.each(files)(
    '%s does not import from runtime/persistence/tui/orchestrator/agents/app',
    (file) => {
      const content = readFileSync(file, 'utf8');
      for (const alias of DISALLOWED_ALIASES) {
        const patterns = [
          new RegExp(`from\\s+["']${alias}["']`),
          new RegExp(`from\\s+["']${alias}/`),
          new RegExp(`import\\s*\\(\\s*["']${alias}["']`),
          new RegExp(`import\\s*\\(\\s*["']${alias}/`),
        ];
        for (const pattern of patterns) {
          expect(
            pattern.test(content),
            `${file} must not import from ${alias}* — found match for ${pattern}`,
          ).toBe(false);
        }
      }
    },
  );
});
