import { expect, test } from '@microsoft/tui-test';

const loadingTimeoutMs = 30_000;
const tuiReadyTimeoutMs = 30_000;
const postLoadingDelayMs = 3_000;

test.use({
  program: {
    file: 'npm',
    args: ['run', 'tui'],
  },
});

test('renders startup shell and keyboard help flow', async ({ terminal }) => {
  await expect(terminal.getByText('loading...')).toBeVisible({
    timeout: loadingTimeoutMs,
  });
  await delay(postLoadingDelayMs);
  await expect(terminal.getByText('gvc0 progress')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });
  await expect(terminal.getByText('No milestones yet.')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });

  terminal.keyPress('h');
  await expect(terminal.getByText('Help [h/q/esc hide]')).toBeVisible();
  await expect(terminal.getByText('Show or hide keyboard help.')).toBeVisible();
  await expect(terminal.getByText('Hide active overlay.')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Help')).not.toBeVisible();

  terminal.keyPress('q');
  await waitForExit(terminal);
});

test('opens monitor overlay and closes it before quit', async ({
  terminal,
}) => {
  await expect(terminal.getByText('loading...')).toBeVisible({
    timeout: loadingTimeoutMs,
  });
  await delay(postLoadingDelayMs);
  await expect(terminal.getByText('gvc0 progress')).toBeVisible({
    timeout: tuiReadyTimeoutMs,
  });

  terminal.keyPress('m');
  await expect(terminal.getByText('Agent Monitor')).toBeVisible();

  terminal.keyEscape();
  await expect(terminal.getByText('Agent Monitor')).not.toBeVisible();

  terminal.keyPress('q');
  await waitForExit(terminal);
});

function waitForExit(terminal: {
  exitResult: { exitCode: number; signal?: number | undefined } | null;
  onExit(
    callback: (exit: { exitCode: number; signal?: number | undefined }) => void,
  ): void;
}): Promise<{ exitCode: number; signal?: number | undefined }> {
  if (terminal.exitResult !== null) {
    return Promise.resolve(terminal.exitResult);
  }
  return new Promise((resolve) => {
    terminal.onExit(resolve);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
