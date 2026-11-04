import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { AnsiTerminal } from "../src/tui/ansi-terminal.js";
import type { TerminalInput, TerminalOutput } from "../src/tui/ansi-terminal.js";
import { createFrame, put } from "../src/tui/frame.js";
import { TerminalError } from "../src/tui/terminal.js";
import type { TerminalHandlers } from "../src/tui/terminal.js";
import { ManualInput, MemoryHistory, ScriptedProvider, answer, runChat } from "./helpers/chat.js";
import { ManualTimers, FakeSignals, KEYS, settleAll, until } from "./helpers/tui.js";

class FakeInput extends EventEmitter implements TerminalInput {
  isRaw = false;
  readableFlowing: boolean | null = null;
  readonly raw: boolean[] = [];
  failRaw = false;
  constructor() {
    super();
    // Like a real readable: adding a "data" listener already starts the flow.
    this.on("newListener", (event: string) => {
      if (event === "data" && this.readableFlowing === null) this.readableFlowing = true;
    });
  }
  setRawMode(mode: boolean): this {
    if (this.failRaw && mode) throw new Error("raw mode refused");
    this.raw.push(mode);
    this.isRaw = mode;
    return this;
  }
  resume(): this {
    this.readableFlowing = true;
    return this;
  }
  pause(): this {
    this.readableFlowing = false;
    return this;
  }
}

class FakeOutput extends EventEmitter implements TerminalOutput {
  columns = 80;
  rows = 25;
  readonly chunks: string[] = [];
  failWith: Error | undefined;
  write(text: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(text);
    callback(this.failWith);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const handlers = (log: string[] = []): TerminalHandlers => ({
  onData: (chunk) => { log.push(`data:${typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()}`); },
  onResize: () => { log.push("resize"); },
  onEnd: () => { log.push("end"); },
});

const ESC = String.fromCharCode(27);
/** A regular expression that starts with the escape character (built, so the source has no control character). */
const seq = (pattern: string, flags = "gu"): RegExp => new RegExp(`${ESC}${pattern}`, flags);
const ENTER = `${ESC}[?1049h`;
const LEAVE = `${ESC}[?1049l`;

/** Removes every escape sequence the adapter is allowed to emit; anything left that is a control is a leak. */
function stripKnown(output: string): string {
  return output
    .replace(seq("\\[\\?(?:1049|7|25)[hl]"), "")
    .replace(seq("\\[(?:\\d+;\\d+)?[HJ]"), "")
    .replace(seq("\\[2J"), "")
    .replace(seq("\\[[0-9;]*m"), "");
}

void describe("AnsiTerminal: lifecycle", () => {
  void it("importing and constructing it changes nothing; open takes over and close restores exactly what was changed", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input, output, color: true });
    assert.deepEqual(input.raw, []);
    assert.deepEqual(output.chunks, []);
    assert.equal(input.listenerCount("data"), 0);
    const events: string[] = [];
    terminal.open(handlers(events));
    assert.deepEqual(input.raw, [true]);
    assert.equal(input.readableFlowing, true);
    assert.equal(input.listenerCount("data"), 1);
    assert.equal(output.listenerCount("resize"), 1);
    assert.ok(output.text.startsWith(ENTER));
    input.emit("data", Buffer.from("hi"));
    output.emit("resize");
    input.emit("end");
    assert.deepEqual(events, ["data:hi", "resize", "end"]);
    await terminal.close();
    await terminal.close(); // idempotent
    assert.deepEqual(input.raw, [true, false]);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.listenerCount("end"), 0);
    assert.equal(output.listenerCount("resize"), 0);
    assert.equal(output.text.split(LEAVE).length - 1, 1, "the alternate screen is left once");
    assert.ok(output.text.endsWith(`${ESC}[0m${ESC}[?7h${ESC}[?25h${LEAVE}`));
    input.emit("data", Buffer.from("late"));
    assert.deepEqual(events, ["data:hi", "resize", "end"]); // nothing is delivered after close
  });

  void it("restores only what it changed: raw mode that was already on stays on, a flowing input keeps flowing", async () => {
    const input = new FakeInput();
    input.isRaw = true;
    input.readableFlowing = true;
    const terminal = new AnsiTerminal({ input, output: new FakeOutput(), color: true });
    terminal.open(handlers());
    await terminal.close();
    assert.deepEqual(input.raw, [true]);
    assert.equal(input.readableFlowing, true);
    assert.equal(input.isRaw, true);
  });

  void it("a failure while opening unwinds the partial setup and throws a TerminalError", async () => {
    const input = new FakeInput();
    input.failRaw = true;
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input, output, color: true });
    assert.throws(() => { terminal.open(handlers()); }, TerminalError);
    await terminal.close();
    assert.deepEqual(input.raw, []);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(output.text, ""); // the alternate screen was never entered
    const bare: TerminalInput = { on: () => undefined, removeListener: () => undefined, resume: () => undefined, pause: () => undefined };
    const noRaw = new AnsiTerminal({ input: bare, output, color: true });
    assert.throws(() => { noRaw.open(handlers()); }, TerminalError);
    await noRaw.close();
  });

  void it("a failure after the screen was entered (listener setup throws) still leaves the screen", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const original = input.on.bind(input);
    let calls = 0;
    input.on = (event, listener) => {
      calls += 1;
      if (calls === 3) throw new Error("listener failure");
      return original(event, listener);
    };
    const terminal = new AnsiTerminal({ input, output, color: true });
    assert.throws(() => { terminal.open(handlers()); }, TerminalError);
    await terminal.close();
    assert.deepEqual(input.raw, [true, false]);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.listenerCount("end"), 0);
  });

  void it("close survives a closed output and still restores raw mode", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input, output, color: true });
    terminal.open(handlers());
    output.failWith = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    await assert.rejects(terminal.draw(frameWith("x")));
    await terminal.close();
    assert.deepEqual(input.raw, [true, false]);
    await terminal.draw(frameWith("late")); // after close: silently nothing
    assert.ok(!output.text.includes("late"));
  });
});

function frameWith(text: string, rows = 3, cols = 10): ReturnType<typeof createFrame> {
  const frame = createFrame(rows, cols);
  put(frame, 0, 0, text, "border");
  return frame;
}

void describe("AnsiTerminal: drawing", () => {
  void it("addresses every row, clips to the grid and never writes the last cell of the last row", async () => {
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input: new FakeInput(), output, color: true });
    terminal.open(handlers());
    output.chunks.length = 0;
    const frame = createFrame(3, 6);
    for (let row = 0; row < 3; row += 1) put(frame, row, 0, "abcdef", "text");
    frame.cursor = { row: 1, col: 2 };
    await terminal.draw(frame);
    const text = output.text;
    assert.ok(text.includes(`${ESC}[1;1H`) && text.includes(`${ESC}[2;1H`) && text.includes(`${ESC}[3;1H`));
    assert.ok(text.includes("abcdef"));
    assert.ok(text.includes("abcde"));
    assert.equal((text.split(`${ESC}[3;1H`)[1] ?? "").includes("f"), false, "the bottom-right cell is not written");
    assert.ok(text.endsWith(`${ESC}[2;3H${ESC}[?25h`), "cursor placed and shown last");
    assert.ok(text.startsWith(`${ESC}[?25l`), "cursor hidden while drawing");
    await terminal.close();
  });

  void it("rewrites only changed rows after the first full frame, and everything after a size change", async () => {
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input: new FakeInput(), output, color: true });
    terminal.open(handlers());
    await terminal.draw(frameWith("one"));
    output.chunks.length = 0;
    await terminal.draw(frameWith("one"));
    assert.ok(!output.text.includes(`${ESC}[1;1H`), "identical frame: nothing redrawn");
    output.chunks.length = 0;
    await terminal.draw(frameWith("two"));
    assert.ok(output.text.includes(`${ESC}[1;1H`) && !output.text.includes(`${ESC}[2;1H`));
    output.chunks.length = 0;
    await terminal.draw(frameWith("two", 3, 12));
    assert.ok(output.text.includes(`${ESC}[2J`) && output.text.includes(`${ESC}[2;1H`));
    await terminal.close();
  });

  void it("emits only its own sequences: text from models and users can never add one", async () => {
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input: new FakeInput(), output, color: true });
    terminal.open(handlers());
    const frame = createFrame(3, 40);
    put(frame, 0, 0, "\u001b[?1049l\u001b[2J\u001b]0;pwned\u0007\u009b31m\u0000", "ai");
    put(frame, 1, 0, "line\r\nbreak\ttab", "error");
    await terminal.draw(frame);
    await terminal.close();
    const leftover = stripKnown(output.text.split(ENTER).join("").replace(`${ESC}[0m${ESC}[?7h${ESC}[?25h${LEAVE}`, ""));
    assert.ok(!leftover.includes(ESC), `unexpected escape in ${JSON.stringify(leftover)}`);
    assert.ok(!leftover.includes("\u0007") && !leftover.includes("\u009b") && !leftover.includes("\r") && !leftover.includes("\n"));
    assert.ok(!output.text.slice(ENTER.length).includes(LEAVE.slice(0, 8)) || output.text.endsWith(LEAVE), "only the final restore leaves the alternate screen");
    assert.equal(output.text.split(LEAVE).length - 1, 1);
    assert.equal(output.text.split(`${ESC}]`).length - 1, 0, "no OSC sequence (title)");
  });

  void it("uses documented colors, and bold/reverse only when color is off", async () => {
    const colored = new FakeOutput();
    const mono = new FakeOutput();
    for (const [output, color] of [[colored, true], [mono, false]] as const) {
      const terminal = new AnsiTerminal({ input: new FakeInput(), output, color });
      terminal.open(handlers());
      const frame = createFrame(3, 30);
      for (const [row, style] of (["border", "user", "ai"] as const).entries()) put(frame, row, 0, style, style);
      put(frame, 2, 10, "wait", "waiting");
      put(frame, 2, 20, "err", "error");
      await terminal.draw(frame);
      await terminal.close();
    }
    assert.ok(colored.text.includes(`${ESC}[0;1;32;40m`), "green bold");
    assert.ok(colored.text.includes(`${ESC}[0;1;34;40m`), "blue bold");
    assert.ok(colored.text.includes(`${ESC}[0;1;33;40m`), "yellow bold");
    assert.ok(colored.text.includes(`${ESC}[0;1;31;40m`), "red bold");
    assert.ok(!seq("\\[[0-9;]*3[0-9]").test(mono.text.replace(seq("\\[\\?[0-9]+[hl]"), "")), "no color codes without color");
    assert.ok(mono.text.includes(`${ESC}[0;1m`) && mono.text.includes(`${ESC}[0;7m`));
  });

  void it("draw rejects when the output fails, so the controller can end quietly on EPIPE", async () => {
    const output = new FakeOutput();
    const terminal = new AnsiTerminal({ input: new FakeInput(), output, color: true });
    terminal.open(handlers());
    output.failWith = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    await assert.rejects(terminal.draw(frameWith("x")), /EPIPE/u);
    await terminal.close();
  });
});

void describe("the production adapter driving the whole application (deterministic, in-memory streams)", () => {
  async function runWithAnsi(options: { argv?: readonly string[]; script: (api: { input: FakeInput; output: FakeOutput; signals: FakeSignals }) => Promise<void>; provider?: ScriptedProvider; history?: MemoryHistory }): Promise<{ code: number; out: string; err: string; input: FakeInput; output: FakeOutput; signals: FakeSignals }> {
    const input = new FakeInput();
    const output = new FakeOutput();
    const signals = new FakeSignals();
    const timers = new ManualTimers();
    const history = options.history ?? new MemoryHistory();
    const result = runChat(options.argv ?? [], options.provider ?? new ScriptedProvider("ollama"), new ManualInput(), {
      env: { XDG_STATE_HOME: "/virtual/state" },
      deps: {
        createHistoryStore: () => history,
        tui: {
          environment: () => ({ stdinIsTTY: true, stdoutIsTTY: true, term: "tmux-256color", rawModeSupported: true, color: true }),
          createTerminal: (environment) => new AnsiTerminal({ input, output, color: environment.color }),
          signals,
          timers,
        },
      },
    });
    await until(() => output.chunks.length > 0, "the first frame");
    await options.script({ input, output, signals });
    const done = await result;
    return { code: done.code, out: done.out, err: done.err, input, output, signals };
  }

  const type = async (input: FakeInput, text: string): Promise<void> => {
    input.emit("data", Buffer.from(text));
    await settleAll(6);
  };

  void it("enters the alternate screen once, shows the conversation, and leaves it once on /exit", async () => {
    const provider = new ScriptedProvider("ollama", [answer("hello there")]);
    const run = await runWithAnsi({
      provider,
      script: async ({ input, output }) => {
        await type(input, "hi");
        await type(input, KEYS.enter);
        await until(() => output.text.includes("hello there"), "the answer on screen");
        await type(input, "/exit");
        await type(input, KEYS.enter);
      },
    });
    assert.equal(run.code, 0);
    assert.equal(run.output.text.split(ENTER).length - 1, 1);
    assert.equal(run.output.text.split(LEAVE).length - 1, 1);
    assert.ok(run.output.text.endsWith(LEAVE));
    assert.deepEqual(run.input.raw, [true, false]);
    assert.equal(run.input.listenerCount("data"), 0);
    assert.equal(run.signals.active, 0);
    assert.equal(run.out, "");
  });

  void it("restores the terminal on Ctrl+C, SIGTERM and an internal error, with the diagnostic after the restore", async () => {
    const ctrlC = await runWithAnsi({ script: async ({ input }) => { await type(input, KEYS.ctrlC); } });
    assert.equal(ctrlC.code, 130);
    assert.deepEqual(ctrlC.input.raw, [true, false]);
    assert.ok(ctrlC.output.text.endsWith(LEAVE));

    const term = await runWithAnsi({ script: async ({ signals }) => { signals.fire("SIGTERM"); await settleAll(6); } });
    assert.equal(term.code, 143);
    assert.ok(term.output.text.endsWith(LEAVE));

    const broken = new ScriptedProvider("ollama", [() => { throw new Error("internal secret"); }]);
    const failed = await runWithAnsi({
      provider: broken,
      script: async ({ input }) => {
        await type(input, "q");
        await type(input, KEYS.enter);
      },
    });
    assert.equal(failed.code, 1);
    assert.equal(failed.err, "neurobrau: error: an internal error occurred\n");
    assert.deepEqual(failed.input.raw, [true, false]);
    assert.ok(failed.output.text.endsWith(LEAVE));
  });

  void it("a broken output pipe ends with 141, quietly, and still attempts the restore", async () => {
    const run = await runWithAnsi({
      script: async ({ input, output }) => {
        output.failWith = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        await type(input, "x");
      },
    });
    assert.equal(run.code, 141);
    assert.equal(run.err, "");
    assert.deepEqual(run.input.raw, [true, false]);
  });
});
