import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { TaskResult } from '@core/types/index';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ApprovalPayload } from '@runtime/contracts';

export type SessionToolResult = Extract<AgentMessage, { role: 'toolResult' }>;

export interface SessionCheckpoint {
  messages: AgentMessage[];
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
      };
  completedToolResults?: SessionToolResult[];
  terminalResult?: TaskResult;
}

interface SessionEnvelope {
  version: 1;
  messages: AgentMessage[];
  pendingWait?: SessionCheckpoint['pendingWait'];
  completedToolResults?: SessionCheckpoint['completedToolResults'];
  terminalResult?: SessionCheckpoint['terminalResult'];
}

export interface SessionStore {
  save(sessionId: string, messages: AgentMessage[]): Promise<void>;
  load(sessionId: string): Promise<AgentMessage[] | null>;
  saveCheckpoint(
    sessionId: string,
    checkpoint: SessionCheckpoint,
  ): Promise<void>;
  loadCheckpoint(sessionId: string): Promise<SessionCheckpoint | null>;
  delete(sessionId: string): Promise<void>;
}

export class FileSessionStore implements SessionStore {
  private readonly sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, '.gvc0', 'sessions');
  }

  async save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    await this.saveCheckpoint(sessionId, { messages });
  }

  async load(sessionId: string): Promise<AgentMessage[] | null> {
    const checkpoint = await this.loadCheckpoint(sessionId);
    return checkpoint?.messages ?? null;
  }

  async saveCheckpoint(
    sessionId: string,
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });

    const envelope: SessionEnvelope = {
      version: 1,
      messages: checkpoint.messages,
      ...(checkpoint.pendingWait !== undefined
        ? { pendingWait: checkpoint.pendingWait }
        : {}),
      ...(checkpoint.completedToolResults !== undefined
        ? { completedToolResults: checkpoint.completedToolResults }
        : {}),
      ...(checkpoint.terminalResult !== undefined
        ? { terminalResult: checkpoint.terminalResult }
        : {}),
    };
    const filePath = this.filePath(sessionId);
    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, JSON.stringify(envelope), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async loadCheckpoint(sessionId: string): Promise<SessionCheckpoint | null> {
    try {
      const raw = await fs.readFile(this.filePath(sessionId), 'utf-8');
      const envelope = JSON.parse(raw) as SessionEnvelope;
      return {
        messages: envelope.messages,
        ...(envelope.pendingWait !== undefined
          ? { pendingWait: envelope.pendingWait }
          : {}),
        ...(envelope.completedToolResults !== undefined
          ? { completedToolResults: envelope.completedToolResults }
          : {}),
        ...(envelope.terminalResult !== undefined
          ? { terminalResult: envelope.terminalResult }
          : {}),
      };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(sessionId));
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
