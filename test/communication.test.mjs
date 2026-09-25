import test from "node:test";
import assert from "node:assert/strict";
import { EXECUTION_STATUSES, VERIFICATION_STATUSES, formatTaskOrder, promoteTaskResult, taskOrder, taskResult } from "../lib/communication.mjs";

test("TaskOrder retains actor, condition, Constraint, Acceptance Criterion and identifiers", () => {
  const condition = "If verification passes, the Coordinator may accept the TaskResult.";
  const order = taskOrder({ task_id: "T-104", owner: "worker", permission: "write", scope: "Change `lib/coordinator.mjs` only if the gate runs.", verification: "npm test", constraints: [condition], acceptance_criteria: ["The Worker must not modify `lib/state.mjs`."] });
  const prompt = formatTaskOrder(order);
  for (const text of ["TaskOrder T-104", "The Worker must implement", condition, "`lib/coordinator.mjs`", "`lib/state.mjs`", "Constraint:", "Acceptance Criterion:", "Execution Status: assigned"]) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /Verification passed\. Accept TaskResult/);
});

test("terminal execution and a gate alone cannot verify or complete a TaskResult", () => {
  const order = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write" });
  const record = { status: "completed", gatePassed: true, verificationRan: true, result: "Verified!", gateEvidence: "raw\nstdout", diff: "raw\ndiff", branch: "feature/x", changedPaths: ["lib/state.mjs"] };
  const result = taskResult(order, record);
  assert.equal(result.version, 1);
  assert.equal(result.execution_status, "execution_complete");
  assert.equal(result.verification_status, "failed");
  assert.deepEqual(result.changed_paths, ["lib/state.mjs"]);
  assert.equal(result.summary.includes("Verified!"), false);
  assert.deepEqual(promoteTaskResult({ ...record, taskResult: result }), result);
  assert.equal(JSON.stringify(result).includes("raw"), false);
  assert.equal(record.gateEvidence, "raw\nstdout");
  assert.equal(record.diff, "raw\ndiff");
  assert.equal(taskResult(order, { status: "completed", verificationRan: true, gatePassed: false }).verification_status, "failed");
});

test("the Harness Verifier, not Worker prose or legacy success, controls acceptance", () => {
  const order = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write" });
  const record = { status: "completed", result: "verified", success: true, verificationRan: true, gatePassed: true, branch: "branch", commitCheck: { valid: true }, commitCount: 1 };
  assert.equal(taskResult(order, { ...record, verificationRan: false }).verification_status, "failed");
  assert.equal(taskResult(order, { ...record, commitCount: 2 }).verification_status, "failed");
  assert.equal(taskResult(order, { ...record, commitCheck: { valid: false } }).verification_status, "failed");
  assert.equal(taskResult(order, record).verification_status, "verified");
  const machine = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write", acceptance_criteria: ["The Worker verification command passes.", "The Worker produced exactly one commit."] });
  assert.equal(taskResult(machine, record).verification_status, "verified");
  const semantic = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write", acceptance_criteria: ["The user understands the result."] });
  assert.equal(taskResult(semantic, record).verification_status, "not_verified");
  assert.equal(taskResult(order, record, { evidenceError: true }).verification_status, "failed");
});

test("Execution Status, Verification Status, and Operation acceptance are distinct", () => {
  assert.ok(EXECUTION_STATUSES.includes("execution_complete"));
  assert.ok(!VERIFICATION_STATUSES.includes("execution_complete"));
  assert.ok(VERIFICATION_STATUSES.includes("verified"));
  assert.ok(!EXECUTION_STATUSES.includes("verified"));
  assert.ok(!EXECUTION_STATUSES.includes("complete"));
  assert.ok(!VERIFICATION_STATUSES.includes("complete"));
});
