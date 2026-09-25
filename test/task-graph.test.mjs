import test from "node:test";
import assert from "node:assert/strict";
import { createOperation, recordTaskResult, acceptTaskResult, rejectTaskResult, acceptOperationCriterion } from "../lib/operation.mjs";
import { createTaskGraph, validateTaskGraph, readyTaskIds, claimTask, recordTaskGraphResult, acceptGraphTask, rejectGraphTask, blockGraphTask, rollbackSpawnFailure, reconcileTaskGraph, migrateTaskGraph, schedulerSummary } from "../lib/task-graph.mjs";

const operation = (dependencies = { "T-2": ["T-1"], "T-3": ["T-1"], "T-4": ["T-2", "T-3"] }) => createOperation({ operation_id: "O", objective: "Inspect the reports.", required_task_ids: ["T-1", "T-2", "T-3", "T-4"], dependencies, acceptance_criteria: ["The Coordinator checked the results."] });
const result = (id, verification_status = "verified") => ({ version: 1, operation_id: "O", task_id: id, execution_status: "execution_complete", verification_status, evidence_refs: [] });
const status = (graph, id) => graph.nodes[id].scheduler_status;

test("TaskGraph validates DAG including self, two-node and longer cycles", () => {
  assert.deepEqual(readyTaskIds(createTaskGraph(operation()), operation()), ["T-1"]);
  for (const deps of [{ "T-1": ["T-1"] }, { "T-1": ["T-2"], "T-2": ["T-1"] }, { "T-1": ["T-2"], "T-2": ["T-3"], "T-3": ["T-1"] }, { "T-2": ["missing"] }, { "T-2": ["T-1", "T-1"] }]) assert.throws(() => operation(deps));
  assert.throws(() => createOperation({ operation_id: "O", objective: "No duplicates.", required_task_ids: ["T-1", "T-1"] }));
});

test("Scheduler claims only ready TaskOrders, records results and atomically accepts Dependencies", () => {
  let op = operation(), graph = createTaskGraph(op);
  assert.equal(status(graph, "T-1"), "ready");
  assert.equal(status(graph, "T-2"), "pending");
  assert.throws(() => claimTask(graph, op, "T-2"), /ready set/);
  graph = claimTask(graph, op, "T-1");
  assert.equal(status(graph, "T-1"), "running");
  assert.equal(graph.nodes["T-1"].attempts, 1);
  assert.throws(() => claimTask(graph, op, "T-1"), /ready set/);
  assert.throws(() => recordTaskGraphResult(graph, op, "T-1"), /recorded TaskResult/);
  op = recordTaskResult(op, result("T-1"));
  graph = recordTaskGraphResult(graph, op, "T-1");
  assert.equal(status(graph, "T-1"), "result_available");
  const accepted = acceptTaskResult(op, "T-1");
  assert.throws(() => validateTaskGraph(graph, accepted), /differs/);
  graph = acceptGraphTask(graph, op, accepted, "T-1"); op = accepted;
  assert.deepEqual(readyTaskIds(graph, op), ["T-2", "T-3"]);
  assert.deepEqual(readyTaskIds(claimTask(graph, op, "T-2"), op), [], "serial Scheduler does not dispatch T-3 while T-2 is running");
  assert.equal(status(graph, "T-4"), "pending");
  assert.deepEqual(op.accepted_task_ids, Object.keys(graph.nodes).filter((id) => status(graph, id) === "accepted"));
  graph = recordTaskGraphResult(claimTask(graph, op, "T-2"), recordTaskResult(op, result("T-2")), "T-2");
  const nextOp = recordTaskResult(op, result("T-2"));
  graph = acceptGraphTask(graph, nextOp, acceptTaskResult(nextOp, "T-2"), "T-2");
  assert.equal(status(graph, "T-4"), "pending", "one accepted Dependency does not unblock T-4");
});

test("unverified TaskResult cannot be accepted; rejection retries twice then exhausts", () => {
  let op = operation(), graph = createTaskGraph(op);
  for (let attempt = 1; attempt <= 2; attempt++) {
    graph = claimTask(graph, op, "T-1");
    op = recordTaskResult(op, result("T-1", "failed"));
    graph = recordTaskGraphResult(graph, op, "T-1");
    assert.throws(() => acceptTaskResult(op, "T-1"), /verified TaskResult/);
    op = rejectTaskResult(op, "T-1");
    graph = rejectGraphTask(graph, op, "T-1");
    assert.equal(graph.nodes["T-1"].attempts, attempt);
    assert.equal(status(graph, "T-1"), attempt === 1 ? "ready" : "exhausted");
  }
  assert.deepEqual(readyTaskIds(graph, op), []);
  assert.throws(() => claimTask(graph, op, "T-1"), /ready set/);
  const summary = schedulerSummary(graph, op);
  assert.deepEqual(summary.exhausted_task_ids, ["T-1"]);
  assert.deepEqual(summary.pending_task_ids, ["T-2", "T-3", "T-4"]);
  assert.doesNotMatch(JSON.stringify(graph), /verification_status|evidence_refs|Worker|Reviewer|stdout|diff/);
});

test("TaskGraph accepted set agrees after every atomic transition; criteria and Mission stay separate", () => {
  let op = operation(), graph = createTaskGraph(op);
  for (const id of op.required_task_ids) {
    graph = claimTask(graph, op, id);
    const recorded = recordTaskResult(op, result(id));
    const available = recordTaskGraphResult(graph, recorded, id);
    assert.throws(() => validateTaskGraph(available, acceptTaskResult(recorded, id)), /differs/);
    const next = acceptTaskResult(recorded, id);
    graph = acceptGraphTask(available, recorded, next, id); op = next;
    assert.deepEqual(Object.keys(graph.nodes).filter((taskId) => graph.nodes[taskId].scheduler_status === "accepted"), op.accepted_task_ids);
  }
  assert.equal(op.status, "open", "Scheduler acceptance cannot accept the Operation criterion");
  assert.throws(() => acceptOperationCriterion(op, "The Coordinator checked the results.", []), /Evidence/);
  assert.equal(Object.hasOwn(op, "mission_complete"), false);
});

test("spawn rollback, explicit Blocker, restore reconciliation and Operation criteria", () => {
  let op = operation(), graph = createTaskGraph(op);
  graph = claimTask(graph, op, "T-1");
  graph = rollbackSpawnFailure(graph, op, "T-1");
  assert.equal(graph.nodes["T-1"].attempts, 0);
  assert.equal(status(graph, "T-1"), "ready");
  graph = reconcileTaskGraph(claimTask(graph, op, "T-1"), op);
  assert.equal(status(graph, "T-1"), "blocked");
  assert.deepEqual(graph.nodes["T-1"].blocker, { task_id: "T-1", blocked_action: "resume an interrupted TaskOrder", required_condition: "the Commander replans after the child outcome is checked" });
  assert.deepEqual(readyTaskIds(graph, op), []);
  assert.throws(() => claimTask(graph, op, "T-1"));
  assert.throws(() => blockGraphTask(graph, op, "T-1", "run", "approval"));
  const migrated = migrateTaskGraph(op);
  assert.equal(status(migrated, "T-1"), "ready");
  assert.throws(() => acceptOperationCriterion(op, "The Coordinator checked the results.", []), /Evidence/);
  assert.equal(op.status, "open");
});
