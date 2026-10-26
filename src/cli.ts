import type { Writable } from "node:stream";

import { run } from "./main.js";
import type { Writer } from "./main.js";

/**
 * Wraps a stream so each write resolves when the chunk is flushed and rejects
 * on failure. The 'error' listener only records the failure: it is delivered
 * to the caller through the write callback or the next write, and an
 * unhandled 'error' event (e.g. EPIPE) would otherwise crash the process.
 */
function createWriter(stream: Writable): Writer {
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

process.exitCode = await run(process.argv.slice(2), {
  stdout: createWriter(process.stdout),
  stderr: createWriter(process.stderr),
});
