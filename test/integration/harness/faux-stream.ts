import {
  type FauxProviderRegistration,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type RegisterFauxProviderOptions,
  registerFauxProvider,
} from '@mariozechner/pi-ai';

/**
 * Thin wrapper around pi-ai's `registerFauxProvider` for integration
 * tests. Registration is global to the pi-ai api-registry, so callers
 * MUST call `unregister()` in an afterEach (or similar) to avoid
 * cross-test bleed.
 *
 * Use the returned `setResponses` / `appendResponses` to script a
 * deterministic sequence of assistant turns, then run a real pi-agent
 * `Agent` against whichever API/model slot the test registered the faux
 * provider on.
 */
export function createFauxProvider(
  options?: RegisterFauxProviderOptions,
): FauxProviderRegistration {
  return registerFauxProvider(options);
}

/**
 * Build a faux response sequence where the agent emits plain text only,
 * with no tool call. Reproduces the planner-phase failure mode where an
 * agent finishes without invoking `submit` / `submitDiscuss`.
 *
 * The runtime detects the missing tool call after the agent loop ends
 * and throws `<phase> phase must call submit before completion`. Used as
 * a regression anchor for that path.
 */
export function fauxPlainTextOnlyResponse(text: string): FauxResponseStep[] {
  return [fauxAssistantMessage([fauxText(text)])];
}

export type { FauxProviderRegistration, FauxResponseStep };
export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };
