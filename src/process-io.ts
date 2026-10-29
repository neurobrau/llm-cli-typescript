import type { Writable } from "node:stream";

import type { InterruptSource, Writer } from "./io.js";

/**
 * Wraps a stream so each write resolves when the chunk is flushed and rejects
 * on failure. The 'error' listener only records the failure: it is delivered
 * to the caller through the write callback or the next write, and an
 * unhandled 'error' event (e.g. EPIPE) would otherwise crash the process
 * before the exit code can be set.
 */
export function createWriter(stream: Writable): Writer {
  let failure: Error | undefined;
  stream.on("error", (error: Error) => {
    failure ??= error;
  });
  return (text) =>
    new Promise<void>((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      stream.write(text, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
}

/**
 * SIGINT is handled only between `register` and the returned unregister
 * function (one-shot operation or chat run); afterwards the default OS
 * behavior returns. The callback may fire repeatedly: an interactive chat
 * needs every Ctrl+C, and a one-shot run is bounded by its cleanup timeout.
 */
export const sigintSource: InterruptSource = {
  register(onInterrupt) {
    process.on("SIGINT", onInterrupt);
    return () => {
      process.removeListener("SIGINT", onInterrupt);
    };
  },
};
