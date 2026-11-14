// Fake provider and session drivers shared by the storage and cross-language
// parity checks: they run the real `run()` from `dist/main.js` (plain and
// fullscreen) with injected fakes and a synthetic state/config root.
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

export function fakeProvider(id, answers, streams = [], models = []) {
  const seen = [];
  return {
    id,
    label: id,
    seen,
    async generate(request) {
      seen.push(request.messages.map((message) => `${message.role}:${message.content}`));
      return answers[seen.length - 1] ?? { kind: "completed", result: { text: `answer ${String(seen.length)}` } };
    },
    // Streamed turns: each script is the list of events of one request.
    stream(request) {
      seen.push(request.messages.map((message) => `${message.role}:${message.content}`));
      const events = streams[seen.length - 1] ?? [];
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              const event = events[index++];
              return event === undefined ? { done: true, value: undefined } : { done: false, value: event };
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    async listModels() {
      return models;
    },
    async checkAvailability() {
      return { available: true, message: "" };
    },
    async defaultModel() {
      return "m";
    },
    async getCapabilities() {
      return { reasoning: { known: false, values: [], allowsModelDefault: true } };
    },
  };
}

export async function runSession(main, root, argv, lines, provider, firstId = 0) {
  const queue = [...lines];
  let ticks = 0;
  const code = await main.run(argv, { stdout: () => undefined, stderr: () => undefined }, {
    createProvider: () => provider,
    createInput: () => ({ readLine: async () => queue.shift(), dispose() {} }),
    storageEnvironment: { env: { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") } },
    clock: () => new Date(Date.UTC(2026, 9, 23, 10, 0, ticks++)),
    newId: (() => {
      let n = firstId;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
  });
  return code;
}

/** Drives the real fullscreen controller with a fake terminal: [keys, text that must appear on screen next] steps. */
export async function runFullscreen(main, root, argv, steps, provider) {
  let handlers;
  let screen = "";
  const terminal = {
    open(given) {
      handlers = given;
    },
    size: () => ({ rows: 25, cols: 80 }),
    async draw(frame) {
      screen = frame.chars.map((row) => row.join("")).join("\n");
    },
    async close() {},
  };
  const timers = {
    now: () => performance.now(),
    after: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(timer) };
    },
    every: (ms, callback) => {
      const timer = setInterval(callback, ms);
      return { cancel: () => clearInterval(timer) };
    },
  };
  const host = {
    environment: () => ({ stdinIsTTY: true, stdoutIsTTY: true, term: "xterm-256color", rawModeSupported: true, color: true }),
    createTerminal: () => terminal,
    signals: { register: () => () => undefined },
    timers,
  };
  let ticks = 0;
  const finished = main.run(argv, { stdout: () => undefined, stderr: () => undefined }, {
    createProvider: () => provider,
    storageEnvironment: { env: { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") } },
    clock: () => new Date(Date.UTC(2026, 9, 23, 11, 0, ticks++)),
    newId: (() => {
      let n = 100;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    tui: host,
  });
  const until = async (condition, what = "the expected screen") => {
    for (let i = 0; i < 5000 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    if (!condition()) throw new Error(`the fullscreen session did not reach ${what}:\n${screen}`);
  };
  await until(() => handlers !== undefined && screen !== "");
  for (const [keys, expected] of steps) {
    // Keys are refused while the storage work of the previous step settles (a few milliseconds); send them again until they take effect.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      handlers.onData(keys);
      if (expected === undefined) break;
      for (let wait = 0; wait < 100 && !screen.includes(expected); wait += 1) await new Promise((resolve) => setTimeout(resolve, 4));
      if (screen.includes(expected)) break;
    }
    if (expected !== undefined) await until(() => screen.includes(expected), JSON.stringify(expected));
    // Storage work of a confirmed choice or a switch settles in a few milliseconds; keys are refused until then.
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return finished;
}

