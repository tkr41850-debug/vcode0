import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from '@mariozechner/pi-tui';

export interface ComposerAutocompleteContext {
  commands: (SlashCommand | AutocompleteItem)[];
}

/**
 * Stable AutocompleteProvider wrapper installed once on the composer.
 * Forwards each call to a fresh CombinedAutocompleteProvider built from
 * the latest context, so unrelated UI refreshes do not have to swap the
 * editor's provider (which clears any active autocomplete UI).
 */
export class DelegatingAutocompleteProvider implements AutocompleteProvider {
  constructor(
    private readonly contextProvider: () => ComposerAutocompleteContext,
  ) {}

  private buildDelegate(): CombinedAutocompleteProvider {
    return new CombinedAutocompleteProvider(this.contextProvider().commands);
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    return this.buildDelegate().getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    );
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.buildDelegate().applyCompletion(
      lines,
      cursorLine,
      cursorCol,
      item,
      prefix,
    );
  }
}
