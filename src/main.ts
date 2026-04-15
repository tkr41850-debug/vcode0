import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppMode } from '@core/types/index';
import { composeApplication } from '@root/compose';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  appFactory: typeof composeApplication = composeApplication,
): Promise<void> {
  applyWorkingDirectory(argv);
  writeStartupNotice();
  const app = await appFactory();
  const mode = parseAppMode(argv);
  await app.start(mode);
}

export function parseAppMode(argv: readonly string[]): AppMode {
  return argv.includes('--auto') ? 'auto' : 'interactive';
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  appFactory: typeof composeApplication = composeApplication,
): Promise<void> {
  let app: Awaited<ReturnType<typeof composeApplication>> | undefined;

  try {
    applyWorkingDirectory(argv);
    writeStartupNotice();
    app = await appFactory();
    const mode = parseAppMode(argv);
    await app.start(mode);
  } catch (error) {
    process.stderr.write(`${formatStartupError(error)}\n`);
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

function formatStartupError(error: unknown): string {
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
