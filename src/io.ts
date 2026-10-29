/** Output and interrupt contracts shared by the one-shot and chat paths. */

export type Writer = (text: string) => Promise<void> | void;

export interface Io {
  readonly stdout: Writer;
  readonly stderr: Writer;
}

/**
 * Registers an interrupt (SIGINT) callback and returns a function that
 * unregisters it. The callback may fire more than once until unregistered.
 * The executable supplies the real signal wiring; unit tests inject their own.
 */
export interface InterruptSource {
  register(onInterrupt: () => void): () => void;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INCOMPLETE = 8;
export const EXIT_BROKEN_PIPE = 141;

/** An output stream failed; carries the original cause for exit-code selection. */
export class OutputError extends Error {
  constructor(readonly cause: unknown) {
    super("output failed");
  }
}

export async function write(writer: Writer, text: string): Promise<void> {
  try {
    await writer(text);
  } catch (error: unknown) {
    throw new OutputError(error);
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
