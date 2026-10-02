import { SessionManager } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import harness from "../extensions/pi-harness.ts";
import { addWorkTask, claimWorkTask, createWork, WORK_ENTRY } from "../lib/work.mjs";
import { PLAN_ENTRY } from "../lib/plan.mjs";
import { mockSettlement } from "./helpers/mock-settlement.mjs";
import { trackControlPi } from "./helpers/control-state-isolation.mjs";

function fixture(entries = [], existingCwd = undefined) {
  const cwd = existingCwd ?? join(tmpdir(), `pi-maintenance-fixture-${randomUUID()}`);
  const session = SessionManager.inMemory(cwd);
  for(const entry of entries)session.appendCustomEntry(entry.customType,entry.data);
  const handlers = new Map(), commands = new Map(), tools = new Map(), notices = [], compactions = [], continuations = [];
  let percent = 0, idle = true;
  const bus = new Map();
  const pi = { get entries(){return session.getEntries();}, commands, tools, compactions, continuations, notices,
    events: { on(name, handler) { const listeners = bus.get(name) ?? new Set(); listeners.add(handler); bus.set(name, listeners); return () => listeners.delete(handler); },
      emit(name, payload) { if (this.mockSettlement !== false) mockSettlement(name, payload); for (const handler of [...(bus.get(name) ?? [])]) handler(payload); } },
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { session.appendCustomEntry(customType, data); },
    sendUserMessage(text) { continuations.push(text); },
  };
  harness(pi);
  const ctx = { mode: "rpc", cwd, sessionManager: session, ui: { notify: (message, type) => notices.push({ message, type }) },
    isIdle: () => idle, getContextUsage: () => ({ percent }), compact: (options) => { compactions.push(options); } };
  const boundary = () => {
    const result=handlers.get("agent_before_settle")?.({entries:[],context:{contextEntries:session.buildSessionProjection().entries,pendingMessages:[]}},ctx);
    for(const draft of result?.entries??[]) {
      if(draft.type === "context_edit")session.appendContextEdit(draft.targetId,draft.replacement);
      else if(draft.type === "custom_message")session.appendCustomMessageEntry(draft.customType,draft.content,draft.display,draft.details);
      else if(draft.type === "custom")session.appendCustomEntry(draft.customType,draft.data);
    }
    return result;
  };
  const emit = (name, event = {}) => {if(name === "agent_settled" && idle)boundary();return handlers.get(name)?.(event, ctx);};
  const ready = emit("session_start");
  pi.shutdown = () => handlers.get("session_shutdown")?.();
  trackControlPi(pi);
  return { ready, pi, ctx, emit, session, boundary, maintenance:()=>session.getEntries().filter(e=>e.customType === "pi-harness-context-maintenance"), setPercent: (value) => { percent = value; }, setIdle: (value) => { idle = value; },
    command: (name, args) => commands.get(name).handler(args, ctx),
    latest: (name) => session.getEntries().filter((entry) => entry.customType === name).at(-1)?.data };
}

test("explicit work resume retains the original objective and interrupted child provenance", async () => {
  const created = addWorkTask(createWork("Preserve the requested API.", ["Keep unrelated changes."]), { owner: "research", scope: "Inspect source.", permission: "read", verification: "Review findings.", acceptance_criteria: ["Name the entry point."] });
  const work = claimWorkTask(created.work, created.task_id);
  const f = fixture([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]); await f.ready;
  assert.equal(f.pi.continuations.length, 0);
  await f.command("work", "resume " + work.work_id);
  assert.match(f.pi.continuations.at(-1), /Original objective: Preserve the requested API/);
  assert.match(f.pi.continuations.at(-1), /Keep unrelated changes/);
  assert.equal(f.latest(WORK_ENTRY)[work.work_id].tasks[created.task_id].status, "unknown");
  await assert.rejects(f.pi.tools.get("pi_harness_goal").execute("complete", { status: "complete", evidence: "No result exists." }), /unresolved/);
});

test("native compaction checkpoints work and plan without editing session history or deciding completion", async () => {
  const work = createWork("Keep the objective across compaction.");
  const f = fixture([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]); await f.ready;
  await f.command("work", "resume " + work.work_id); await f.command("plan", "on");
  f.session.appendMessage({ role: "user", content: "Keep this request.", timestamp: 1 });
  const before = JSON.stringify(f.session.buildSessionProjection().messages);
  const instructions = await f.emit("session_before_compact", { reason: "threshold" });
  assert.match(instructions.customInstructions, /original objective/);
  assert.equal(f.latest(WORK_ENTRY)[work.work_id].status, "active");
  assert.equal(f.latest(PLAN_ENTRY).enabled, true);
  assert.equal(f.pi.compactions.length, 0);
  assert.equal(JSON.stringify(f.session.buildSessionProjection().messages), before);
  assert.equal(f.maintenance().length, 0);
});

test("high context and native failure do not trigger a second Harness compaction", async () => {
  const f = fixture(); await f.ready;
  f.setPercent(95); f.emit("context"); f.emit("session_compact_failed"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 0);
  assert.equal(f.maintenance().length, 0);
  assert.equal(f.emit("cache_warming_decision", { action: "warm" }), undefined);
});
