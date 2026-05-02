#!/usr/bin/env node

'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');

function tryLoadPty() {
  try {
    // Attempt the same load that node-pty's utils.js does at runtime.
    require(path.join(nodePtyDir, 'build', 'Release', 'pty.node'));
    return true;
  } catch {
    // fall through to prebuild check
  }
  try {
    const prebuildPath = path.join(
      nodePtyDir,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'pty.node',
    );
    require(prebuildPath);
    return true;
  } catch {
    return false;
  }
}

if (tryLoadPty()) {
  // Binary already works; nothing to rebuild.
  process.exit(0);
}

console.log(
  '[gvc0 postinstall] node-pty prebuild not loadable in this environment ' +
    '(likely musl/Alpine). Rebuilding from source via node-gyp...',
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
