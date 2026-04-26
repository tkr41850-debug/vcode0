import type { IpcBridge } from '@agents/worker/ipc-bridge';
import { buildWorkerToolset } from '@agents/worker/toolset';
import { describe, expect, it } from 'vitest';

function noopBridge(): IpcBridge {
  return {
    taskId: 't-1',
    agentRunId: 'r-1',
    progress: () => {},
    requestHelp: () => Promise.resolve({ kind: 'discuss' }),
    requestApproval: () => Promise.resolve({ kind: 'approved' }),
    claimLock: () => Promise.resolve({ granted: true }),
    submitResult: () => Promise.resolve(),
  };
}

describe('buildWorkerToolset', () => {
  it('returns the full worker tool catalog with expected names', () => {
    const tools = buildWorkerToolset({
      ipc: noopBridge(),
      workdir: '/tmp',
      projectRoot: '/tmp',
    });

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'append_knowledge',
        'confirm',
        'edit_file',
        'git_diff',
        'git_status',
        'list_files',
        'read_file',
        'record_decision',
        'request_approval',
        'request_help',
        'run_command',
        'search_files',
        'submit',
        'write_file',
      ].sort(),
    );
  });

  it('does not share mutable toolset state across calls', () => {
    const deps = {
      ipc: noopBridge(),
      workdir: '/tmp',
      projectRoot: '/tmp',
    };

    const first = buildWorkerToolset(deps);
    first.length = 0;

    const second = buildWorkerToolset(deps);
    expect(second.length).toBeGreaterThan(0);
  });
});
