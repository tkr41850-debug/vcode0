/**
 * Scripted faux-provider sequences for the pi-sdk resume/replay spike.
 *
 * Each scenario drives the pi-sdk `Agent` into a specific state shape so the
 * spike test can observe how `Agent.continue()` behaves after abort/resume.
 *
 * These fixtures are pure data — no assertions. The spike test harness
 * (`./pi-sdk-resume.test.ts`) owns the assertions and logs `[SPIKE][Sn]`
 * observations that get lifted into `docs/spikes/pi-sdk-resume.md`.
 */

import {
  fauxAssistantMessage,
  fauxText,
  type FauxResponseStep,
  fauxToolCall,
} from '../harness/faux-stream.js';

/**
 * Scenario 1 — cold start: one assistant message with a terminal `submit`
 * tool call followed by a textual wrap-up. This is the happy path: the
 * Agent reaches `turn_end` naturally with a clean transcript.
 */
export const COLD_START: FauxResponseStep[] = [
  fauxAssistantMessage(
    [
      fauxToolCall('submit', {
        summary: 'cold start: task done',
        filesChanged: [],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Task submitted.')]),
];

/**
 * Scenario 2 — mid-tool-call: assistant emits a tool call that a test harness
 * can intercept (we abort on the `tool_execution_start` event, before the
 * tool completes). A follow-up assistant message is queued so continue()
 * has somewhere to go if pi-sdk permits resumption.
 */
export const MID_TOOL_CALL: FauxResponseStep[] = [
  fauxAssistantMessage(
    [
      fauxToolCall('progress', {
        message: 'long-running step in progress',
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Resumed after mid-tool abort.')]),
];

/**
 * Scenario 3 — mid-response stream: the assistant emits a long text
 * response. The harness aborts on the first `message_update` so the
 * streamed-but-incomplete assistant message is left dangling.
 */
export const MID_RESPONSE: FauxResponseStep[] = [
  fauxAssistantMessage([
    fauxText(
      `This is a long response that will be aborted mid-stream. ${'x'.repeat(
        500,
      )}`,
    ),
  ]),
  fauxAssistantMessage([fauxText('Resumed message after mid-response abort.')]),
];

/**
 * Scenario 4 — post-commit abort: assistant runs `submit` tool to
 * completion (so the last message in the transcript is a tool-result),
 * then continue() is called. This is the "clean resume after a pause"
 * path — the case RESEARCH.md says pi-sdk explicitly supports.
 */
export const POST_COMMIT: FauxResponseStep[] = [
  fauxAssistantMessage(
    [
      fauxToolCall('submit', {
        summary: 'post-commit scenario: submitted',
        filesChanged: [],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('Continuation after post-commit.')]),
];

/**
 * Scenario 5 — catastrophic crash: sessions-store integrity check.
 * Drives the same shape as COLD_START; the test targets the session
 * persistence layer, not the live Agent.
 */
export const CATASTROPHIC: FauxResponseStep[] = COLD_START;

export const ALL_SCENARIOS = {
  coldStart: COLD_START,
  midToolCall: MID_TOOL_CALL,
  midResponse: MID_RESPONSE,
  postCommit: POST_COMMIT,
  catastrophic: CATASTROPHIC,
} as const;
