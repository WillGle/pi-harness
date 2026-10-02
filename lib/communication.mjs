// Harness-owned L2 contract. Text fields retain the caller's exact technical identifiers
// and logical relations; do not paraphrase or run a style compressor over them.
import { randomUUID } from "node:crypto";
import { semanticCriteria, verifyTaskOrder } from "./verifier.mjs";
import { verifiedFindings } from "./semantic-verifier.mjs";
import { safeFailureCode } from "./failure-codes.mjs";

export const TASK_RESULT_VERSION = 1;
export const EXECUTION_STATUSES = Object.freeze(["assigned", "running", "execution_complete", "failed", "blocked"]);
export const VERIFICATION_STATUSES = Object.freeze(["not_verified", "verifying", "verified", "failed", "blocked"]);

export function taskOrder(task) {
  const role = task.owner;
  const objective = task.scope.trim();
  const verification = task.verification.trim();
  const roleConstraints = role === "worker"
    ? ["The Worker must work only in the assigned isolated worktree.", "The Worker must not integrate the branch."]
    : [`The ${role} ExecutionUnit must not mutate the project.`];
  const constraints = [...roleConstraints, ...(task.constraints ?? [])];
  return {
    version: 1,
    task_id: task.task_id ?? randomUUID(),
    ...(task.operation_id ? { operation_id: task.operation_id } : {}),
    role,
    objective,
    scope: objective,
    permission: task.permission,
    verification,
    constraints,
    acceptance_criteria: task.acceptance_criteria ?? [],
    review_evidence: task.review_evidence ?? {},
    review_profile: task.review_profile ?? {},
    execution_status: "assigned",
  };
}

export function formatTaskOrder(order) {
  const actor = order.role === "worker" ? "Worker" : `${order.role} ExecutionUnit`;
  return [
    `TaskOrder ${order.task_id}`,
    ...(order.operation_id ? [`Work ${order.operation_id}`] : []),
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
export function taskResult(order, record, { evidenceRefs = [], evidenceError = undefined, semanticVerification = undefined } = {}) {
  const execution_status = record.status === "completed" || record.status === "steered"
    ? "execution_complete" : record.status === "stopped" ? "blocked" : "failed";
  const deterministic = verifyTaskOrder(order, record, execution_status, evidenceError);
  const allowedReview = deterministic.verification_status === "not_verified" && semanticCriteria(order).length > 0
    && semanticVerification?.task_id === order.task_id && semanticVerification?.verifier === "semantic"
    && ["verified", "failed", "blocked"].includes(semanticVerification.status)
    && semanticVerification.criteria?.length === semanticCriteria(order).length
    && semanticVerification.criteria.every((item, index) => item.criterion === semanticCriteria(order)[index]
      && (item.verifier ?? (Object.hasOwn(order.review_profile ?? {}, item.criterion) && order.review_profile[item.criterion] === "security" ? null : "semantic")) === (Object.hasOwn(order.review_profile ?? {}, item.criterion) && order.review_profile[item.criterion] === "security" ? "security" : "semantic"));
  const verification_status = allowedReview ? semanticVerification.status : deterministic.verification_status;
  const verification_summary = allowedReview ? semanticVerification.summary : deterministic.verification_summary;
  const actor = order.role === "worker" ? "Worker" : `${order.role} ExecutionUnit`;
  const findings = allowedReview ? verifiedFindings(order, semanticVerification) : undefined;
  const failed = verification_status === "failed" || verification_status === "blocked";
  const failure_code = !failed ? undefined : evidenceError ? "HARNESS_EVIDENCE_FAILED"
    : record.failure_code ? safeFailureCode(record.failure_code)
    : semanticVerification && semanticVerification.status !== "verified" ? safeFailureCode(semanticVerification.failure_code ?? "HARNESS_VERIFIER_FAILED")
      : execution_status !== "execution_complete" ? ["stopped", "aborted"].includes(record.status) ? "HARNESS_CANCELLED" : "HARNESS_CHILD_FAILED"
        : order.role === "worker" && !record.branch ? "HARNESS_WORKTREE_FAILED" : "HARNESS_VERIFIER_FAILED";
  const summary = execution_status === "execution_complete"
    ? allowedReview && semanticVerification.status === "verified" && findings?.length
      ? `The ${actor} satisfied ${findings.length} verified Acceptance Criteria.`
      : `The ${actor} stopped normally. The Commander has not accepted this TaskResult.`
    : `The ${actor} did not complete the TaskOrder.`;
  return {
    version: TASK_RESULT_VERSION,
    task_id: order.task_id,
    ...(order.operation_id ? { operation_id: order.operation_id } : {}),
    execution_status,
    verification_status,
    ...(failure_code ? { failure_code: safeFailureCode(failure_code) } : {}),
    ...(failure_code === "HARNESS_WORKTREE_FAILED" && execution_status === "execution_complete" && order.role === "worker" && !record.branch ? { failure_stage: "worker_branch_result" } : {}),
    verification_summary,
    checks: { command: order.role === "worker" ? order.verification : null,
      ran: record.verificationRan ?? false, passed: record.verificationRan ? record.gatePassed === true : null,
      scope: order.role !== "worker" ? "report_review" : order.verification === "git diff --check" ? "diff_formatting_only" : "named_command_only",
      commit_count: record.commitCount ?? null, independent_review: allowedReview ? semanticVerification.status : "not_performed" },
    summary,
    changed_paths: record.changedPaths ?? [],
    artifact_refs: record.branch ? [record.branch] : [],
    evidence_refs: evidenceRefs,
    ...(allowedReview ? { semantic_verification: semanticVerification, findings } : {}),
    ...(evidenceError ? { evidence_error: "The Evidence Store could not persist all execution Evidence." } : {}),
    ...(execution_status === "blocked" ? { blocker: "The ExecutionUnit cannot continue until the Commander resolves the cancellation or stop condition." } : {}),
  };
}
