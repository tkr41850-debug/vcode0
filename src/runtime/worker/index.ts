import type { IpcBridge } from '@agents/worker';
import { buildWorkerToolset } from '@agents/worker';
import type { Task, TaskResult } from '@core/types/index';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { WorkerContext } from '@runtime/context/index';
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

export class WorkerRuntime {
  private agent: Agent | undefined;
  private pendingHelp: PendingHelp | undefined;
  private pendingApproval: PendingApproval | undefined;
  private terminalResult: TaskResult | undefined;

  constructor(
    private readonly transport: ChildIpcTransport,
    private readonly sessionStore: SessionStore,
    private readonly config: WorkerRuntimeConfig,
  ) {}

  async run(
    task: Task,
    context: WorkerContext,
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

    const systemPrompt = buildSystemPrompt(task, context);

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
      dispatch.mode === 'resume'
        ? dispatch.sessionId
        : `session-${task.id}-${dispatch.agentRunId}`;

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
      const errorMessage =
        runError instanceof Error ? runError.message : String(runError);
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
    });
  }

  handleMessage(message: OrchestratorToWorkerMessage): void {
    if (this.agent === undefined) return;

    switch (message.type) {
      case 'steer': {
        this.agent.steer({
          role: 'user',
          content: `[steering:${message.directive.kind}] ${message.directive.timing}`,
          timestamp: Date.now(),
        });
        break;
      }
      case 'suspend': {
        this.agent.abort();
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
      case 'resume':
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

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let usd = 0;
  let summary = '';

  for (const msg of messages) {
    if (!isAssistantMessage(msg)) continue;
    inputTokens += msg.usage.input;
    outputTokens += msg.usage.output;
    cacheReadTokens += msg.usage.cacheRead;
    cacheWriteTokens += msg.usage.cacheWrite;
    totalTokens += msg.usage.totalTokens;
    usd += msg.usage.cost.total;
    const text = extractText(msg);
    if (text.length > 0) summary = text.slice(0, 500);
  }

  return {
    usage: {
      provider,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      usd,
    },
    summary,
  };
}
