import type { IpcBridge } from '@agents/worker/ipc-bridge';
import { createPathLockClaimer } from '@agents/worker/path-lock';
import { createAppendKnowledgeTool } from '@agents/worker/tools/append-knowledge';
import { createConfirmTool } from '@agents/worker/tools/confirm';
import { createEditFileTool } from '@agents/worker/tools/edit-file';
import { createGitDiffTool } from '@agents/worker/tools/git-diff';
import { createGitStatusTool } from '@agents/worker/tools/git-status';
import { createListFilesTool } from '@agents/worker/tools/list-files';
import { createReadFileTool } from '@agents/worker/tools/read-file';
import { createRecordDecisionTool } from '@agents/worker/tools/record-decision';
import { createRequestApprovalTool } from '@agents/worker/tools/request-approval';
import { createRequestHelpTool } from '@agents/worker/tools/request-help';
import { createRunCommandTool } from '@agents/worker/tools/run-command';
import { createSearchFilesTool } from '@agents/worker/tools/search-files';
import { createSubmitTool } from '@agents/worker/tools/submit';
import { createWriteFileTool } from '@agents/worker/tools/write-file';
import type { AgentTool } from '@mariozechner/pi-agent-core';

export interface WorkerToolsetDeps {
  /** IPC seam for orchestrator round-trips (blocking tools, submit). */
  ipc: IpcBridge;
  /** Absolute path to the task's git worktree — file/command tools run here. */
  workdir: string;
  /** Absolute path to the project root — knowledge files live under `.gvc0/`. */
  projectRoot: string;
  /**
   * REQ-EXEC-02: called by the run-command tool after each `git commit`
   * lands (exit 0) — carries the resulting SHA and whether the required
   * `gvc0-task-id` + `gvc0-run-id` trailers were found. The worker runtime
   * translates this into a `commit_done` IPC frame.
   */
  onCommitDone?: (sha: string, trailerOk: boolean) => void;
}

/**
 * Assemble the full worker tool catalog for one run.
 *
 * The factory returns a fresh array every call so runs never share mutable tool
 * state. Each tool is constructed from its own file and closes over only the
 * dependencies it needs.
 */
// pi-sdk's `AgentState.tools` is typed `AgentTool<any>[]`. The per-tool
// factories return specific `AgentTool<TSchema, TDetails>` types that cannot
// be assigned to `AgentTool<TSchema, any>` under `exactOptionalPropertyTypes`
// without widening the element type here.
// biome-ignore lint/suspicious/noExplicitAny: matches pi-sdk's own AgentTool<any>[] signature
type WorkerTool = AgentTool<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function buildWorkerToolset(deps: WorkerToolsetDeps): WorkerTool[] {
  const claimer = createPathLockClaimer(deps.ipc);
  return [
    createSubmitTool(deps.ipc),
    createConfirmTool(deps.ipc),
    createRequestHelpTool(deps.ipc),
    createRequestApprovalTool(deps.ipc),
    createAppendKnowledgeTool(deps.projectRoot),
    createRecordDecisionTool(deps.projectRoot),
    createReadFileTool(deps.workdir),
    createWriteFileTool(deps.workdir, claimer),
    createEditFileTool(deps.workdir, claimer),
    createListFilesTool(deps.workdir),
    createSearchFilesTool(deps.workdir),
    createRunCommandTool({
      workdir: deps.workdir,
      taskId: deps.ipc.taskId,
      agentRunId: deps.ipc.agentRunId,
      ...(deps.onCommitDone !== undefined
        ? { onCommitDone: deps.onCommitDone }
        : {}),
    }),
    createGitStatusTool(deps.workdir),
    createGitDiffTool(deps.workdir),
  ] as WorkerTool[];
}
