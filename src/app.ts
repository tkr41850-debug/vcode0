#!/usr/bin/env node
import { PiAgentPort } from '@agents/pi-agent-port';
import { createPromptLibrary } from '@agents/prompts/library';
import type { Model } from '@mariozechner/pi-ai';
import { main } from './main.js';

/**
 * `npm run app` entry point. Reads BASE_URL + API_KEY (and an optional
 * MODEL_ID) from the environment, builds an OpenAI-compatible {@link Model}
 * literal, wires a real {@link PiAgentPort}, and boots the TUI.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    process.stderr.write(
      `gvc0: missing required environment variable: ${name}\n` +
        `usage: BASE_URL=https://api.example.com/v1 API_KEY=sk-... npm run app\n`,
    );
    process.exit(2);
  }
  return value;
}

function buildModel(
  baseUrl: string,
  modelId: string,
): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

let shuttingDown = false;
function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\ngvc0: received ${signal}, exiting.\n`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

installSignalHandlers();

const baseUrl = requireEnv('BASE_URL');
const apiKey = requireEnv('API_KEY');
const modelId = process.env.MODEL_ID ?? 'gpt-4o-mini';

const model = buildModel(baseUrl, modelId);
const agents = new PiAgentPort({
  model,
  prompts: createPromptLibrary(),
  apiKey,
});

try {
  await main({ agents });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\ngvc0: fatal: ${message}\n`);
  process.exit(1);
}
