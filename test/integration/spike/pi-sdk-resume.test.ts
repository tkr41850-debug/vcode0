/**
 * Pi-SDK Agent resume/replay fidelity SPIKE (plan 03-05).
 *
 * Five scenario runs that drive a real `Agent` against pi-ai's faux
 * provider and observe what happens when we:
 *   (1) cold-start,
 *   (2) abort mid-tool-call,
 *   (3) abort mid-response-stream,
 *   (4) resume post-commit (last msg is tool-result),
 *   (5) simulate catastrophic crash via session-file round-trip.
 *
 * Each test logs a `[SPIKE][Sn]` structured observation line. These
 * observations are the raw input to `docs/spikes/pi-sdk-resume.md`.
 *
 * Assertions are DELIBERATELY weak: the goal is reproducibility, not a
 * pass/fail gate. Throws are recorded, not thrown.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import { resolveModel } from '@runtime/routing/model-bridge';
import { FileSessionStore } from '@runtime/sessions/index';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFauxProvider,
  type FauxProviderRegistration,
  type FauxResponseStep,
} from '../harness/faux-stream.js';
import { ALL_SCENARIOS } from './fixtures.js';

const MODEL_ID = 'claude-sonnet-4-20250514';

function makeAgent(faux: FauxProviderRegistration): Agent {
  const model = resolveModel(
    { model: `anthropic:${MODEL_ID}`, tier: 'standard' },
    {
      enabled: false,
      ceiling: MODEL_ID,
      tiers: { heavy: MODEL_ID, standard: MODEL_ID, light: MODEL_ID },
      escalateOnFailure: false,
      budgetPressure: false,
    },
  );
  // Use the faux registration to make sure it's alive.
  void faux;
  return new Agent({
    initialState: {
      systemPrompt: 'You are a spike test agent.',
      model,
      tools: [],
      messages: [],
    },
    getApiKey: () => 'faux-key',
  });
}

interface Snapshot {
  messageCount: number;
  lastRole: string | undefined;
  pendingToolCalls: number;
  isStreaming: boolean;
  errorMessage: string | undefined;
  hasStreamingMessage: boolean;
}

function snapshot(agent: Agent): Snapshot {
  const messages = agent.state.messages;
  const last = messages.at(-1);
  return {
    messageCount: messages.length,
    lastRole: last?.role,
    pendingToolCalls: agent.state.pendingToolCalls.size,
    isStreaming: agent.state.isStreaming,
    errorMessage: agent.state.errorMessage,
    hasStreamingMessage: agent.state.streamingMessage !== undefined,
  };
}

async function tryContinue(agent: Agent): Promise<string | null> {
  try {
    await agent.continue();
    await agent.waitForIdle();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function log(label: string, payload: unknown): void {
  // eslint-disable-next-line no-console
  console.log(label, JSON.stringify(payload));
}

describe('pi-sdk resume spike', () => {
  let faux: FauxProviderRegistration;

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: MODEL_ID }],
    });
  });

  afterEach(() => {
    faux.unregister();
  });

  it('Scenario 1 — cold start: prompt+submit completes with terminal response', async () => {
    faux.setResponses(ALL_SCENARIOS.coldStart as FauxResponseStep[]);
    const agent = makeAgent(faux);

    let continueError: string | null = null;
    try {
      await agent.prompt('task: do x');
      await agent.waitForIdle();
    } catch (err) {
      continueError = err instanceof Error ? err.message : String(err);
    }
    const snap = snapshot(agent);
    log('[SPIKE][S1][afterPrompt]', { ...snap, promptError: continueError });

    expect(snap.messageCount).toBeGreaterThan(0);
  });

  it('Scenario 2 — mid-tool abort: inspect state + continue()', async () => {
    faux.setResponses(ALL_SCENARIOS.midToolCall as FauxResponseStep[]);
    const agent = makeAgent(faux);

    // Abort on first message_update event (simulates pause while streaming).
    let aborted = false;
    const unsub = agent.subscribe((ev) => {
      if (!aborted && ev.type === 'message_update') {
        aborted = true;
        agent.abort();
      }
    });

    try {
      await agent.prompt('long task with a tool call');
    } catch {
      // expected: AbortError may surface
    }
    try {
      await agent.waitForIdle();
    } catch {
      /* ignore */
    }
    unsub();
    const afterAbort = snapshot(agent);
    log('[SPIKE][S2][afterAbort]', afterAbort);

    const continueErr = await tryContinue(agent);
    const afterContinue = snapshot(agent);
    log('[SPIKE][S2][afterContinue]', {
      ...afterContinue,
      continueError: continueErr,
    });
  });

  it('Scenario 3 — mid-response abort: inspect streaming state + continue()', async () => {
    faux.setResponses(ALL_SCENARIOS.midResponse as FauxResponseStep[]);
    const agent = makeAgent(faux);

    let aborted = false;
    const unsub = agent.subscribe((ev) => {
      if (!aborted && ev.type === 'message_update') {
        aborted = true;
        agent.abort();
      }
    });

    try {
      await agent.prompt('stream a long response');
    } catch {
      /* ignore */
    }
    try {
      await agent.waitForIdle();
    } catch {
      /* ignore */
    }
    unsub();
    const afterAbort = snapshot(agent);
    log('[SPIKE][S3][afterAbort]', afterAbort);

    const continueErr = await tryContinue(agent);
    log('[SPIKE][S3][afterContinue]', {
      ...snapshot(agent),
      continueError: continueErr,
    });
  });

  it('Scenario 4 — post-commit resume: call continue() after clean turn_end', async () => {
    faux.setResponses(ALL_SCENARIOS.postCommit as FauxResponseStep[]);
    const agent = makeAgent(faux);

    try {
      await agent.prompt('commit and finish');
      await agent.waitForIdle();
    } catch (err) {
      log('[SPIKE][S4][promptError]', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const afterPrompt = snapshot(agent);
    log('[SPIKE][S4][afterPrompt]', afterPrompt);

    const continueErr = await tryContinue(agent);
    log('[SPIKE][S4][afterContinue]', {
      ...snapshot(agent),
      continueError: continueErr,
    });
  });

  it('Scenario 5 — catastrophic: FileSessionStore round-trip + rehydrated Agent.continue()', async () => {
    faux.setResponses(ALL_SCENARIOS.catastrophic as FauxResponseStep[]);
    const dir = path.join(os.tmpdir(), `gvc0-spike-s5-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore(dir);
    const sessionId = 'spike-s5';

    // 1. Run agent A to completion and persist its transcript.
    const agentA = makeAgent(faux);
    try {
      await agentA.prompt('commit and finish');
      await agentA.waitForIdle();
    } catch {
      /* ignore */
    }
    const savedMessages = [...agentA.state.messages];
    await store.save(sessionId, savedMessages);

    // 2. Verify the session file is intact and loadable.
    const loaded = await store.load(sessionId);
    log('[SPIKE][S5][loaded]', {
      recoveredCount: loaded?.length,
      lastRole: loaded?.at(-1)?.role,
      savedCount: savedMessages.length,
    });
    expect(loaded).not.toBeNull();

    // 3. Spawn a fresh Agent with the loaded transcript and call continue().
    // Need a fresh faux-response script so continue() has somewhere to go.
    faux.setResponses([
      // Provide a terminal no-op assistant message for the continuation.
      ...(ALL_SCENARIOS.coldStart as FauxResponseStep[]),
    ]);
    const model = resolveModel(
      { model: `anthropic:${MODEL_ID}`, tier: 'standard' },
      {
        enabled: false,
        ceiling: MODEL_ID,
        tiers: { heavy: MODEL_ID, standard: MODEL_ID, light: MODEL_ID },
        escalateOnFailure: false,
        budgetPressure: false,
      },
    );
    const agentB = new Agent({
      initialState: {
        systemPrompt: 'You are a spike test agent.',
        model,
        tools: [],
        messages: loaded ?? [],
      },
      getApiKey: () => 'faux-key',
      sessionId: `resumed-${sessionId}`,
    });

    const continueErr = await tryContinue(agentB);
    log('[SPIKE][S5][afterContinue]', {
      ...snapshot(agentB),
      continueError: continueErr,
    });
  });
});
