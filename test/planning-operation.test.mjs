import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOperation, materializeOperation } from "../lib/operation.mjs";
import { createTaskGraph, dispatchableTaskIds } from "../lib/task-graph.mjs";
import { coordinatorPrompt, operationBrief, parseCoordinatorDecision, runOperation } from "../lib/operation-runner.mjs";

const proposal = {
  local_ref: "implement",
  role: "worker",
  scope: "Implement the requested change and preserve the Harness boundaries.",
  dependencies: [],
  acceptance_criteria: ["The requested change is implemented."],
  execution_policy_id: "worker-write",
};
const decision = (action, fields = {}) => JSON.stringify({ version: 1, operation_id: "O-plan", action, reason: "Use the bounded plan.", ...fields });

test("planning Operation has no Commander Task identities and has no dispatchable TaskOrder", () => {
  const operation = createOperation({ operation_id: "O-plan", objective: "Implement safely.", planning: true, allowed_policy_ids: ["worker-write"] });
  assert.equal(Object.hasOwn(operation, "required_task_ids"), false);
  assert.deepEqual(createTaskGraph(operation).nodes, {});
  assert.deepEqual(dispatchableTaskIds(createTaskGraph(operation), operation, 2), []);
  assert.throws(() => createOperation({ operation_id: "O-bad", objective: "Implement safely.", planning: true, allowed_policy_ids: ["worker-write"], required_task_ids: ["Commander-task"] }), /cannot contain Commander Task identities/);
});

test("Harness materializes only bounded semantic proposals with trusted policy authority", () => {
  const operation = createOperation({ operation_id: "O-plan", objective: "Implement safely.", planning: true, allowed_policy_ids: ["worker-write"] });
  const materialized = materializeOperation(operation, [proposal]);
  assert.deepEqual(materialized.operation.required_task_ids, ["T-O-plan-01"]);
  assert.equal(materialized.operation.task_specs["T-O-plan-01"].permission, "write");
  assert.equal(materialized.operation.task_specs["T-O-plan-01"].verification, "git diff --check");
  assert.deepEqual(dispatchableTaskIds(materialized.graph, materialized.operation, 2), ["T-O-plan-01"]);
  assert.throws(() => materializeOperation(operation, [{ ...proposal, permission: "write" }]), /unauthorized Task fields/);
  assert.throws(() => materializeOperation(operation, [{ ...proposal, execution_policy_id: "arbitrary-shell" }]), /unauthorized execution policy/);
});

test("planning Coordinator instructions require semantic proposals, not pre-existing Task IDs", () => {
  const operation = createOperation({ operation_id: "O-plan", objective: "Implement safely.", planning: true, allowed_policy_ids: ["worker-write"] });
  const prompt = coordinatorPrompt(operationBrief(operation, { version: 1, operation_id: "O-plan", turns: 0, decisions: [], blocker: null }));
  const profile = readFileSync(new URL("../.pi/agents/coordinator.md", import.meta.url), "utf8");
  assert.match(prompt, /planning Operation\. Return action "plan_tasks"/);
  assert.match(prompt, /top-level "tasks" array, never "proposals"/);
  assert.match(prompt, /Allowed policy-to-role mapping: \{"worker-write":"worker"\}/);
  assert.match(profile, /No TaskOrder ID or registered TaskSpec exists yet/);
  assert.match(profile, /Put semantic proposals in the top-level `tasks` array, never `proposals`/);
  assert.match(profile, /Set `role` to exactly `scout`, `research`, or `worker`/);
  assert.match(profile, /Do not use or require Task IDs, TaskSpecs, permissions, verification commands/);
  assert.match(profile, /If `OperationBrief\.planning` is false, use only registered Task IDs/);
  assert.match(profile, /Every `required_task_ids` value in the OperationBrief already has a Harness-registered TaskSpec/);
  assert.match(profile, /Do not request TaskSpec registration and do not block for a missing TaskSpec/);
});

test("CoordinatorDecision rejects fenced JSON while preserving valid planning semantics", () => {
  const operation = createOperation({ operation_id: "O-plan", objective: "Implement safely.", planning: true, allowed_policy_ids: ["worker-write"] });
  const valid = decision("plan_tasks", { tasks: [proposal] });
  assert.equal(parseCoordinatorDecision(valid, operation).action, "plan_tasks");
  assert.throws(() => parseCoordinatorDecision(`\`\`\`json\n${valid}\n\`\`\``, operation), /malformed JSON/);
  assert.throws(() => parseCoordinatorDecision(decision("plan_tasks", { tasks: [{ ...proposal, permission: "write" }] }), operation), /unauthorized Task fields/);
  assert.throws(() => parseCoordinatorDecision(decision("plan_tasks", { tasks: [{ ...proposal, role: "Implement the add function and tests" }] }), operation), /role must be exactly scout, research, or worker/);
  assert.throws(() => parseCoordinatorDecision(JSON.stringify({ ...JSON.parse(valid), proposals: proposal }), operation), /invalid or belongs to a foreign Operation/);
});

test("Coordinator plan_tasks materializes before a managed TaskOrder dispatches", async () => {
  const operation = createOperation({ operation_id: "O-plan", objective: "Implement safely.", planning: true, allowed_policy_ids: ["worker-write"] });
  assert.equal(parseCoordinatorDecision(decision("plan_tasks", { tasks: [proposal] }), operation).action, "plan_tasks");
  let step = 0, dispatched;
  const report = await runOperation(operation, {
    turn: async () => [
      decision("plan_tasks", { tasks: [proposal] }),
      decision("dispatch", { task_id: "T-O-plan-01" }),
      decision("accept_task", { task_id: "T-O-plan-01" }),
    ][step++],
    dispatch: async (task) => {
      dispatched = task;
      return { version: 1, operation_id: "O-plan", task_id: task.task_id, execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] };
    },
  });
  assert.equal(dispatched.task_id, "T-O-plan-01");
  assert.equal(dispatched.verification, "git diff --check");
  assert.equal(report.status, "complete");
  assert.deepEqual(report.accepted_task_ids, ["T-O-plan-01"]);
});
