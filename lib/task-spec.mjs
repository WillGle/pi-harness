export function validateTask(task) {
  for (const key of ["owner", "scope", "verification", "permission"]) {
    if (!task?.[key]?.trim?.()) throw new Error(`Task requires ${key}`);
  }
  if (!["scout", "research", "worker"].includes(task.owner)) throw new Error("Unknown task owner");
  if (!["read", "write"].includes(task.permission)) throw new Error("Task permission must be read or write");
  if (task.owner !== "worker" && task.permission !== "read") throw new Error(`${task.owner} tasks are read-only`);
  if (task.task_id !== undefined && (typeof task.task_id !== "string" || !task.task_id.trim())) throw new Error("TaskOrder requires a nonempty task_id");
  if (task.operation_id !== undefined && (typeof task.operation_id !== "string" || !task.operation_id.trim() || !task.task_id?.trim())) throw new Error("Operation-bound TaskOrder requires an operation_id and task_id");
  if (task.operation_id && task.owner !== "worker" && !(task.acceptance_criteria?.length)) throw new Error("An Operation-bound read-only TaskOrder requires at least one Acceptance Criterion so the Verifier can normalize its report before promotion");
  if (task.review_evidence !== undefined && (!task.review_evidence || Array.isArray(task.review_evidence) || typeof task.review_evidence !== "object" || Object.entries(task.review_evidence).some(([criterion, kind]) => !task.acceptance_criteria?.includes(criterion) || !(task.owner === "worker" ? ["diff", "gate", "execution"] : ["report"]).includes(kind)))) throw new Error("Review Evidence selection must name a TaskOrder Acceptance Criterion and an allowed Evidence kind");
  if (task.review_profile !== undefined && (!task.review_profile || Array.isArray(task.review_profile) || typeof task.review_profile !== "object" || Object.entries(task.review_profile).length > 32 || Object.entries(task.review_profile).some(([criterion, profile]) => !task.acceptance_criteria?.includes(criterion) || !["default", "security"].includes(profile)))) throw new Error("Review Profile must name a TaskOrder Acceptance Criterion and default or security profile");
  if ((task.acceptance_criteria?.length ?? 0) > 32 || (task.acceptance_criteria && new Set(task.acceptance_criteria).size !== task.acceptance_criteria.length)) throw new Error("TaskOrder Acceptance Criteria must be unique and bounded");
  for (const field of ["constraints", "acceptance_criteria"]) {
    if (task[field] !== undefined && (!Array.isArray(task[field]) || task[field].some((item) => typeof item !== "string" || !item.trim()))) throw new Error(`TaskOrder ${field} must contain nonempty text`);
  }
  return task;
}

export const TASK_SPEC_FIELDS = ["owner", "permission", "verification", "acceptance_criteria", "review_evidence", "review_profile"];

// Only registration by the Commander/user grants authority to run commands.
// A worktree isolates Git changes, not host credentials or filesystem access.
export function registeredTask(operation, id) {
  if (!operation.required_task_ids.includes(id)) throw new Error("Unknown registered Task ID");
  const scope = operation.task_intents?.[id];
  if (typeof scope !== "string") throw new Error("Task requires a registered Task intent");
  const spec = operation.task_specs?.[id];
  if (!spec) throw new Error("Task requires a trusted registered TaskSpec; legacy Operations must be replanned before dispatch");
  return validateTask({ ...structuredClone(spec), task_id: id, operation_id: operation.operation_id, scope, constraints: [...(operation.constraints ?? [])] });
}

export function registerTaskSpecs(operation, specs) {
  if (!specs || Array.isArray(specs) || typeof specs !== "object") throw new Error("TaskSpecs must be a registered mapping");
  const registry = {};
  for (const [id, spec] of Object.entries(specs)) {
    if (!operation.required_task_ids.includes(id) || !spec || Array.isArray(spec) || typeof spec !== "object" || Object.keys(spec).some(key => !TASK_SPEC_FIELDS.includes(key))) throw new Error("TaskSpec contains unregistered fields or identity");
    if (typeof spec.verification !== "string" || spec.verification.length > 500 || Buffer.byteLength(JSON.stringify(spec)) > 8000) throw new Error("TaskSpec exceeds its bounded contract");
    registry[id] = structuredClone(spec);
    registeredTask({ ...operation, task_specs: registry }, id);
  }
  return registry;
}
