import type { IpcBridge } from '@agents/worker';
import { buildWorkerToolset } from '@agents/worker';
import type {
  GitConflictContext,
  Task,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { TaskPayload } from '@runtime/context/index';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
  OrchestratorToWorkerMessage,
  RuntimeUsageDelta,
  TaskRuntimeDispatch,
} from '@runtime/contracts';
import type { ChildIpcTransport } from '@runtime/ipc/index';
import { resolveModel } from '@runtime/routing/model-bridge';
import type { SessionStore } from '@runtime/sessions/index';
import { messagesToTokenUsageAggregate } from '@runtime/usage';
import { buildSystemPrompt } from '@runtime/worker/system-prompt';

export interface WorkerRuntimeConfig {
  modelId: string;
  /** Absolute path to the project root — used to locate `.gvc0/` knowledge files. */
  projectRoot: string;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

interface PendingHelp {
  resolve: (response: HelpResponse) => void;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
}

interface SuspensionState {
  reason: TaskSuspendReason;
  files: string[];
}

export class WorkerRuntime {
  private agent: Agent | undefined;
  private pendingHelp: PendingHelp | undefined;
  private pendingApproval: PendingApproval | undefined;
  private terminalResult: TaskResult | undefined;
  private suspended: SuspensionState | undefined;

  constructor(
    private readonly transport: ChildIpcTransport,
    private readonly sessionStore: SessionStore,
    private readonly config: WorkerRuntimeConfig,
  ) {}

  async run(
    task: Task,
    payload: TaskPayload,
    dispatch: TaskRuntimeDispatch,
  ): Promise<void> {
    const model = resolveModel(
      { model: this.config.modelId, tier: 'standard' },
      {
        enabled: false,
        ceiling: this.config.modelId,
        tiers: {
          heavy: this.config.modelId,
          standard: this.config.modelId,
          light: this.config.modelId,
        },
        escalateOnFailure: false,
        budgetPressure: false,
      },
    );

    const systemPrompt = buildSystemPrompt(task, payload);

    let messages: AgentMessage[] = [];
    if (dispatch.mode === 'resume') {
      const loaded = await this.sessionStore.load(dispatch.sessionId);
      if (loaded !== null) {
        messages = loaded;
      }
    }

    const ipcBridge = this.createIpcBridge(task.id, dispatch.agentRunId);
    const tools = buildWorkerToolset({
      ipc: ipcBridge,
      workdir: process.cwd(),
      projectRoot: this.config.projectRoot,
    });

    const agentOptions: NonNullable<ConstructorParameters<typeof Agent>[0]> = {
      initialState: {
        systemPrompt,
        model,
        tools,
        messages,
      },
    };
    if (this.config.getApiKey !== undefined) {
      agentOptions.getApiKey = this.config.getApiKey;
    }
    if (dispatch.mode === 'resume') {
      agentOptions.sessionId = dispatch.sessionId;
    }

    this.agent = new Agent(agentOptions);

    const sessionId =
      dispatch.mode === 'resume' ? dispatch.sessionId : dispatch.agentRunId;

    this.agent.subscribe((event: AgentEvent) =>
      this.handleAgentEvent(event, task.id, dispatch.agentRunId),
    );

    let runError: unknown;
    try {
      if (dispatch.mode === 'resume' && messages.length > 0) {
        await this.agent.continue();
      } else {
        await this.agent.prompt(task.description);
      }
    } catch (err: unknown) {
      runError = err;
    }

    const finalMessages = this.agent.state.messages;
    const { usage, summary } = summarizeRun(
      finalMessages,
      model.provider,
      model.id,
    );
    await this.sessionStore.save(sessionId, finalMessages);

    if (runError !== undefined) {
      const errorMessage = formatError(runError);
      this.transport.send({
        type: 'error',
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        error: errorMessage,
        usage,
      });
      return;
    }

    const result: TaskResult = this.terminalResult ?? {
      summary,
      filesChanged: [],
    };

    this.transport.send({
      type: 'result',
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
      result,
      usage,
      completionKind:
        this.terminalResult !== undefined ? 'submitted' : 'implicit',
    });
  }

  handleMessage(message: OrchestratorToWorkerMessage): void {
    if (this.agent === undefined) return;

    switch (message.type) {
      case 'steer': {
        this.agent.steer({
          role: 'user',
          content: formatSteeringMessage(message.directive),
          timestamp: Date.now(),
        });
        break;
      }
      case 'suspend': {
        this.suspended = {
          reason: message.reason,
          files: [...message.files],
        };
        this.agent.followUp({
          role: 'user',
          content: formatSuspendMessage(message.reason, message.files),
          timestamp: Date.now(),
        });
        break;
      }
      case 'resume': {
        const suspended = this.suspended;
        this.suspended = undefined;
        this.agent.followUp({
          role: 'user',
          content: formatResumeMessage(message.reason, suspended),
          timestamp: Date.now(),
        });
        break;
      }
      case 'abort': {
        this.agent.abort();
        break;
      }
      case 'help_response': {
        const pending = this.pendingHelp;
        if (pending !== undefined) {
          this.pendingHelp = undefined;
          pending.resolve(message.response);
        }
        break;
      }
      case 'approval_decision': {
        const pending = this.pendingApproval;
        if (pending !== undefined) {
          this.pendingApproval = undefined;
          pending.resolve(message.decision);
        }
        break;
      }
      case 'manual_input': {
        this.agent.followUp({
          role: 'user',
          content: message.text,
          timestamp: Date.now(),
        });
        break;
      }
      case 'run':
        break;
    }
  }

  private createIpcBridge(taskId: string, agentRunId: string): IpcBridge {
    return {
      taskId,
      agentRunId,
      progress: (messageText: string) => {
        this.transport.send({
          type: 'progress',
          taskId,
          agentRunId,
          message: messageText,
        });
      },
      requestHelp: (query: string) => {
        if (this.pendingHelp !== undefined) {
          return Promise.reject(
            new Error('request_help already pending — only one at a time'),
          );
        }
        this.transport.send({
          type: 'request_help',
          taskId,
          agentRunId,
          query,
        });
        return new Promise<HelpResponse>((resolve) => {
          this.pendingHelp = { resolve };
        });
      },
      requestApproval: (payload: ApprovalPayload) => {
        if (this.pendingApproval !== undefined) {
          return Promise.reject(
            new Error('request_approval already pending — only one at a time'),
          );
        }
        this.transport.send({
          type: 'request_approval',
          taskId,
          agentRunId,
          payload,
        });
        return new Promise<ApprovalDecision>((resolve) => {
          this.pendingApproval = { resolve };
        });
      },
      submitResult: (result: TaskResult) => {
        this.terminalResult = result;
      },
    };
  }

  private handleAgentEvent(
    event: AgentEvent,
    taskId: string,
    agentRunId: string,
  ): void {
    switch (event.type) {
      case 'message_end': {
        if (isAssistantMessage(event.message)) {
          const text = extractText(event.message);
          if (text.length > 0) {
            this.transport.send({
              type: 'assistant_output',
              taskId,
              agentRunId,
              text,
            });
          }
        }
        break;
      }
      case 'turn_end': {
        this.transport.send({
          type: 'progress',
          taskId,
          agentRunId,
          message: 'Turn completed',
        });
        break;
      }
      default:
        break;
    }
  }
}

function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
  return (msg as AssistantMessage).role === 'assistant';
}

function formatSteeringMessage(directive: {
  kind: 'sync_recommended' | 'sync_required' | 'conflict_steer';
  timing: 'next_checkpoint' | 'immediate';
  gitConflictContext?: GitConflictContext;
}): string {
  const header = `[steering:${directive.kind}] ${directive.timing}`;
  if (directive.kind !== 'conflict_steer') {
    return header;
  }

  return `${header}\n${formatConflictContext(directive.gitConflictContext)}`;
}

function formatSuspendMessage(
  reason: TaskSuspendReason,
  files: string[],
): string {
  const suffix =
    files.length > 0 ? `\nfiles: ${files.join(', ')}` : '\nfiles: none';
  return `[suspend:${reason}] pause current work until resume${suffix}`;
}

function formatResumeMessage(
  reason: TaskResumeReason,
  suspended?: SuspensionState,
): string {
  const prior =
    suspended === undefined
      ? ''
      : `\nprior_suspend: ${suspended.reason}\nfiles: ${suspended.files.join(', ') || 'none'}`;
  return `[resume:${reason}] continue from latest branch state${prior}`;
}

function formatConflictContext(
  context: GitConflictContext | undefined,
): string {
  if (context === undefined) {
    return 'conflict_context: unavailable';
  }

  const lines = [
    `conflict_kind: ${context.kind}`,
    `feature_id: ${context.featureId}`,
    `files: ${context.files.join(', ') || 'none'}`,
  ];

  if (context.conflictedFiles !== undefined) {
    lines.push(
      `conflicted_files: ${context.conflictedFiles.join(', ') || 'none'}`,
    );
  }
  if (context.kind === 'same_feature_task_rebase') {
    lines.push(`task_id: ${context.taskId}`);
    lines.push(`task_branch: ${context.taskBranch}`);
    lines.push(`rebase_target: ${context.rebaseTarget}`);
    lines.push(`pause_reason: ${context.pauseReason}`);
    if (context.dominantTaskId !== undefined) {
      lines.push(`dominant_task_id: ${context.dominantTaskId}`);
    }
    if (context.dominantTaskSummary !== undefined) {
      lines.push(`dominant_task_summary: ${context.dominantTaskSummary}`);
    }
    if (context.dominantTaskFilesChanged !== undefined) {
      lines.push(
        `dominant_task_files_changed: ${context.dominantTaskFilesChanged.join(', ') || 'none'}`,
      );
    }
    if (context.reservedWritePaths !== undefined) {
      lines.push(
        `reserved_write_paths: ${context.reservedWritePaths.join(', ') || 'none'}`,
      );
    }
  } else if (context.kind === 'cross_feature_feature_rebase') {
    lines.push(`blocked_by_feature_id: ${context.blockedByFeatureId}`);
    lines.push(`target_branch: ${context.targetBranch}`);
    lines.push(`pause_reason: ${context.pauseReason}`);
  } else {
    lines.push(`task_id: ${context.taskId}`);
    lines.push(`task_branch: ${context.taskBranch}`);
    lines.push(`rebase_target: ${context.rebaseTarget}`);
    lines.push(`blocked_by_feature_id: ${context.blockedByFeatureId}`);
    lines.push(`pause_reason: ${context.pauseReason}`);
    if (context.reservedWritePaths !== undefined) {
      lines.push(
        `reserved_write_paths: ${context.reservedWritePaths.join(', ') || 'none'}`,
      );
    }
  }

  if (context.dependencyOutputs !== undefined) {
    lines.push(`dependency_outputs_count: ${context.dependencyOutputs.length}`);
  }
  if (context.lastVerification !== undefined) {
    lines.push(`last_verification_ok: ${context.lastVerification.ok}`);
    if (context.lastVerification.summary !== undefined) {
      lines.push(
        `last_verification_summary: ${context.lastVerification.summary}`,
      );
    }
  }

  return lines.join('\n');
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * Single pass over the message history — sums usage and captures the last
 * non-empty assistant text as the summary. Called once per run.
 */
function summarizeRun(
  messages: AgentMessage[],
  provider: string,
  model: string,
): { usage: RuntimeUsageDelta; summary: string } {
  const aggregate = messagesToTokenUsageAggregate(messages, provider, model);
  let summary = '';

  for (const msg of messages) {
    if (!isAssistantMessage(msg)) continue;
    const text = extractText(msg);
    if (text.length > 0) summary = text.slice(0, 500);
  }

  return {
    usage: {
      provider,
      model,
      llmCalls: aggregate.llmCalls,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      ...(aggregate.cacheReadTokens > 0
        ? { cacheReadTokens: aggregate.cacheReadTokens }
        : {}),
      ...(aggregate.cacheWriteTokens > 0
        ? { cacheWriteTokens: aggregate.cacheWriteTokens }
        : {}),
      ...(aggregate.reasoningTokens > 0
        ? { reasoningTokens: aggregate.reasoningTokens }
        : {}),
      ...(aggregate.audioInputTokens > 0
        ? { audioInputTokens: aggregate.audioInputTokens }
        : {}),
      ...(aggregate.audioOutputTokens > 0
        ? { audioOutputTokens: aggregate.audioOutputTokens }
        : {}),
      totalTokens: aggregate.totalTokens,
      usd: aggregate.usd,
    },
    summary,
  };
}
