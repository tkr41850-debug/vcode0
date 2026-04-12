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
    submitResult: () => {},
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

  it('returns a fresh array on every call', () => {
    const deps = {
      ipc: noopBridge(),
      workdir: '/tmp',
      projectRoot: '/tmp',
    };
    const a = buildWorkerToolset(deps);
    const b = buildWorkerToolset(deps);
    expect(a).not.toBe(b);
  });
});
