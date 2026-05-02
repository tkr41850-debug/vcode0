#!/usr/bin/env node

'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');
const sourceBuildPath = path.join(nodePtyDir, 'build', 'Release', 'pty.node');
const isMuslLinux =
  process.platform === 'linux' &&
  process.report?.getReport().header.glibcVersionRuntime === undefined;

function tryLoadPty(binaryPath) {
  try {
    require(binaryPath);
    return true;
  } catch {
    return false;
  }
}

if (tryLoadPty(sourceBuildPath)) {
  process.exit(0);
}

if (!isMuslLinux) {
  const prebuildPath = path.join(
    nodePtyDir,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'pty.node',
  );
  if (tryLoadPty(prebuildPath)) {
    process.exit(0);
  }
}

console.log(
  '[gvc0 postinstall] node-pty native binary not loadable for this environment. ' +
    'Rebuilding from source via node-gyp...',
);

try {
  execSync('node-gyp rebuild', {
    cwd: nodePtyDir,
    stdio: 'inherit',
  });
  console.log('[gvc0 postinstall] node-pty rebuilt successfully.');
} catch (err) {
  console.error('[gvc0 postinstall] node-gyp rebuild failed:', err.message);
  // Non-fatal: warn but do not break npm install for users who will not run
  // the TUI e2e lane on this platform. The SIGSEGV will reappear only when
  // tui-test tries to spawn a PTY.
  process.exit(0);
}
