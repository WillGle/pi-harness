import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCoordinateTask } from "../lib/coordinator.mjs";
import harness from "../extensions/pi-harness.ts";
import { PROACTIVE_COMPACT_ENTRY, setProactiveThreshold } from "../lib/compaction-policy.mjs";

function fixture(entries = []) {
  const handlers = new Map(), commands = new Map(), tools = new Map(), notices = [], compactions = [], continuations = [];
  let percent = 0, idle = true;
  const bus = new Map();
  const pi = { entries, commands, tools, compactions, continuations, notices,
    events: { on(name, handler) { const listeners = bus.get(name) ?? new Set(); listeners.add(handler); bus.set(name, listeners); return () => listeners.delete(handler); },
      emit(name, payload) { for (const handler of [...(bus.get(name) ?? [])]) handler(payload); } },
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    sendUserMessage(text) { continuations.push(text); },
  };
  harness(pi);
  const ctx = { mode: "rpc", sessionManager: { getEntries: () => entries }, ui: { notify: (message, type) => notices.push({ message, type }) },
    isIdle: () => idle, getContextUsage: () => ({ percent }), compact: (options) => { compactions.push(options); } };
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start");
  return { pi, ctx, emit, setPercent: (value) => { percent = value; }, setIdle: (value) => { idle = value; },
    command: (name, args) => commands.get(name).handler(args, ctx),
    latest: (name) => entries.filter((entry) => entry.customType === name).at(-1)?.data };
}

test("threshold defaults to 70% of the active model context window and remains configurable", async () => {
  const f = fixture();
  await f.command("harness-compact", "status");
  assert.match(f.pi.notices.at(-1).message, /enabled at 70%/);
  f.setPercent(69); f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 0);
  f.setPercent(70); f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 1);
  f.pi.compactions[0].onComplete({ summary: "DONE" });
  f.setPercent(60); f.emit("context");
  await f.command("harness-compact", "set 73");
  assert.deepEqual(f.latest(PROACTIVE_COMPACT_ENTRY), { enabled: true, threshold_percent: 73 });
  f.setPercent(72); f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 1);
  for (const invalid of ["49", "91", "73.5", "abc", "80%", "set", "set  77abc"]) {
    if (invalid.startsWith("set")) await f.command("harness-compact", invalid);
    else assert.throws(() => setProactiveThreshold(invalid));
  }
  assert.equal(f.latest(PROACTIVE_COMPACT_ENTRY).threshold_percent, 73);
  const restored = fixture(f.pi.entries);
  await restored.command("harness-compact", "status");
  assert.match(restored.pi.notices.at(-1).message, /enabled at 73%/);
  await restored.command("harness-compact", "disable");
  assert.deepEqual(restored.latest(PROACTIVE_COMPACT_ENTRY), { enabled: false, threshold_percent: 73 });
  restored.setPercent(95); restored.emit("context"); restored.emit("agent_settled");
  assert.equal(restored.pi.compactions.length, 0);
  const legacyDisabled = fixture([{ customType: PROACTIVE_COMPACT_ENTRY, data: { enabled: false, threshold_percent: null } }]);
  await legacyDisabled.command("harness-compact", "status");
  assert.match(legacyDisabled.pi.notices.at(-1).message, /disabled/);
});

test("context only marks pending; settled compaction completes before Goal continuation", async () => {
  const f = fixture();
  await f.command("harness-compact", "set 65");
  f.setPercent(66); f.setIdle(false);
  f.emit("context"); f.emit("context");
  await f.command("goal", "Finish this Mission.");
  assert.equal(f.pi.compactions.length, 0);
  assert.equal(f.pi.continuations.length, 0);
  f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 0);
  f.setIdle(true);
  f.emit("agent_settled"); f.emit("agent_settled"); f.emit("context");
  assert.equal(f.pi.compactions.length, 1);
  assert.equal(f.pi.continuations.length, 0);
  assert.equal(f.latest("pi-harness-compact-state").mission.status, "active");
  assert.equal(f.latest("pi-harness-goal-state").status, "active");
  f.pi.compactions[0].onComplete({ summary: "DONE" });
  assert.equal(f.pi.continuations.length, 1);
  assert.equal(f.latest("pi-harness-goal-state").status, "active");
  f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 1, "high usage after compaction must not cause a loop");
  f.setPercent(40); f.emit("context");
  f.setPercent(67); f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 2, "only a later below-to-above crossing re-arms");
});

test("compaction errors do not transition Goal or retry at the same high-water mark", async () => {
  const f = fixture();
  await f.command("harness-compact", "set 70");
  f.setPercent(71); f.emit("context");
  await f.command("goal", "Keep the Mission active.");
  f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 1);
  f.pi.compactions[0].onError(new Error("Nothing to compact"));
  assert.equal(f.latest("pi-harness-goal-state").status, "active");
  assert.equal(f.pi.continuations.length, 1);
  f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 1);
});

test("direct Task/Reviewer tool activity holds compaction until it finishes", async () => {
  const f = fixture();
  await f.command("harness-compact", "set 58");
  f.setPercent(59);
  f.emit("tool_execution_start", { toolCallId: "reviewer", toolName: "pi_harness_coordinate" });
  f.emit("context"); f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 0);
  f.emit("tool_execution_end", { toolCallId: "reviewer" });
  assert.equal(f.pi.compactions.length, 1);
});

test("active direct TaskOrder and semantic Reviewer are never aborted by proactive compaction", async () => {
  const f = fixture();
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-review-"));
  const before = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = cwd;
  try {
    await f.command("harness-compact", "set 55");
    f.setPercent(60); f.emit("context");
    let review;
    f.pi.events.on("subagents:rpc:spawn", (request) => {
      const id = request.type === "research" ? "research-1" : "reviewer-1";
      f.pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
      if (request.type === "research") queueMicrotask(() => f.pi.events.emit("subagents:completed", { id, status: "completed", result: "The report identifies a source." }));
      else review = { request, id };
    });
    const task = executeCoordinateTask(f.pi, { owner: "research", task_id: "T-1", scope: "Read source", verification: "Check report", permission: "read", acceptance_criteria: ["The report identifies a source."] }, { cwd, timeout: 1500, rpcTimeout: 1000 });
    for (let i = 0; i < 30 && !review; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(review);
    f.emit("agent_settled");
    assert.equal(f.pi.compactions.length, 0);
    assert.equal(review.request.options.signal.aborted, false);
    const packet = JSON.parse(review.request.prompt.slice(review.request.prompt.indexOf('{"version"')));
    f.pi.events.emit("subagents:completed", { id: review.id, status: "completed", result: JSON.stringify({ version: 1, task_id: "T-1", status: "verified", summary: "Checked.", criteria: [{ criterion: "The report identifies a source.", status: "passed", finding: "The report identifies a source.", evidence_refs: [packet.evidence[0].reference] }] }) });
    assert.equal((await task).taskResult.verification_status, "verified");
    f.emit("agent_settled");
    assert.equal(f.pi.compactions.length, 1);
    assert.equal(review.request.options.signal.aborted, false);
  } finally {
    if (before === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = before;
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("native compaction satisfies pending request without a second Harness compaction", async () => {
  const f = fixture();
  await f.command("harness-compact", "set 75");
  await f.pi.tools.get("pi_harness_operation").execute("id", { action: "create", operation_id: "O-1", objective: "Inspect the source.", required_task_ids: ["T-1"] });
  f.setPercent(76); f.emit("context");
  f.emit("session_before_compact", { reason: "threshold" });
  assert.equal(f.pi.compactions.length, 0);
  assert.ok(f.latest("pi-harness-compact-state"));
  assert.deepEqual(f.latest(PROACTIVE_COMPACT_ENTRY), { enabled: true, threshold_percent: 75 });
  assert.equal(f.latest("pi-harness-operation-state")["O-1"].status, "open");
  assert.deepEqual(f.latest("pi-harness-coordinator-state"), {});
  f.emit("session_compact", { reason: "threshold" });
  f.emit("agent_settled");
  assert.equal(f.pi.compactions.length, 0);
});
