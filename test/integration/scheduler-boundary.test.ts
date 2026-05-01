import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Plan 04-01 Task 3: AST boundary walker.
 *
 * Enforces that specific files (compose.ts and agents/runtime.ts) do
 * NOT directly mutate the FeatureGraph outside of explicitly
 * allowlisted call sites. The walker scans the files listed in the
 * adjacent allowlist JSON, collects every call expression that targets
 * one of the known mutation methods, and fails if any is not covered by
 * the allowlist.
 *
 * The mutation method set is the canonical list of 23 FeatureGraph
 * mutators — kept in sync with `src/core/graph/types.ts`. When a new
 * mutator is added, both the type and this set must update together.
 */

// 23 mutator methods defined on the FeatureGraph interface.
const MUTATION_METHODS = new Set([
  'createMilestone',
  'createFeature',
  'createTask',
  'addDependency',
  'removeDependency',
  'splitFeature',
  'mergeFeatures',
  'cancelFeature',
  'removeFeature',
  'changeMilestone',
  'editFeature',
  'editMilestone',
  'addTask',
  'editTask',
  'removeTask',
  'removeMilestone',
  'reorderTasks',
  'reweight',
  'queueMilestone',
  'dequeueMilestone',
  'clearQueuedMilestones',
  'transitionFeature',
  'transitionTask',
  'updateMergeTrainState',
  'replaceUsageRollups',
]);

interface AllowlistEntry {
  methods: string[];
  reason: string;
}

interface AllowlistSchema {
  scanned_files: string[];
  allowlist: Record<string, AllowlistEntry[]>;
}

interface MutationSite {
  file: string;
  method: string;
  line: number;
  column: number;
}

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST_PATH = path.join(
  __dirname,
  'scheduler-boundary-allowlist.json',
);

function loadAllowlist(): AllowlistSchema {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
  return JSON.parse(raw) as AllowlistSchema;
}

function scanMutationSites(relFile: string): MutationSite[] {
  const absFile = path.join(REPO_ROOT, relFile);
  const src = fs.readFileSync(absFile, 'utf-8');
  const source = ts.createSourceFile(
    relFile,
    src,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const sites: MutationSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;
        if (MUTATION_METHODS.has(methodName)) {
          const { line, character } = source.getLineAndCharacterOfPosition(
            callee.name.getStart(source),
          );
          sites.push({
            file: relFile,
            method: methodName,
            line: line + 1,
            column: character + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return sites;
}

describe('Scheduler boundary — AST walker', () => {
  const allowlist = loadAllowlist();

  it('known mutation method set covers the entire FeatureGraph interface', () => {
    const typesSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'core', 'graph', 'types.ts'),
      'utf-8',
    );
    // Extract every "methodName(...): void/ReturnType;" declaration from
    // the `FeatureGraph` interface block. This is a sanity check that
    // the MUTATION_METHODS set above matches the interface.
    const interfaceMatch = typesSrc.match(
      /export interface FeatureGraph \{([\s\S]*?)\n\}/,
    );
    expect(interfaceMatch, 'FeatureGraph interface not found').toBeTruthy();
    const body = interfaceMatch?.[1] ?? '';
    const declaredMethods = [
      ...body.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\(/gm),
    ].map((m) => m[1] ?? '');
    const mutatorsInInterface = declaredMethods.filter(
      (name) =>
        // Non-mutator methods defined on the interface — read-only or
        // tick-lifecycle hooks.
        ![
          'snapshot',
          'readyFeatures',
          'readyTasks',
          'queuedMilestones',
          'isComplete',
          '__enterTick',
          '__leaveTick',
        ].includes(name),
    );
    expect(new Set(mutatorsInInterface)).toEqual(MUTATION_METHODS);
  });

  it('scanned files have zero unexpected mutation sites (all covered by allowlist)', () => {
    const violations: MutationSite[] = [];

    for (const relFile of allowlist.scanned_files) {
      const sites = scanMutationSites(relFile);
      const allowedMethods = new Set<string>();
      for (const entry of allowlist.allowlist[relFile] ?? []) {
        for (const method of entry.methods) {
          allowedMethods.add(method);
        }
      }
      for (const site of sites) {
        if (!allowedMethods.has(site.method)) {
          violations.push(site);
        }
      }
    }

    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.file}:${v.line}:${v.column} — direct mutation graph.${v.method}() — route through schedulerRef.current?.enqueue(...) or add to allowlist with justification`,
        )
        .join('\n');
      throw new Error(
        `\nScheduler boundary violation — ${violations.length} direct graph mutation(s) found in scanned files:\n${formatted}\n`,
      );
    }

    expect(violations.length).toBe(0);
  }, 15_000);

  it('scanned files exist and contain at least one allowlisted mutation (allowlist is live, not stale)', () => {
    for (const relFile of allowlist.scanned_files) {
      const absFile = path.join(REPO_ROOT, relFile);
      expect(fs.existsSync(absFile), `${relFile} must exist`).toBe(true);
      const sites = scanMutationSites(relFile);
      // At least one mutation should land in this file — if zero, the
      // allowlist is probably stale and we should remove the file from
      // scanned_files.
      expect(sites.length).toBeGreaterThan(0);
    }
  });

  it('allowlist does not mention methods outside the known mutator set', () => {
    for (const [file, entries] of Object.entries(allowlist.allowlist)) {
      for (const entry of entries) {
        for (const method of entry.methods) {
          expect(
            MUTATION_METHODS.has(method),
            `allowlist for ${file} references unknown mutator "${method}"`,
          ).toBe(true);
        }
      }
    }
  });
});
