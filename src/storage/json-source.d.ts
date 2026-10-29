/**
 * Type for the JSON.parse source-text access (`context.source`) that Node 24
 * ships but TypeScript 5.9's bundled lib does not describe yet. Adds an
 * overload only; nothing is patched at runtime.
 */
interface JsonParseContext {
  /** The original text of a primitive value; absent for objects and arrays. */
  readonly source?: string;
}

interface JSON {
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context: JsonParseContext) => unknown,
  ): unknown;
}
