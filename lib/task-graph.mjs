// Harness-owned, immutable Scheduler. Operation owns Dependencies and accepted Task IDs;
// every transition validates that the TaskGraph agrees with that Operation.
export const TASK_GRAPH_ENTRY = "pi-harness-task-graph-state";
const STATUSES = new Set(["pending", "ready", "running", "result_available", "accepted", "blocked", "exhausted"]);
const validId = (id) => typeof id === "string" && !!id.trim();
const fail = (text) => { throw new Error(`TaskGraph Scheduler: ${text}`); };

export function validateTaskGraph(graph, operation) {
  if (graph?.version !== 1 || graph.operation_id !== operation?.operation_id || !graph.nodes || Array.isArray(graph.nodes) || typeof graph.nodes !== "object" || Object.keys(graph).some((key) => !["version", "operation_id", "nodes"].includes(key)) || !Array.isArray(operation.required_task_ids) || !operation.required_task_ids.length || new Set(operation.required_task_ids).size !== operation.required_task_ids.length) fail("invalid TaskGraph or Operation");
  const ids = operation.required_task_ids;
  if (Object.keys(graph.nodes).length !== ids.length || ids.some((id) => !validId(id) || !Object.hasOwn(graph.nodes, id))) fail("TaskGraph and Operation Task IDs differ");
  const accepted = new Set(operation.accepted_task_ids);
  if (accepted.size !== operation.accepted_task_ids.length || [...accepted].some((id) => !ids.includes(id))) fail("invalid Operation accepted Task IDs");
  const visited = new Set(), visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail("Dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.nodes[id].dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) {
    const node = graph.nodes[id], deps = operation.dependencies[id] ?? [];
    if (node?.task_id !== id || !Array.isArray(node.dependencies) || new Set(node.dependencies).size !== node.dependencies.length || node.dependencies.length !== deps.length || node.dependencies.some((dep, i) => dep !== deps[i] || !ids.includes(dep) || dep === id) || !STATUSES.has(node.scheduler_status) || !Number.isSafeInteger(node.attempts) || !Number.isSafeInteger(node.max_attempts) || node.attempts < 0 || node.max_attempts !== 2 || node.attempts > node.max_attempts) fail("invalid node or Dependency");
    if (Object.keys(node).some((key) => !["task_id", "dependencies", "scheduler_status", "attempts", "max_attempts", "blocker"].includes(key))) fail("TaskGraph must not store execution context");
    if ((node.scheduler_status === "accepted") !== accepted.has(id)) fail("TaskGraph accepted state differs from Operation acceptance");
    if ((node.scheduler_status === "blocked") !== Object.hasOwn(node, "blocker")) fail("Scheduler Blocker must match blocked status");
    if (node.blocker && (typeof node.blocker.blocked_action !== "string" || !node.blocker.blocked_action.trim() || node.blocker.blocked_action.length > 500 || typeof node.blocker.required_condition !== "string" || !node.blocker.required_condition.trim() || node.blocker.required_condition.length > 500 || Object.keys(node.blocker).some((key) => !["task_id", "blocked_action", "required_condition"].includes(key)) || node.blocker.task_id !== id)) fail("invalid Scheduler Blocker");
    if (["ready", "running", "accepted", "exhausted"].includes(node.scheduler_status) && node.dependencies.some((dep) => !accepted.has(dep))) fail("Scheduler Status bypasses a Dependency");
    if (node.scheduler_status === "pending" && node.dependencies.every((dep) => accepted.has(dep))) fail("pending Task has accepted Dependencies");
    if (node.scheduler_status === "ready" && node.attempts >= node.max_attempts) fail("ready Task has no retry budget");
    if (["result_available", "accepted"].includes(node.scheduler_status) && !operation.task_results[id]) fail("Scheduler Status requires a TaskResult");
    if (node.scheduler_status === "accepted" && (operation.task_results[id].execution_status !== "execution_complete" || operation.task_results[id].verification_status !== "verified")) fail("accepted TaskOrder requires a verified TaskResult");
    if (node.scheduler_status === "running" && node.attempts === 0) fail("running Task lacks an attempt");
    if (node.scheduler_status === "exhausted" && node.attempts !== node.max_attempts) fail("exhausted Task has retry budget");
  }
  for (const id of ids) visit(id);
  return graph;
}

export function createTaskGraph(operation) {
  const graph = { version: 1, operation_id: operation.operation_id, nodes: Object.fromEntries(operation.required_task_ids.map((id) => [id, {
    task_id: id, dependencies: [...(operation.dependencies[id] ?? [])], scheduler_status: (operation.dependencies[id] ?? []).length ? "pending" : "ready", attempts: 0, max_attempts: 2,
  }])) };
  return validateTaskGraph(graph, operation);
}

export function migrateTaskGraph(operation, legacyDispatchCounts = {}) {
  const accepted = new Set(operation.accepted_task_ids);
  const graph = { version: 1, operation_id: operation.operation_id, nodes: Object.fromEntries(operation.required_task_ids.map((id) => {
    const dependencies = [...(operation.dependencies[id] ?? [])];
    const result = operation.task_results[id];
    const previous = legacyDispatchCounts[id];
    const attempts = Number.isSafeInteger(previous) && previous >= 0 ? Math.min(2, Math.max(result ? 1 : 0, previous)) : result ? 1 : 0;
    const dependenciesAccepted = dependencies.every((dep) => accepted.has(dep));
    const scheduler_status = accepted.has(id) ? "accepted" : result && !operation.rejected_task_ids.includes(id) ? "result_available"
      : attempts >= 2 && dependenciesAccepted ? "exhausted" : attempts >= 2 ? "blocked" : dependenciesAccepted ? "ready" : "pending";
    return [id, { task_id: id, dependencies, scheduler_status, attempts, max_attempts: 2,
      ...(scheduler_status === "blocked" ? { blocker: { task_id: id, blocked_action: "dispatch a legacy TaskOrder", required_condition: "the Commander checks its retry history and Dependencies" } } : {}) }];
  })) };
  return validateTaskGraph(graph, operation);
}

const replaceNode = (graph, id, change) => ({ ...graph, nodes: { ...graph.nodes, [id]: { ...graph.nodes[id], ...change } } });
export function readyTaskIds(graph, operation) {
  validateTaskGraph(graph, operation);
  if (operation.status !== "open" || Object.values(graph.nodes).some((node) => node.scheduler_status === "running")) return [];
  return operation.required_task_ids.filter((id) => {
    const node = graph.nodes[id];
    return node.scheduler_status === "ready" && node.attempts < node.max_attempts && node.dependencies.every((dep) => graph.nodes[dep].scheduler_status === "accepted");
  });
}
export function schedulerSummary(graph, operation) {
  validateTaskGraph(graph, operation);
  const result = { ready_task_ids: readyTaskIds(graph, operation) };
  for (const status of ["pending", "running", "result_available", "accepted", "blocked", "exhausted"]) result[`${status}_task_ids`] = operation.required_task_ids.filter((id) => graph.nodes[id].scheduler_status === status);
  return result;
}
export function claimTask(graph, operation, id) {
  if (!readyTaskIds(graph, operation).includes(id)) fail("TaskOrder is not in the Scheduler ready set");
  return validateTaskGraph(replaceNode(graph, id, { scheduler_status: "running", attempts: graph.nodes[id].attempts + 1 }), operation);
}
export function recordTaskGraphResult(graph, operation, id) {
  validateTaskGraph(graph, operation);
  if (graph.nodes[id]?.scheduler_status !== "running" || !operation.task_results[id] || operation.rejected_task_ids.includes(id)) fail("running TaskOrder requires its latest recorded TaskResult");
  return validateTaskGraph(replaceNode(graph, id, { scheduler_status: "result_available" }), operation);
}
export function acceptGraphTask(graph, previousOperation, nextOperation, id) {
  validateTaskGraph(graph, previousOperation);
  if (graph.nodes[id]?.scheduler_status !== "result_available" || !nextOperation.accepted_task_ids.includes(id)) fail("only a result_available TaskOrder can be accepted");
  let next = replaceNode(graph, id, { scheduler_status: "accepted" });
  for (const dependent of previousOperation.required_task_ids) {
    const node = next.nodes[dependent];
    if (node.scheduler_status === "pending" && node.dependencies.every((dep) => next.nodes[dep].scheduler_status === "accepted")) next = replaceNode(next, dependent, { scheduler_status: "ready" });
  }
  return validateTaskGraph(next, nextOperation);
}
export function rejectGraphTask(graph, operation, id) {
  validateTaskGraph(graph, operation);
  const node = graph.nodes[id];
  if (node?.scheduler_status !== "result_available" || !operation.rejected_task_ids.includes(id)) fail("only a rejected TaskResult can release its TaskOrder");
  return validateTaskGraph(replaceNode(graph, id, { scheduler_status: node.attempts < node.max_attempts ? "ready" : "exhausted" }), operation);
}
export function blockGraphTask(graph, operation, id, blocked_action, required_condition) {
  validateTaskGraph(graph, operation);
  if (!graph.nodes[id] || ["accepted", "blocked", "exhausted"].includes(graph.nodes[id].scheduler_status)) fail("cannot block this TaskOrder");
  return validateTaskGraph(replaceNode(graph, id, { scheduler_status: "blocked", blocker: { task_id: id, blocked_action, required_condition } }), operation);
}
export function rollbackSpawnFailure(graph, operation, id) {
  validateTaskGraph(graph, operation);
  const node = graph.nodes[id];
  if (node?.scheduler_status !== "running") fail("cannot roll back a TaskOrder that is not running");
  return validateTaskGraph(replaceNode(graph, id, { scheduler_status: "ready", attempts: node.attempts - 1 }), operation);
}
export function reconcileTaskGraph(graph, operation) {
  validateTaskGraph(graph, operation);
  let next = graph;
  for (const id of operation.required_task_ids) if (next.nodes[id].scheduler_status === "running") next = blockGraphTask(next, operation, id, "resume an interrupted TaskOrder", "the Commander replans after the child outcome is checked");
  return next;
}
