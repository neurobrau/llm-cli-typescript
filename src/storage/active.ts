import type { ProviderId } from "../domain/generation.js";
import { StorageCodecError } from "./errors.js";
import { CanonicalObject, asObject, asString, isSchemaVersion1, isWellFormed, parseJson, renderCanonical } from "./json.js";
import { SCHEMA_VERSION } from "./types.js";
import type { ActiveSelection } from "./types.js";

const PROVIDERS: readonly ProviderId[] = ["openai", "ollama"];

function supportedProvider(value: unknown): ProviderId | undefined {
  return PROVIDERS.find((provider) => provider === value);
}

/**
 * Reads `active.json`. Narrower than conversations by design: only a
 * supported provider and a non-empty model are usable at startup, so anything
 * else (including a provider the CLI does not know) is a typed error.
 */
export function decodeActiveSelection(input: string | Uint8Array): ActiveSelection {
  const root = asObject(parseJson(input));
  if (root === undefined) {
    throw new StorageCodecError("document", "the top level must be a JSON object");
  }
  if (!isSchemaVersion1(root.fields.get("schema_version"))) {
    throw new StorageCodecError("document", "unsupported schema_version (expected 1)");
  }
  const provider = supportedProvider(asString(root.fields.get("provider")));
  if (provider === undefined) {
    throw new StorageCodecError("field", `'provider' must be one of: ${PROVIDERS.join(", ")}`);
  }
  const model = asString(root.fields.get("model"));
  if (model === undefined || model === "" || !isWellFormed(model)) {
    throw new StorageCodecError("field", "'model' must be a non-empty string");
  }
  return Object.freeze({ provider, model });
}

/** One line with Python's separators and a trailing newline. */
export function encodeActiveSelection(selection: ActiveSelection): string {
  if (supportedProvider(selection.provider) === undefined) {
    throw new StorageCodecError("value", `'provider' must be one of: ${PROVIDERS.join(", ")}`);
  }
  if (typeof selection.model !== "string" || selection.model === "" || !isWellFormed(selection.model)) {
    throw new StorageCodecError("value", "'model' must be a non-empty string");
  }
  const entries = [
    ["schema_version", BigInt(SCHEMA_VERSION)],
    ["provider", selection.provider],
    ["model", selection.model],
  ] as const;
  return `${renderCanonical(new CanonicalObject(entries))}\n`;
}
