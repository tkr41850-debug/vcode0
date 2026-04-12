#!/usr/bin/env node
import { main } from './main.js';

function printNotWiredBanner(message: string): void {
  process.stderr.write(
    [
      '',
      'gvc0: not yet runnable end-to-end',
      '----------------------------------',
      `reason: ${message}`,
      '',
      'unimplemented surfaces:',
      '  - compose.ts (composeApplication)',
      '  - GitPort   (real implementation)',
      '  - RuntimePort (process-per-task pool)',
      '  - AgentPort (pi-agent-core wiring)',
      '  - TuiApp    (real pi-tui rendering)',
      '',
    ].join('\n'),
  );
}

let shuttingDown = false;
function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\ngvc0: received ${signal}, exiting.\n`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

installSignalHandlers();

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  printNotWiredBanner(message);
  process.exit(1);
}
