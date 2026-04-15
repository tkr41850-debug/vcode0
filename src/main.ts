import type { AppMode } from '@core/types/index';
import { composeApplication } from '@root/compose';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  appFactory: typeof composeApplication = composeApplication,
): Promise<void> {
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

function formatStartupError(error: unknown): string {
  return `Failed to start gvc0 TUI: ${formatUnknownError(error)}`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (import.meta.main) {
  void runCli();
}
