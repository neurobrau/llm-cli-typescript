/** A real Linux pseudo-terminal for child processes, through the test-only Python standard-library driver. */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ESC = String.fromCharCode(27);
/** Removes the CSI sequences (cursor addressing and colors) so screen text can be matched. */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu");

const DRIVER = resolve(import.meta.dirname, "..", "..", "..", "tests", "helpers", "pty_driver.py");

/** Why PTY tests cannot run here, or `undefined` when they can. */
export function ptyUnavailable(): string | undefined {
  if (process.platform !== "linux") return "PTY tests need Linux";
  const probe = spawnSync("python3", ["-I", "-c", "import pty, termios, fcntl, select"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return "python3 with the pty module is not available";
  return undefined;
}

export interface PtyExit {
  readonly code: number | null;
  readonly signal: number | null;
}

export interface TermiosState {
  readonly icanon: boolean;
  readonly echo: boolean;
  readonly isig: boolean;
}

export class Pty {
  private output = "";
  private readonly waiters: { pattern: RegExp; from: number; resolve: () => void }[] = [];
  private readonly termiosWaiters: ((state: TermiosState) => void)[] = [];
  private buffer = "";
  readonly exit: Promise<PtyExit>;

  constructor(command: readonly string[], env: NodeJS.ProcessEnv, size = { rows: 25, cols: 80 }) {
    const child = spawn("python3", ["-I", DRIVER, String(size.rows), String(size.cols), ...command], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.send = (text) => { child.stdin.write(`send ${Buffer.from(text, "utf8").toString("hex")}\n`); };
    this.resize = (rows, cols) => { child.stdin.write(`resize ${String(rows)} ${String(cols)}\n`); };
    this.signal = (name) => { child.stdin.write(`signal ${name}\n`); };
    this.termios = () => new Promise<TermiosState>((done) => {
      this.termiosWaiters.push(done);
      child.stdin.write("termios\n");
    });
    child.stdin.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    let driverErrors = "";
    child.stderr.on("data", (chunk: string) => { driverErrors += chunk; });
    this.exit = new Promise<PtyExit>((done, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
          const line = this.buffer.slice(0, at);
          this.buffer = this.buffer.slice(at + 1);
          const event = JSON.parse(line) as { t: string; hex?: string; code?: number | null; signal?: number | null; icanon?: boolean; echo?: boolean; isig?: boolean };
          if (event.t === "out" && event.hex !== undefined) {
            this.output += Buffer.from(event.hex, "hex").toString("utf8");
            this.check();
          } else if (event.t === "termios") {
            this.termiosWaiters.shift()?.({ icanon: event.icanon === true, echo: event.echo === true, isig: event.isig === true });
          } else if (event.t === "exit") {
            done({ code: event.code ?? null, signal: event.signal ?? null });
          }
        }
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(`pty driver failed (${String(code)}): ${driverErrors}`));
      });
    });
  }

  readonly send: (text: string) => void;
  readonly resize: (rows: number, cols: number) => void;
  readonly signal: (name: "SIGINT" | "SIGTERM" | "SIGHUP") => void;
  readonly termios: () => Promise<TermiosState>;

  /** The raw bytes received so far. */
  text(): string {
    return this.output;
  }

  /** The received text without CSI sequences. */
  screenText(): string {
    return this.output.replace(CSI, "");
  }

  /** Resolves when `pattern` matches the screen text (CSI removed) received after `from` (a `mark()`). */
  waitFor(pattern: RegExp, from = this.output.length): Promise<void> {
    return new Promise((resolvePromise) => {
      this.waiters.push({ pattern, from, resolve: resolvePromise });
      this.check();
    });
  }

  mark(): number {
    return this.output.length;
  }

  private check(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.pattern.test(this.output.slice(waiter.from).replace(CSI, ""))) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }
}
