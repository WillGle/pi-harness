import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import harness from "../extensions/pi-harness.ts";
import { createOperation } from "../lib/operation.mjs";
import { coordinatorPrompt, coordinatorState, operationBrief, parseCoordinatorDecision, runOperation } from "../lib/operation-runner.mjs";
import { cancelCoordinateTasks, executeCoordinatorTurn } from "../lib/coordinator.mjs";
import { TASK_GRAPH_ENTRY } from "../lib/task-graph.mjs";

const dir = mkdtempSync(join(tmpdir(), "pi-phasee-test-"));
const prior = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = dir;
after(() => { if (prior === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = prior; rmSync(dir, { recursive: true, force: true }); });
const op = () => createOperation({ operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1", "T-2"], dependencies: { "T-2": ["T-1"] }, acceptance_criteria: ["The Coordinator checked the result."] });
const decision = (action, fields = {}) => JSON.stringify({ version: 1, operation_id: "O-1", action, reason: "The Coordinator checked the Operation state.", ...fields });
const task = (id) => ({ task_id: id, owner: "research", scope: "Inspect `lib/coordinator.mjs`.", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies `lib/coordinator.mjs`."] });

test("Coordinator packet contains bounded semantic state, not transcripts", () => {
  const operation = op();
  const packet = operationBrief(operation, coordinatorState(operation), "Mission objective.");
  assert.equal(packet.OperationBrief.mission, "Mission objective.");
  assert.deepEqual(packet.OperationBrief.ready_task_ids, ["T-1"]);
  assert.deepEqual(packet.OperationBrief.pending_task_ids, ["T-2"]);
  assert.ok(!coordinatorPrompt(packet).includes("raw Worker transcript"));
  const profile = readFileSync(".pi/agents/coordinator.md", "utf8");
  assert.match(profile, /tools: read/);
  assert.match(profile, /extensions: false/);
  assert.match(profile, /skills: false/);
  assert.doesNotMatch(profile, /tools:.*\b(?:bash|write|edit|Agent)\b/);
});

test("pi-subagents 0.19.0 RPC cannot safely resume a completed Coordinator session", () => {
  const source = readFileSync("node_modules/@tintinweb/pi-subagents/dist/index.js", "utf8");
  const start = source.indexOf("const spawnTopLevel =");
  const end = source.indexOf("const resolveAgentRef =", start);
  assert.ok(start > 0 && end > start);
  assert.match(source.slice(start, end), /delete safeOptions\.resumeSessionFile/);
  assert.match(source, /spawn: spawnTopLevel/);
  assert.match(source, /resumeSessionFile: entry\.sessionFile/);
  const manager = readFileSync("node_modules/@tintinweb/pi-subagents/dist/agent-manager.js", "utf8");
  const settle = manager.slice(manager.indexOf("settleRun(record, guardCallback, pool)"), manager.indexOf("abortOwnedChildren(parentId)"));
  assert.match(settle, /this\.runningBackground--/);
  assert.match(settle, /this\.drainQueue\(\)/);
  assert.match(manager, /armQueuedAbort\(id, options\.signal\)/);
  // The package permits an internal @handle resume, but rejects an RPC caller's
  // resumeSessionFile. Fresh turns release the serial slot before a Worker runs.
});

test("malformed or unauthorized CoordinatorDecision fails closed", () => {
  for (const raw of ["not JSON", decision("dispatch", { task: task("UNKNOWN") }), decision("accept_task", { task_id: "UNKNOWN" }), decision("report", { mission_complete: true }), decision("accept_task", { task_id: "T-1", task: task("T-1") }), JSON.stringify({ ...JSON.parse(decision("report")), operation_id: "O-foreign" })]) assert.throws(() => parseCoordinatorDecision(raw, op()));
  const state = coordinatorState(op());
  assert.deepEqual(Object.keys(state).sort(), ["blocker", "decisions", "operation_id", "turns", "version"]);
});

test("Harness rejects Dependency bypass and unverified acceptance", async () => {
  const reports = [];
  for (const proposed of [decision("dispatch", { task: task("T-2") }), decision("accept_task", { task_id: "T-1" }), decision("dispatch", { task: { ...task("T-1"), owner: "research", permission: "write" } })]) {
    let spawns = 0;
    const report = await runOperation(op(), { turn: async () => proposed, dispatch: async () => { spawns++; throw Error("must not execute"); } });
    assert.equal(report.status, "blocked");
    assert.equal(spawns, 0);
    reports.push(report);
  }
  assert.equal(reports[0].commander_action_required, true);
});

test("strategic block escalates, but ordinary retry failure stays operational", async () => {
  const blocked = await runOperation(op(), { turn: async () => decision("block", { blocked_action: "change Mission scope", required_condition: "the Commander approves the scope change", question: "May the Coordinator change the Mission scope?" }) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.escalation.type, "strategic_decision_required");
  assert.match(blocked.blocker, /until the Commander approves/);
});

test("Harness bounds repeated failed TaskOrders without an infinite loop", async () => {
  let spawns = 0;
  const report = await runOperation(createOperation({ operation_id: "O-1", objective: "Retry task.", required_task_ids: ["T-1"] }), {
    turn: async (prompt) => JSON.parse(prompt.slice(prompt.indexOf('{"OperationBrief"'))).OperationBrief.result_available_task_ids.includes("T-1")
      ? decision("reject_task", { task_id: "T-1" }) : decision("dispatch", { task: task("T-1") }),
    dispatch: async () => { spawns++; return { task_id: "T-1", operation_id: "O-1", execution_status: "execution_complete", verification_status: "failed", evidence_refs: [] }; },
  });
  assert.equal(spawns, 2);
  assert.equal(report.status, "blocked");
  assert.match(report.blocker, /retry limit/);
  assert.equal(report.escalation, undefined);
  assert.equal(report.accepted_task_ids.length, 0);
});

function fakePi(entries = []) {
  const tools = new Map(), events = new Map(), lifecycle = new Map(), commands = new Map();
  const pi = { tools, entries, commands,
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { pi.entries.push({ customType, data }); },
    on(name, handler) { lifecycle.set(name, handler); },
    events: {
      on(name, handler) { const set = events.get(name) ?? new Set(); set.add(handler); events.set(name, set); return () => set.delete(handler); },
      emit(name, payload) { for (const handler of [...(events.get(name) ?? [])]) handler(payload); },
    },
  };
  harness(pi);
  pi.sessionStart = (nextEntries) => { pi.entries = nextEntries; lifecycle.get("session_start")({}, { mode: "rpc", sessionManager: { getEntries: () => nextEntries } }); };
  pi.sessionStart(entries);
  return pi;
}
const call = async (pi, tool, input, signal) => JSON.parse((await pi.tools.get(tool).execute("id", input, signal)).content[0].text);

test("a legacy Operation entry migrates to TaskGraph without resetting accepted TaskResults", () => {
  const operation = op();
  const verified = { version: 1, operation_id: "O-1", task_id: "T-1", execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] };
  const previous = { ...operation, accepted_task_ids: ["T-1"], task_results: { "T-1": verified } };
  const pi = fakePi([{ customType: "pi-harness-operation-state", data: { "O-1": previous } }]);
  const snapshot = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].scheduler_status, "accepted");
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-2"].scheduler_status, "ready");
  assert.deepEqual(snapshot.operations["O-1"].accepted_task_ids, ["T-1"]);
  const failed = { ...previous, task_results: { ...previous.task_results, "T-2": { ...verified, task_id: "T-2", verification_status: "failed" } }, rejected_task_ids: ["T-2"] };
  const legacy = fakePi([
    { customType: "pi-harness-operation-state", data: { "O-1": failed } },
    { customType: "pi-harness-coordinator-state", data: { "O-1": { version: 1, operation_id: "O-1", turns: 3, decisions: [], blocker: null, dispatch_counts: { "T-2": 2 } } } },
  ]);
  const migrated = legacy.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.equal(migrated.nodes["T-2"].attempts, 2);
  assert.equal(migrated.nodes["T-2"].scheduler_status, "exhausted");
  assert.equal(Object.hasOwn(legacy.entries.filter((entry) => entry.customType === "pi-harness-coordinator-state").at(-1).data["O-1"], "dispatch_counts"), false);
});

test("goal cancellation aborts the Coordinator turn; an unrelated turn is unaffected", async () => {
  const pi = fakePi();
  const requests = new Map();
  let seq = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = `coordinator-${++seq}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    requests.set(request.prompt, { id, request });
    request.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
  });
  await pi.commands.get("goal").handler("Mission objective.", {});
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1"] });
  const managed = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  const unrelated = executeCoordinatorTurn(pi, "Unrelated OperationBrief", { groupId: "other", timeout: 1000, rpcTimeout: 1000 });
  for (let i = 0; i < 20 && requests.size < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.size, 2);
  await assert.rejects(() => call(pi, "pi_harness_operation", { action: "status", operation_id: "O-1" }), /owns this Operation/);
  await assert.rejects(() => call(pi, "pi_harness_operation", { action: "accept_task", operation_id: "O-1", task_id: "T-1" }), /owns this Operation/);
  await pi.commands.get("goal").handler("cancel", {});
  assert.equal([...requests.values()].find((value) => value.request.prompt.includes("O-1")).request.options.signal.aborted, true);
  const other = [...requests.values()].find((value) => value.request.prompt === "Unrelated OperationBrief");
  assert.equal(other.request.options.signal.aborted, false);
  pi.events.emit("subagents:completed", { id: other.id, status: "completed", result: "unrelated result" });
  assert.equal(await unrelated, "unrelated result");
  assert.equal((await managed).status, "blocked");
  const persisted = pi.entries.filter((entry) => entry.customType === "pi-harness-coordinator-state").at(-1).data["O-1"];
  assert.match(persisted.blocker, /restarts the cancelled run/);
  assert.equal(cancelCoordinateTasks("other"), 0);
});

test("switching sessions aborts the run without writing old Coordinator state into the new session", async () => {
  const pi = fakePi();
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1"] });
  let request;
  pi.events.on("subagents:rpc:spawn", (next) => {
    request = next;
    pi.events.emit(`subagents:rpc:spawn:reply:${next.requestId}`, { success: true, data: { id: "coord" } });
    next.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id: "coord", status: "stopped" }), { once: true });
  });
  const oldRun = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 20 && !request; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(request);
  const newEntries = [];
  pi.sessionStart(newEntries);
  assert.equal(request.options.signal.aborted, true);
  assert.equal((await oldRun).status, "blocked");
  assert.equal(newEntries.length, 0);
  await assert.rejects(() => call(pi, "pi_harness_operation", { action: "status", operation_id: "O-1" }), /Unknown Operation/);
});

test("Scheduler attempt budget survives Coordinator replacement and session restore", async () => {
  const pi = fakePi();
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Inspect report.", required_task_ids: ["T-1"] });
  let stage = 0, counter = 0;
  const steps = [
    decision("dispatch", { task: task("T-1") }), decision("reject_task", { task_id: "T-1" }),
    decision("block", { blocked_action: "choose another report", required_condition: "the Coordinator checks an alternate source" }),
  ];
  const scripted = (instance, decisions) => instance.events.on("subagents:rpc:spawn", (req) => {
    const id = `agent-${++counter}`;
    instance.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => instance.events.emit("subagents:completed", { id, status: "completed", result: req.type === "coordinator" ? decisions[stage++] : "A read-only report." }));
  });
  scripted(pi, steps);
  assert.equal((await call(pi, "pi_harness_run_operation", { operation_id: "O-1" })).status, "blocked");
  let snapshot = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].attempts, 1);
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].scheduler_status, "ready");
  const restored = fakePi(pi.entries);
  stage = 0;
  scripted(restored, [decision("dispatch", { task: task("T-1") }), decision("reject_task", { task_id: "T-1" }), decision("dispatch", { task: task("T-1") })]);
  const report = await call(restored, "pi_harness_run_operation", { operation_id: "O-1" });
  assert.equal(report.status, "blocked");
  assert.match(report.blocker, /retry limit/);
  snapshot = restored.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].attempts, 2);
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].scheduler_status, "exhausted");
});

test("old-session direct TaskResult cannot mutate a new session's TaskGraph", async () => {
  const pi = fakePi();
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Old session.", required_task_ids: ["T-1"] });
  let request;
  pi.events.on("subagents:rpc:spawn", (next) => {
    request = next;
    pi.events.emit(`subagents:rpc:spawn:reply:${next.requestId}`, { success: true, data: { id: "old-worker" } });
    next.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id: "old-worker", status: "stopped" }), { once: true });
  });
  const old = call(pi, "pi_harness_coordinate", { operation_id: "O-1", task_id: "T-1", owner: "research", permission: "read", scope: "Inspect old session.", verification: "Check the result." });
  for (let i = 0; i < 20 && !request; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(request);
  const nextEntries = [];
  pi.sessionStart(nextEntries);
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "New session.", required_task_ids: ["T-1"] });
  await assert.rejects(old, /Old-session TaskResult/);
  const snapshot = nextEntries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.operations["O-1"].objective, "New session.");
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].attempts, 0);
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].scheduler_status, "ready");
});

test("goal cancellation aborts the active managed ExecutionUnit", async () => {
  const pi = fakePi();
  await pi.commands.get("goal").handler("Mission objective.", {});
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Inspect report.", required_task_ids: ["T-1"] });
  let workerSignal;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = request.type === "coordinator" ? "coord-1" : "worker-1";
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: decision("dispatch", { task: { task_id: "T-1", owner: "research", scope: "Inspect report.", permission: "read", verification: "Inspect report." } }) }));
    else { workerSignal = request.options.signal; workerSignal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true }); }
  });
  const pending = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 20 && !workerSignal; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(workerSignal);
  await pi.commands.get("goal").handler("cancel", {});
  assert.equal(workerSignal.aborted, true);
  assert.equal((await pending).status, "blocked");
  const graph = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.equal(graph.nodes["T-1"].scheduler_status, "blocked");
});

test("managed Operation cancellation aborts all claimed wave Tasks and blocks ghost-running nodes", async () => {
  const pi = fakePi();
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Cancel wave.", required_task_ids: ["T-1", "T-2"] });
  const active = [];
  pi.events.on("subagents:rpc:spawn", (req) => {
    const id = `agent-${active.length}-${req.type}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (req.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }) }));
    else {
      active.push(req);
      req.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    }
  });
  const pending = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 40 && active.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(active.length, 2);
  const snapshotBefore = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.deepEqual(Object.values(snapshotBefore.nodes).map((node) => node.scheduler_status), ["running", "running"]);
  await call(pi, "pi_harness_cancel_operation", { operation_id: "O-1" });
  assert.ok(active.every((req) => req.options.signal.aborted));
  assert.equal((await pending).status, "blocked");
  const snapshotAfter = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.deepEqual(Object.values(snapshotAfter.nodes).map((node) => node.scheduler_status), ["blocked", "blocked"]);
});

test("old parallel wave cannot mutate a new session after both children abort", async () => {
  const pi = fakePi();
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Old wave.", required_task_ids: ["T-1", "T-2"] });
  const workers = [];
  pi.events.on("subagents:rpc:spawn", (req) => {
    const id = `old-${workers.length}-${req.type}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (req.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }) }));
    else {
      workers.push({ id, req });
      req.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    }
  });
  const old = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 40 && workers.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(workers.length, 2);
  const freshEntries = [];
  pi.sessionStart(freshEntries);
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "New session.", required_task_ids: ["T-1", "T-2"] });
  assert.ok(workers.every(({ req }) => req.options.signal.aborted));
  assert.equal((await old).status, "blocked");
  const snapshot = freshEntries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.operations["O-1"].objective, "New session.");
  assert.deepEqual(Object.values(snapshot.task_graphs["O-1"].nodes).map((node) => [node.scheduler_status, node.attempts]), [["ready", 0], ["ready", 0]]);
});

test("serial Coordinator turns dispatch through Harness; Commander receives only OperationReport", async () => {
  const pi = fakePi();
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1", "T-2"], dependencies: { "T-2": ["T-1"] }, acceptance_criteria: ["The Coordinator checked the result."] });
  const types = [], prompts = [], order = ["T-1", "T-2"];
  let stage = 0, seq = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    types.push(request.type); prompts.push(request.prompt);
    if (request.type === "research") {
      const graph = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
      const currentTask = types.filter((type) => type === "research").length === 1 ? "T-1" : "T-2";
      assert.equal(graph.nodes[currentTask].scheduler_status, "running", "claim must persist before package spawn");
      assert.equal(graph.nodes[currentTask].attempts, 1);
    }
    const id = `agent-${++seq}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => {
      if (request.type === "coordinator") {
        const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"OperationBrief"')));
        assert.ok(!request.prompt.includes("RAW PRIVATE REPORT"));
        assert.ok(!request.prompt.includes("RAW REVIEWER OUTPUT"));
        const steps = [
          () => decision("dispatch", { task: task("T-1") }),
          () => decision("accept_task", { task_id: "T-1" }),
          () => decision("dispatch", { task: task("T-2") }),
          () => decision("accept_task", { task_id: "T-2" }),
          () => decision("accept_criterion", { criterion: "The Coordinator checked the result.", evidence_refs: [packet.OperationBrief.task_results["T-1"].evidence_refs[0]] }),
        ];
        return pi.events.emit("subagents:completed", { id, status: "completed", result: steps[stage++]() });
      }
      if (request.type === "research") return pi.events.emit("subagents:completed", { id, status: "completed", result: `RAW PRIVATE REPORT ${order.shift()}: The report identifies \`lib/coordinator.mjs\`.` });
      const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"version"')));
      const response = { version: 1, task_id: packet.task_id, status: "verified", summary: "RAW REVIEWER OUTPUT", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status: "passed", finding: "The semantic Verifier checked the selected report.", evidence_refs: [packet.evidence[0].reference] })) };
      pi.events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify(response) });
    });
  });
  const report = await call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.accepted_task_ids, ["T-1", "T-2"]);
  assert.equal(report.commander_action_required, true);
  assert.ok(!JSON.stringify(report).includes("RAW PRIVATE REPORT"));
  assert.ok(!JSON.stringify(report).includes("RAW REVIEWER OUTPUT"));
  assert.deepEqual(types, ["coordinator", "research", "reviewer", "coordinator", "coordinator", "research", "reviewer", "coordinator", "coordinator"]);
  assert.ok(prompts.filter((_, i) => types[i] === "coordinator").every((text) => !text.includes("RAW PRIVATE REPORT")));
  assert.equal(pi.entries.some((entry) => entry.customType === "pi-harness-goal-state"), false);
  const restored = fakePi(pi.entries);
  assert.equal(restored.entries.filter((entry) => entry.customType === "pi-harness-operation-state").at(-1).data["O-1"].status, "complete");
  const snapshot = restored.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.deepEqual(snapshot.operations["O-1"].accepted_task_ids, Object.keys(snapshot.task_graphs["O-1"].nodes).filter((id) => snapshot.task_graphs["O-1"].nodes[id].scheduler_status === "accepted"));
  assert.ok(!JSON.stringify(snapshot.task_graphs).includes("RAW PRIVATE REPORT"));
  assert.ok(!JSON.stringify(snapshot.task_graphs).includes("RAW REVIEWER OUTPUT"));
  await assert.rejects(() => call(restored, "pi_harness_operation", { action: "status", operation_id: "O-1" }), /bounded OperationReport/);
});
