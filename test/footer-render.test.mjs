import test from "node:test";
import assert from "node:assert/strict";
import harness from "../extensions/pi-harness.ts";
import "./helpers/control-state-isolation.mjs";

test("cache economics footer renders cached context usage without session scans", () => {
  const handlers = new Map();
  let footerFactory;
  let usageReads = 0;
  const entries = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, appendEntry(customType, data) { entries.push({ customType, data }); },
    getActiveTools() { return []; }, setActiveTools() {},
  };
  harness(pi);
  const ctx = {
    mode: "tui", cwd: process.cwd(), model: { id: "test-model", contextWindow: 100_000 }, thinkingLevel: "off",
    sessionManager: { getEntries: () => entries },
    getContextUsage() { usageReads++; return { tokens: usageReads * 100, contextWindow: 100_000, percent: usageReads / 10 }; },
    ui: { setHeader() {}, setFooter(factory) { footerFactory = factory; } },
  };
  handlers.get("session_start")({}, ctx);
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const footerData = { onBranchChange: () => () => {}, getGitBranch: () => undefined };
  const widget = footerFactory({ requestRender() {} }, theme, footerData);
  for (let index = 0; index < 25; index++) {
    assert.equal(widget.render(120).length, 2);
  }
  assert.equal(usageReads, 1, "rendering never invokes Pi's history-projecting context usage getter");
  handlers.get("context")({}, ctx);
  widget.render(120);
  assert.equal(usageReads, 2, "Pi's context lifecycle event refreshes the cached usage");
  widget.dispose();
});
