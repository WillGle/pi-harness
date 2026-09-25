import test from "node:test";
import assert from "node:assert/strict";
import harness from "../extensions/pi-harness.ts";
import { executeCoordinatorTurn } from "../lib/coordinator.mjs";

function fakePi(entries = []) {
  const tools = new Map(), events = new Map(), lifecycle = new Map(), commands = new Map();
  const pi = { entries, tools, commands,
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, value) { commands.set(name, value); },
    appendEntry(customType, data) { pi.entries.push({ customType, data }); },
    on(name, handler) { lifecycle.set(name, handler); },
    events: { on(name, handler) { const set = events.get(name) ?? new Set(); set.add(handler); events.set(name, set); return () => set.delete(handler); }, emit(name, value) { for (const handler of events.get(name) ?? []) handler(value); } },
    start(next) { pi.entries = next; lifecycle.get("session_start")({}, { mode: "rpc", sessionManager: { getEntries: () => next } }); },
    checkpoint() { lifecycle.get("session_before_compact")({}); },
  };
  harness(pi); pi.start(entries); return pi;
}
const call = async (pi, name, input) => JSON.parse((await pi.tools.get(name).execute("id", input)).content[0].text);
const latest = (pi, name) => pi.entries.filter((entry) => entry.customType === name).at(-1)?.data;
const create = { action: "create", operation_id: "O-G", objective: "Check domains.", required_task_ids: ["T-A", "T-B"], heads: [{ head_id: "H-A", domain: "architecture", task_ids: ["T-A"] }] };
const coordinator = (action, extra = {}) => JSON.stringify({ version: 1, operation_id: "O-G", action, reason: "The Coordinator needs advice.", ...extra });
const head = JSON.stringify({ version: 1, operation_id: "O-G", head_id: "H-A", action: "report", reason: "T-A is ready." });
const wait = async (condition) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); assert.ok(condition()); };

test("Operation setup persists bounded Task intents and shared constraints for Head context", async () => {
  const pi = fakePi();
  const op = await call(pi, "pi_harness_operation", { ...create, constraints: ["Do not integrate."], task_intents: { "T-A": "Inspect architecture.", "T-B": "Unrelated task." } });
  assert.deepEqual(op.constraints, ["Do not integrate."]);
  assert.equal(op.task_intents["T-A"], "Inspect architecture.");
  await assert.rejects(() => call(pi, "pi_harness_operation", { ...create, operation_id: "O-BAD", task_intents: { "T-UNKNOWN": "Invented task." } }), /Task intents/);
});

test("Head Registry and bounded HeadState survive checkpoint and reload; no transcript persists", async () => {
  const pi = fakePi(); await call(pi, "pi_harness_operation", create);
  const registry = latest(pi, "pi-harness-head-registry-state");
  assert.deepEqual(registry["O-G"].heads["H-A"].task_ids, ["T-A"]);
  let turns = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = `turn-${++turns}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: request.type === "head" ? head : turns === 1 ? coordinator("consult_head", { head_id: "H-A" }) : coordinator("block", { blocked_action: "dispatch T-A", required_condition: "the Coordinator selects T-A" }) }));
  });
  const report = await call(pi, "pi_harness_run_operation", { operation_id: "O-G" });
  assert.equal(report.status, "blocked");
  assert.equal(latest(pi, "pi-harness-head-state")["O-G"]["H-A"].turns, 1);
  pi.checkpoint();
  const saved = [...pi.entries];
  assert.deepEqual(latest(pi, "pi-harness-head-registry-state"), registry);
  assert.ok(!JSON.stringify(saved.filter((entry) => entry.customType === "pi-harness-head-state")).includes("Head transcript"));
  const reloaded = fakePi(saved);
  assert.deepEqual(latest(reloaded, "pi-harness-head-registry-state"), registry);
  reloaded.checkpoint();
  assert.equal(latest(reloaded, "pi-harness-head-state")["O-G"]["H-A"].turns, 1);
});

test("Session switch prevents old Head result from changing new session", async () => {
  const pi = fakePi(); await call(pi, "pi_harness_operation", create);
  let activeHead;
  let serial = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = `switch-${++serial}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: coordinator("consult_head", { head_id: "H-A" }) }));
    else activeHead = { id, request };
  });
  const old = call(pi, "pi_harness_run_operation", { operation_id: "O-G" });
  await wait(() => !!activeHead);
  const fresh = [];
  pi.start(fresh);
  assert.equal(activeHead.request.options.signal.aborted, true);
  pi.events.emit("subagents:completed", { id: activeHead.id, status: "completed", result: head });
  assert.equal((await old).status, "blocked");
  assert.equal(fresh.length, 0);
});

test("Goal cancellation aborts active Head and leaves unrelated turn running", async () => {
  const pi = fakePi(); await pi.commands.get("goal").handler("Check domains.", {}); await call(pi, "pi_harness_operation", create);
  const pending = [];
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = `turn-${pending.length}`; pending.push({ id, request });
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    request.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    if (request.type === "coordinator" && request.prompt !== "Unrelated") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: coordinator("consult_head", { head_id: "H-A" }) }));
  });
  const running = call(pi, "pi_harness_run_operation", { operation_id: "O-G" });
  await wait(() => pending.some((item) => item.request.type === "head"));
  const other = executeCoordinatorTurn(pi, "Unrelated", { groupId: "other", timeout: 1000 });
  await wait(() => pending.some((item) => item.request.prompt === "Unrelated"));
  await pi.commands.get("goal").handler("cancel", {});
  assert.equal(pending.find((item) => item.request.type === "head").request.options.signal.aborted, true);
  const unrelated = pending.find((item) => item.request.prompt === "Unrelated");
  assert.equal(unrelated.request.options.signal.aborted, false);
  pi.events.emit("subagents:completed", { id: unrelated.id, status: "completed", result: "other" });
  assert.equal(await other, "other");
  assert.equal((await running).status, "blocked");
});
