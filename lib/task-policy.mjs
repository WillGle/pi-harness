import { validateTask } from "./task-spec.mjs";

// The Harness owns executable authority. A Coordinator can select only an
// allowed policy ID and can never supply its own permissions or shell command.
export const TRUSTED_EXECUTION_POLICIES = Object.freeze({
  "research-read": Object.freeze({ owner: "research", permission: "read", verification: "The Verifier checks the report against the Task Acceptance Criteria." }),
  "scout-read": Object.freeze({ owner: "scout", permission: "read", verification: "The Verifier checks the report against the Task Acceptance Criteria." }),
  "worker-write": Object.freeze({ owner: "worker", permission: "write", verification: "git diff --check" }),
});

export function resolveExecutionPolicy(policyId, allowedPolicyIds, acceptanceCriteria) {
  if (typeof policyId !== "string" || !Array.isArray(allowedPolicyIds) || !allowedPolicyIds.includes(policyId)) throw new Error("Coordinator selected an unauthorized execution policy");
  const policy = TRUSTED_EXECUTION_POLICIES[policyId];
  if (!policy) throw new Error("Execution policy is not registered by the Harness");
  const task = validateTask({
    ...structuredClone(policy),
    scope: "Harness validates the semantic scope after policy resolution.",
    acceptance_criteria: acceptanceCriteria,
  });
  return Object.fromEntries(["owner", "permission", "verification", "acceptance_criteria", "review_evidence", "review_profile"].filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
}
