import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { InputError, LineReader } from "../src/line-input.js";

const listeners = (stream: PassThrough): number => ["data", "end", "close", "error"].reduce((sum, name) => sum + stream.listenerCount(name), 0);

void describe("LineReader", () => {
  void it("splits LF and CRLF lines and delivers a last line without a newline", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);
    stream.write("one\r\ntwo\n\nthree");
    stream.end();
    assert.equal(await reader.readLine(), "one");
    assert.equal(await reader.readLine(), "two");
    assert.equal(await reader.readLine(), "");
    assert.equal(await reader.readLine(), "three");
    assert.equal(await reader.readLine(), undefined);
    assert.equal(await reader.readLine(), undefined);
    reader.dispose();
  });

  void it("decodes characters split across arbitrary byte chunks and keeps a CR/LF pair split over chunks", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);
    const bytes = Buffer.from("héllo 世界 😀\r\nzweite\n", "utf8");
    for (const byte of bytes) stream.write(Buffer.from([byte]));
    stream.end();
    assert.equal(await reader.readLine(), "héllo 世界 😀");
    assert.equal(await reader.readLine(), "zweite");
    assert.equal(await reader.readLine(), undefined);
    reader.dispose();
  });

  void it("waits for lines that arrive later and does not lose ones that arrived before it was asked", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);
    stream.write("early\n");
    await new Promise((resolve) => setImmediate(resolve));
    const first = await reader.readLine();
    const pending = reader.readLine();
    stream.write("later\n");
    assert.equal(first, "early");
    assert.equal(await pending, "later");
    reader.dispose();
  });

  void it("an aborted wait rejects with an AbortError and a later read still gets the next line", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);
    const controller = new AbortController();
    const waiting = reader.readLine(controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    stream.write("after\n");
    assert.equal(await reader.readLine(), "after");
    reader.dispose();
  });

  void it("pauses the stream at the high-water mark and resumes as lines are consumed", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream, { highWaterMark: 2 });
    stream.write("a\nb\nc\nd\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stream.isPaused(), true);
    assert.equal(await reader.readLine(), "a");
    assert.equal(await reader.readLine(), "b");
    assert.equal(await reader.readLine(), "c");
    assert.equal(await reader.readLine(), "d");
    reader.dispose();
  });

  void it("delivers buffered lines before reporting a read error, which differs from the end of input", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);
    stream.write("kept\n");
    await new Promise((resolve) => setImmediate(resolve));
    stream.destroy(new Error("boom"));
    assert.equal(await reader.readLine(), "kept");
    await assert.rejects(reader.readLine(), (error: unknown) => error instanceof InputError && error.reason === "read");
    reader.dispose();
  });

  void it("an over-long line is an input error, not a silent truncation", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream, { maxLineLength: 8 });
    stream.write("ok\n123456789");
    assert.equal(await reader.readLine(), "ok");
    await assert.rejects(reader.readLine(), (error: unknown) => error instanceof InputError && error.reason === "line-too-long");
    reader.dispose();
  });

  void it("dispose removes every listener, pauses and does not destroy a caller-owned stream", async () => {
    const stream = new PassThrough();
    const before = listeners(stream);
    const reader = new LineReader(stream);
    assert.ok(listeners(stream) > before);
    const waiting = reader.readLine();
    reader.dispose();
    assert.equal(await waiting, undefined);
    assert.equal(listeners(stream), before);
    assert.equal(stream.destroyed, false);
    assert.equal(stream.isPaused(), true);
    reader.dispose(); // idempotent
  });
});
