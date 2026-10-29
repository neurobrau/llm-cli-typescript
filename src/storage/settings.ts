import { ANSWER_STYLES } from "../domain/settings.js";
import type { AnswerStyle } from "../domain/settings.js";
import { StorageCodecError } from "./errors.js";
import { CanonicalObject, JsonObject, asObject, asString, compareCodePoints, isPresent, isSchemaVersion1, isWellFormed, jsonTypeName, nonNegativeInteger, parseJson, renderCanonical } from "./json.js";
import type { Canonical, JsonValue } from "./json.js";
import { SCHEMA_VERSION } from "./types.js";
import type { DecodedSettings, StoredModelPreferences } from "./types.js";
import type { StoredSettings } from "./types.js";
import { requireText } from "./usage.js";

const NO_PROVIDERS = new JsonObject(new Map());
const DEFAULT_STYLE: AnswerStyle = "normal";
const MAX_NAME_IN_NOTICE = 60;

export function emptySettings(): StoredSettings {
  return { answerStyle: DEFAULT_STYLE, providers: new Map() };
}

function answerStyleOf(value: unknown): AnswerStyle | undefined {
  return ANSWER_STYLES.find((style) => style === value);
}

/** Names go into notices JSON-quoted (controls escaped) and capped. */
function shown(name: string): string {
  const quoted = JSON.stringify(name);
  return quoted.length > MAX_NAME_IN_NOTICE ? `${quoted.slice(0, MAX_NAME_IN_NOTICE)}…` : quoted;
}

/**
 * Reads `settings.json`. A wrong top level or schema version, or a
 * non-object `providers`, makes the whole document unusable (typed error;
 * a file-system layer must then not overwrite it). Bad individual values are
 * skipped and reported in `notices`; unknown fields are ignored. Saved values
 * are not checked against any model's capabilities.
 */
export function decodeSettings(input: string | Uint8Array): DecodedSettings {
  const root = asObject(parseJson(input));
  if (root === undefined) {
    throw new StorageCodecError("document", "the top level must be a JSON object");
  }
  if (!isSchemaVersion1(root.fields.get("schema_version"))) {
    throw new StorageCodecError("document", "unsupported schema_version (expected 1)");
  }
  const notices: string[] = [];
  let answerStyle = DEFAULT_STYLE;
  if (root.fields.has("answer_style")) {
    const raw = root.fields.get("answer_style");
    const style = answerStyleOf(raw);
    if (style === undefined) {
      notices.push(`Ignoring unknown answer_style (${jsonTypeName(raw)}); using ${DEFAULT_STYLE}.`);
    } else {
      answerStyle = style;
    }
  }
  const rawProviders = root.fields.has("providers") ? asObject(root.fields.get("providers")) : NO_PROVIDERS;
  if (rawProviders === undefined) {
    throw new StorageCodecError("document", "'providers' must be an object");
  }
  const providers = new Map<string, ReadonlyMap<string, StoredModelPreferences>>();
  for (const providerName of [...rawProviders.fields.keys()].sort(compareCodePoints)) {
    const models = asObject(asObject(rawProviders.fields.get(providerName))?.fields.get("models"));
    if (models === undefined || !isWellFormed(providerName)) {
      notices.push(`Ignoring settings for provider ${shown(providerName)}: 'models' must be an object.`);
      continue;
    }
    const decoded = new Map<string, StoredModelPreferences>();
    for (const modelName of [...models.fields.keys()].sort(compareCodePoints)) {
      const entry = decodeModelEntry(models.fields.get(modelName), modelName);
      if (typeof entry === "string") {
        notices.push(`Ignoring settings for ${shown(providerName)}/${shown(modelName)}: ${entry}.`);
      } else {
        decoded.set(modelName, entry);
      }
    }
    if (decoded.size > 0) {
      providers.set(providerName, decoded);
    }
  }
  return { settings: { answerStyle, providers }, notices };
}

/** Preferences, or the reason the whole entry is skipped. */
function decodeModelEntry(value: JsonValue | undefined, modelName: string): StoredModelPreferences | string {
  const entry = asObject(value);
  if (entry === undefined) {
    return "entry must be an object";
  }
  if (!isWellFormed(modelName)) {
    return "the model name is not valid text";
  }
  let reasoning: string | undefined;
  if (isPresent(entry, "reasoning")) {
    reasoning = asString(entry.fields.get("reasoning"));
    if (reasoning === undefined || reasoning === "" || !isWellFormed(reasoning)) {
      return "'reasoning' must be a non-empty string";
    }
  }
  let maxOutputTokens: bigint | null | undefined;
  if (entry.fields.has("max_output_tokens")) {
    const raw = entry.fields.get("max_output_tokens");
    if (raw === null) {
      maxOutputTokens = null;
    } else {
      const count = nonNegativeInteger(raw);
      if (count === undefined || count === 0n) {
        return "'max_output_tokens' must be a positive integer or null";
      }
      maxOutputTokens = count;
    }
  }
  return Object.freeze({
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
}

/**
 * Canonical file text: 2-space indent, providers and models in code-point
 * order, empty entries (and providers left empty) omitted, trailing newline.
 */
export function encodeSettings(settings: StoredSettings): string {
  if (answerStyleOf(settings.answerStyle) === undefined) {
    throw new StorageCodecError("value", `'answer_style' must be one of: ${ANSWER_STYLES.join(", ")}`);
  }
  const providerEntries: (readonly [string, Canonical])[] = [];
  for (const providerName of [...settings.providers.keys()].sort(compareCodePoints)) {
    requireText(providerName, "provider name");
    const models = settings.providers.get(providerName) ?? new Map<string, StoredModelPreferences>();
    const modelEntries: (readonly [string, Canonical])[] = [];
    for (const modelName of [...models.keys()].sort(compareCodePoints)) {
      requireText(modelName, "model name");
      const prefs = models.get(modelName);
      const fields = prefs === undefined ? undefined : encodePreferences(prefs, providerName, modelName);
      if (fields !== undefined) {
        modelEntries.push([modelName, fields]);
      }
    }
    if (modelEntries.length > 0) {
      providerEntries.push([providerName, new CanonicalObject([["models", new CanonicalObject(modelEntries)]])]);
    }
  }
  const document = new CanonicalObject([
    ["schema_version", BigInt(SCHEMA_VERSION)],
    ["answer_style", settings.answerStyle],
    ["providers", new CanonicalObject(providerEntries)],
  ]);
  return `${renderCanonical(document, 2)}\n`;
}

/** The entry's fields, or `undefined` when nothing is set (the entry is omitted). */
function encodePreferences(prefs: StoredModelPreferences, provider: string, model: string): Canonical | undefined {
  const label = `${shown(provider)}/${shown(model)}`;
  const entries: (readonly [string, Canonical])[] = [];
  if (prefs.reasoning !== undefined) {
    requireText(prefs.reasoning, `reasoning of ${label}`);
    if (prefs.reasoning === "") {
      throw new StorageCodecError("value", `reasoning of ${label} must not be empty`);
    }
    entries.push(["reasoning", prefs.reasoning]);
  }
  const tokens: unknown = prefs.maxOutputTokens;
  if (tokens !== undefined) {
    if (tokens !== null && (typeof tokens !== "bigint" || tokens <= 0n)) {
      throw new StorageCodecError("value", `max_output_tokens of ${label} must be a positive bigint or null`);
    }
    entries.push(["max_output_tokens", tokens]);
  }
  return entries.length === 0 ? undefined : new CanonicalObject(entries);
}
