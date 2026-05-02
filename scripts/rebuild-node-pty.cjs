#!/usr/bin/env node
// Rebuild node-pty from source when the prebuild is incompatible with this
// environment (e.g. Alpine Linux / musl libc). The prebuilds in
// node_modules/node-pty/prebuilds/ are glibc binaries; musl-based systems need
// a local compile via node-gyp.
//
// node-pty's own install script (node scripts/prebuild.js || node-gyp rebuild)
// only tests whether the prebuild *directory* exists, not whether the binary is
// loadable, so it silently picks up the incompatible prebuild on Alpine.
//
// This script:
//   1. Tries to require the pty.node native addon via node-pty's normal loader.
//   2. If it loads cleanly, exits 0 (nothing to do).
//   3. If it fails with a symbol-not-found or load error, invokes node-gyp
//      rebuild inside node_modules/node-pty and exits with that result code.
//
// Run via `npm run postinstall` (wired in package.json scripts).

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
