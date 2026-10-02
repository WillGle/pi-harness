import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import harness from "../extensions/pi-harness.ts";
import "./helpers/control-state-isolation.mjs";

test("footer renders two cached lines without history scans and exposes one bounded status projection", async () => {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  let footerFactory;
  let entriesReads = 0;
  let renderRequests = 0;
  let customLines;
  let statusOverlay;
  let overlayClosed = false;
  let contextUsage = { tokens: 164_000, contextWindow: 272_000, percent: 60.3 };
  let runtimeModel = { id: "test-model", name: "Test Model", contextWindow: 272_000 };
  let thinkingLevel = "off";
  const entries = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    getActiveTools() { return []; }, setActiveTools() {},
  };
  harness(pi);
  const theme = { fg: (_tone, text) => text, bold: (text) => text };
  const ctx = {
    mode: "tui", cwd: process.cwd(), get model() { return runtimeModel; }, get thinkingLevel() { return thinkingLevel; },
    sessionManager: { getEntries() { entriesReads++; return entries; } },
    getContextUsage() { return contextUsage; },
    ui: {
      setHeader() {}, setFooter(factory) { footerFactory = factory; },
      notify() {},
      async custom(factory) {
        statusOverlay = factory({ requestRender() { renderRequests++; } }, theme, {}, () => { overlayClosed = true; });
        customLines = statusOverlay.render(90);
      },
    },
  };
  await handlers.get("session_start")({}, ctx);
  const readsAfterStartup = entriesReads;
  ctx.sessionManager.getEntries = () => { throw new Error("footer must not inspect session history"); };
  const widget = footerFactory({ requestRender() { renderRequests++; } }, theme, { getGitBranch() { throw new Error("footer must not query branch data"); } });
  for (const width of [160, 100, 60]) {
    const lines = widget.render(width);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  const initialFooter = widget.render(160);
  assert.match(initialFooter[0], /Work Idle/);
  assert.match(initialFooter[1], /Test Model · Off/);
  for (let index = 0; index < 30; index++) widget.render(120);
  assert.equal(entriesReads, readsAfterStartup, "footer render performs no session-history reads");
  assert.equal(renderRequests, 0, "repeated render does not request redraws");
  assert.equal(handlers.has("message_update"), false, "token output is not a StatusViewModel refresh event");
  assert.equal(handlers.has("tool_execution_update"), false, "child output is not a StatusViewModel refresh event");

  const sameContext = handlers.get("context");
  sameContext({}, ctx);
  assert.equal(renderRequests, 0, "an unchanged visible context state does not request a redraw");
  contextUsage = { tokens: 260_000, contextWindow: 272_000, percent: 95.6 };
  sameContext({}, ctx);
  assert.equal(renderRequests, 1, "a visible high-context transition requests one redraw");

  runtimeModel = { id: "runtime-id", name: "Daybreak Blue", contextWindow: 272_000 };
  thinkingLevel = "high";
  handlers.get("model_select")({ type: "model_select", model: { id: "ignored", name: "Event Payload Name" } }, ctx);
  assert.equal(renderRequests, 2, "the current runtime model selection requests one redraw");
  assert.match(widget.render(160)[1], /Daybreak Blue · High/);
  thinkingLevel = "medium";
  handlers.get("thinking_level_select")({ type: "thinking_level_select", level: "low" }, ctx);
  assert.equal(renderRequests, 3, "the current runtime thinking level requests one redraw");
  assert.match(widget.render(160)[1], /Daybreak Blue · Medium/);

  await commands.get("status").handler("", ctx);
  assert.ok(customLines.some((line) => line.includes("Blockers")));
  assert.ok(customLines.length <= 21, "expanded status uses the bounded scroll viewport");
  statusOverlay.handleInput("\u001b[6~");
  customLines = statusOverlay.render(90);
  assert.ok(customLines.some((line) => line.includes("Context Economics")), "the expanded projection can scroll to Context Economics");
  statusOverlay.handleInput("\u001b");
  assert.equal(overlayClosed, true, "the expanded view responds to Escape");
  const toolResult = await tools.get("pi_harness_status").execute("call", {});
  assert.match(toolResult.content[0].text, /Context Economics/);
  assert.match(toolResult.content[0].text, /Blockers/);
  assert.equal(entriesReads, readsAfterStartup, "expanded status uses the cached StatusViewModel");
  widget.dispose?.();
});
