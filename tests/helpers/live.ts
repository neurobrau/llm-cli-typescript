import { spawn } from "node:child_process";

export interface LiveChild {
  readonly child: ReturnType<typeof spawn>;
  readonly result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
  waitFor(stream: "stdout" | "stderr", pattern: RegExp): Promise<void>;
  write(text: string): void;
}

/** A long-lived child with piped stdio whose output can be awaited by pattern. */
export function live(args: readonly string[], env: NodeJS.ProcessEnv): LiveChild {
  const child = spawn(process.execPath, [...args], { env, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000, killSignal: "SIGKILL" });
  const buffers = { stdout: "", stderr: "" };
  const waiters: { stream: "stdout" | "stderr"; pattern: RegExp; resolve: () => void }[] = [];
  const check = (): void => {
    for (const waiter of [...waiters]) {
      if (waiter.pattern.test(buffers[waiter.stream])) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { buffers.stdout += chunk; check(); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { buffers.stderr += chunk; check(); });
  child.stdin.on("error", () => undefined);
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { resolvePromise({ code, signal }); });
  });
  return {
    child,
    result,
    stdout: () => buffers.stdout,
    stderr: () => buffers.stderr,
    waitFor: (stream, pattern) => new Promise<void>((resolvePromise) => { waiters.push({ stream, pattern, resolve: resolvePromise }); check(); }),
    write: (text) => { child.stdin.write(text); },
  };
}

