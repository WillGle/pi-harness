import test from "node:test";
import assert from "node:assert/strict";
import { EXECUTION_STATUSES, VERIFICATION_STATUSES, formatTaskOrder, taskOrder, taskResult } from "../lib/communication.mjs";

test("TaskOrder retains actor, condition, Constraint, Acceptance Criterion and identifiers", () => {
  const condition = "If verification passes, the Coordinator may accept the TaskResult.";
  const order = taskOrder({ task_id: "T-104", owner: "worker", permission: "write", scope: "Change `lib/executor.mjs` only if the gate runs.", verification: "npm test", constraints: [condition], acceptance_criteria: ["The Worker must not modify `lib/plan.mjs`."] });
  const prompt = formatTaskOrder(order);
  for (const text of ["TaskOrder T-104", "The Worker must implement", condition, "`lib/executor.mjs`", "`lib/plan.mjs`", "Constraint:", "Acceptance Criterion:", "Execution Status: assigned"]) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /Verification passed\. Accept TaskResult/);
});

test("terminal execution and a gate alone cannot verify or complete a TaskResult", () => {
  const order = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write" });
  const record = { status: "completed", gatePassed: true, verificationRan: true, result: "Verified!", gateEvidence: "raw\nstdout", diff: "raw\ndiff", branch: "feature/x", changedPaths: ["lib/plan.mjs"] };
  const result = taskResult(order, record);
  assert.equal(result.version, 1);
  assert.equal(result.execution_status, "execution_complete");
  assert.equal(result.verification_status, "failed");
  assert.deepEqual(result.changed_paths, ["lib/plan.mjs"]);
  assert.equal(result.summary.includes("Verified!"), false);
  assert.equal(JSON.stringify(result).includes("raw"), false);
  assert.equal(record.gateEvidence, "raw\nstdout");
  assert.equal(record.diff, "raw\ndiff");
  assert.equal(taskResult(order, { status: "completed", verificationRan: true, gatePassed: false }).verification_status, "failed");
});

test("the Harness Verifier, not Worker prose or legacy success, controls acceptance", () => {
  const order = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write" });
  const record = { status: "completed", result: "verified", success: true, verificationRan: true, gatePassed: true, branch: "branch", commitCheck: { valid: true }, commitCount: 1 };
  assert.equal(taskResult(order, { ...record, verificationRan: false }).verification_status, "failed");
  assert.equal(taskResult(order, { ...record, commitCount: 2 }).verification_status, "verified");
  assert.equal(taskResult(order, { ...record, commitCheck: { valid: false } }).verification_status, "failed");
  assert.equal(taskResult(order, record).verification_status, "verified");
  const machine = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write", acceptance_criteria: ["The Worker verification command passes.", "The Worker produced exactly one commit."] });
  assert.equal(taskResult(machine, record).verification_status, "verified");
  assert.equal(taskResult(machine, { ...record, commitCount: 2 }).verification_status, "failed");
  const semantic = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write", acceptance_criteria: ["The user understands the result."] });
  assert.equal(taskResult(semantic, record).verification_status, "not_verified");
  assert.equal(taskResult(order, record, { evidenceError: true }).verification_status, "failed");
});

test("missing-branch and other failed TaskResults carry bounded failure codes without child error text", () => {
  const worker = taskOrder({ owner: "worker", scope: "edit", verification: "npm test", permission: "write" });
  assert.equal(taskResult(worker, { status: "completed" }).failure_code, "HARNESS_WORKTREE_FAILED");
  assert.equal(taskResult(worker, { status: "completed" }).failure_stage, "worker_branch_result");
  assert.equal(taskResult(worker, { status: "completed" }).execution_status, "execution_complete");
  const research = taskOrder({ owner: "research", scope: "inspect", verification: "check", permission: "read" });
  assert.equal(taskResult(research, { status: "error", error: "private provider detail" }).failure_code, "HARNESS_CHILD_FAILED");
  assert.equal(taskResult(research, { status: "stopped" }).failure_code, "HARNESS_CANCELLED");
  assert.equal(JSON.stringify(taskResult(research, { status: "error", error: "private provider detail" })).includes("private provider detail"), false);
});

test("Execution Status, Verification Status, and Operation acceptance are distinct", () => {
  assert.ok(EXECUTION_STATUSES.includes("execution_complete"));
  assert.ok(!VERIFICATION_STATUSES.includes("execution_complete"));
  assert.ok(VERIFICATION_STATUSES.includes("verified"));
  assert.ok(!EXECUTION_STATUSES.includes("verified"));
  assert.ok(!EXECUTION_STATUSES.includes("complete"));
  assert.ok(!VERIFICATION_STATUSES.includes("complete"));
});
