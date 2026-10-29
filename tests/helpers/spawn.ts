import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningChild {
  readonly child: ChildProcess;
  readonly result: Promise<ChildResult>;
}

/** Starts node with a minimal allowlisted environment and a bounded lifetime. */
export function startNode(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000, stdin?: string): RunningChild {
  const child = spawn(process.execPath, [...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"], // stdin is closed right away when there is nothing to send
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  child.stdin.on("error", () => undefined); // the child may exit before reading everything
  child.stdin.end(stdin);
  const result = new Promise<ChildResult>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
  return { child, result };
}
