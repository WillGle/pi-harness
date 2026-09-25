import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import harness from "../extensions/pi-harness.ts";
import { createOperation } from "../lib/operation.mjs";
import { parallelTaskLimit, parseCoordinatorDecision, runOperation } from "../lib/operation-runner.mjs";
import { availableSlots, claimTasks, createTaskGraph, dispatchableTaskIds, readyTaskIds, reconcileTaskGraph, runningTaskIds, schedulerSummary } from "../lib/task-graph.mjs";
import { loadSettings, applySettings } from "../node_modules/@tintinweb/pi-subagents/dist/settings.js";
import { AgentManager } from "../node_modules/@tintinweb/pi-subagents/dist/agent-manager.js";

const op = (deps = {}) => createOperation({ operation_id: "O-H", objective: "Check independent tasks.", required_task_ids: ["T-1", "T-2", "T-3"], dependencies: deps });
const task = (task_id) => ({ task_id, owner: "research", scope: `Review ${task_id}.`, permission: "read", verification: "Check report." });
const decision = (action, more = {}) => JSON.stringify({ version: 1, operation_id: "O-H", action, reason: "The selected Tasks are ready.", ...more });
const result = (task_id, verification_status = "verified") => ({ version: 1, operation_id: "O-H", task_id, execution_status: "execution_complete", verification_status, evidence_refs: [`evidence-${task_id}`] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Harness policy and package capacity are bounded independently", () => {
  const saved = process.env.PI_HARNESS_MAX_PARALLEL_TASKS;
  try {
    delete process.env.PI_HARNESS_MAX_PARALLEL_TASKS;
    assert.equal(parallelTaskLimit(), 2);
    for (const [value, limit] of [["1", 1], ["2", 2], ["4", 4]]) assert.equal(parallelTaskLimit(value), limit);
    for (const value of ["", "0", "5", "2.0", " 2", "NaN"]) assert.throws(() => parallelTaskLimit(value));
    process.env.PI_HARNESS_MAX_PARALLEL_TASKS = "5";
    assert.throws(() => harness({}), /PI_HARNESS_MAX_PARALLEL_TASKS/);
  } finally { if (saved === undefined) delete process.env.PI_HARNESS_MAX_PARALLEL_TASKS; else process.env.PI_HARNESS_MAX_PARALLEL_TASKS = saved; }
  assert.deepEqual(JSON.parse(readFileSync(".pi/subagents.json", "utf8")), { maxConcurrent: 4, maxConcurrentForeground: 1, worktreeIsolation: true });
  const manager = new AgentManager(() => {}, 1);
  applySettings(loadSettings(process.cwd()), { setMaxConcurrent: (n) => manager.setMaxConcurrent(n), setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n), setWorktreeIsolation: () => {} });
  assert.equal(manager.getMaxConcurrent(), 4, "installed pi-subagents must apply the project background cap");
  assert.equal(manager.getMaxConcurrentForeground(), 1);
  manager.runningBackground = 3;
  assert.equal(manager.poolHasRoom("background"), true);
  manager.runningBackground = 4;
  assert.equal(manager.poolHasRoom("background"), false);
  manager.dispose();
});

test("TaskGraph readiness is independent of slots; a batch claim is atomic", () => {
  const operation = op({ "T-3": ["T-1", "T-2"] });
  const graph = createTaskGraph(operation);
  assert.deepEqual(readyTaskIds(graph, operation), ["T-1", "T-2"]);
  assert.equal(availableSlots(graph, operation, 1), 1);
  assert.deepEqual(dispatchableTaskIds(graph, operation, 1), ["T-1"]);
  for (const ids of [["T-1", "T-1"], ["T-1", "T-3"], ["T-1", "foreign"]]) assert.throws(() => claimTasks(graph, operation, ids, 2));
  const exhaustedOp = op();
  const base = createTaskGraph(exhaustedOp);
  const exhausted = { ...base, nodes: { ...base.nodes, "T-1": { ...base.nodes["T-1"], scheduler_status: "exhausted", attempts: 2 } } };
  assert.throws(() => claimTasks(exhausted, exhaustedOp, ["T-1", "T-2"], 2));
  assert.throws(() => claimTasks(graph, operation, ["T-1", "T-2"], 1));
  assert.deepEqual(readyTaskIds(graph, operation), ["T-1", "T-2"], "failed claims must not mutate the graph");
  const claimed = claimTasks(graph, operation, ["T-1", "T-2"], 2);
  assert.deepEqual(runningTaskIds(claimed, operation), ["T-1", "T-2"]);
  assert.equal(claimed.nodes["T-1"].attempts, 1);
  assert.equal(claimed.nodes["T-2"].attempts, 1);
  assert.deepEqual(readyTaskIds(claimed, operation), []);
  assert.equal(availableSlots(claimed, operation, 2), 0);
  const independent = op();
  const withReadySibling = claimTasks(createTaskGraph(independent), independent, ["T-1", "T-2"], 3);
  assert.deepEqual(schedulerSummary(withReadySibling, independent, 3).ready_task_ids, ["T-3"]);
  assert.equal(availableSlots(withReadySibling, independent, 3), 1);
  assert.deepEqual(dispatchableTaskIds(withReadySibling, independent, 3), ["T-3"]);
  assert.throws(() => claimTasks(claimed, operation, ["T-1"], 2));
  const restored = reconcileTaskGraph(claimed, operation);
  assert.deepEqual(schedulerSummary(restored, operation).blocked_task_ids, ["T-1", "T-2"]);
  assert.equal(restored.nodes["T-3"].scheduler_status, "pending");
});

test("Coordinator validates all batch members before any Task starts", async () => {
  const operation = op({ "T-3": ["T-1"] });
  for (const tasks of [[task("T-1")], [task("T-1"), task("T-1")], [task("T-1"), task("T-3")], [task("T-1"), task("foreign")]]) {
    let starts = 0;
    const report = await runOperation(operation, { turn: async () => decision("dispatch_batch", { tasks }), dispatch: async () => { starts++; return result("T-1"); } });
    assert.equal(report.status, "blocked");
    assert.equal(starts, 0);
  }
  assert.throws(() => parseCoordinatorDecision(decision("dispatch_batch", { tasks: [task("T-1")] }), operation));
  assert.throws(() => parseCoordinatorDecision(decision("dispatch_batch", { tasks: [task("T-1"), task("T-1")] }), operation));
  let starts = 0;
  const serial = await runOperation(op(), { turn: async () => decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }), dispatch: async () => { starts++; } }, { parallelLimit: 1 });
  assert.equal(serial.status, "blocked");
  assert.equal(starts, 0);
});

test("independent Task pipelines overlap; each completion persists before the sibling ends", async () => {
  const operation = op();
  const pending = new Map(), snapshots = [];
  let orderedResults;
  let turns = 0;
  const run = runOperation(operation, {
    turn: async (prompt) => {
      turns++;
      const brief = JSON.parse(prompt.slice(prompt.indexOf('{"OperationBrief"'))).OperationBrief;
      if (turns === 1) {
        assert.equal(brief.parallel_limit, 2);
        assert.equal(brief.available_slots, 2);
        return decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] });
      }
      if (brief.result_available_task_ids.includes("T-1") && !brief.accepted_task_ids.includes("T-1")) {
        orderedResults = Object.keys(brief.task_results);
        return decision("accept_task", { task_id: "T-1" });
      }
      if (brief.result_available_task_ids.includes("T-2") && !brief.accepted_task_ids.includes("T-2")) return decision("accept_task", { task_id: "T-2" });
      return decision("dispatch", { task: task("T-3") });
    },
    dispatch: (selected) => {
      if (selected.task_id !== "T-3") assert.deepEqual(snapshots.at(-1).running, ["T-1", "T-2"], "the batch claim must persist before either child starts");
      const hold = deferred(); pending.set(selected.task_id, hold);
      if (selected.task_id === "T-3") hold.resolve(result("T-3"));
      return hold.promise;
    },
    save: (nextOperation, state, graph) => snapshots.push({ results: Object.keys(nextOperation.task_results), running: runningTaskIds(graph, nextOperation), available: schedulerSummary(graph, nextOperation).available_slots, turns: state.turns }),
  });
  await tick();
  assert.deepEqual([...pending.keys()], ["T-1", "T-2"], "both Task pipelines must start before either finishes");
  assert.deepEqual(snapshots.find((snap) => snap.running.length === 2).running, ["T-1", "T-2"]);
  assert.equal(turns, 1, "the Coordinator must not run during the wave");
  pending.get("T-2").resolve(result("T-2"));
  await tick();
  assert.ok(snapshots.some((snap) => snap.results.join() === "T-2" && snap.running.join() === "T-1"));
  assert.equal(turns, 1);
  pending.get("T-1").resolve(result("T-1"));
  const report = await run;
  assert.equal(report.status, "blocked", "T-3 still requires explicit acceptance; the Coordinator turn limit bounds this fixture");
  assert.deepEqual(report.accepted_task_ids, ["T-1", "T-2"]);
  assert.deepEqual(orderedResults, ["T-1", "T-2"], "OperationBrief order follows required IDs, not completion order");
  assert.ok(snapshots.some((snap) => snap.results.join() === "T-1,T-2"), "persisted TaskResults follow required IDs");
  assert.equal(snapshots.at(-1).running.length, 0);
});

test("one failed pipeline blocks only its Task; a successful sibling keeps its result", async () => {
  const operation = op();
  let final;
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }),
    dispatch: async ({ task_id }) => task_id === "T-1" ? result(task_id) : Promise.reject(Error("unknown child outcome")),
    save: (nextOperation, _state, graph) => { final = { operation: nextOperation, graph }; },
  });
  assert.equal(report.status, "blocked");
  assert.equal(final.graph.nodes["T-1"].scheduler_status, "result_available");
  assert.equal(final.graph.nodes["T-2"].scheduler_status, "blocked");
  assert.equal(final.operation.task_results["T-1"].task_id, "T-1");
  assert.equal(final.graph.nodes["T-3"].scheduler_status, "ready");
  assert.equal(final.graph.nodes["T-2"].attempts, 1);
});

test("a failed criterion retries only its own Task after the sibling is accepted", async () => {
  const operation = op();
  let last, attempts = { "T-1": 0, "T-2": 0 };
  const run = await runOperation(operation, {
    turn: async (prompt) => {
      const brief = JSON.parse(prompt.slice(prompt.indexOf('{"OperationBrief"'))).OperationBrief;
      if (!brief.task_results["T-1"]) return decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] });
      if (!brief.rejected_task_ids.includes("T-1") && brief.task_results["T-1"].verification_status === "failed") return decision("reject_task", { task_id: "T-1" });
      if (!brief.accepted_task_ids.includes("T-2")) return decision("accept_task", { task_id: "T-2" });
      if (brief.ready_task_ids.includes("T-1")) return decision("dispatch", { task: task("T-1") });
      return decision("report");
    },
    dispatch: async ({ task_id }) => { attempts[task_id]++; return result(task_id, task_id === "T-1" && attempts[task_id] === 1 ? "failed" : "verified"); },
    save: (nextOperation, _state, graph) => { last = { operation: nextOperation, graph }; },
  });
  assert.equal(run.status, "blocked");
  assert.deepEqual(attempts, { "T-1": 2, "T-2": 1 });
  assert.equal(last.graph.nodes["T-1"].attempts, 2);
  assert.equal(last.graph.nodes["T-1"].scheduler_status, "result_available");
  assert.equal(last.graph.nodes["T-2"].scheduler_status, "accepted");
});

test("a failed atomic claim persistence starts no Task", async () => {
  let starts = 0, saves = 0;
  const report = await runOperation(op(), {
    turn: async () => decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }),
    dispatch: async () => { starts++; },
    save: () => { if (++saves === 1) throw Error("store unavailable"); },
  });
  assert.equal(starts, 0);
  assert.equal(report.status, "blocked");
});

test("cancellation stops the wave and leaves no running node", async () => {
  const controller = new AbortController(), tasks = new Map();
  let last;
  const run = runOperation(op(), {
    turn: async () => decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }),
    dispatch: ({ task_id }) => { const hold = deferred(); tasks.set(task_id, hold); controller.signal.addEventListener("abort", () => hold.reject(Error("cancelled")), { once: true }); return hold.promise; },
    save: (_operation, _state, graph) => { last = graph; },
  }, { signal: controller.signal });
  await tick(); assert.deepEqual([...tasks.keys()], ["T-1", "T-2"]);
  controller.abort();
  assert.equal((await run).status, "blocked");
  assert.deepEqual(Object.values(last.nodes).filter((node) => node.scheduler_status === "running"), []);
  assert.equal(last.nodes["T-1"].scheduler_status, "blocked");
  assert.equal(last.nodes["T-2"].scheduler_status, "blocked");
});
