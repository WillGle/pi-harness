import { registerTaskSpecs } from "./task-spec.mjs";
import { readEvidence } from "./evidence.mjs";
import { createTaskGraph } from "./task-graph.mjs";
import { resolveExecutionPolicy } from "./task-policy.mjs";

export const OPERATION_ENTRY = "pi-harness-operation-state";

export function createOperation({ operation_id, mission_id = undefined, objective, required_task_ids, acceptance_criteria = [], dependencies = {}, constraints = [], task_intents = {}, task_specs = {}, allowed_policy_ids = [], planning = false }) {
  if (typeof operation_id !== "string" || !operation_id.trim() || typeof objective !== "string" || !objective.trim() || (mission_id !== undefined && (typeof mission_id !== "string" || !mission_id.trim()))) throw new Error("Operation requires an ID and objective");
  if (!Array.isArray(acceptance_criteria) || acceptance_criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim()) || new Set(acceptance_criteria).size !== acceptance_criteria.length) throw new Error("Operation Acceptance Criteria must be distinct text");
  if (!Array.isArray(constraints) || constraints.length > 16 || constraints.some((item) => typeof item !== "string" || !item.trim() || item.length > 500)) throw new Error("Operation constraints must be bounded text");
  if (planning) {
    if (required_task_ids !== undefined || Object.keys(dependencies).length || Object.keys(task_intents).length || Object.keys(task_specs).length) throw new Error("Planning Operations cannot contain Commander Task identities, Dependencies, intents, or TaskSpecs");
    if (!Array.isArray(allowed_policy_ids) || !allowed_policy_ids.length || allowed_policy_ids.length > 16 || allowed_policy_ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(allowed_policy_ids).size !== allowed_policy_ids.length) throw new Error("Planning Operations require distinct allowed execution policy IDs");
    for (const policyId of allowed_policy_ids) resolveExecutionPolicy(policyId, allowed_policy_ids, ["The Task satisfies its Acceptance Criteria."]);
    return { version: 1, operation_id, ...(mission_id ? { mission_id } : {}), objective, acceptance_criteria, allowed_policy_ids: [...allowed_policy_ids], planning: true,
      ...(constraints.length ? { constraints: [...constraints] } : {}), status: "open", task_results: {}, accepted_task_ids: [], rejected_task_ids: [], criterion_evidence: {}, acceptance_summary: "The Coordinator has not materialized the TaskGraph." };
  }
  if (!Array.isArray(required_task_ids) || !required_task_ids.length || required_task_ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(required_task_ids).size !== required_task_ids.length) throw new Error("Operation requires distinct TaskOrder IDs");
  if (!dependencies || Array.isArray(dependencies) || typeof dependencies !== "object" || Object.entries(dependencies).some(([id, refs]) => !required_task_ids.includes(id) || !Array.isArray(refs) || refs.some((ref) => ref === id || !required_task_ids.includes(ref)) || new Set(refs).size !== refs.length)) throw new Error("Operation Dependencies must refer to other required TaskOrders");
  if (!task_intents || Array.isArray(task_intents) || typeof task_intents !== "object" || Object.entries(task_intents).some(([id, intent]) => !required_task_ids.includes(id) || typeof intent !== "string" || !intent.trim() || intent.length > 500)) throw new Error("Task intents must name registered Task IDs and contain bounded text");
  const operation = { version: 1, operation_id, ...(mission_id ? { mission_id } : {}), objective, required_task_ids, acceptance_criteria, dependencies,
    ...(constraints.length ? { constraints: [...constraints] } : {}), ...(Object.keys(task_intents).length ? { task_intents: { ...task_intents } } : {}),
    status: "open", task_results: {}, accepted_task_ids: [], rejected_task_ids: [], criterion_evidence: {}, acceptance_summary: "The Coordinator has not accepted all required TaskResults and Operation Acceptance Criteria." };
  const registry = registerTaskSpecs(operation, task_specs);
  if (Object.keys(registry).length) operation.task_specs = registry;
  createTaskGraph(operation); // Reject cycles before the Operation can be persisted or dispatched.
  return operation;
}

export function materializeOperation(operation, proposals) {
  if (!operation?.planning || operation.status !== "open") throw new Error("Only an open planning Operation can be materialized");
  if (!Array.isArray(proposals) || !proposals.length || proposals.length > 32) throw new Error("Planning requires 1 to 32 Task proposals");
  const allowedFields = ["local_ref", "role", "scope", "dependencies", "acceptance_criteria", "execution_policy_id"];
  const refs = new Set();
  for (const proposal of proposals) {
    if (!proposal || Array.isArray(proposal) || typeof proposal !== "object" || Object.keys(proposal).some((key) => !allowedFields.includes(key))) throw new Error("Planning proposal contains unauthorized Task fields");
    if (typeof proposal.local_ref !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(proposal.local_ref) || refs.has(proposal.local_ref)) throw new Error("Planning Task local_ref must be unique and bounded");
    if (!['scout', 'research', 'worker'].includes(proposal.role) || typeof proposal.scope !== "string" || !proposal.scope.trim() || proposal.scope.length > 500 || !Array.isArray(proposal.dependencies) || proposal.dependencies.some((ref) => typeof ref !== "string") || new Set(proposal.dependencies).size !== proposal.dependencies.length || !Array.isArray(proposal.acceptance_criteria) || !proposal.acceptance_criteria.length || proposal.acceptance_criteria.length > 32 || proposal.acceptance_criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim() || criterion.length > 500) || new Set(proposal.acceptance_criteria).size !== proposal.acceptance_criteria.length) throw new Error("Planning Task semantics are invalid or oversized");
    refs.add(proposal.local_ref);
  }
  const required_task_ids = proposals.map((_, index) => `T-${operation.operation_id}-${String(index + 1).padStart(2, "0")}`);
  const refToId = Object.fromEntries(proposals.map((proposal, index) => [proposal.local_ref, required_task_ids[index]]));
  const dependencies = {}, task_intents = {}, task_specs = {};
  for (let index = 0; index < proposals.length; index++) {
    const proposal = proposals[index], taskId = required_task_ids[index];
    if (proposal.dependencies.some((ref) => !refs.has(ref) || ref === proposal.local_ref)) throw new Error("Planning Dependency names an unknown or self local_ref");
    const spec = resolveExecutionPolicy(proposal.execution_policy_id, operation.allowed_policy_ids, proposal.acceptance_criteria);
    if (spec.owner !== proposal.role) throw new Error("Execution policy does not authorize the proposed Task role");
    dependencies[taskId] = proposal.dependencies.map((ref) => refToId[ref]);
    task_intents[taskId] = proposal.scope;
    task_specs[taskId] = spec;
  }
  const materialized = { ...operation, planning: false, required_task_ids, dependencies, task_intents, task_specs, acceptance_summary: "The Coordinator has not accepted all required TaskResults and Operation Acceptance Criteria." };
  delete materialized.planning;
  delete materialized.allowed_policy_ids;
  registerTaskSpecs(materialized, task_specs);
  const graph = createTaskGraph(materialized);
  return { operation: materialized, graph, ref_to_task_id: refToId };
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
  const recorded = { ...operation.task_results, [result.task_id]: result };
  return { ...operation, task_results: Object.fromEntries(operation.required_task_ids.filter((id) => Object.hasOwn(recorded, id)).map((id) => [id, recorded[id]])),
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
    if (!operation.required_task_ids.includes(item.metadata.task_id) || (item.metadata.operation_id !== undefined && item.metadata.operation_id !== operation.operation_id)) throw new Error("Operation Acceptance Criterion requires Evidence from this Operation's required TaskOrder");
  }
  return updateStatus({ ...operation, criterion_evidence: { ...operation.criterion_evidence, [criterion]: [...evidenceRefs] } });
}
