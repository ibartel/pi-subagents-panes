/**
 * Unit tests for the surface layer and display configuration.
 *
 * No multiplexer runs here: these cover handle encoding, config parsing, the
 * depth rule, and the response parsers each adapter relies on. The tmux
 * integration tests exercise real panes separately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeHandle, encodeHandle } from "../pi-extension/subagents/surfaces/types.ts";
import {
  extractHerdrPaneId,
  extractHerdrScreen,
} from "../pi-extension/subagents/surfaces/herdr.ts";
import {
  extractOrcaHandle,
  extractOrcaScreen,
} from "../pi-extension/subagents/surfaces/orca.ts";
import { parseDefaultsConfig, parseDisplayConfig } from "../pi-extension/subagents/status.ts";
import { DEFAULT_DISPLAY_CONFIG } from "../pi-extension/subagents/status.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const testApi = (subagentsModule as any).__test__;

describe("defaults config", () => {
  it("is empty when the block is absent", () => {
    assert.deepEqual(parseDefaultsConfig({ status: { enabled: true } }), {});
  });

  it("reads model and thinking", () => {
    assert.deepEqual(
      parseDefaultsConfig({ defaults: { model: "z-ai/glm-5.3", thinking: "high" } }),
      { model: "z-ai/glm-5.3", thinking: "high" },
    );
  });

  it("rejects invalid values and unknown keys", () => {
    assert.throws(() => parseDefaultsConfig({ defaults: { thinking: "turbo" } }), /defaults\.thinking/);
    assert.throws(() => parseDefaultsConfig({ defaults: { model: "" } }), /defaults\.model/);
    assert.throws(() => parseDefaultsConfig({ defaults: { modle: "typo" } }), /defaults/);
  });
});

describe("surface handles", () => {
  it("round-trips every mux", () => {
    assert.deepEqual(decodeHandle(encodeHandle("tmux", "%12")), { mux: "tmux", id: "%12" });
    assert.deepEqual(decodeHandle(encodeHandle("herdr", "w1:p3")), { mux: "herdr", id: "w1:p3" });
    assert.deepEqual(decodeHandle(encodeHandle("orca", "term_ab-12")), {
      mux: "orca",
      id: "term_ab-12",
    });
  });

  it("keeps colons inside herdr pane ids intact", () => {
    assert.equal(decodeHandle("herdr:w2:p11").id, "w2:p11");
  });

  it("rejects malformed or unknown handles", () => {
    assert.throws(() => decodeHandle("nope"), /Invalid surface handle/);
    assert.throws(() => decodeHandle("screen:%1"), /Invalid surface handle/);
    assert.throws(() => decodeHandle("tmux:"), /Invalid surface handle/);
  });
});

describe("display config", () => {
  it("defaults when the display block is absent", () => {
    assert.deepEqual(parseDisplayConfig({ status: { enabled: true } }), DEFAULT_DISPLAY_CONFIG);
  });

  it("defaults nestedMode to mode", () => {
    assert.deepEqual(parseDisplayConfig({ display: { mode: "tab" } }), {
      mode: "tab",
      nestedMode: "tab",
      multiplexer: "auto",
    });
  });

  it("keeps independent top-level and nested modes", () => {
    assert.deepEqual(
      parseDisplayConfig({
        display: { mode: "splitRight", nestedMode: "splitDown", multiplexer: "herdr" },
      }),
      { mode: "splitRight", nestedMode: "splitDown", multiplexer: "herdr" },
    );
  });

  it("rejects unknown modes and multiplexers", () => {
    assert.throws(() => parseDisplayConfig({ display: { mode: "splitLeft" } }), /display\.mode/);
    assert.throws(
      () => parseDisplayConfig({ display: { mode: "tab", nestedMode: "float" } }),
      /display\.nestedMode/,
    );
    assert.throws(
      () => parseDisplayConfig({ display: { multiplexer: "screen" } }),
      /display\.multiplexer/,
    );
  });

  it("rejects unsupported display keys", () => {
    assert.throws(
      () => parseDisplayConfig({ display: { mode: "tab", direction: "up" } }),
      /display has unsupported key/,
    );
  });
});

describe("display mode by depth", () => {
  const config = { mode: "splitRight" as const, nestedMode: "splitDown" as const };

  it("uses the top-level mode for a root session", () => {
    assert.equal(testApi.resolveDisplayModeFor(undefined, false, config), "splitRight");
  });

  it("uses the nested mode for a subagent", () => {
    assert.equal(testApi.resolveDisplayModeFor(undefined, true, config), "splitDown");
  });

  it("lets a per-agent override win at either depth", () => {
    assert.equal(testApi.resolveDisplayModeFor("tab", false, config), "tab");
    assert.equal(testApi.resolveDisplayModeFor("tab", true, config), "tab");
  });
});

describe("herdr response parsing", () => {
  it("reads the pane id from a split response", () => {
    const raw = JSON.stringify({
      id: "cli:pane:split",
      result: {
        type: "pane_info",
        pane: { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1" },
      },
    });
    assert.equal(extractHerdrPaneId(raw), "w1:p3");
  });

  it("reads the root pane id from a tab-create response", () => {
    const raw = JSON.stringify({
      result: {
        type: "tab_created",
        root_pane: { pane_id: "w1:p2" },
        tab: { tab_id: "w1:t2" },
      },
    });
    assert.equal(extractHerdrPaneId(raw), "w1:p2");
  });

  it("falls back to scanning plain text output", () => {
    assert.equal(extractHerdrPaneId("created w2:p9\n"), "w2:p9");
  });

  it("throws when no pane id is present", () => {
    assert.throws(() => extractHerdrPaneId("{}"), /Could not determine the new herdr pane id/);
  });

  it("unwraps the screen text", () => {
    assert.equal(
      extractHerdrScreen(JSON.stringify({ result: { text: "line one\nline two" } })),
      "line one\nline two",
    );
    assert.equal(extractHerdrScreen("plain screen"), "plain screen");
  });
});

describe("orca response parsing", () => {
  it("finds a handle nested anywhere in the payload", () => {
    assert.equal(
      extractOrcaHandle(JSON.stringify({ ok: true, result: { terminal: { handle: "term_ab12" } } })),
      "term_ab12",
    );
    assert.equal(extractOrcaHandle('{"ok":true,"result":{"handle":"term_12-3"}}'), "term_12-3");
  });

  it("surfaces an Orca error instead of a handle", () => {
    assert.throws(
      () =>
        extractOrcaHandle(
          JSON.stringify({
            ok: false,
            error: { message: "Local terminal creation is unavailable" },
          }),
        ),
      /Orca: Local terminal creation is unavailable/,
    );
  });

  it("unwraps the rendered screen tail", () => {
    assert.equal(
      extractOrcaScreen(
        JSON.stringify({ ok: true, result: { terminal: { tail: ["a", "b"] } } }),
      ),
      "a\nb",
    );
  });
});
