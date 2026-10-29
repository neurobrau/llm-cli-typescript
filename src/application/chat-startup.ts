/**
 * Startup of the interactive chat (Python `cli.run_interactive`/
 * `ChatSession.restore`, Go `runInteractive`): locate state, restore the
 * conversation, build the selected provider, load settings and resolve them.
 * Nothing is written. The caller prints; this function returns warnings in a
 * deterministic order and throws ProviderError / SettingsError / AbortError
 * for the fatal cases.
 */
import type { ChatInvocation } from "../args.js";
import { ensureNotAborted } from "../domain/errors.js";
import type { ProviderId } from "../domain/generation.js";
import type { Provider } from "../domain/provider.js";
import type { ModelPreferences, ResolvedSettings } from "../domain/settings.js";
import { displayPath } from "../storage/fs/errors.js";
import { resolveStorageComponents } from "../storage/fs/paths.js";
import type { StorageEnvironment } from "../storage/fs/paths.js";
import { matchesSelection } from "../storage/matching.js";
import type { ActiveSelection, StoredConversation, StoredSettings } from "../storage/types.js";
import { resolveSettings } from "./resolve-settings.js";
import { ChatSession } from "./session.js";
import type { Clock, SessionHistory } from "./session.js";

/** The reading half of a history store plus what the session writes through. */
export interface HistoryPort extends SessionHistory {
  loadActive(): Promise<{ readonly selection: ActiveSelection | undefined; readonly warning: string | undefined }>;
  loadLatest(
    accepts: (conversation: StoredConversation) => boolean,
  ): Promise<{ readonly conversation: StoredConversation | undefined; readonly warnings: readonly string[] }>;
}

/** Settings are read-only in the chat: the port has no way to save. */
export interface SettingsPort {
  load(): Promise<{ readonly settings: StoredSettings; readonly warnings: readonly string[] }>;
}

export interface ChatStartupDependencies {
  /** The only source of state locations: no `process.env` and no `homedir()` here. */
  readonly environment: { readonly env: StorageEnvironment; readonly home?: string | undefined };
  readonly clock: Clock;
  readonly newId: () => string;
  /** Creates the provider the conversation will use; called once, only for the selected provider. */
  readonly createProvider: (id: ProviderId) => Provider;
  /** Throws a ProviderError when the selected provider cannot run (e.g. no API key). No network. */
  readonly checkProviderReady?: ((id: ProviderId) => void) | undefined;
  readonly createHistoryStore: (conversationsDirectory: string) => HistoryPort;
  readonly createSettingsStore: (path: string) => SettingsPort;
}

export interface StartedChat {
  readonly session: ChatSession;
  readonly provider: Provider;
  readonly settings: ResolvedSettings;
  /** Ordered startup warnings and notices, each shown once. */
  readonly warnings: readonly string[];
}

export const NO_HOME_HISTORY = "Cannot determine the home directory; conversation history is disabled.";
export const NO_HOME_SETTINGS = "Cannot determine the home directory; settings are not loaded or saved.";
const INVALID_STATE_PATH = "The state directory location is invalid; conversation history is disabled.";
const INVALID_CONFIG_PATH = "The configuration directory location is invalid; settings are not loaded or saved.";

const SUPPORTED: readonly ProviderId[] = ["openai", "ollama"];

function supportedProvider(value: string | undefined): ProviderId | undefined {
  return SUPPORTED.find((id) => id === value);
}

export async function startChat(invocation: ChatInvocation, deps: ChatStartupDependencies, signal: AbortSignal): Promise<StartedChat> {
  const warnings: string[] = [];
  const paths = resolveStorageComponents(deps.environment);

  // 1. History (never touched with --no-history, not even to resolve its location).
  let history: HistoryPort | undefined;
  if (!invocation.noHistory) {
    if (paths.history.ok) {
      history = deps.createHistoryStore(paths.history.value.conversations);
    } else {
      warnings.push(paths.history.error.kind === "home-required" ? NO_HOME_HISTORY : INVALID_STATE_PATH);
    }
  }

  // 2. The requested selection. An omitted provider differs from an explicit one only when
  //    neither provider nor model was given (then the saved active selection applies).
  const nothingRequested = invocation.provider === undefined && invocation.model === undefined;
  let requestedProvider: ProviderId | undefined = invocation.provider ?? (invocation.model === undefined ? undefined : "openai");
  let requestedModel: string | undefined = invocation.model;
  if (history !== undefined && nothingRequested) {
    const active = await history.loadActive();
    ensureNotAborted(signal);
    if (active.warning !== undefined) warnings.push(active.warning);
    if (active.selection !== undefined) {
      requestedProvider = active.selection.provider;
      requestedModel = active.selection.model;
    }
  }

  // 3. Restore: only providers this edition can run are eligible; other files stay untouched.
  const filter = { provider: requestedProvider, model: requestedModel };
  let restored: StoredConversation | undefined;
  if (history !== undefined) {
    const latest = await history.loadLatest(
      (conversation) => supportedProvider(conversation.provider ?? "openai") !== undefined && matchesSelection(conversation, filter),
    );
    ensureNotAborted(signal);
    warnings.push(...latest.warnings);
    restored = latest.conversation;
  }
  const providerId = supportedProvider(restored === undefined ? requestedProvider : (restored.provider ?? "openai")) ?? "openai";

  // 4. Only the selected provider is built; a missing key ends startup before any output.
  deps.checkProviderReady?.(providerId);
  const provider = deps.createProvider(providerId);

  // 5. Fill the unresolved model with the provider's own default; never replace a restored or requested one.
  const model = restored?.model ?? requestedModel ?? (await provider.defaultModel(signal));
  ensureNotAborted(signal);

  // 6. Settings (read-only), capabilities, strict resolution: CLI > valid saved > built-in.
  let stored: StoredSettings | undefined;
  if (paths.settings.ok) {
    const loaded = await deps.createSettingsStore(paths.settings.value).load();
    ensureNotAborted(signal);
    stored = loaded.settings;
    warnings.push(...loaded.warnings);
  } else {
    warnings.push(paths.settings.error.kind === "home-required" ? NO_HOME_SETTINGS : INVALID_CONFIG_PATH);
  }
  const capabilities = await provider.getCapabilities(model, signal);
  ensureNotAborted(signal);
  const saved = savedPreferences(stored, providerId, model, invocation.maxOutputTokens !== undefined);
  warnings.push(...saved.notices);
  const resolution = resolveSettings({
    provider: providerId,
    model,
    capabilities,
    saved: saved.preferences,
    ...(stored === undefined ? {} : { savedAnswerStyle: stored.answerStyle }),
    cli: {
      ...(invocation.reasoning === undefined ? {} : { reasoning: invocation.reasoning }),
      ...(invocation.maxOutputTokens === undefined ? {} : { maxOutputTokens: invocation.maxOutputTokens }),
      ...(invocation.answerStyle === undefined ? {} : { answerStyle: invocation.answerStyle }),
    },
    mode: "strict",
  });
  warnings.push(...resolution.notices);

  const session = new ChatSession({
    selection: { provider: providerId, model },
    clock: deps.clock,
    newId: deps.newId,
    history,
    restored,
  });
  return { session, provider, settings: resolution.settings, warnings };
}

/**
 * Stored preferences for the exact provider/model in the runtime's number
 * form. A stored limit is converted only after bigint bounds checks: one that
 * does not fit a safe integer is ignored with a visible notice (the file is
 * never touched), while a valid reasoning choice is kept.
 */
export function savedPreferences(
  stored: StoredSettings | undefined,
  provider: ProviderId,
  model: string,
  cliSetsLimit: boolean,
): { readonly preferences: ModelPreferences; readonly notices: readonly string[] } {
  const entry = stored?.providers.get(provider)?.get(model);
  if (entry === undefined) {
    return { preferences: {}, notices: [] };
  }
  const notices: string[] = [];
  let maxOutputTokens: number | null | undefined;
  const limit = entry.maxOutputTokens;
  if (limit === null) {
    maxOutputTokens = null;
  } else if (limit !== undefined) {
    if (limit > 0n && limit <= BigInt(Number.MAX_SAFE_INTEGER)) {
      maxOutputTokens = Number(limit);
    } else if (!cliSetsLimit) {
      // With a command-line limit the saved one is overridden anyway, as for any other saved limit.
      notices.push(
        `Saved setting ignored: max output tokens ${limit.toString(10)} for ${provider}/${displayPath(model)} cannot be used ` +
          `(the largest supported value is ${String(Number.MAX_SAFE_INTEGER)}). Using the default.`,
      );
    }
  }
  return {
    preferences: {
      ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
    notices,
  };
}

