// Harness-owned L2 contract. Text fields retain the caller's exact technical identifiers
// and logical relations; do not paraphrase or run a style compressor over them.
import { randomUUID } from "node:crypto";
import { verifyTaskOrder } from "./verifier.mjs";

export const TASK_RESULT_VERSION = 1;
export const EXECUTION_STATUSES = Object.freeze(["assigned", "running", "execution_complete", "failed", "blocked"]);
export const VERIFICATION_STATUSES = Object.freeze(["not_verified", "verifying", "verified", "failed", "blocked"]);

export function taskOrder(task) {
  const role = task.owner;
  const objective = task.scope.trim();
  const verification = task.verification.trim();
  const constraints = task.constraints ?? (role === "worker"
    ? ["The Worker must work only in the assigned isolated worktree.", "The Worker must not integrate the branch."]
    : [`The ${role} ExecutionUnit must not mutate the project.`]);
  return {
    version: 1,
    task_id: task.task_id ?? randomUUID(),
    role,
    objective,
    scope: objective,
    permission: task.permission,
    verification,
    constraints,
    acceptance_criteria: task.acceptance_criteria ?? [],
    execution_status: "assigned",
  };
}

export function formatTaskOrder(order) {
  const actor = order.role === "worker" ? "Worker" : `${order.role} ExecutionUnit`;
  return [
    `TaskOrder ${order.task_id}`,
    `Execution Status: ${order.execution_status}.`,
    `The ${actor} must ${order.role === "worker" ? "implement" : "inspect and report evidence for"} this objective: ${order.objective}`,
    `Scope: ${order.scope}`,
    ...order.constraints.map((text) => `Constraint: ${text}`),
    ...order.acceptance_criteria.map((text) => `Acceptance Criterion: ${text}`),
    `Verification: ${order.verification}`,
    ...(order.role === "worker" ? [
      "The Worker must leave changes uncommitted. The package creates one atomic commit with the required policy metadata.",
      "The Worker must not merge or integrate the branch.",
    ] : ["The ExecutionUnit must report concise findings and must not mutate the project."]),
  ].join("\n");
}

// Raw child output stays in the execution record. Only persisted Evidence gets
// a reference. The Harness Verifier, not child text or legacy success, owns status.
export function taskResult(order, record, { evidenceRefs = [], evidenceError = undefined } = {}) {
  const execution_status = record.status === "completed" || record.status === "steered"
    ? "execution_complete" : record.status === "stopped" ? "blocked" : "failed";
  const { verification_status, verification_summary } = verifyTaskOrder(order, record, execution_status, evidenceError);
  return {
    version: TASK_RESULT_VERSION,
    task_id: order.task_id,
    execution_status,
    verification_status,
    verification_summary,
    summary: execution_status === "execution_complete"
      ? `The ${order.role === "worker" ? "Worker" : `${order.role} ExecutionUnit`} stopped normally. The Coordinator has not accepted this TaskResult.`
      : `The ${order.role === "worker" ? "Worker" : `${order.role} ExecutionUnit`} did not complete the TaskOrder.`,
    changed_paths: record.changedPaths ?? [],
    artifact_refs: record.branch ? [record.branch] : [],
    evidence_refs: evidenceRefs,
    ...(evidenceError ? { evidence_error: "The Evidence Store could not persist all execution Evidence." } : {}),
    ...(execution_status === "blocked" ? { blocker: "The ExecutionUnit cannot continue until the Coordinator resolves the cancellation or stop condition." } : {}),
  };
}

// The tool boundary promotes only semantic fields. Direct executeCoordinateTask
// callers retain the legacy record for migration; the parent model does not.
export function promoteTaskResult(record) {
  return record.taskResult;
}
