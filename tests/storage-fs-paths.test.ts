import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HistoryStore, SettingsStore, newConversationId, resolveStoragePaths } from "../src/storage/fs/index.js";
import type { StorageFs } from "../src/storage/fs/index.js";
import { StoragePathError } from "../src/storage/fs/index.js";
import { isValidConversationId } from "../src/storage/index.js";

const HOME = "/home/user";

void describe("resolveStoragePaths", () => {
  void it("uses absolute XDG bases and normalizes them", () => {
    const paths = resolveStoragePaths({ env: { XDG_STATE_HOME: "/s/../state//", XDG_CONFIG_HOME: "/c/./cfg/" }, home: HOME });
    assert.deepEqual(paths, {
      conversations: "/state/neurobrau/conversations",
      active: "/state/neurobrau/active.json",
      settings: "/c/cfg/neurobrau/settings.json",
    });
  });

  void it("falls back to the home directory when XDG values are unset, empty or relative, independently", () => {
    const fallback = {
      conversations: `${HOME}/.local/state/neurobrau/conversations`,
      active: `${HOME}/.local/state/neurobrau/active.json`,
      settings: `${HOME}/.config/neurobrau/settings.json`,
    };
    assert.deepEqual(resolveStoragePaths({ env: {}, home: HOME }), fallback);
    assert.deepEqual(resolveStoragePaths({ env: { XDG_STATE_HOME: "", XDG_CONFIG_HOME: "rel/dir" }, home: HOME }), fallback);
    assert.deepEqual(resolveStoragePaths({ env: { XDG_STATE_HOME: "~/state", XDG_CONFIG_HOME: undefined }, home: HOME }), fallback);
    const mixed = resolveStoragePaths({ env: { XDG_STATE_HOME: "/abs/state", XDG_CONFIG_HOME: "relative" }, home: HOME });
    assert.equal(mixed.conversations, "/abs/state/neurobrau/conversations");
    assert.equal(mixed.settings, `${HOME}/.config/neurobrau/settings.json`);
  });

  void it("does not expand ~ inside an absolute XDG value", () => {
    const paths = resolveStoragePaths({ env: { XDG_STATE_HOME: "/data/~/s", XDG_CONFIG_HOME: "/data/~" } });
    assert.equal(paths.active, "/data/~/s/neurobrau/active.json");
  });

  void it("needs a home only for a base without a valid XDG value, and never guesses cwd", () => {
    const both = { XDG_STATE_HOME: "/s", XDG_CONFIG_HOME: "/c" };
    assert.equal(resolveStoragePaths({ env: both }).settings, "/c/neurobrau/settings.json");
    for (const input of [
      { env: {} },
      { env: { XDG_STATE_HOME: "/s" } },
      { env: { XDG_CONFIG_HOME: "/c" }, home: "" },
      { env: { XDG_STATE_HOME: "/s", XDG_CONFIG_HOME: "rel" }, home: "relative/home" },
    ]) {
      assert.throws(() => resolveStoragePaths(input), (error: unknown) => error instanceof StoragePathError && error.kind === "home-required");
    }
  });

  void it("reads only the injected environment (record or getter), never process.env", () => {
    const asked: string[] = [];
    const paths = resolveStoragePaths({
      env: (name) => {
        asked.push(name);
        return name === "XDG_STATE_HOME" ? "/g/state" : undefined;
      },
      home: HOME,
    });
    assert.deepEqual(asked.sort(), ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]);
    assert.equal(paths.conversations, "/g/state/neurobrau/conversations");
    // An inherited/prototype key of a record is not an environment value.
    const inherited = Object.create({ XDG_STATE_HOME: "/leak" }) as Record<string, string | undefined>;
    assert.equal(resolveStoragePaths({ env: inherited, home: HOME }).active, `${HOME}/.local/state/neurobrau/active.json`);
  });

  void it("rejects embedded NUL values with a generic error", () => {
    for (const input of [
      { env: { XDG_STATE_HOME: "/s\0x" }, home: HOME },
      { env: { XDG_CONFIG_HOME: "rel\0" }, home: HOME },
      { env: {}, home: "/h\0" },
    ]) {
      assert.throws(
        () => resolveStoragePaths(input),
        (error: unknown) => error instanceof StoragePathError && error.kind === "invalid-path" && !error.message.includes("\0"),
      );
    }
  });
});

void describe("new conversation ids", () => {
  void it("are canonical lowercase version-4 UUIDs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const id = newConversationId();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.ok(isValidConversationId(id));
      seen.add(id);
    }
    assert.equal(seen.size, 50);
  });
});

void describe("inert construction", () => {
  void it("constructors touch neither the filesystem nor the environment", () => {
    const touched: string[] = [];
    const spy = new Proxy({} as StorageFs, {
      get: (_target, key) => {
        touched.push(String(key));
        return undefined;
      },
    });
    const store = new HistoryStore("/nowhere/neurobrau/conversations", { fs: spy });
    const settings = new SettingsStore("/nowhere/neurobrau/settings.json", { fs: spy });
    assert.equal(store.activePath, "/nowhere/neurobrau/active.json");
    assert.equal(settings.saveEnabled, false);
    assert.deepEqual(touched, []);
  });

  void it("require absolute locations", () => {
    assert.throws(() => new HistoryStore("relative/conversations"), StoragePathError);
    assert.throws(() => new SettingsStore(""), StoragePathError);
    assert.throws(() => new HistoryStore("/a\0b"), StoragePathError);
  });

  void it("pathFor accepts only canonical UUIDs", () => {
    const store = new HistoryStore("/x/neurobrau/conversations");
    assert.equal(store.pathFor("11111111-1111-4111-8111-111111111111"), "/x/neurobrau/conversations/11111111-1111-4111-8111-111111111111.json");
    for (const bad of ["../x", "a/b", "", "11111111-1111-4111-8111-11111111111G", "11111111-1111-4111-8111-111111111111.json", "11111111-1111-4111-8111-11111111111F"]) {
      assert.throws(() => store.pathFor(bad), StoragePathError);
    }
  });
});
