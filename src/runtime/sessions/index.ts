import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

interface SessionEnvelope {
  version: 1;
  messages: AgentMessage[];
}

export interface SessionStore {
  save(sessionId: string, messages: AgentMessage[]): Promise<void>;
  load(sessionId: string): Promise<AgentMessage[] | null>;
  delete(sessionId: string): Promise<void>;
}

export class FileSessionStore implements SessionStore {
  private readonly sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, '.gvc0', 'sessions');
  }

  async save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });

    const envelope: SessionEnvelope = { version: 1, messages };
    const filePath = this.filePath(sessionId);
    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, JSON.stringify(envelope), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async load(sessionId: string): Promise<AgentMessage[] | null> {
    try {
      const raw = await fs.readFile(this.filePath(sessionId), 'utf-8');
      const envelope = JSON.parse(raw) as SessionEnvelope;
      return envelope.messages;
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
