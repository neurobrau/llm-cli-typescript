import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { costLine, usageReport } from "../src/application/usage-report.js";
import { panelStats } from "../src/tui/panel.js";
import type { StoredConversation, StoredUsageRecord } from "../src/storage/types.js";
import { ManualInput, MemoryHistory, ScriptedProvider, answer, completed, failure, incomplete, runChat } from "./helpers/chat.js";
import { startMenuTui } from "./helpers/menus.js";
import type { MenuRig } from "./helpers/menus.js";
import { KEYS, settleAll, startTui, until } from "./helpers/tui.js";
import type { TuiSession } from "./helpers/tui.js";

const AT = new Date("2026-10-22T00:00:00.000Z");
const LUNA_ARGS = ["--provider", "openai", "--model", "gpt-6-luna"];
const EXAMPLE = { inputTokens: 15_000n, outputTokens: 2_000n, cachedInputTokens: 4_000n, cacheWriteTokens: 1_000n };
const EXAMPLE_LINE = "Estimated cost: $0.002165 (ESTIMATED, not a billed amount; pricing 2026-10-22)";

const rec = (provider: string, model: string, usage: StoredUsageRecord["usage"], serviceTier?: string, status: "completed" | "incomplete" = "completed"): StoredUsageRecord => ({
  at: AT,
  provider,
  model,
  status,
  ...(serviceTier === undefined ? {} : { serviceTier }),
  usage,
});

const ESC = String.fromCharCode(0x1b);

async function submit(session: TuiSession, line: string): Promise<void> {
  await session.type(line);
  await session.key(KEYS.enter);
}

const panelCost = (session: TuiSession): string => {
  const lines = session.term.lines().map((line) => line.slice(60, 78).trim());
  const index = lines.indexOf("COST (EST.)");
  assert.ok(index >= 0, "COST (EST.) heading");
  return lines[index + 1] ?? "";
};

void describe("usage report cost line", () => {
  void it("appends the shared long description after the unchanged token details", () => {
    const text = usageReport([rec("openai", "gpt-6-luna", EXAMPLE, "default")]);
    const lines = text.split("\n");
    assert.equal(lines[0], "Conversation usage (1 request(s): 1 completed, 0 incomplete; as reported by the API):");
    assert.equal(lines.at(-1), EXAMPLE_LINE);
    assert.ok(text.includes("Input tokens: 15,000"));
    assert.ok(text.includes("Latest completed request input: 15,000 tokens"));
    assert.ok(!text.includes("not implemented"));
  });

  void it("shows partial, qualified and unavailable lines and keeps the reported-subtotal wording", () => {
    const partial = usageReport([rec("openai", "gpt-6-luna", EXAMPLE, "default"), rec("openai", "mystery", { inputTokens: 1n, outputTokens: 1n }, "default")]);
    assert.ok(partial.includes("Cached input tokens (part of input): 4,000 (reported subtotal: 1 of 2 requests reported this)"));
    assert.ok(partial.endsWith("Estimated cost: at least $0.002165 (ESTIMATED, not a billed amount; pricing 2026-10-22; no pricing data for mystery)"));
    const qualified = usageReport([rec("openai", "gpt-6-luna", { inputTokens: 10n, outputTokens: 1n })]);
    assert.ok(qualified.includes("Cached input tokens (part of input): not reported"));
    assert.ok(qualified.includes("Estimated cost: approximately $0.000002"));
    const unavailable = usageReport([rec("openai", "mystery", { inputTokens: 1n })]);
    assert.ok(unavailable.includes("Output tokens: not reported"));
    assert.ok(unavailable.endsWith("Estimated cost: unavailable (no pricing data for mystery)"));
  });

  void it("does not count a non-reported count as zero in the displayed token details when pricing assumes zero", () => {
    const text = usageReport([rec("openai", "gpt-6-luna", { inputTokens: 100n, outputTokens: 10n }, "default")]);
    assert.ok(text.includes("Cached input tokens (part of input): not reported"));
    assert.ok(text.includes("Cache write tokens (part of input): not reported"));
    assert.ok(text.includes("cached tokens not reported (all input priced as uncached)"));
  });

  void it("escapes control characters from saved names in the cost notes", () => {
    const hostile = `evil${ESC}[2J\nmodel`;
    const text = costLine([rec("openai", hostile, { inputTokens: 1n, outputTokens: 1n }, "default")]);
    assert.ok(!text.includes(ESC));
    assert.ok(!text.includes("\n"));
    assert.ok(text.includes("evil\\x1b[2J\\x0amodel"), text);
    const tier = costLine([rec("openai", "gpt-6-luna", { inputTokens: 1n, outputTokens: 1n }, `t${ESC}x`)]);
    assert.ok(!tier.includes(ESC));
  });

  void it("stored cloud and unknown-provider records are never shown as free", () => {
    for (const record of [rec("ollama", "glm-4.7:cloud", { inputTokens: 1n }), rec("acme", "m", { inputTokens: 1n })]) {
      const text = usageReport([record]);
      assert.ok(text.includes("Estimated cost: unavailable"), text);
      assert.ok(!text.includes("$0"), text);
    }
  });

  void it("panel statistics carry the short cost computed once with the counts", () => {
    assert.equal(panelStats([]).cost, "-");
    assert.equal(panelStats([rec("ollama", "m", {})]).cost, "$0 (local)");
    assert.equal(panelStats([rec("openai", "gpt-6-luna", EXAMPLE, "default")]).cost, "$0.002165");
    assert.equal(panelStats([rec("openai", "gpt-6-luna", EXAMPLE, "default"), rec("openai", "x", {})]).cost, ">=$0.002165");
    assert.equal(panelStats([rec("openai", "gpt-6-luna", { inputTokens: 10n, outputTokens: 1n })]).cost, "~$0.000002");
    assert.equal(panelStats([rec("openai", "x", {})]).cost, "unavailable");
  });
});

void describe("plain chat /usage cost", () => {
  const chat = (lines: readonly string[], provider: ScriptedProvider, argv: readonly string[]) => runChat([...argv, "--no-history"], provider, new ManualInput(lines, true));

  void it("prints the estimate from recorded usage once, and makes no provider call to do so", async () => {
    const provider = new ScriptedProvider("openai", [() => Promise.resolve(completed("hi", EXAMPLE, "default"))]);
    const run = await chat(["hello", "/usage", "/usage", "/exit"], provider, LUNA_ARGS);
    assert.equal(run.code, 0, run.err);
    assert.equal(provider.calls, 1);
    assert.equal(run.out.split(EXAMPLE_LINE).length - 1, 2); // one line per /usage, the same value both times
    assert.ok(run.out.includes("Conversation usage (1 request(s): 1 completed, 0 incomplete"));
  });

  void it("adds cost for an incomplete record once and nothing for a failed request", async () => {
    const provider = new ScriptedProvider("openai", [failure("boom"), () => Promise.resolve(incomplete("part", EXAMPLE))]);
    const run = await chat(["one", "two", "/usage", "/exit"], provider, LUNA_ARGS);
    assert.ok(run.out.includes("1 request(s): 0 completed, 1 incomplete"), run.out);
    assert.ok(run.out.includes("Estimated cost: approximately $0.002165"), run.out); // tier not reported -> qualified
    assert.ok(run.out.includes("Standard tier assumed (tier not reported)"));
  });

  void it("shows the empty-conversation lines and local Ollama as free API cost", async () => {
    const empty = await chat(["/usage", "/exit"], new ScriptedProvider("openai"), LUNA_ARGS);
    assert.ok(empty.out.includes("Token usage: no API requests in this conversation yet.\nEstimated cost: - (no requests yet)\n"));
    const local = await chat(["hi", "/usage", "/exit"], new ScriptedProvider("ollama", [answer("x", { inputTokens: 5n, outputTokens: 5n })]), ["--provider", "ollama"]);
    assert.ok(local.out.includes("API cost: $0 (local Ollama inference)"));
  });

  void it("immediate per-response --usage output is unchanged and has no cost", async () => {
    const provider = new ScriptedProvider("openai", [() => Promise.resolve(completed("hi", EXAMPLE, "default"))]);
    const run = await chat(["hello", "/exit"], provider, [...LUNA_ARGS, "--usage"]);
    assert.ok(!run.out.includes("Estimated cost"), run.out);
    assert.ok(!run.out.includes("$"), run.out);
  });
});

void describe("fullscreen cost", () => {
  void it("shows the panel cost after an accepted request, the same /usage line as plain chat, and no cost without usage", async () => {
    const provider = new ScriptedProvider("openai", [() => Promise.resolve(completed("hi", EXAMPLE, "default")), failure("boom")]);
    const session = await startTui({ provider, argv: LUNA_ARGS });
    assert.equal(panelCost(session), "-");
    await submit(session, "hello");
    await until(() => panelCost(session) === "$0.002165", "the cost");
    const calls = provider.calls;
    await submit(session, "/usage");
    assert.ok(session.term.flat().includes(EXAMPLE_LINE));
    assert.equal(provider.calls, calls);
    await submit(session, "again"); // fails: no record, no cost change
    await until(() => provider.calls === 2, "second call");
    await until(() => session.screen().includes("boom"), "the error");
    assert.equal(panelCost(session), "$0.002165");
    await submit(session, "/reset");
    await until(() => panelCost(session) === "-", "reset to no cost");
    await session.key(KEYS.ctrlC);
    await session.result;
  });

  void it("follows restored records: local, cloud, unknown provider and an empty tier never display as free", async () => {
    const stored = (requests: StoredUsageRecord[], provider: string, model: string): StoredConversation => ({
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: AT,
      updatedAt: AT,
      provider,
      model,
      messages: [],
      requests,
    });
    const rows: readonly (readonly [StoredConversation, string[], string])[] = [
      [stored([rec("ollama", "m1", { inputTokens: 5n })], "ollama", "m1"), ["--provider", "ollama"], "$0 (local)"],
      [stored([rec("ollama", "m1:cloud", { inputTokens: 5n })], "ollama", "m1"), ["--provider", "ollama"], "unavailable"],
      [stored([rec("acme", "m1", { inputTokens: 5n })], "ollama", "m1"), ["--provider", "ollama"], "unavailable"],
      [stored([rec("openai", "gpt-6-luna", { inputTokens: 5n, outputTokens: 5n }, "")], "openai", "gpt-6-luna"), LUNA_ARGS, "unavailable"],
      [stored([rec("openai", "gpt-6-luna", EXAMPLE, "default"), rec("ollama", "x:cloud", {})], "openai", "gpt-6-luna"), LUNA_ARGS, ">=$0.002165"],
    ];
    for (const [conversation, argv, expected] of rows) {
      const history = new MemoryHistory();
      history.latest = conversation;
      const session = await startTui({ history, argv, provider: new ScriptedProvider(conversation.provider === "openai" ? "openai" : "ollama") });
      assert.equal(panelCost(session), expected, JSON.stringify(argv));
      await session.key(KEYS.ctrlC);
      await session.result;
    }
  });

  void it("never lets a hostile saved name reach the terminal as a control sequence", async () => {
    const hostile = `evil${ESC}[2Jmodel`;
    const history = new MemoryHistory();
    history.latest = {
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: AT,
      updatedAt: AT,
      provider: "openai",
      model: "gpt-6-luna",
      messages: [],
      requests: [rec("openai", hostile, { inputTokens: 1n, outputTokens: 1n }, "default")],
    };
    const session = await startTui({ history, argv: LUNA_ARGS, provider: new ScriptedProvider("openai") });
    await submit(session, "/usage");
    assert.ok(!session.term.log.some((entry) => entry.includes(`${ESC}[2J`)), "no injected escape sequence");
    assert.ok(session.term.flat().includes("no pricing data for evil\\x1b[2Jmodel"));
    await session.key(KEYS.ctrlC);
    await session.result;
  });
});

void describe("fullscreen cost follows the active selection", () => {
  const press = (rig: MenuRig, sequence: string): Promise<void> => rig.session.key(sequence);
  const submitRig = async (rig: MenuRig, line: string): Promise<void> => {
    await rig.session.type(line);
    await press(rig, KEYS.enter);
  };
  const doneAndCost = async (rig: MenuRig, cost: string): Promise<void> => {
    await until(() => rig.session.term.status().startsWith("DONE"), "DONE");
    await until(() => panelCost(rig.session) === cost, `cost ${cost}`);
  };

  void it("A -> B -> A: each selection shows only its own records, with no combined cost", async () => {
    const rig = await startMenuTui({
      configure: ({ ollama, openai }) => {
        ollama.push(() => Promise.resolve(completed("local", { inputTokens: 5n, outputTokens: 5n })));
        openai.push(() => Promise.resolve(completed("remote", EXAMPLE, "default")));
      },
    });
    await submitRig(rig, "to ollama");
    await doneAndCost(rig, "$0 (local)");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => rig.session.term.flat().includes("Now using OpenAI / gpt-6-luna."), "switched");
    assert.equal(panelCost(rig.session), "-"); // a fresh conversation: nothing from the Ollama one
    await submitRig(rig, "to openai");
    await doneAndCost(rig, "$0.002165");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => rig.session.term.flat().includes("Now using Ollama"), "back to ollama");
    await settleAll();
    assert.equal(panelCost(rig.session), "$0 (local)");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => panelCost(rig.session) === "$0.002165", "openai cost restored");
    await press(rig, KEYS.ctrlC);
    await rig.session.result;
  });
});
