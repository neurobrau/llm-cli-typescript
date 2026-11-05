/**
 * The selection state of a fullscreen run: which provider/model is in use and
 * the independent conversation (messages, usage, file) of every exact
 * provider/model pair used so far (docs/tui-spec.md sections 4b and 11).
 *
 * Switching has two separate steps so cancellation is clean:
 *
 * - `prepareSwitch` is asynchronous and read-only: it builds/checks the target
 *   provider, resolves its settings and finds its conversation. It changes
 *   nothing, so an aborted or failed preparation leaves selection, memory and
 *   files exactly as they were.
 * - `accept` is the synchronous acceptance boundary: it swaps the selection in
 *   memory (no await) and only then starts the storage writes, which are
 *   awaited by the caller and never rolled back.
 *
 * A conversation remembered earlier in this run wins over the disk; an empty
 * conversation that already has a file (for example after `/reset`) is
 * remembered too. Sessions share one `active.json` tracker and the history
 * access; nothing is written merely because a remembered conversation returns.
 */
import { ensureNotAborted, ProviderError, SettingsError } from "../domain/errors.js";
import type { ProviderId } from "../domain/generation.js";
import type { Provider } from "../domain/provider.js";
import type { ModelCapabilities, ResolvedSettings } from "../domain/settings.js";
import { matchesSelection } from "../storage/matching.js";
import type { ActiveSelection, StoredConversation } from "../storage/types.js";
import type { HistoryPort } from "./chat-startup.js";
import { PROVIDER_LABELS, ProviderHub } from "./provider-hub.js";
import type { PreferencesService } from "./preferences.js";
import { ChatSession } from "./session.js";
import type { ActiveTracker, Clock } from "./session.js";

/** A recoverable refusal to switch; the message is the visible text. */
export class SwitchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchRefusal";
  }
}

/** The key of an exact selection; JSON keeps provider and model apart whatever characters the model ID has. */
export function selectionKey(selection: ActiveSelection): string {
  return JSON.stringify([selection.provider, selection.model]);
}

export type SwitchSource =
  | { readonly kind: "parked"; readonly session: ChatSession }
  | { readonly kind: "restored"; readonly conversation: StoredConversation }
  | { readonly kind: "new" };

export interface PreparedSwitch {
  /** Rejected by `accept` when the workspace changed since the preparation started. */
  readonly stamp: number;
  readonly provider: Provider;
  readonly selection: ActiveSelection;
  readonly settings: ResolvedSettings;
  /** Resolver notices (unsupported command-line or saved values). */
  readonly notices: readonly string[];
  /** Storage warnings of the conversation lookup (unreadable files). */
  readonly warnings: readonly string[];
  readonly source: SwitchSource;
}

export interface SwitchResult {
  readonly session: ChatSession;
  readonly source: SwitchSource["kind"];
  /** The reference notice: restored, or a new conversation. */
  readonly notice: string;
  /** The storage writes of the acceptance, already started; resolves to warnings. */
  readonly writes: Promise<readonly string[]>;
}

export interface WorkspaceOptions {
  readonly hub: ProviderHub;
  readonly preferences: PreferencesService;
  readonly session: ChatSession;
  readonly provider: Provider;
  readonly settings: ResolvedSettings;
  readonly history: HistoryPort | undefined;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly activeTracker: ActiveTracker;
}

/** What a confirmed settings choice did. */
export interface SettingChange {
  readonly changed: boolean;
  /** The storage write (resolves to a warning when it failed), if one was needed. */
  readonly save: Promise<string | undefined> | undefined;
}

export class Workspace {
  private readonly hub: ProviderHub;
  private readonly prefs: PreferencesService;
  private readonly history: HistoryPort | undefined;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly tracker: ActiveTracker;
  private readonly sessions = new Map<string, ChatSession>();
  private active: ChatSession;
  private activeProvider: Provider;
  private resolved: ResolvedSettings;
  private stamp = 0;

  constructor(options: WorkspaceOptions) {
    this.hub = options.hub;
    this.prefs = options.preferences;
    this.history = options.history;
    this.clock = options.clock;
    this.newId = options.newId;
    this.tracker = options.activeTracker;
    this.active = options.session;
    this.activeProvider = options.provider;
    this.resolved = options.settings;
    this.sessions.set(selectionKey(options.session.selection), options.session);
  }

  get session(): ChatSession {
    return this.active;
  }

  get provider(): Provider {
    return this.activeProvider;
  }

  get settings(): ResolvedSettings {
    return this.resolved;
  }

  get selection(): ActiveSelection {
    return this.active.selection;
  }

  // ----- switching -----

  /**
   * Reads and checks everything a switch needs, changing nothing. `progress` reports the reference
   * status labels. Throws `SwitchRefusal` for "not available" cases, ProviderError for other provider
   * failures and an AbortError when cancelled.
   */
  async prepareSwitch(
    target: { readonly provider: ProviderId; readonly model?: string | undefined },
    signal: AbortSignal,
    progress: (label: string) => void,
  ): Promise<PreparedSwitch> {
    const stamp = this.stamp;
    const label = PROVIDER_LABELS[target.provider];
    let provider: Provider;
    if (target.provider === this.activeProvider.id) {
      provider = this.activeProvider;
    } else {
      progress(`Checking ${label}`);
      provider = this.acquire(target.provider, label);
      let availability;
      try {
        availability = await provider.checkAvailability(signal);
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw new SwitchRefusal(`${label} is not available: ${error.message}`);
        throw error;
      }
      ensureNotAborted(signal);
      if (!availability.available) throw new SwitchRefusal(`${label} is not available: ${availability.message}`);
    }
    const model = target.model ?? (await provider.defaultModel(signal));
    ensureNotAborted(signal);
    const selection: ActiveSelection = { provider: target.provider, model };
    progress("Checking model settings");
    const capabilities = await provider.getCapabilities(model, signal);
    ensureNotAborted(signal);
    const { settings, notices } = this.prefs.resolveFor(target.provider, model, capabilities);

    const parked = this.sessions.get(selectionKey(selection));
    let source: SwitchSource = parked === undefined ? { kind: "new" } : { kind: "parked", session: parked };
    let warnings: readonly string[] = [];
    if (parked === undefined && this.history !== undefined) {
      const latest = await this.history.loadLatest((conversation) => matchesSelection(conversation, selection));
      ensureNotAborted(signal);
      warnings = latest.warnings;
      if (latest.conversation !== undefined) source = { kind: "restored", conversation: latest.conversation };
    }
    return { stamp, provider, selection, settings, notices, warnings, source };
  }

  /**
   * The synchronous acceptance: no await between the caller's last cancellation check and this call
   * returning. Afterwards the selection, conversation and settings are the target's; the returned writes
   * (empty conversation and `active.json` for a new selection, `active.json` only for a remembered or
   * restored one) are already started and are never rolled back.
   */
  accept(prepared: PreparedSwitch): SwitchResult {
    if (prepared.stamp !== this.stamp) throw new Error("the selection changed while it was being prepared");
    const previous = this.active;
    const hadMessages = previous.snapshot().messages.length > 0;
    const persistent = previous.persistent;
    // Nothing worth remembering (no content, no file): the conversation is simply dropped.
    if (!previous.retainable) this.sessions.delete(selectionKey(previous.selection));
    const { source } = prepared;
    const session =
      source.kind === "parked"
        ? source.session
        : new ChatSession({
            selection: prepared.selection,
            clock: this.clock,
            newId: this.newId,
            history: this.history,
            activeTracker: this.tracker,
            ...(source.kind === "restored" ? { restored: source.conversation } : {}),
          });
    this.sessions.set(selectionKey(prepared.selection), session);
    this.active = session;
    this.activeProvider = prepared.provider;
    this.resolved = prepared.settings;
    this.stamp += 1;
    const writes = source.kind === "new" ? session.persist() : session.persistActive();
    const count = session.snapshot().messages.length;
    const now = `Now using ${PROVIDER_LABELS[prepared.selection.provider]} / ${prepared.selection.model}.`;
    let notice: string;
    if (count > 0) {
      notice = `${now} Restored its conversation (${String(count)} messages).`;
    } else if (hadMessages && persistent) {
      notice = `${now} Started a new conversation; the previous one stays saved.`;
    } else if (hadMessages) {
      notice = `${now} Started a new conversation; the previous messages are not sent to the new model.`;
    } else {
      notice = `${now} Started a new conversation.`;
    }
    return { session, source: source.kind, notice, writes };
  }

  /** After a confirmed cleanup: nothing remembered in memory may come back; the active conversation was already restarted. */
  forgetOthers(): void {
    for (const [key, session] of [...this.sessions]) {
      if (session !== this.active) this.sessions.delete(key);
    }
  }

  // ----- settings of the current selection -----

  /** `value` is a provider value, or `"default"` for the explicit model default. */
  chooseReasoning(capabilities: ModelCapabilities, value: string): SettingChange {
    const { provider, model } = this.selection;
    const choice = this.prefs.setReasoning(provider, model, value);
    if (choice.changed) this.reresolve(capabilities);
    return choice;
  }

  /** `null` is the explicit model default; otherwise a positive limit (any size is stored, the runtime needs a safe integer). */
  chooseMaxOutputTokens(capabilities: ModelCapabilities, value: bigint | null): SettingChange {
    const { provider, model } = this.selection;
    const choice = this.prefs.setMaxOutputTokens(provider, model, value);
    if (choice.changed) this.reresolve(capabilities);
    return choice;
  }

  chooseAnswerStyle(style: ResolvedSettings["answerStyle"]["value"]): SettingChange {
    const choice = this.prefs.setAnswerStyle(style);
    if (choice.changed) {
      this.resolved = { ...this.resolved, answerStyle: { value: style, source: "saved" } };
      this.stamp += 1;
    }
    return choice;
  }

  private reresolve(capabilities: ModelCapabilities): void {
    const { provider, model } = this.selection;
    // The notices of this resolution were already shown when the selection was made.
    this.resolved = this.prefs.resolveFor(provider, model, capabilities).settings;
    this.stamp += 1;
  }

  private acquire(id: ProviderId, label: string): Provider {
    try {
      return this.hub.acquire(id);
    } catch (error: unknown) {
      if (error instanceof ProviderError || error instanceof SettingsError) {
        throw new SwitchRefusal(`${label} is not available: ${error.message}`);
      }
      throw error;
    }
  }
}
