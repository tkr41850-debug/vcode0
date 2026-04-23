# Spike: pi-sdk `Agent.continue()` resume/replay fidelity

**Date:** 2026-04-23
**pi-sdk version tested:** `@mariozechner/pi-agent-core` **0.66.1**
**Gating phase:** Phase 7 (two-tier pause + respawn-with-replay), REQ-INBOX-02 / REQ-INBOX-03
**Harness:** `test/integration/spike/pi-sdk-resume.test.ts` (reproducible; re-run on pi-sdk upgrades)
**Raw observations:** `.planning/phases/03-worker-execution-loop/spike-run-output.txt`

## TL;DR

`Agent.continue()` is **unusable** as the primary resume path for Phase 7. In
every scenario we tested, after either a clean `turn_end` or an aborted run,
the transcript ends on an `assistant` message, and pi-sdk's `Agent.continue()`
refuses to proceed with `"Cannot continue from message role: assistant"`
([agent.d.ts:103](../../node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts)).

Decision: **persist-tool-outputs** strategy. Phase 7 owns a thin
`@runtime/resume` facade that hides this from consumers.

## Scenario matrix & observations

| # | Scenario                            | Setup                                                                 | Observed (Agent state)                                                                                                   | continue() outcome                                                |
|---|-------------------------------------|-----------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| 1 | Cold start                          | Fresh Agent, `prompt("task: do x")` runs `submit` tool to completion | `{"messageCount":4,"lastRole":"assistant","pendingToolCalls":0,"isStreaming":false,"hasStreamingMessage":false,"promptError":null}` | N/A (cold)                                                        |
| 2 | Mid-tool abort                      | `prompt` + abort on first `message_update`                            | `{"messageCount":4,"lastRole":"assistant","pendingToolCalls":0,"isStreaming":false,"errorMessage":"Request was aborted","hasStreamingMessage":false}` | **throws** `"Cannot continue from message role: assistant"`       |
| 3 | Mid-response abort                  | `prompt` + abort on first `message_update`                            | `{"messageCount":2,"lastRole":"assistant","pendingToolCalls":0,"isStreaming":false,"errorMessage":"Request was aborted","hasStreamingMessage":false}` | **throws** `"Cannot continue from message role: assistant"`       |
| 4 | Post-commit resume                  | `prompt` runs to clean `turn_end`, then `continue()` is called       | `{"messageCount":4,"lastRole":"assistant","pendingToolCalls":0,"isStreaming":false,"hasStreamingMessage":false}`         | **throws** `"Cannot continue from message role: assistant"`       |
| 5 | Catastrophic crash (session roundtrip) | Run to completion, save via `FileSessionStore`, load, rehydrate new Agent, continue | loaded `{"recoveredCount":4,"lastRole":"assistant","savedCount":4}`                                                      | **throws** `"Cannot continue from message role: assistant"`       |

### Key observations

1. **`lastRole` is ALWAYS `"assistant"` after every run path we measured.** Cold
   start, mid-tool abort, mid-stream abort, clean turn_end, and session
   roundtrip all leave the transcript ending on an assistant message —
   precisely the state `continue()` rejects.
2. **`pendingToolCalls` is always 0 post-abort.** pi-sdk appears to drop the
   pending set on abort; we cannot use it as a splice cue.
3. **`streamingMessage` is `undefined` post-abort.** The partial-streamed
   assistant message is not preserved across the abort/settle boundary.
4. **`errorMessage` IS populated** after abort (`"Request was aborted"`) and is
   visible on the state snapshot.
5. **`FileSessionStore` round-trip is lossless.** Scenario 5 saved 4 messages
   and loaded 4 with the same `lastRole`. The persistence layer is not the
   problem; pi-sdk's `continue()` contract is.

## Decision: **persist-tool-outputs**

Phase 7 CANNOT rely on `Agent.continue()` as the resume primitive. In every
observed case where a resume is actually needed (mid-tool abort, mid-stream
abort, clean turn_end rehydration, catastrophic crash) the transcript ends
with an assistant message and `continue()` throws.

Even scenario 4 — the nominally "clean" post-commit path — fails the same
way, because the terminal `submit` tool is *followed* by a wrap-up assistant
text message (the faux-response sequence drains one more assistant response
after the tool call). The moment an assistant says anything that isn't a
raw tool call, `continue()` is off the table until a user/tool message is
appended.

### Why not native

1. Every realistic resume trigger in Phase 7 (hot-window expiry, process
   crash, explicit operator pause) lands us in `lastRole=assistant`.
2. pi-sdk's `continue()` throws synchronously on that state — there is no
   pi-sdk-level workaround within the documented API.
3. Silently dropping the trailing assistant message would discard work and
   break observability.

### Why not hybrid

The "native for some, fallback for others" split doesn't save meaningful
code: the fallback is required for every realistic path, and adding a
native-first branch just adds a dead code path plus more tests.

### Why persist-tool-outputs works

After abort or pause, we need to:

1. Surface the latest transcript (already covered by `FileSessionStore`).
2. Ensure the transcript ends on a `user` or `tool-result` message before
   calling `continue()`.

For the mid-tool-call path, this means persisting tool-execution results as
they complete and splicing any matching tool-call from the terminal
assistant message into a synthetic tool-result message on resume. For the
clean turn_end path, this means appending a `user` nudge ("resume") as the
next message so `continue()` has a valid anchor, OR skipping the resume
entirely (the agent is already done). For mid-response abort, we either
drop the dangling partial (losing zero information — the partial was
already incomplete) or re-prompt.

## Minimal impl (Task 6 target)

### Files

- `src/runtime/resume/index.ts` — exports `RESUME_STRATEGY = 'persist-tool-outputs'` and `resume({ agent, savedMessages, toolOutputs })`.
- `src/runtime/resume/tool-output-store.ts` — in-memory + file-backed implementations of `ToolOutputStore`.
- `src/runtime/sessions/index.ts` — comment documenting the save-site + pointing here.
- `test/unit/runtime/resume/tool-output-store.test.ts` — roundtrip + clear + missing-id coverage.

### Resume algorithm

```text
splice(savedMessages, toolOutputs):
  messages = [...savedMessages]
  last = messages.at(-1)
  if last.role === "assistant" AND last has toolCalls:
    for each toolCall tc in last.toolCalls:
      saved = toolOutputs.get(tc.id)
      if saved exists:
        messages.push({ role: "toolResult", toolCallId: tc.id, content: JSON.stringify(saved) })
  return messages

resume(agent, savedMessages, toolOutputs):
  spliced = splice(savedMessages, toolOutputs)
  agent.state.messages = spliced
  await agent.continue()
  await agent.waitForIdle()
```

The splice is a best-effort: if the assistant's terminal message is NOT a
tool-call message (e.g., it's a plain text wrap-up like scenario 4), the
transcript is already well-formed and there is nothing to splice, but
`continue()` still refuses. Phase 7 handles that edge case by treating
`lastRole === "assistant" && no-tool-calls` as "run already terminated,
no resume needed" — the transcript is the final output.

## Phase 7 integration checklist

- [ ] Phase 7 plan 07-03 imports `{ resume, RESUME_STRATEGY } from '@runtime/resume'`.
- [ ] Hot-window expiry persists the latest transcript via `FileSessionStore` at `turn_end` and at `message_end` (both are safe given the fallback).
- [ ] `afterToolCall` callback wired into the worker's `Agent` constructor records `{ toolCallId, output }` into the per-agent-run `ToolOutputStore`. File-backed store lives at `.gvc0/tool-outputs/<sessionId>/<toolCallId>.json`.
- [ ] Respawn path constructs a new `Agent`, loads the transcript via `FileSessionStore`, instantiates the matching `ToolOutputStore`, and calls `resume({ agent, savedMessages, toolOutputs })`.
- [ ] Edge case: if `resume()` detects `lastRole === "assistant"` with NO tool calls, it should early-return a `terminated` signal rather than calling `continue()`. This is the "agent already finished" path that Phase 7 must surface as a no-op.
- [ ] On successful respawn, the tool-output store is cleared (the outputs are now encoded in the transcript as tool-result messages; keeping them creates drift risk).

## Known limitations & follow-ups

- The spike uses pi-ai's faux provider. Real providers' streaming timing,
  tool-call packaging, and token accounting may differ. Re-run the spike
  against a live provider before Phase 7 declares 07-03 done.
- Scenario 3 (mid-response abort) could not produce a non-empty
  `streamingMessage` snapshot — the abort happens after the stream settles.
  If a future pi-sdk version preserves the partial message across abort,
  the fallback will still work (we drop partials rather than splice them)
  but there is a latent opportunity to recover partial assistant output
  that we do NOT exploit today.
- The `ToolOutputStore` is per-run by design. If a tool call spans worker
  restarts (the tool itself crashes and is retried), the store must be
  keyed on `{ agentRunId, toolCallId }`, not `toolCallId` alone. Phase 9
  (crash recovery) will validate this keying.
- `continue()` is still used on the happy resume path. If pi-sdk later
  relaxes the `"assistant last"` check, the fallback becomes unnecessary
  for cases where the splice is a no-op. The spike test guards this: a
  future green run on scenario 4 would let us revisit the decision.

## Verification

Task 7 appends a facade smoke-test (`Facade — resume() via @runtime/resume
handles saved-and-rehydrated Agent without throwing`) to
`test/integration/spike/pi-sdk-resume.test.ts`. It asserts:

1. `RESUME_STRATEGY === 'persist-tool-outputs'` (the decision constant
   matches this document).
2. The facade does not throw on a cold-start transcript whose last
   message is a plain-text assistant wrap-up.
3. The outcome discriminates `resumed` vs `already-terminated` so Phase 7
   can branch on it.

`npm run test:integration -- test/integration/spike/pi-sdk-resume` must
stay green. If it fails after a pi-sdk upgrade, the decision on this page
must be re-validated before merging the upgrade.
