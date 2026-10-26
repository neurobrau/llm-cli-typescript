import { PROGRAM_NAME, parseCliArgs } from "./args.js";
import { helpText, usageHint, versionText } from "./help.js";
import { readPackageVersion } from "./version.js";

export type Writer = (text: string) => Promise<void> | void;

export interface Io {
  readonly stdout: Writer;
  readonly stderr: Writer;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_BROKEN_PIPE = 141;

class OutputError extends Error {
  constructor(readonly cause: unknown) {
    super("output failed");
  }
}

/** Runs the CLI and returns the exit code; never calls process.exit(). */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  try {
    return await execute(argv, io);
  } catch (error: unknown) {
    if (error instanceof OutputError) {
      return outputFailureCode(error.cause, io);
    }
    return reportInternalError(error, io);
  }
}

async function execute(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parseCliArgs(argv);
  switch (parsed.kind) {
    case "help":
      await write(io.stdout, helpText(readPackageVersion()));
      return EXIT_OK;
    case "version":
      await write(io.stdout, versionText(readPackageVersion()));
      return EXIT_OK;
    case "error":
      await write(io.stderr, `${PROGRAM_NAME}: error: ${parsed.message}\n${usageHint()}`);
      return EXIT_USAGE;
  }
}

async function write(writer: Writer, text: string): Promise<void> {
  try {
    await writer(text);
  } catch (error: unknown) {
    throw new OutputError(error);
  }
}

async function outputFailureCode(cause: unknown, io: Io): Promise<number> {
  if (hasErrorCode(cause, "EPIPE")) {
    return EXIT_BROKEN_PIPE;
  }
  try {
    await io.stderr(`${PROGRAM_NAME}: error: cannot write output\n`);
  } catch {
    // stderr is unusable as well; the exit code is the only remaining signal.
  }
  return EXIT_FAILURE;
}

async function reportInternalError(error: unknown, io: Io): Promise<number> {
  const reason = error instanceof Error ? error.message : "unknown failure";
  try {
    await io.stderr(`${PROGRAM_NAME}: error: ${reason}\n`);
  } catch (writeError: unknown) {
    return hasErrorCode(writeError, "EPIPE") ? EXIT_BROKEN_PIPE : EXIT_FAILURE;
  }
  return EXIT_FAILURE;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
