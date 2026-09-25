import { readEvidence } from "./evidence.mjs";
import { createTaskGraph } from "./task-graph.mjs";

export const OPERATION_ENTRY = "pi-harness-operation-state";

export function createOperation({ operation_id, objective, required_task_ids, acceptance_criteria = [], dependencies = {} }) {
  if (typeof operation_id !== "string" || !operation_id.trim() || typeof objective !== "string" || !objective.trim()) throw new Error("Operation requires an ID and objective");
  if (!Array.isArray(required_task_ids) || !required_task_ids.length || required_task_ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(required_task_ids).size !== required_task_ids.length) throw new Error("Operation requires distinct TaskOrder IDs");
  if (!Array.isArray(acceptance_criteria) || acceptance_criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim()) || new Set(acceptance_criteria).size !== acceptance_criteria.length) throw new Error("Operation Acceptance Criteria must be distinct text");
  if (!dependencies || Array.isArray(dependencies) || typeof dependencies !== "object" || Object.entries(dependencies).some(([id, refs]) => !required_task_ids.includes(id) || !Array.isArray(refs) || refs.some((ref) => ref === id || !required_task_ids.includes(ref)) || new Set(refs).size !== refs.length)) throw new Error("Operation Dependencies must refer to other required TaskOrders");
  const operation = { version: 1, operation_id, objective, required_task_ids, acceptance_criteria, dependencies,
    status: "open", task_results: {}, accepted_task_ids: [], rejected_task_ids: [], criterion_evidence: {}, acceptance_summary: "The Coordinator has not accepted all required TaskResults and Operation Acceptance Criteria." };
  createTaskGraph(operation); // Reject cycles before the Operation can be persisted or dispatched.
  return operation;
}

function updateStatus(operation) {
  const complete = operation.required_task_ids.every((id) => operation.accepted_task_ids.includes(id))
    && operation.acceptance_criteria.every((criterion) => Object.hasOwn(operation.criterion_evidence, criterion));
  return { ...operation, status: complete ? "complete" : "open",
    acceptance_summary: complete ? "The Coordinator accepted all required verified TaskResults and Operation Acceptance Criteria. The Commander must still evaluate the Mission Definition of Done."
      : "The Coordinator has not accepted all required TaskResults and Operation Acceptance Criteria." };
}

// Harness records only its own semantic TaskResult, never legacy child success.
export function recordTaskResult(operation, result) {
  if (operation.status === "complete" || result?.operation_id !== operation.operation_id || !operation.required_task_ids.includes(result?.task_id)) throw new Error("TaskResult does not belong to an open Operation");
  if (operation.accepted_task_ids.includes(result.task_id)) throw new Error("The Coordinator already accepted this TaskResult");
  return { ...operation, task_results: { ...operation.task_results, [result.task_id]: result },
    rejected_task_ids: operation.rejected_task_ids.filter((id) => id !== result.task_id) };
}

export function rejectTaskResult(operation, taskId) {
  if (operation.status !== "open" || !operation.task_results[taskId] || operation.accepted_task_ids.includes(taskId) || operation.rejected_task_ids.includes(taskId)) throw new Error("The Coordinator cannot reject this TaskResult");
  return { ...operation, rejected_task_ids: [...operation.rejected_task_ids, taskId] };
}

export function acceptTaskResult(operation, taskId) {
  if (operation.status !== "open" || operation.accepted_task_ids.includes(taskId) || operation.rejected_task_ids.includes(taskId)) throw new Error("The Operation cannot accept this TaskResult again");
  const result = operation.task_results[taskId];
  if (!result || result.operation_id !== operation.operation_id || result.execution_status !== "execution_complete" || result.verification_status !== "verified" || result.evidence_error) throw new Error("The Coordinator requires a verified TaskResult from this Operation");
  if ((operation.dependencies[taskId] ?? []).some((id) => !operation.accepted_task_ids.includes(id))) throw new Error("The Coordinator must accept the Dependency before this TaskResult");
  return updateStatus({ ...operation, accepted_task_ids: [...operation.accepted_task_ids, taskId] });
}

export function acceptOperationCriterion(operation, criterion, evidenceRefs, cwd = process.cwd()) {
  if (operation.status !== "open" || !operation.acceptance_criteria.includes(criterion) || Object.hasOwn(operation.criterion_evidence, criterion)) throw new Error("The Operation cannot accept this Acceptance Criterion");
  if (!Array.isArray(evidenceRefs) || !evidenceRefs.length) throw new Error("Operation acceptance requires Evidence references");
  for (const ref of evidenceRefs) {
    const item = readEvidence(ref, cwd);
    if (!operation.required_task_ids.includes(item.metadata.task_id)) throw new Error("Operation Acceptance Criterion requires Evidence from a required TaskOrder");
  }
  return updateStatus({ ...operation, criterion_evidence: { ...operation.criterion_evidence, [criterion]: [...evidenceRefs] } });
}
