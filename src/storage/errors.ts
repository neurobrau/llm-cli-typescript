/**
 * Typed codec failures. Messages name fields and categories only: never file
 * bodies, message content, parser excerpts or paths.
 */
export type StorageCodecErrorKind =
  /** Input bytes are not valid UTF-8. */
  | "encoding"
  /** Not valid JSON, or nested too deeply to parse. */
  | "syntax"
  /** Valid JSON, but the document as a whole is unusable (top level, schema version, ...). */
  | "document"
  /** A required field is missing or invalid. */
  | "field"
  /** An in-memory value passed to an encoder is not storable. */
  | "value"
  /** The runtime lacks JSON.parse source-text access. */
  | "runtime";

export class StorageCodecError extends Error {
  readonly kind: StorageCodecErrorKind;

  constructor(kind: StorageCodecErrorKind, message: string) {
    super(message);
    this.name = "StorageCodecError";
    this.kind = kind;
  }
}
