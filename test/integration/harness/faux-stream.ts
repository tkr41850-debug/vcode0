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

export type { FauxProviderRegistration, FauxResponseStep };
export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };
