/**
 * Saved preferences of a fullscreen run plus the command-line overrides that
 * are still in force (docs/tui.md). Reuses the strict/lenient resolver and
 * `savedPreferences`; owns no serialization of its own - saving goes through
 * the very settings store that loaded the file, whose never-overwrite-an-
 * unreadable-file state therefore stays intact.
 *
 * - Command-line values are held apart from resolved values. A confirmed
 *   choice clears only its own field's override, for the rest of the run.
 * - Nothing is written by startup, discovery or switching; only a confirmed
 *   change writes, and a write failure never undoes the choice for this run.
 * - Every other stored entry (other providers, models, unknown names, huge
 *   limits) is carried over untouched.
 */
import { StorageCodecError } from "../storage/errors.js";
import { emptySettings } from "../storage/settings.js";
import type { StoredModelPreferences, StoredSettings } from "../storage/types.js";
import type { ProviderId } from "../domain/generation.js";
import type { AnswerStyle, CliOverrides, ModelCapabilities, SettingsResolution } from "../domain/settings.js";
import { resolveSettings } from "./resolve-settings.js";
import { savedPreferences } from "./chat-startup.js";
import type { SettingsSaver } from "./chat-startup.js";

export const NO_SETTINGS_LOCATION = "Settings not saved: the configuration location is not known.";

/** What a confirmed choice did: whether anything changed, and the write (resolving to a warning, if it failed). */
export interface Choice {
  /** False: the choice equals what was already saved and nothing overrode it - no confirmation, no write. */
  readonly changed: boolean;
  readonly save: Promise<string | undefined> | undefined;
}

const UNCHANGED: Choice = { changed: false, save: undefined };

interface Overrides {
  reasoning?: NonNullable<CliOverrides["reasoning"]>;
  maxOutputTokens?: number;
  answerStyle?: AnswerStyle;
}

export interface PreferencesOptions {
  /** The document the store loaded, or `undefined` when no settings location is usable. */
  readonly stored: StoredSettings | undefined;
  /** The original store; a store without `save` (or none) keeps changes in memory with a warning. */
  readonly saver: Partial<SettingsSaver> | undefined;
  readonly overrides: CliOverrides;
}

export class PreferencesService {
  private stored: StoredSettings;
  private readonly overrides: Overrides;
  private readonly saver: Partial<SettingsSaver> | undefined;
  private styleKnown: boolean;

  constructor(options: PreferencesOptions) {
    this.stored = options.stored ?? emptySettings();
    this.styleKnown = options.stored !== undefined;
    this.saver = options.saver;
    this.overrides = {
      ...(options.overrides.reasoning === undefined ? {} : { reasoning: options.overrides.reasoning }),
      ...(options.overrides.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.overrides.maxOutputTokens }),
      ...(options.overrides.answerStyle === undefined ? {} : { answerStyle: options.overrides.answerStyle }),
    };
  }

  /** The remaining command-line overrides (a copy). */
  get remainingOverrides(): CliOverrides {
    return { ...this.overrides };
  }

  /** The current in-memory document (may be ahead of the disk after a failed write). */
  get document(): StoredSettings {
    return this.stored;
  }

  /**
   * Resolves a selection leniently: CLI (remaining) > valid saved > builtin; an unusable value gives the
   * resolver's notice and falls through to the next source. Notices for stored limits the runtime cannot use are included.
   */
  resolveFor(provider: ProviderId, model: string, capabilities: ModelCapabilities): SettingsResolution {
    const saved = savedPreferences(this.stored, provider, model, this.overrides.maxOutputTokens !== undefined);
    const resolution = resolveSettings({
      provider,
      model,
      capabilities,
      saved: saved.preferences,
      ...(this.styleKnown ? { savedAnswerStyle: this.stored.answerStyle } : {}),
      cli: this.remainingOverrides,
      mode: "lenient",
    });
    return { settings: resolution.settings, notices: [...saved.notices, ...resolution.notices] };
  }

  entryFor(provider: string, model: string): StoredModelPreferences | undefined {
    return this.stored.providers.get(provider)?.get(model);
  }

  /** `value` is a provider value or `"default"` (omit the parameter, explicitly). */
  setReasoning(provider: string, model: string, value: string): Choice {
    const hadOverride = this.overrides.reasoning !== undefined;
    const differs = this.entryFor(provider, model)?.reasoning !== value;
    if (!hadOverride && !differs) return UNCHANGED;
    delete this.overrides.reasoning;
    if (!differs) return { changed: true, save: undefined };
    this.stored = withEntry(this.stored, provider, model, { reasoning: value });
    return { changed: true, save: this.persist() };
  }

  /** `null` is the explicit model default; a bigint a positive limit of any size. */
  setMaxOutputTokens(provider: string, model: string, value: bigint | null): Choice {
    const hadOverride = this.overrides.maxOutputTokens !== undefined;
    const current = this.entryFor(provider, model)?.maxOutputTokens;
    const differs = current === undefined || current !== value;
    if (!hadOverride && !differs) return UNCHANGED;
    delete this.overrides.maxOutputTokens;
    if (!differs) return { changed: true, save: undefined };
    this.stored = withEntry(this.stored, provider, model, { maxOutputTokens: value });
    return { changed: true, save: this.persist() };
  }

  /** The answer style is global. */
  setAnswerStyle(style: AnswerStyle): Choice {
    const hadOverride = this.overrides.answerStyle !== undefined;
    const differs = !this.styleKnown || this.stored.answerStyle !== style;
    if (!hadOverride && !differs) return UNCHANGED;
    delete this.overrides.answerStyle;
    if (!differs) return { changed: true, save: undefined };
    this.stored = { ...this.stored, answerStyle: style };
    this.styleKnown = true;
    return { changed: true, save: this.persist() };
  }

  /**
   * Hands the current in-memory document to the store (encoded at once, so concurrent changes keep their order).
   * Resolves to `undefined` on success, otherwise to the visible warning; the choice stays effective either way.
   */
  private async persist(): Promise<string | undefined> {
    if (this.saver?.save === undefined) return NO_SETTINGS_LOCATION;
    try {
      const result = await this.saver.save(this.stored);
      return result.saved ? undefined : result.warning;
    } catch (error: unknown) {
      if (error instanceof StorageCodecError) return `Settings not saved: ${error.message}.`;
      throw error;
    }
  }
}

/** A copy of the document with one model's preferences merged; every other entry is shared untouched. */
function withEntry(stored: StoredSettings, provider: string, model: string, patch: StoredModelPreferences): StoredSettings {
  const providers = new Map(stored.providers);
  const models = new Map(providers.get(provider) ?? []);
  models.set(model, { ...models.get(model), ...patch });
  providers.set(provider, models);
  return { ...stored, providers };
}
