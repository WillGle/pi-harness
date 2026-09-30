import test from "node:test";
import assert from "node:assert/strict";
import { reconcileAttemptLedger, validateAttemptLedger } from "../lib/attempt-ledger.mjs";
import { attachOperation, createMission, missionIsClosable, missionSituationBoard, validateMissionOwnership } from "../lib/mission.mjs";
import { createOperation, recordTaskResult, terminalizeOperation } from "../lib/operation.mjs";
import { acceptGraphTask, claimTask, createTaskGraph, recordTaskGraphResult, reconcileTaskGraph, supersedeGraphTask, waiveGraphTask } from "../lib/task-graph.mjs";

function fixture() {
  const operation = createOperation({ operation_id: "O-1", mission_id: "M-1", objective: "Inspect the source.", required_task_ids: ["T-1", "T-2"], dependencies: { "T-2": ["T-1"] }, task_intents: { "T-1": "Inspect Mission closure.", "T-2": "Inspect the dependent closure path." }, task_specs: { "T-1": { owner: "research", permission: "read", verification: "Inspect the Mission closure source.", acceptance_criteria: ["The report identifies the closure rule."] }, "T-2": { owner: "research", permission: "read", verification: "Inspect the dependent closure source.", acceptance_criteria: ["The report identifies the dependent rule."] } } });
  const missions = { "M-1": createMission({ mission_id: "M-1", objective: "Keep obligations accountable.", operation_ids: ["O-1"] }) };
  return { missions, operations: { "O-1": operation }, taskGraphs: { "O-1": createTaskGraph(operation) } };
}

test("Mission ownership rejects an unowned Operation and keeps unresolved Tasks on the Situation Board", () => {
  const state = fixture();
  validateMissionOwnership(state.missions, state.operations, state.taskGraphs);
  assert.throws(() => validateMissionOwnership({}, state.operations, state.taskGraphs), /owning Mission/);
  assert.equal(missionIsClosable(state.missions["M-1"], state.operations, state.taskGraphs), false);
  const board = missionSituationBoard(state.missions, state.operations, state.taskGraphs);
  assert.match(board, /Mission M-1/);
  assert.match(board, /TaskOrder T-1: ready/);
  assert.match(board, /TaskOrder T-2: pending/);
  assert.match(board, /Intent: Inspect Mission closure/);
  assert.match(board, /Dependencies: T-1/);
  assert.match(board, /Acceptance Criteria: The report identifies the closure rule/);
  assert.doesNotMatch(board, /Evidence|stdout|transcript/);
});

test("Mission closure requires a terminal Operation disposition", () => {
  const planning = createOperation({ operation_id: "O-plan", mission_id: "M-plan", objective: "Plan safely.", planning: true, allowed_policy_ids: ["research-read"] });
  const planningMission = createMission({ mission_id: "M-plan", objective: "Plan safely.", operation_ids: ["O-plan"] });
  assert.equal(missionIsClosable(planningMission, { "O-plan": planning }, { "O-plan": createTaskGraph(planning) }), false, "a planning Operation has no terminal disposition");

  const state = fixture();
  let graph = waiveGraphTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1", { authority_type: "commander", reason: "The requirement is removed." });
  graph = waiveGraphTask(graph, state.operations["O-1"], "T-2", { authority_type: "commander", reason: "The requirement is removed." });
  assert.equal(missionIsClosable(state.missions["M-1"], state.operations, { ...state.taskGraphs, "O-1": graph }), false, "resolved TaskOrders do not terminalize an open Operation");
  state.operations["O-1"] = terminalizeOperation(state.operations["O-1"], graph, { status: "waived", authority_type: "commander", reason: "All remaining TaskOrders are waived." });
  assert.equal(missionIsClosable(state.missions["M-1"], state.operations, { ...state.taskGraphs, "O-1": graph }), false, "a waived Operation is terminal but does not satisfy successful Mission completion");
});

test("Mission completion rejects unresolved obligations and Task IDs with multiple Operation owners", () => {
  const state = fixture();
  assert.throws(() => validateMissionOwnership({ "M-1": createMission({ mission_id: "M-1", objective: "Keep obligations accountable.", status: "complete", operation_ids: ["O-1"] }) }, state.operations, state.taskGraphs), /Complete Mission has unresolved/);
  const duplicate = createOperation({ operation_id: "O-2", mission_id: "M-1", objective: "Reuse an owned Task ID.", required_task_ids: ["T-1"] });
  state.operations["O-2"] = duplicate;
  state.taskGraphs["O-2"] = createTaskGraph(duplicate);
  state.missions = attachOperation(state.missions, "M-1", "O-2");
  assert.throws(() => validateMissionOwnership(state.missions, state.operations, state.taskGraphs), /multiple owning Operations/);
});

test("Attempt Ledger records a claimed Attempt before completion and retains terminal accounting", () => {
  const state = fixture();
  state.taskGraphs["O-1"] = claimTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1");
  let ledger = reconcileAttemptLedger({}, state.operations, state.taskGraphs);
  assert.deepEqual(ledger["A-O-1-T-1-01"], { version: 1, attempt_id: "A-O-1-T-1-01", mission_id: "M-1", operation_id: "O-1", task_id: "T-1", ordinal: 1, status: "running" });
  const result = { version: 1, operation_id: "O-1", task_id: "T-1", execution_status: "execution_complete", verification_status: "verified", evidence_refs: ["evidence://project/opaque"] };
  state.operations["O-1"] = recordTaskResult(state.operations["O-1"], result);
  state.taskGraphs["O-1"] = recordTaskGraphResult(state.taskGraphs["O-1"], state.operations["O-1"], "T-1");
  ledger = reconcileAttemptLedger(ledger, state.operations, state.taskGraphs);
  assert.equal(ledger["A-O-1-T-1-01"].status, "execution_complete");
  assert.deepEqual(ledger["A-O-1-T-1-01"].evidence_refs, ["evidence://project/opaque"]);
  assert.throws(() => validateAttemptLedger({ ...ledger, bad: { ...ledger["A-O-1-T-1-01"], attempt_id: "bad", task_id: "T-other" } }, state.operations, state.taskGraphs), /owning TaskOrder/);
});

test("Attempt Ledger preserves an unknown child outcome when failure provenance has a code", () => {
  const state = fixture();
  state.taskGraphs["O-1"] = claimTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1");
  state.taskGraphs["O-1"] = reconcileTaskGraph(state.taskGraphs["O-1"], state.operations["O-1"]);
  const ledger = reconcileAttemptLedger({}, state.operations, state.taskGraphs);
  assert.equal(state.taskGraphs["O-1"].nodes["T-1"].blocker.failure_code, "HARNESS_SESSION_INTERRUPTED");
  assert.equal(ledger["A-O-1-T-1-01"].status, "unknown");
  const superseded = supersedeGraphTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1", { authority_type: "commander", reason: "A replacement TaskOrder is registered.", replacement_mission_id: "M-1", replacement_operation_id: "O-replacement", replacement_task_id: "T-replacement" });
  const preserved = reconcileAttemptLedger(ledger, state.operations, { ...state.taskGraphs, "O-1": superseded });
  assert.equal(preserved["A-O-1-T-1-01"].status, "unknown", "Task supersession cannot rewrite an Attempt outcome");
  assert.equal(preserved["A-O-1-T-1-01"].failure_code, "HARNESS_SESSION_INTERRUPTED");
  assert.equal(missionIsClosable(state.missions["M-1"], state.operations, state.taskGraphs, ledger), false);
  let resolvedGraph = waiveGraphTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1", { authority_type: "commander", reason: "The obligation is waived while its child outcome remains unknown." });
  resolvedGraph = waiveGraphTask(resolvedGraph, state.operations["O-1"], "T-2", { authority_type: "commander", reason: "The remaining obligation is waived." });
  state.operations["O-1"] = terminalizeOperation(state.operations["O-1"], resolvedGraph, { status: "waived", authority_type: "commander", reason: "The remaining TaskOrders are waived." });
  assert.equal(missionIsClosable(state.missions["M-1"], state.operations, { ...state.taskGraphs, "O-1": resolvedGraph }, preserved), false, "an unresolved child outcome cannot be hidden by a Task waiver");
  const board = missionSituationBoard(state.missions, state.operations, state.taskGraphs, ledger);
  assert.match(board, /Unresolved Attempt A-O-1-T-1-01 for TaskOrder T-1: unknown/);
});

test("Situation Board retains unresolved obligations from a blocked Mission", () => {
  const state = fixture();
  state.missions["M-1"] = createMission({ ...state.missions["M-1"], status: "blocked" });
  const board = missionSituationBoard(state.missions, state.operations, state.taskGraphs);
  assert.match(board, /Mission M-1\nStatus: blocked\./);
  assert.match(board, /TaskOrder T-1: ready/);
});

test("Mission Constraints are bounded, durable, and visible on the Situation Board", () => {
  const mission = createMission({ mission_id: "M-constraints", objective: "Preserve behavior.", constraints: ["Keep the public API stable.", "Do not add dependencies."] });
  const board = missionSituationBoard({ [mission.mission_id]: mission }, {}, {});
  assert.deepEqual(mission.constraints, ["Keep the public API stable.", "Do not add dependencies."]);
  assert.match(board, /Constraint: Keep the public API stable\./);
  assert.match(board, /Constraint: Do not add dependencies\./);
  assert.throws(() => createMission({ mission_id: "M-bad", objective: "Reject oversized constraints.", constraints: ["x".repeat(501)] }), /Mission state is invalid/);
  assert.throws(() => createMission({ mission_id: "M-bad", objective: "Reject duplicate constraints.", constraints: ["Preserve behavior.", "Preserve behavior."] }), /Mission state is invalid/);
});

test("Situation Board keeps planning and materialized Operations distinct", () => {
  const mission = createMission({ mission_id: "M-plan-board", objective: "Materialize semantic Tasks safely.", operation_ids: ["O-plan-board"] });
  const operation = createOperation({ operation_id: "O-plan-board", mission_id: mission.mission_id, objective: "Plan source inspection.", allowed_policy_ids: ["research-read"], planning: true });
  const graph = createTaskGraph(operation);
  const board = missionSituationBoard({ [mission.mission_id]: mission }, { [operation.operation_id]: operation }, { [operation.operation_id]: graph });
  assert.match(board, /Operation O-plan-board: open/);
  assert.match(board, /awaiting semantic Task proposals; no Task IDs are materialized/);
  assert.doesNotMatch(board, /TaskOrder/);
});

test("Situation Board bounds the total Mission, Operation, and Task projection", () => {
  const missions = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const mission_id = `M-${String(index).padStart(2, "0")}`;
    return [mission_id, createMission({ mission_id, objective: "Retain bounded control state." })];
  }));
  const board = missionSituationBoard(missions, {}, {}, {});
  assert.equal([...board.matchAll(/^Mission /gm)].length, 8);
  assert.match(board, /32 additional Missions omitted/);

  const mission = createMission({ mission_id: "M-tasks", objective: "Retain unresolved Task obligations.", operation_ids: ["O-1", "O-2"] });
  const operations = {}, graphs = {};
  for (const operation_id of mission.operation_ids) {
    const required_task_ids = Array.from({ length: 20 }, (_, index) => `${operation_id}-T-${String(index + 1).padStart(2, "0")}`);
    operations[operation_id] = createOperation({ operation_id, mission_id: mission.mission_id, objective: "Retain bounded Task obligations.", required_task_ids });
    graphs[operation_id] = createTaskGraph(operations[operation_id]);
  }
  const taskBoard = missionSituationBoard({ [mission.mission_id]: mission }, operations, graphs, {});
  assert.equal([...taskBoard.matchAll(/^TaskOrder /gm)].length, 32);
  assert.match(taskBoard, /8 additional unresolved TaskOrders omitted/);
});

test("Situation Board enforces a character bound for oversized restored identifiers", () => {
  const mission_id = `M-${"x".repeat(30_000)}`;
  const mission = createMission({ mission_id, objective: "Retain a bounded projection." });
  const board = missionSituationBoard({ [mission_id]: mission }, {}, {});
  assert.ok(board.length <= 24_000);
  assert.match(board, /truncated; remaining obligations stay in durable Mission state/);
});

test("supersession needs persisted replacement lineage and waiver is a terminal non-acceptance disposition", () => {
  const state = fixture();
  const replacement = createOperation({ operation_id: "O-2", mission_id: "M-1", objective: "Replace blocked work.", required_task_ids: ["T-3"] });
  state.operations["O-2"] = replacement;
  state.taskGraphs["O-2"] = createTaskGraph(replacement);
  state.missions = attachOperation(state.missions, "M-1", "O-2");
  const superseded = supersedeGraphTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1", { authority_type: "commander", reason: "Replacement TaskOrder is registered.", replacement_mission_id: "M-1", replacement_operation_id: "O-2", replacement_task_id: "T-3" });
  assert.equal(superseded.nodes["T-1"].scheduler_status, "superseded");
  assert.equal(superseded.nodes["T-1"].disposition.replacement_task_id, "T-3");
  assert.equal(superseded.nodes["T-1"].disposition.authority_type, "commander");
  assert.match(superseded.nodes["T-1"].disposition.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  const waived = waiveGraphTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1", { authority_type: "commander", reason: "Requirement removed." });
  assert.equal(waived.nodes["T-1"].scheduler_status, "waived");
  assert.throws(() => waiveGraphTask(state.taskGraphs["O-1"], state.operations["O-1"], "T-1", { authority_type: "worker", reason: "A Worker cannot waive a TaskOrder." }), /invalid Task disposition/);
  assert.equal(missionIsClosable(state.missions["M-1"], state.operations, { ...state.taskGraphs, "O-1": superseded }), false, "the replacement TaskOrder is unresolved");
});
