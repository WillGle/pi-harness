import { mockSettlement } from "./helpers/mock-settlement.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import harness from "../extensions/pi-harness.ts";
import { OPERATION_ENTRY } from "../lib/operation.mjs";
import { MISSION_ENTRY, createMission } from "../lib/mission.mjs";
import { GOAL_ENTRY, goalState } from "../lib/state.mjs";
import { TASK_GRAPH_ENTRY } from "../lib/task-graph.mjs";
import { readControlState } from "../lib/control-state-store.mjs";
import { trackControlPi } from "./helpers/control-state-isolation.mjs";

function makePi(entries) {
  const tools = new Map(), handlers = new Map(), listeners = new Map();
  const pi = {
    tools, entries, commands: new Map(), spawns: 0, followUps: [],
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { this.commands.set(name, command); },
    sendUserMessage(text, options) { this.followUps.push({ text, options }); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    events: {
      on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
      emit(name, event) { if (this.mockSettlement !== false) mockSettlement(name, event); if (name === "subagents:rpc:spawn") pi.spawns++; for (const fn of [...(listeners.get(name) ?? [])]) fn(event); },
    },
    start() { handlers.get("session_start")?.({}, { sessionManager: { getEntries: () => entries }, mode: "rpc" }); },
    shutdown() { return handlers.get("session_shutdown")?.(); },
    contextPrompt() { const event = {systemPromptOptions:{sections:{}}}; const result=handlers.get("before_agent_start")?.(event, {}); assert.equal(result?.message,undefined); return {sections:event.systemPromptOptions.sections}; },
  };
  harness(pi);
  pi.start();
  return trackControlPi(pi);
}

async function call(pi, name, input) { return JSON.parse((await pi.tools.get(name).execute("test", input)).content[0].text); }
function activeMissionEntries(objective) {
  return [{ customType: GOAL_ENTRY, data: goalState(objective) }, { customType: MISSION_ENTRY, data: { "M-test": createMission({ mission_id: "M-test", objective }) } }];
}

test("Commander context receives the Harness language contract without skill selection", () => {
  const pi = makePi([]);
  const prompt = pi.contextPrompt().sections.pi_harness_contract;
  for (const text of ["ASD-STE100-derived Agent English", "State the actor explicitly.", "Put a condition before the action that depends on it.", "Only the Coordinator may accept", "Operation completion does not complete the Mission.", "Do not promote raw L3 Worker context or raw Evidence to L0 or L1.", "Treat an ordinary user request in natural language as sufficient input.", "Choose DIRECT EXECUTION", "Choose MANAGED MISSION", "Treat a user `mission:` hint", "Do not ask the user to trigger maintenance", "Cache-hit ratio is telemetry, not the optimization objective."]) assert.ok(prompt.includes(text), text);
});

test("natural-language Commander can start a managed Mission and retain its Constraints", async () => {
  const pi = makePi([]);
  const started = await call(pi, "pi_harness_start_mission", { objective: "Fix the authentication bug and verify it.", constraints: ["Preserve the public API."] });
  assert.equal(started.status, "active");
  assert.match(started.mission_id, /^M-/);
  const mission = pi.entries.filter((entry) => entry.customType === MISSION_ENTRY).at(-1).data[started.mission_id];
  assert.deepEqual(mission.constraints, ["Preserve the public API."]);
  assert.equal(pi.spawns, 0, "Mission start does not bypass Coordinator planning");
  assert.match(pi.followUps.at(-1).text, /Create a task-less planning Operation/);
  const operation = await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-natural-language", objective: mission.objective, constraints: ["Use the existing test runner."] });
  assert.equal(operation.planning, true);
  assert.deepEqual(pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.operations[operation.operation_id].constraints, [...mission.constraints, "Use the existing test runner."]);
  assert.deepEqual(Object.keys(pi.tools.get("pi_harness_start_mission").parameters.properties).sort(), ["constraints", "objective"]);
  await assert.rejects(() => pi.tools.get("pi_harness_start_mission").execute("test", { objective: "Start a conflicting Mission." }), /Mission is already active/);
});

test("a new natural-language Mission does not silently select persisted Missions", async () => {
  const old = createMission({ mission_id: "M-old", objective: "Continue previous work." });
  const entries = [{ customType: MISSION_ENTRY, data: { [old.mission_id]: old } }];
  const pi = makePi(entries);
  const started = await call(pi, "pi_harness_start_mission", { objective: "Start a separate new objective." });
  assert.notEqual(started.mission_id, old.mission_id);
  const created = await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-new-natural", objective: "Start a separate new objective." });
  assert.equal(created.mission_id, started.mission_id);
  assert.deepEqual(entries.filter((entry) => entry.customType === MISSION_ENTRY).at(-1).data[old.mission_id].operation_ids, []);
});

test("Commander-facing Operation tools cannot accept TaskResults or expose TaskResult contents", async () => {
  const entries = activeMissionEntries("Inspect the Coordinator.");
  const pi = makePi(entries);
  await pi.commands.get("mission").handler("resume M-test", {});
  const created = await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-test", objective: "Inspect the Coordinator.", required_task_ids: ["T-test"] });
  assert.equal(created.operation_id, "O-test");
  assert.equal(created.status, "open");
  assert.equal(Object.hasOwn(created, "task_results"), false);

  await assert.rejects(() => pi.tools.get("pi_harness_operation").execute("test", { action: "accept_task", operation_id: "O-test", task_id: "T-test" }), /Only the Harness Coordinator/);
  const status = await call(pi, "pi_harness_operation", { action: "status", operation_id: "O-test" });
  assert.equal(status.status, "open");
  assert.equal(Object.hasOwn(status, "task_results"), false);
  assert.equal(Object.hasOwn(status, "evidence_refs"), false);

  const snapshot = entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.deepEqual(snapshot.operations["O-test"].accepted_task_ids, []);
  assert.equal(snapshot.task_graphs["O-test"].nodes["T-test"].scheduler_status, "ready");
  assert.ok(entries.some((entry) => entry.customType === OPERATION_ENTRY));
});

test("Commander records an explicit terminal Operation disposition after TaskOrder waiver", async () => {
  const entries = activeMissionEntries("Inspect the Coordinator."), pi = makePi(entries);
  await pi.commands.get("mission").handler("resume M-test", {});
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-waive", objective: "Inspect the Coordinator.", required_task_ids: ["T-waive"] });
  await call(pi, "pi_harness_operation", { action: "waive", operation_id: "O-waive", task_id: "T-waive", authority_type: "commander", reason: "The requirement is removed." });
  const terminal = await call(pi, "pi_harness_operation", { action: "waive_operation", operation_id: "O-waive", authority_type: "commander", reason: "All remaining TaskOrders are waived." });
  assert.equal(terminal.status, "waived");
  const snapshot = entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.operations["O-waive"].status, "waived");
  assert.equal(snapshot.operations["O-waive"].operation_disposition.kind, "waived");
  assert.equal(snapshot.operations["O-waive"].operation_disposition.authority_type, "commander");
  assert.match(snapshot.operations["O-waive"].operation_disposition.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("Commander can remove a TaskOrder through its durable waiver", async () => {
  const entries = activeMissionEntries("Inspect the Coordinator."), pi = makePi(entries);
  await pi.commands.get("mission").handler("resume M-test", {});
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-remove", objective: "Inspect the Coordinator.", required_task_ids: ["T-remove"] });
  const removed = await call(pi, "pi_harness_operation", { action: "remove", operation_id: "O-remove", task_id: "T-remove", authority_type: "commander", reason: "The task is no longer needed." });
  assert.equal(removed.disposition, "waived");
  const snapshot = entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.task_graphs["O-remove"].nodes["T-remove"].scheduler_status, "waived");
});

test("Commander creates a task-less planning Operation", async () => {
  const entries = activeMissionEntries("Implement safely."), pi = makePi(entries);
  await pi.commands.get("mission").handler("resume M-test", {});
  const created = await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-plan", objective: "Implement safely.", allowed_policy_ids: ["worker-write"] });
  assert.equal(created.planning, true);
  const snapshot = entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(Object.hasOwn(snapshot.operations["O-plan"], "required_task_ids"), false);
  assert.deepEqual(snapshot.task_graphs["O-plan"].nodes, {});
});

test("Commander cannot create an Operation without an active Mission", async () => {
  const pi = makePi([]);
  await assert.rejects(() => pi.tools.get("pi_harness_operation").execute("test", { action: "create", operation_id: "O-orphan", objective: "Inspect safely." }), /explicitly selected Mission/);
});

test("Commander creates an Operation only after explicitly selecting its owning Mission", async () => {
  const entries = [{ customType: MISSION_ENTRY, data: { "M-only": createMission({ mission_id: "M-only", objective: "Restore safely." }) } }];
  const pi = makePi(entries);
  await assert.rejects(() => pi.tools.get("pi_harness_operation").execute("test", { action: "create", operation_id: "O-restored", objective: "Restore safely.", required_task_ids: ["T-restored"] }), /explicitly selected Mission/);
  await pi.commands.get("mission").handler("resume M-only", {});
  const created = await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-restored", objective: "Restore safely.", required_task_ids: ["T-restored"] });
  assert.equal(created.mission_id, "M-only");
});

test("resuming a Mission with an existing control lease validates the lease", async () => {
  const pi = makePi(activeMissionEntries("Resume safely.")), notifications = [];
  const ctx = { ui: { notify: (message, level) => notifications.push({ message, level }) } };
  await pi.commands.get("mission").handler("resume M-test", ctx);
  await pi.commands.get("mission").handler("resume M-test", ctx);
  assert.equal(notifications.some(({ level }) => level === "error"), false);
  assert.equal(notifications.filter(({ message }) => message.includes("Mission M-test resumed.")).length, 2);
});

test("multiple restored Missions remain unselected until an exact ID is resumed", async () => {
  const entries = [{ customType: MISSION_ENTRY, data: {
    "M-first": createMission({ mission_id: "M-first", objective: "First Mission." }),
    "M-second": createMission({ mission_id: "M-second", objective: "Second Mission." }),
  } }];
  const pi = makePi(entries);
  await pi.commands.get("mission").handler("list", {});
  await assert.rejects(() => pi.tools.get("pi_harness_operation").execute("test", { action: "create", operation_id: "O-ambiguous", objective: "Inspect safely." }), /explicitly selected Mission/);
  await pi.commands.get("mission").handler("resume M-second", {});
  const created = await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-second", objective: "Inspect safely.", required_task_ids: ["T-second"] });
  assert.equal(created.mission_id, "M-second");
  assert.deepEqual(entries.filter((entry) => entry.customType === MISSION_ENTRY).at(-1).data["M-first"].operation_ids, []);
});

test("a Pi session cannot transfer Mission control state to a different project directory", async () => {
  const entries = [{ customType: MISSION_ENTRY, data: { "M-project": createMission({ mission_id: "M-project", objective: "Keep project ownership isolated." }) } }];
  const pi = makePi(entries);
  await pi.commands.get("mission").handler("resume M-project", { cwd: "/tmp/pi-harness-other-project" });
  await assert.rejects(() => pi.tools.get("pi_harness_operation").execute("test", { action: "create", operation_id: "O-cross-project", objective: "Do not copy state." }), /explicitly selected Mission/);
  assert.equal(readControlState("/tmp/pi-harness-other-project"), undefined);
});

test("a completed Mission cannot be resumed or reopened", async () => {
  const completed = createMission({ mission_id: "M-complete", objective: "Already closed.", status: "complete" });
  const pi = makePi([{ customType: MISSION_ENTRY, data: { [completed.mission_id]: completed } }]);
  await pi.commands.get("mission").handler("resume M-complete", {});
  await assert.rejects(() => pi.tools.get("pi_harness_goal").execute("test", { status: "complete", evidence: "Already closed." }), /explicitly resume a Mission/);
  assert.equal(pi.entries.filter((entry) => entry.customType === MISSION_ENTRY).at(-1).data[completed.mission_id].status, "complete");
});

test("an errored Mission can be explicitly cancelled", async () => {
  const mission = createMission({ mission_id: "M-error", objective: "Recover safely.", status: "error" });
  const pi = makePi([{ customType: MISSION_ENTRY, data: { [mission.mission_id]: mission } }]);
  await pi.commands.get("mission").handler("cancel M-error", {});
  const cancelled = pi.entries.filter((entry) => entry.customType === MISSION_ENTRY).at(-1).data[mission.mission_id];
  assert.equal(cancelled.status, "cancelled");
});

test("legacy direct dispatch is disabled and cannot promote a TaskResult to the Commander", async () => {
  const pi = makePi([]);
  await assert.rejects(() => pi.tools.get("pi_harness_coordinate").execute("test", {
    owner: "research", scope: "Inspect the Coordinator.", permission: "read", verification: "Inspect the report.",
  }), /Direct TaskOrder dispatch is disabled/);
  assert.equal(pi.spawns, 0);
});
