import type { Task } from '@core/types/index';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { WorkerContext } from '@runtime/context/index';
import type {
  OrchestratorToWorkerMessage,
  RuntimeUsageDelta,
  TaskRuntimeDispatch,
} from '@runtime/contracts';
import type { ChildIpcTransport } from '@runtime/ipc/index';
import { resolveModel } from '@runtime/routing/model-bridge';
import type { SessionStore } from '@runtime/sessions/index';

export interface WorkerRuntimeConfig {
  modelId: string;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

export class WorkerRuntime {
  private agent: Agent | undefined;
  private readonly pendingResponses = new Map<
    string,
    { resolve: (text: string) => void }
  >();

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

    const tools: AgentTool[] = [];

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

    try {
      if (dispatch.mode === 'resume' && messages.length > 0) {
        await this.agent.continue();
      } else {
        await this.agent.prompt(task.description);
      }

      const usage = aggregateUsage(
        this.agent.state.messages,
        model.provider,
        model.id,
      );

      await this.sessionStore.save(sessionId, this.agent.state.messages);

      this.transport.send({
        type: 'result',
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        result: {
          summary: extractSummary(this.agent.state.messages),
          filesChanged: [],
        },
        usage,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (this.agent !== undefined) {
        await this.sessionStore.save(sessionId, this.agent.state.messages);
      }

      this.transport.send({
        type: 'error',
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        error: errorMessage,
        usage: aggregateUsage(
          this.agent?.state.messages ?? [],
          model.provider,
          model.id,
        ),
      });
    }
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
        const pending = this.pendingResponses.get('help');
        if (pending !== undefined) {
          this.pendingResponses.delete('help');
          pending.resolve(
            message.response.kind === 'answer'
              ? message.response.text
              : '[discuss]',
          );
        } else {
          this.agent.followUp({
            role: 'user',
            content:
              message.response.kind === 'answer'
                ? message.response.text
                : '[discuss]',
            timestamp: Date.now(),
          });
        }
        break;
      }
      case 'approval_decision': {
        const pending = this.pendingResponses.get('approval');
        if (pending !== undefined) {
          this.pendingResponses.delete('approval');
          pending.resolve(
            message.decision.kind === 'approved' ||
              message.decision.kind === 'approve_always'
              ? 'approved'
              : message.decision.kind === 'reject'
                ? `rejected: ${message.decision.comment ?? ''}`
                : 'discuss',
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
      case 'resume': {
        // Resume after suspend — agent will need to continue
        break;
      }
      case 'run': {
        // Initial run message handled in entry.ts, not here
        break;
      }
    }
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
          message: `Turn completed`,
        });
        break;
      }
      default:
        break;
    }
  }
}

function buildSystemPrompt(task: Task, context: WorkerContext): string {
  const parts: string[] = [];

  parts.push(
    `You are a task worker executing task ${task.id}: ${task.description}`,
  );

  if (context.planSummary !== undefined) {
    parts.push(`\n## Plan\n${context.planSummary}`);
  }

  if (
    context.dependencyOutputs !== undefined &&
    context.dependencyOutputs.length > 0
  ) {
    parts.push('\n## Dependency Outputs');
    for (const dep of context.dependencyOutputs) {
      parts.push(`- ${dep.taskId} (${dep.featureName}): ${dep.summary}`);
    }
  }

  if (context.codebaseMap !== undefined) {
    parts.push(`\n## Codebase\n${context.codebaseMap}`);
  }

  if (context.knowledge !== undefined) {
    parts.push(`\n## Knowledge\n${context.knowledge}`);
  }

  if (context.decisions !== undefined) {
    parts.push(`\n## Decisions\n${context.decisions}`);
  }

  return parts.join('\n');
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

function extractSummary(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && isAssistantMessage(msg)) {
      const text = extractText(msg);
      if (text.length > 0) {
        return text.slice(0, 500);
      }
    }
  }
  return '';
}

function aggregateUsage(
  messages: AgentMessage[],
  provider: string,
  model: string,
): RuntimeUsageDelta {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let usd = 0;

  for (const msg of messages) {
    if (isAssistantMessage(msg)) {
      inputTokens += msg.usage.input;
      outputTokens += msg.usage.output;
      cacheReadTokens += msg.usage.cacheRead;
      cacheWriteTokens += msg.usage.cacheWrite;
      totalTokens += msg.usage.totalTokens;
      usd += msg.usage.cost.total;
    }
  }

  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    usd,
  };
}
