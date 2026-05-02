import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppMode } from '@core/types/index';
import {
  composeApplication,
  type ExplainTarget,
  explainProject,
} from '@root/compose';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  appFactory: typeof composeApplication = composeApplication,
  explainFactory: typeof explainProject = explainProject,
): Promise<void> {
  await runCli(argv, appFactory, explainFactory);
}

export function parseAppMode(argv: readonly string[]): AppMode {
  return argv.includes('--auto') ? 'auto' : 'interactive';
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  appFactory: typeof composeApplication = composeApplication,
  explainFactory: typeof explainProject = explainProject,
): Promise<void> {
  let app: Awaited<ReturnType<typeof composeApplication>> | undefined;

  try {
    applyWorkingDirectory(argv);
    const explainTarget = parseExplainTarget(argv);
    if (explainTarget !== undefined) {
      process.stdout.write(`${await explainFactory(explainTarget)}\n`);
      return;
    }

    writeStartupNotice();
    app = await appFactory();
    const mode = parseAppMode(argv);
    await app.start(mode);
  } catch (error) {
    process.stderr.write(`${formatCliError(error, argv)}\n`);
    process.exitCode = 1;
    if (app !== undefined) {
      try {
        await app.stop();
      } catch (stopError) {
        process.stderr.write(
          `Failed to stop gvc0 cleanly: ${formatUnknownError(stopError)}\n`,
        );
      }
    }
  }
}

function applyWorkingDirectory(argv: readonly string[]): void {
  const cwd = resolveWorkingDirectory(argv);
  if (cwd !== undefined) {
    process.chdir(cwd);
  }
}

function resolveWorkingDirectory(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--cwd');
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}

function writeStartupNotice(): void {
  process.stdout.write('loading...\n');
}

class ExplainCliError extends Error {}

function parseExplainTarget(
  argv: readonly string[],
): ExplainTarget | undefined {
  const args = stripGlobalCliOptions(argv);
  if (args[0] !== 'explain') {
    return undefined;
  }

  const [_, kind, id, ...rest] = args;
  if (rest.length > 0 || kind === undefined || id === undefined) {
    throw new ExplainCliError('Usage: gvc0 explain <feature|task|run> <id>');
  }
  if (kind !== 'feature' && kind !== 'task' && kind !== 'run') {
    throw new ExplainCliError(
      `Unsupported explain target "${kind}". Usage: gvc0 explain <feature|task|run> <id>`,
    );
  }

  return { kind, id };
}

function stripGlobalCliOptions(argv: readonly string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--auto') {
      continue;
    }
    if (arg === '--cwd') {
      index += 1;
      continue;
    }
    args.push(arg);
  }
  return args;
}

function formatCliError(error: unknown, argv: readonly string[]): string {
  if (error instanceof ExplainCliError) {
    return error.message;
  }
  if (stripGlobalCliOptions(argv)[0] === 'explain') {
    return `Failed to run gvc0 explain: ${formatUnknownError(error)}`;
  }
  return `Failed to start gvc0 TUI: ${formatUnknownError(error)}`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  void runCli();
}

export function isExecutedAsMain(
  moduleUrl: string,
  argv1: string | undefined,
): boolean {
  if (import.meta.main) {
    return true;
  }
  if (argv1 === undefined) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  return path.resolve(argv1) === path.resolve(modulePath);
}
