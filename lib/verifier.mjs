// Harness-owned deterministic Verifier. This code does not consume child claims
// as acceptance authority. Acceptance Criteria supplied as prose require a
// later semantic Verifier; the deterministic gate does not prove them.
// Only these exact criteria describe checks already enforced by Harness.
// Unknown prose remains semantic; do not infer checkability from wording.
export const DETERMINISTIC_CRITERIA = Object.freeze([
  "The Worker verification command passes.",
  "The package-managed branch exists.",
  "The Worker commit policy is valid.",
  "The Worker produced exactly one commit.",
]);
export function semanticCriteria(order) {
  return order.role === "worker"
    ? order.acceptance_criteria.filter((text) => !DETERMINISTIC_CRITERIA.includes(text))
    : order.acceptance_criteria;
}

export function verifyTaskOrder(order, record, executionStatus, evidenceError = undefined) {
  if (evidenceError) return { verification_status: "failed", verification_summary: "The Evidence Store could not persist the execution Evidence. The Verifier cannot accept this TaskResult." };
  if (executionStatus === "blocked") return { verification_status: "blocked", verification_summary: "The ExecutionUnit stopped. The Verifier cannot check the Acceptance Criteria until the Blocker is removed." };
  if (executionStatus !== "execution_complete") return { verification_status: "failed", verification_summary: "The ExecutionUnit did not complete the TaskOrder. The Verifier cannot accept this TaskResult." };
  if (order.role !== "worker") return { verification_status: "not_verified", verification_summary: "The Verifier has not checked the reported findings from the read-only ExecutionUnit." };
  if (!record.verificationRan || !record.gatePassed || !record.branch || !record.commitCheck?.valid || record.commitCount !== 1) {
    return { verification_status: "failed", verification_summary: "The deterministic Verifier checked the Worker gate, branch, and commit policy. At least one required check failed." };
  }
  if (semanticCriteria(order).length) return {
    verification_status: "not_verified",
    verification_summary: "The deterministic Verifier checked the Worker gate, branch, and commit policy. The additional Acceptance Criteria require semantic verification.",
  };
  return { verification_status: "verified", verification_summary: "The deterministic Verifier checked the Worker gate, branch, and commit policy. All required deterministic Acceptance Criteria passed." };
}
