import type { StoredConversation } from "./types.js";

/** What a caller asks for; an unspecified field is a wildcard. */
export interface SelectionFilter {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Whether a stored conversation belongs to the requested provider/model. A
 * stored conversation without a provider counts as `openai`; one without a
 * model matches any requested model of its provider. Unknown stored providers
 * are plain strings that match only themselves (or a wildcard). Pure: the
 * stored metadata is never rewritten.
 */
export function matchesSelection(conversation: StoredConversation, filter: SelectionFilter): boolean {
  const provider = conversation.provider ?? "openai";
  if (filter.provider !== undefined && provider !== filter.provider) {
    return false;
  }
  return filter.model === undefined || conversation.model === undefined || conversation.model === filter.model;
}
