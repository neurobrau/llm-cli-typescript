import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { safeText } from "../src/providers/redact.js";

const SECRET = "synthetic-secret-value-123";

void describe("safeText", () => {
  void it("strips CSI and OSC escape sequences and other control characters", () => {
    assert.equal(safeText("a\u001b[31;1mred\u001b[0m b\u001b]0;evil title\u0007c\u001b]8;;http://x\u001b\\link d\u0000e\u0085f\u009bg"), "ared bclink defg");
  });

  void it("flattens newlines and tabs into single spaces", () => {
    assert.equal(safeText("one\r\ntwo\t\tthree\n\n  four"), "one two three four");
  });

  void it("caps the length at 300 characters with an ellipsis", () => {
    const out = safeText("x".repeat(500));
    assert.equal(Array.from(out).length, 301);
    assert.ok(out.endsWith("…"));
    assert.equal(safeText("y".repeat(300)), "y".repeat(300));
  });

  void it("redacts the configured secret exactly, even when control characters split it", () => {
    assert.equal(safeText(`key=${SECRET}!`, [SECRET]), "key=[redacted]!");
    assert.equal(safeText(`key=${SECRET.slice(0, 5)}\u0001${SECRET.slice(5)}`, [SECRET]), "key=[redacted]");
    assert.equal(safeText("nothing", [""]), "nothing");
  });

  void it("redacts key-like strings by pattern but leaves short look-alikes", () => {
    assert.equal(safeText("a sk-abcdef123 b sk-proj-Ab_Cd-123456 c"), "a [redacted] b [redacted] c");
    assert.equal(safeText("sk-ab and risk-assessment"), "sk-ab and risk-assessment");
  });
});
