import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SettingsError } from "../src/domain/errors.js";
import { DEFAULT_BASE_URL, resolveBaseUrl } from "../src/providers/ollama/host.js";

void describe("OLLAMA_HOST normalization", () => {
  void it("uses the local default for absent, empty and blank values", () => {
    for (const value of [undefined, "", "   ", "\t\n"]) {
      assert.equal(resolveBaseUrl(value), DEFAULT_BASE_URL);
    }
  });

  void it("accepts hosts, ports, URLs, IPv4, IPv6 and path prefixes", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["localhost", "http://localhost:11434"],
      ["  localhost:8080  ", "http://localhost:8080"],
      ["192.168.1.5", "http://192.168.1.5:11434"],
      ["192.168.1.5:9", "http://192.168.1.5:9"],
      ["ollama.internal:443", "http://ollama.internal:443"],
      ["http://example.com", "http://example.com:11434"],
      ["https://example.com", "https://example.com:11434"],
      ["HTTPS://Example.com:8443/", "https://Example.com:8443"],
      ["http://example.com:80", "http://example.com:80"],
      ["https://example.com:443/", "https://example.com:443"],
      ["http://127.0.0.1:11435", "http://127.0.0.1:11435"],
      ["[::1]", "http://[::1]:11434"],
      ["[::1]:9000", "http://[::1]:9000"],
      ["http://[fe80::1]:1/", "http://[fe80::1]:1"],
      ["http://host:11434/ollama/", "http://host:11434/ollama"],
      ["host/prefix/sub//", "http://host:11434/prefix/sub"],
      ["http://host///", "http://host:11434"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(resolveBaseUrl(input), expected, input);
    }
  });

  void it("maps the bind-all addresses to the local loopback address", () => {
    assert.equal(resolveBaseUrl("0.0.0.0"), "http://127.0.0.1:11434");
    assert.equal(resolveBaseUrl("0.0.0.0:9"), "http://127.0.0.1:9");
    assert.equal(resolveBaseUrl("http://0.0.0.0:11500/x"), "http://127.0.0.1:11500/x");
    assert.equal(resolveBaseUrl("[::]"), "http://127.0.0.1:11434");
    assert.equal(resolveBaseUrl("https://[::]:7"), "https://127.0.0.1:7");
  });

  void it("rejects malformed ports", () => {
    for (const value of ["host:0", "host:65536", "host:99999", "host:abc", "host:", "host:-1", "host:1.5", "host: 80", "[::1]:", "[::1]:x", "host:123456"]) {
      assert.throws(() => resolveBaseUrl(value), SettingsError, value);
    }
  });

  void it("rejects unsupported schemes, userinfo, queries and fragments without echoing the value", () => {
    const secrets = ["user:hunter2@host", "http://user:hunter2@host:1", "http://:hunter2@host", "ftp://host", "file:///etc/passwd", "ws://host", "http://host?token=hunter2", "http://host/p#hunter2", "host/p?x=hunter2"];
    for (const value of secrets) {
      assert.throws(
        () => resolveBaseUrl(value),
        (error: unknown) => {
          assert.ok(error instanceof SettingsError, value);
          assert.match(error.message, /^Invalid OLLAMA_HOST: .+\.$/);
          assert.ok(!error.message.includes("hunter2") && !error.message.includes("passwd"), error.message);
          return true;
        },
        value,
      );
    }
  });

  void it("rejects malformed hosts, IPv6 forms and path characters", () => {
    for (const value of ["::1", "fe80::1:11434", "[::1", "[::1]x", "[nope]", "[1.2.3.4]", "bad host", "-host", "host-", "http://", "http:///path", ":11434", "host/a b", "host/a\\b", "host/a\u0001b", "a..b:1/é"]) {
      assert.throws(() => resolveBaseUrl(value), SettingsError, value);
    }
  });
});
