import { randomUUID } from 'node:crypto';
import type { ClaimLockResult, IpcBridge } from '@agents/worker';
import { buildWorkerToolset } from '@agents/worker';
import type {
  GitConflictContext,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
  OrchestratorToWorkerMessage,
  RuntimeUsageDelta,
  TaskRunPayload,
  TaskRuntimeDispatch,
} from '@runtime/contracts';
import type { ChildIpcTransport } from '@runtime/ipc/index';
import { resolveModel } from '@runtime/routing/model-bridge';
import type {
  SessionCheckpoint,
  SessionStore,
  SessionToolResult,
} from '@runtime/sessions/index';
import { messagesToTokenUsageAggregate } from '@runtime/usage';
import { buildSystemPrompt } from '@runtime/worker/system-prompt';

export interface WorkerRuntimeConfig {
  /** Absolute path to the project root — used to locate `.gvc0/` knowledge files. */
  projectRoot: string;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

interface PendingHelp {
  toolCallId: string;
  query: string;
  resolve: (response: HelpResponse) => void | Promise<void>;
}

interface PendingApproval {
  toolCallId: string;
  payload: ApprovalPayload;
  resolve: (decision: ApprovalDecision) => void | Promise<void>;
}

interface PendingClaim {
  resolve: (result: ClaimLockResult) => void;
}

interface SuspensionState {
  reason: TaskSuspendReason;
  files: string[];
}

export class WorkerRuntime {
  private agent: Agent | undefined;
  private currentSessionId: string | undefined;
  private currentTaskId: string | undefined;
  private currentAgentRunId: string | undefined;
  private pendingHelp: PendingHelp | undefined;
  private pendingApproval: PendingApproval | undefined;
  private deliveringHelpResponse = false;
  private deliveringApprovalDecision = false;
  private readonly pendingClaims = new Map<string, PendingClaim>();
  private terminalResult: TaskResult | undefined;
  private suspended: SuspensionState | undefined;

  constructor(
    private readonly transport: ChildIpcTransport,
    private readonly sessionStore: SessionStore,
    private readonly config: WorkerRuntimeConfig,
  ) {}

  async run(
    taskRun: TaskRunPayload,
    dispatch: TaskRuntimeDispatch,
  ): Promise<void> {
    const { task, payload, model: modelId, routingTier } = taskRun;
    const model = resolveModel(
      { model: modelId, tier: routingTier },
      {
        enabled: false,
        ceiling: modelId,
        tiers: {
          heavy: modelId,
          standard: modelId,
          light: modelId,
        },
        escalateOnFailure: false,
        budgetPressure: false,
      },
    );

    const systemPrompt = buildSystemPrompt(task, payload);

    const sessionId =
      dispatch.mode === 'resume' ? dispatch.sessionId : dispatch.agentRunId;

    let messages: AgentMessage[] = [];
    let checkpoint: SessionCheckpoint | null = null;
    if (dispatch.mode === 'resume') {
      checkpoint = await this.sessionStore.loadCheckpoint(dispatch.sessionId);
      if (checkpoint !== null) {
        messages = checkpoint.messages;
        this.terminalResult = checkpoint.terminalResult;
      }
    }

    this.currentSessionId = sessionId;
    this.currentTaskId = task.id;
    this.currentAgentRunId = dispatch.agentRunId;

    const ipcBridge = this.createIpcBridge(
      task.id,
      dispatch.agentRunId,
      sessionId,
    );
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
      toolExecution: 'sequential',
    };
    if (this.config.getApiKey !== undefined) {
      agentOptions.getApiKey = this.config.getApiKey;
    }
    if (dispatch.mode === 'resume') {
      agentOptions.sessionId = dispatch.sessionId;
    }

    this.agent = new Agent(agentOptions);

    this.agent.subscribe((event: AgentEvent) =>
      this.handleAgentEvent(event, task.id, dispatch.agentRunId),
    );

    let runError: unknown;
    try {
      if (dispatch.mode === 'resume' && checkpoint !== null) {
        await this.resumeFromCheckpoint(checkpoint, task.description);
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
    await this.sessionStore.saveCheckpoint(sessionId, {
      messages: finalMessages,
      ...(this.terminalResult !== undefined
        ? { terminalResult: this.terminalResult }
        : {}),
    });

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
        if (
          pending !== undefined &&
          pending.toolCallId === message.toolCallId &&
          !this.deliveringHelpResponse
        ) {
          this.deliveringHelpResponse = true;
          this.resolvePendingWait(pending, message.response)
            .catch(() => {})
            .finally(() => {
              this.deliveringHelpResponse = false;
            });
        }
        break;
      }
      case 'approval_decision': {
        const pending = this.pendingApproval;
        if (
          pending !== undefined &&
          pending.toolCallId === message.toolCallId &&
          !this.deliveringApprovalDecision
        ) {
          this.deliveringApprovalDecision = true;
          this.resolvePendingWait(pending, message.decision)
            .catch(() => {})
            .finally(() => {
              this.deliveringApprovalDecision = false;
            });
        }
        break;
      }
      case 'claim_decision': {
        const pending = this.pendingClaims.get(message.claimId);
        if (pending !== undefined) {
          this.pendingClaims.delete(message.claimId);
          pending.resolve(
            message.kind === 'granted'
              ? { granted: true }
              : {
                  granted: false,
                  deniedPaths: message.deniedPaths ?? [],
                },
          );
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

  private createIpcBridge(
    taskId: string,
    agentRunId: string,
    sessionId: string,
  ): IpcBridge {
    this.currentSessionId = sessionId;
    this.currentTaskId = taskId;
    this.currentAgentRunId = agentRunId;

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
      requestHelp: async (toolCallId: string, query: string) => {
        if (this.pendingHelp !== undefined) {
          throw new Error('request_help already pending — only one at a time');
        }
        const waitForResponse = new Promise<HelpResponse>((resolve) => {
          this.pendingHelp = { toolCallId, query, resolve };
        });
        try {
          await this.persistCheckpoint({
            kind: 'help',
            toolCallId,
            query,
          });
          this.transport.send({
            type: 'request_help',
            taskId,
            agentRunId,
            toolCallId,
            query,
          });
        } catch (err: unknown) {
          this.pendingHelp = undefined;
          throw err;
        }
        return await waitForResponse;
      },
      requestApproval: async (toolCallId: string, payload: ApprovalPayload) => {
        if (this.pendingApproval !== undefined) {
          throw new Error(
            'request_approval already pending — only one at a time',
          );
        }
        const waitForDecision = new Promise<ApprovalDecision>((resolve) => {
          this.pendingApproval = { toolCallId, payload, resolve };
        });
        try {
          await this.persistCheckpoint({
            kind: 'approval',
            toolCallId,
            payload,
          });
          this.transport.send({
            type: 'request_approval',
            taskId,
            agentRunId,
            toolCallId,
            payload,
          });
        } catch (err: unknown) {
          this.pendingApproval = undefined;
          throw err;
        }
        return await waitForDecision;
      },
      claimLock: (paths: readonly string[]) => {
        const claimId = randomUUID();
        this.transport.send({
          type: 'claim_lock',
          taskId,
          agentRunId,
          claimId,
          paths: [...paths],
        });
        return new Promise<ClaimLockResult>((resolve) => {
          this.pendingClaims.set(claimId, { resolve });
        });
      },
      submitResult: async (result: TaskResult) => {
        this.terminalResult = result;
        await this.persistCheckpoint(this.currentPendingWait());
      },
    };
  }

  private async persistCheckpoint(
    pendingWait?:
      | {
          kind: 'help';
          toolCallId: string;
          query: string;
        }
      | {
          kind: 'approval';
          toolCallId: string;
          payload: ApprovalPayload;
        },
  ): Promise<void> {
    const sessionId = this.currentSessionId;
    if (sessionId === undefined) {
      return;
    }

    const messages = this.agent?.state.messages ?? [];

    await this.sessionStore.saveCheckpoint(sessionId, {
      messages,
      ...(pendingWait !== undefined ? { pendingWait } : {}),
      ...(this.terminalResult !== undefined
        ? { terminalResult: this.terminalResult }
        : {}),
    });
  }

  private async resumeFromCheckpoint(
    checkpoint: SessionCheckpoint,
    taskDescription: string,
  ): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      throw new Error('worker agent not initialized');
    }

    if (checkpoint.pendingWait === undefined) {
      if (checkpoint.terminalResult !== undefined) {
        this.terminalResult = checkpoint.terminalResult;
        return;
      }
      const completedToolResults = checkpoint.completedToolResults ?? [];
      if (completedToolResults.length > 0) {
        agent.state.messages = [
          ...checkpoint.messages,
          ...completedToolResults,
        ];
      }
      if (agent.state.messages.length > 0) {
        await agent.continue();
      } else {
        await agent.prompt(taskDescription);
      }
      return;
    }

    if (checkpoint.pendingWait.kind === 'help') {
      await this.restorePendingHelp(checkpoint.pendingWait, checkpoint);
      return;
    }

    await this.restorePendingApproval(checkpoint.pendingWait, checkpoint);
  }

  private async restorePendingHelp(
    pendingWait: Extract<
      NonNullable<SessionCheckpoint['pendingWait']>,
      { kind: 'help' }
    >,
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      this.pendingHelp = {
        toolCallId: pendingWait.toolCallId,
        query: pendingWait.query,
        resolve: async (response) => {
          await this.finishRestoredWait(
            pendingWait.toolCallId,
            {
              content: [
                {
                  type: 'text',
                  text:
                    response.kind === 'answer'
                      ? response.text
                      : '[operator chose to discuss — expect follow-up steering]',
                },
              ],
              details: {
                query: pendingWait.query,
                responseKind: response.kind,
              },
            },
            checkpoint,
          );
          resolve();
        },
      };
      this.transport.send({
        type: 'request_help',
        taskId: this.currentTaskId ?? 'unknown-task',
        agentRunId:
          this.currentAgentRunId ?? this.currentSessionId ?? 'unknown-run',
        toolCallId: pendingWait.toolCallId,
        query: pendingWait.query,
      });
    });
  }

  private async restorePendingApproval(
    pendingWait: Extract<
      NonNullable<SessionCheckpoint['pendingWait']>,
      { kind: 'approval' }
    >,
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      this.pendingApproval = {
        toolCallId: pendingWait.toolCallId,
        payload: pendingWait.payload,
        resolve: async (decision) => {
          await this.finishRestoredWait(
            pendingWait.toolCallId,
            {
              content: [
                {
                  type: 'text',
                  text:
                    decision.kind === 'approved'
                      ? 'approved'
                      : decision.kind === 'approve_always'
                        ? 'approved (always)'
                        : decision.kind === 'reject'
                          ? `rejected${decision.comment !== undefined ? `: ${decision.comment}` : ''}`
                          : 'operator chose to discuss',
                },
              ],
              details: {
                kind: pendingWait.payload.kind,
                decision: decision.kind,
              },
            },
            checkpoint,
          );
          resolve();
        },
      };
      this.transport.send({
        type: 'request_approval',
        taskId: this.currentTaskId ?? 'unknown-task',
        agentRunId:
          this.currentAgentRunId ?? this.currentSessionId ?? 'unknown-run',
        toolCallId: pendingWait.toolCallId,
        payload: pendingWait.payload,
      });
    });
  }

  private async finishRestoredWait(
    toolCallId: string,
    result: {
      content: { type: 'text'; text: string }[];
      details: Record<string, unknown>;
    },
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      throw new Error('worker agent not initialized');
    }
    const toolResult = buildToolResultMessage(
      toolCallId,
      inferToolName(checkpoint.pendingWait),
      result,
    );
    agent.state.messages = [...checkpoint.messages, toolResult];
    await this.persistCheckpoint();
    await agent.continue();
  }

  private resolvePendingWait(
    pending: PendingHelp,
    response: HelpResponse,
  ): Promise<void>;
  private resolvePendingWait(
    pending: PendingApproval,
    response: ApprovalDecision,
  ): Promise<void>;
  private async resolvePendingWait(
    pending: PendingHelp | PendingApproval,
    response: HelpResponse | ApprovalDecision,
  ): Promise<void> {
    const toolResult = isPendingApproval(pending)
      ? buildApprovalToolResult(pending, response as ApprovalDecision)
      : buildHelpToolResult(pending, response as HelpResponse);
    const sessionId = this.currentSessionId;
    if (sessionId !== undefined) {
      await this.sessionStore.saveCheckpoint(sessionId, {
        messages: this.agent?.state.messages ?? [],
        completedToolResults: [toolResult],
        ...(this.terminalResult !== undefined
          ? { terminalResult: this.terminalResult }
          : {}),
      });
    }
    if (isPendingApproval(pending)) {
      this.pendingApproval = undefined;
    } else {
      this.pendingHelp = undefined;
    }
    await pending.resolve(response as never);
  }

  private currentPendingWait(): SessionCheckpoint['pendingWait'] | undefined {
    if (this.pendingHelp !== undefined) {
      return {
        kind: 'help',
        toolCallId: this.pendingHelp.toolCallId,
        query: this.pendingHelp.query,
      };
    }
    if (this.pendingApproval !== undefined) {
      return {
        kind: 'approval',
        toolCallId: this.pendingApproval.toolCallId,
        payload: this.pendingApproval.payload,
      };
    }
    return undefined;
  }

  private async handleAgentEvent(
    event: AgentEvent,
    taskId: string,
    agentRunId: string,
  ): Promise<void> {
    switch (event.type) {
      case 'message_end': {
        if (event.message.role === 'toolResult') {
          await this.persistCheckpoint(this.currentPendingWait());
        }
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

function inferToolName(
  pendingWait: SessionCheckpoint['pendingWait'],
): 'request_help' | 'request_approval' {
  return pendingWait?.kind === 'approval' ? 'request_approval' : 'request_help';
}

function buildToolResultMessage(
  toolCallId: string,
  toolName: string,
  result: {
    content: { type: 'text'; text: string }[];
    details: Record<string, unknown>;
  },
): SessionToolResult {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  };
}

function isPendingApproval(
  pending: PendingHelp | PendingApproval,
): pending is PendingApproval {
  return 'payload' in pending;
}

function buildHelpToolResult(
  pending: PendingHelp,
  response: HelpResponse,
): SessionToolResult {
  return buildToolResultMessage(pending.toolCallId, 'request_help', {
    content: [
      {
        type: 'text',
        text:
          response.kind === 'answer'
            ? response.text
            : '[operator chose to discuss — expect follow-up steering]',
      },
    ],
    details: {
      query: pending.query,
      responseKind: response.kind,
    },
  });
}

function buildApprovalToolResult(
  pending: PendingApproval,
  decision: ApprovalDecision,
): SessionToolResult {
  return buildToolResultMessage(pending.toolCallId, 'request_approval', {
    content: [
      {
        type: 'text',
        text:
          decision.kind === 'approved'
            ? 'approved'
            : decision.kind === 'approve_always'
              ? 'approved (always)'
              : decision.kind === 'reject'
                ? `rejected${decision.comment !== undefined ? `: ${decision.comment}` : ''}`
                : 'operator chose to discuss',
      },
    ],
    details: {
      kind: pending.payload.kind,
      decision: decision.kind,
    },
  });
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
