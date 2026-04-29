import type { GraphProposal } from '@core/proposals/index';
import { parseStoredProposalPayload } from '@orchestrator/proposals/index';
import { describe, expect, it } from 'vitest';

describe('parseStoredProposalPayload', () => {
  it('returns proposal for valid plan payload in top-level form', () => {
    const proposal: GraphProposal = {
      version: 1,
      mode: 'plan',
      aliases: {},
      ops: [],
    };
    const payloadJson = JSON.stringify(proposal);

    const result = parseStoredProposalPayload(payloadJson, 'plan');

    expect(result.proposal.mode).toBe('plan');
    expect(result.recovery).toBeUndefined();
  });

  it('returns replan payload in wrapped form with optional recovery', () => {
    const proposal: GraphProposal = {
      version: 1,
      mode: 'replan',
      aliases: {},
      ops: [],
    };
    const recovery = { phaseSummary: 'some summary' };
    const payloadJson = JSON.stringify({ proposal, recovery });

    const result = parseStoredProposalPayload(payloadJson, 'replan');

    expect(result.proposal.mode).toBe('replan');
    expect(result.recovery).toBeDefined();
    expect(result.recovery?.phaseSummary).toBe('some summary');
  });

  it('throws on mode mismatch', () => {
    const proposal: GraphProposal = {
      version: 1,
      mode: 'plan',
      aliases: {},
      ops: [],
    };
    const payloadJson = JSON.stringify(proposal);

    expect(() => parseStoredProposalPayload(payloadJson, 'replan')).toThrow(
      /mode mismatch/,
    );
  });

  it('throws on malformed JSON', () => {
    const payloadJson = 'not-json{';

    expect(() => parseStoredProposalPayload(payloadJson)).toThrow();
  });

  it('throws when payload is undefined', () => {
    expect(() => parseStoredProposalPayload(undefined)).toThrow(
      'proposal payload missing from agent run',
    );
  });
});
