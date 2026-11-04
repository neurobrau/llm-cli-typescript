/**
 * The production terminal setup and key handling in a real pseudo-terminal (Linux, Python standard library
 * driver). The child is the test harness with loopback providers, a synthetic key and an isolated HOME/XDG.
 * Skipped - and reported as skipped, never as passing - when python3 or its pty module is unavailable.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { decodeConversation } from "../src/storage/index.js";
import { Loopback, NDJSON, liveStream } from "./helpers/loopback.js";
import { bodyOf as ollamaBody, tag, tags } from "./helpers/ollama.js";
import { Pty, ptyUnavailable } from "./helpers/pty.js";

const HARNESS = resolve(import.meta.dirname, "helpers", "harness.js");
const ESC = String.fromCharCode(27);
const ENTER_SCREEN = `${ESC}[?1049h`;
const LEAVE_SCREEN = `${ESC}[?1049l`;
const plain = tag("m1", { capabilities: ["completion"], details: { context_length: 4096 } });
const skip = ptyUnavailable();
if (skip !== undefined) console.log(`PTY integration tests are skipped: ${skip}`);

let server: Loopback;
let scratch = "";
let env: NodeJS.ProcessEnv = {};
let state = "";

before(async () => {
  server = await Loopback.start();
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-pty-"));
  state = join(scratch, "state");
  // Allowlisted environment: no keys, no proxies, temporary HOME/XDG only.
  env = {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(scratch, "config"),
    TERM: "xterm-256color",
    HARNESS_OLLAMA_BASE: server.origin,
  };
  assert.equal(server.pending, 0, "previous test left unconsumed responders");
  server.requests.length = 0;
  server.unexpected.length = 0;
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  assert.equal(server.unexpected.length, 0);
});

const nd = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const piece = (content: string): string => nd({ model: "m1", message: { role: "assistant", content }, done: false });
const finish = (): string => nd({ model: "m1", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
const command = (...extra: string[]): string[] => [process.execPath, HARNESS, server.url, "--provider", "ollama", "--model", "m1", ...extra];

const options = skip === undefined ? {} : { skip };

void describe("fullscreen chat in a real pseudo-terminal", options, () => {
  void it("takes the terminal over, cancels with Ctrl+C, continues in the same screen, and restores everything on /exit", async () => {
    const first = liveStream(NDJSON);
    const second = liveStream(NDJSON);
    server.expect(tags(plain), first.responder, second.responder);
    const pty = new Pty(command("--stream", "--transcript-on-exit"), env);
    await pty.waitFor(/\[ Input \]/u);
    assert.ok(pty.text().includes(ENTER_SCREEN), "alternate screen entered");
    const running = await pty.termios();
    assert.equal(running.icanon, false, "raw input while running");
    assert.equal(running.echo, false, "no echo while running");

    pty.send("slow question\r");
    const one = await first.opened();
    await one.write(piece("partial"));
    await pty.waitFor(/AI > partial/u);
    pty.send("\u0003"); // Ctrl+C is a key in raw mode
    await pty.waitFor(/Cancelled\. The partial answer above was not saved\./u);
    await one.closed;

    pty.send("next question\r");
    const two = await second.opened();
    await two.write(piece("fresh ") + piece("answer") + finish());
    two.end();
    await pty.waitFor(/AI > fresh answer/u);
    pty.send("/exit\r");
    const done = await pty.exit;
    assert.equal(done.code, 0);

    const output = pty.text();
    assert.equal(output.split(ENTER_SCREEN).length - 1, 1, "entered once");
    assert.equal(output.split(LEAVE_SCREEN).length - 1, 1, "left once");
    const afterLeave = output.slice(output.indexOf(LEAVE_SCREEN) + LEAVE_SCREEN.length).replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu"), "");
    assert.ok(afterLeave.includes("YOU > next question"), "the transcript follows the restored terminal");
    assert.ok(afterLeave.includes("AI > fresh answer"));
    assert.ok(!afterLeave.includes("slow question"), "the cancelled exchange is not in the transcript");
    assert.ok(!afterLeave.includes("partial"));

    const bodies = server.requests.filter((r) => r.path === "/api/chat").map(ollamaBody);
    assert.deepEqual(bodies.map((b) => (b.messages as { content: string }[]).map((m) => m.content)), [["slow question"], ["next question"]]);
    const directory = join(state, "neurobrau", "conversations");
    const [name] = await readdir(directory);
    assert.ok(name);
    assert.deepEqual(decodeConversation(await readFile(join(directory, name))).messages.map((m) => m.content), ["next question", "fresh answer"]);
  });

  void it("restores the terminal on SIGTERM (143) and on idle Ctrl+C (130)", async () => {
    server.expect(tags(plain), tags(plain));
    const term = new Pty(command(), env);
    await term.waitFor(/\[ Input \]/u);
    term.signal("SIGTERM");
    const terminated = await term.exit;
    assert.equal(terminated.code, 143);
    assert.ok(term.text().trimEnd().endsWith(LEAVE_SCREEN) || term.text().includes(LEAVE_SCREEN));

    const interrupted = new Pty(command(), env);
    await interrupted.waitFor(/\[ Input \]/u);
    interrupted.send("\u0003");
    assert.equal((await interrupted.exit).code, 130);
    assert.equal(interrupted.text().split(LEAVE_SCREEN).length - 1, 1);
  });

  void it("resizes below the minimum and back without losing the draft", async () => {
    server.expect(tags(plain));
    const pty = new Pty(command(), env);
    await pty.waitFor(/\[ Input \]/u);
    pty.send("Grüß 😀");
    await pty.waitFor(/YOU > Grüß 😀/u);
    let mark = pty.mark();
    pty.resize(10, 30);
    await pty.waitFor(/Terminal too small\./u, mark);
    mark = pty.mark();
    pty.resize(25, 80);
    await pty.waitFor(/\[ Input \]/u, mark);
    await pty.waitFor(/YOU > Grüß 😀/u, mark);
    pty.send("\u0015\u0004"); // Ctrl+U, Ctrl+D
    assert.equal((await pty.exit).code, 0);
  });

  void it("falls back to the plain chat with --plain: no alternate screen, no escape sequences", async () => {
    server.expect(tags(plain));
    const pty = new Pty(command("--plain"), env);
    await pty.waitFor(/YOU > /u);
    pty.send("/exit\r");
    assert.equal((await pty.exit).code, 0);
    assert.ok(!pty.text().includes(ESC));
  });

  void it("falls back to the plain chat for an unknown TERM", async () => {
    server.expect(tags(plain));
    const pty = new Pty(command(), { ...env, TERM: "vt52" });
    await pty.waitFor(/YOU > /u);
    pty.send("/exit\r");
    assert.equal((await pty.exit).code, 0);
    assert.ok(!pty.text().includes(ENTER_SCREEN));
  });

  void it("Ctrl+D on an empty draft exits 0 and leaves the screen (the kernel line discipline is also reset by Node at exit, so this does not prove our restore alone)", async () => {
    server.expect(tags(plain));
    const pty = new Pty(command(), env);
    await pty.waitFor(/\[ Input \]/u);
    pty.send("\u0004");
    await pty.exit;
    assert.ok(pty.text().includes(LEAVE_SCREEN));
  });
});
