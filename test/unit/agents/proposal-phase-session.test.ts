import { type ProposalOpScope, ProposalPhaseSessionImpl } from '@agents';
import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';

const scope: ProposalOpScope = {
  featureId: 'f-1',
  phase: 'plan',
  agentRunId: 'run-feature:f-1:plan',
};

interface FakeAgent {
  abort: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
}

function createFakeAgent(): FakeAgent {
  return {
    abort: vi.fn(),
    followUp: vi.fn(),
  };
}

describe('ProposalPhaseSessionImpl pre-bind queuing', () => {
  it('queues sendUserMessage before bindAgent and dispatches once bound', () => {
    const session = new ProposalPhaseSessionImpl(scope);
    session.sendUserMessage('first');
    session.sendUserMessage('second');

    const fake = createFakeAgent();
    session.bindAgent(fake as unknown as Agent);

    expect(fake.followUp).toHaveBeenCalledTimes(2);
    expect(fake.followUp.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      content: 'first',
    });
    expect(fake.followUp.mock.calls[1]?.[0]).toMatchObject({
      role: 'user',
      content: 'second',
    });
  });

  it('post-bind sendUserMessage dispatches immediately', () => {
    const session = new ProposalPhaseSessionImpl(scope);
    const fake = createFakeAgent();
    session.bindAgent(fake as unknown as Agent);

    session.sendUserMessage('hi');

    expect(fake.followUp).toHaveBeenCalledTimes(1);
    expect((fake.followUp.mock.calls[0]?.[0] as AgentMessage).content).toBe(
      'hi',
    );
  });

  it('pre-bind abort triggers agent.abort via microtask after bind', async () => {
    const session = new ProposalPhaseSessionImpl(scope);
    session.abort();

    const fake = createFakeAgent();
    session.bindAgent(fake as unknown as Agent);

    // Microtask not yet drained; bindAgent only schedules.
    expect(fake.abort).not.toHaveBeenCalled();

    // Yield once for the queued microtask.
    await Promise.resolve();

    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it('post-bind abort dispatches immediately', () => {
    const session = new ProposalPhaseSessionImpl(scope);
    const fake = createFakeAgent();
    session.bindAgent(fake as unknown as Agent);

    session.abort();

    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it('awaitOutcome before bindOutcome throws', () => {
    const session = new ProposalPhaseSessionImpl(scope);
    expect(() => session.awaitOutcome()).toThrow(
      'feature phase outcome not bound',
    );
  });

  it('awaitOutcome after bindOutcome resolves to the bound promise', async () => {
    const session = new ProposalPhaseSessionImpl(scope);
    const fake = createFakeAgent();
    session.bindAgent(fake as unknown as Agent);

    const result = { summary: 's', proposal: {}, details: {} };
    session.bindOutcome(Promise.resolve(result as never));

    await expect(session.awaitOutcome()).resolves.toBe(result);
  });
});

describe('ProposalPhaseSessionImpl request-help wiring', () => {
  it('requestHelp returns a pending promise; respondToHelp resolves it', async () => {
    const session = new ProposalPhaseSessionImpl(scope);

    const helpPromise = session.requestHelp('call-1', 'which deps?');
    expect(session.listPendingHelp()).toEqual([
      { toolCallId: 'call-1', query: 'which deps?' },
    ]);

    const delivered = session.respondToHelp('call-1', {
      kind: 'answer',
      text: 'depends on t-2',
    });
    expect(delivered).toBe(true);

    await expect(helpPromise).resolves.toEqual({
      kind: 'answer',
      text: 'depends on t-2',
    });
    expect(session.listPendingHelp()).toEqual([]);
  });

  it('respondToHelp returns false for unknown toolCallId', () => {
    const session = new ProposalPhaseSessionImpl(scope);
    const delivered = session.respondToHelp('missing', {
      kind: 'discuss',
    });
    expect(delivered).toBe(false);
  });

  it('multiple concurrent help requests resolve independently', async () => {
    const session = new ProposalPhaseSessionImpl(scope);

    const a = session.requestHelp('call-a', 'q-a');
    const b = session.requestHelp('call-b', 'q-b');
    expect(session.listPendingHelp()).toHaveLength(2);

    session.respondToHelp('call-b', { kind: 'discuss' });
    await expect(b).resolves.toEqual({ kind: 'discuss' });
    expect(session.listPendingHelp()).toEqual([
      { toolCallId: 'call-a', query: 'q-a' },
    ]);

    session.respondToHelp('call-a', { kind: 'answer', text: 'a' });
    await expect(a).resolves.toEqual({ kind: 'answer', text: 'a' });
  });
});
