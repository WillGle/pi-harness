import { schedulerSummary } from "./task-graph.mjs";
import { validateTask } from "./coordinator.mjs";

export const HEAD_REGISTRY_ENTRY = "pi-harness-head-registry-state";
export const HEAD_STATE_ENTRY = "pi-harness-head-state";
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const text = (value, max = 300) => typeof value === "string" && !!value.trim() && value.length <= max;

export function createHeadRegistry(operation, heads = []) {
  if (!Array.isArray(heads) || heads.length > 16) throw new Error("Head assignment is invalid");
  const registry = { version: 1, operation_id: operation.operation_id, heads: {} };
  const assigned = new Set();
  for (const head of heads) {
    if (!keys(head, ["head_id", "domain", "task_ids"]) || !text(head.head_id, 80) || !text(head.domain, 80) || !Array.isArray(head.task_ids) || !head.task_ids.length || Object.hasOwn(registry.heads, head.head_id)) throw new Error("Head assignment has a duplicate ID or an empty Head");
    for (const id of head.task_ids) {
      if (!operation.required_task_ids.includes(id) || assigned.has(id)) throw new Error("Head assignment has an unknown or duplicate Task ID");
      assigned.add(id);
    }
    Object.defineProperty(registry.heads, head.head_id, { value: { head_id: head.head_id, domain: head.domain, task_ids: [...head.task_ids] }, enumerable: true, writable: true, configurable: true });
  }
  return registry;
}

export function validateHeadRegistry(registry, operation) {
  if (!keys(registry, ["version", "operation_id", "heads"]) || registry.version !== 1 || registry.operation_id !== operation.operation_id || !object(registry.heads) || Object.keys(registry.heads).length > 16) throw new Error("Head Registry does not match the Operation");
  const validated = createHeadRegistry(operation, Object.values(registry.heads));
  if (Object.keys(registry.heads).some((id) => id !== registry.heads[id]?.head_id) || JSON.stringify(validated) !== JSON.stringify(registry)) throw new Error("Head Registry has invalid entries");
  return registry;
}

export function headState(operationId, headId) {
  return { version: 1, operation_id: operationId, head_id: headId, turns: 0, decisions: [], blocker: null };
}
export function validateHeadState(state, registry) {
  if (!keys(state, ["version", "operation_id", "head_id", "turns", "decisions", "blocker"]) || state.version !== 1 || state.operation_id !== registry.operation_id || !Object.hasOwn(registry.heads, state.head_id) || !Number.isSafeInteger(state.turns) || state.turns < 0 || !Array.isArray(state.decisions) || state.decisions.length > 3 || state.decisions.some((item) => !keys(item, ["action", "task_id", "reason"]) || !text(item.action, 40) || !text(item.reason, 300) || (item.task_id !== undefined && !registry.heads[state.head_id].task_ids.includes(item.task_id))) || (state.blocker !== null && !text(state.blocker, 300))) throw new Error("HeadState is invalid");
  return state;
}

export function domainBrief(operation, graph, registry, headId, state) {
  validateHeadRegistry(registry, operation);
  const head = registry.heads[headId];
  if (!head) throw new Error("Unknown Head");
  validateHeadState(state, registry);
  if (state.head_id !== headId) throw new Error("Foreign HeadState");
  const summary = schedulerSummary(graph, operation);
  const ids = head.task_ids;
  const packet = { DomainBrief: { version: 1, operation_id: operation.operation_id, head_id: headId, domain: head.domain,
    objective: operation.objective, task_ids: ids,
    task_intents: Object.fromEntries(ids.filter((id) => Object.hasOwn(operation.task_intents ?? {}, id)).map((id) => [id, operation.task_intents[id]])),
    constraints: operation.constraints ?? [], acceptance_criteria: operation.acceptance_criteria,
    ready_task_ids: summary.ready_task_ids.filter((id) => ids.includes(id)),
    pending_task_ids: summary.pending_task_ids.filter((id) => ids.includes(id)),
    result_available_task_ids: summary.result_available_task_ids.filter((id) => ids.includes(id)),
    accepted_task_ids: summary.accepted_task_ids.filter((id) => ids.includes(id)),
    blocked_task_ids: summary.blocked_task_ids.filter((id) => ids.includes(id)),
    dependencies: Object.fromEntries(ids.map((id) => [id, (operation.dependencies[id] ?? []).map((dep) => ({ task_id: dep, status: operation.accepted_task_ids.includes(dep) ? "accepted" : "pending" }))])),
    task_results: Object.fromEntries(ids.filter((id) => operation.task_results[id]).map((id) => [id, operation.task_results[id]])),
  }, HeadState: state };
  if (Buffer.byteLength(JSON.stringify(packet)) > 12_000) throw new Error("DomainBrief exceeds its size limit");
  return packet;
}

export function headPrompt(packet) {
  return ["The Domain Head must return one JSON HeadDecision. Version: 1. Use only DomainBrief and HeadState.",
    "Actions: recommend_dispatch, recommend_accept, recommend_reject, block, report. A recommendation is advice, not execution or acceptance.",
    "For recommend_dispatch return task_id and task {task_id, owner, scope, permission, verification, constraints?, acceptance_criteria?, review_evidence?}. Only ready_task_ids can be dispatched.",
    "For recommend_accept and recommend_reject return task_id. For block return blocked_action and required_condition; task_id is optional.",
    "Return reason for each action. Use the Operation objective and assigned Task intents. Do not include transcripts, raw Evidence, or hidden reasoning.", JSON.stringify(packet)].join("\n");
}

export function parseHeadDecision(raw, operation, graph, registry, headId) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8_000) throw new Error("HeadDecision exceeds its size limit");
  let d;
  try { d = JSON.parse(raw); } catch { throw new Error("HeadDecision is malformed JSON"); }
  const head = registry.heads[headId];
  const actions = { recommend_dispatch: ["task_id", "task"], recommend_accept: ["task_id"], recommend_reject: ["task_id"], block: ["task_id", "blocked_action", "required_condition"], report: [] };
  if (!head || !keys(d, ["version", "operation_id", "head_id", "action", "reason", ...(actions[d?.action] ?? [])]) || d.version !== 1 || d.operation_id !== operation.operation_id || d.head_id !== headId || !Object.hasOwn(actions, d.action) || !text(d.reason)) throw new Error("HeadDecision is invalid or foreign");
  if (d.task_id !== undefined && !head.task_ids.includes(d.task_id)) throw new Error("HeadDecision names a Task ID outside this Head");
  if (["recommend_dispatch", "recommend_accept", "recommend_reject"].includes(d.action) && !d.task_id) throw new Error("HeadDecision requires a Task ID");
  if (d.action === "recommend_dispatch") {
    if (!schedulerSummary(graph, operation).ready_task_ids.includes(d.task_id) || !keys(d.task, ["task_id", "owner", "scope", "permission", "verification", "constraints", "acceptance_criteria", "review_evidence"]) || d.task.task_id !== d.task_id) throw new Error("HeadDecision cannot dispatch a pending TaskOrder");
    // Apply the same bounded TaskOrder checks as the Coordinator.
    // Imported here to avoid giving the Head any execution authority.
    if (!text(d.task.scope, 1000) || !text(d.task.verification, 500)) throw new Error("HeadDecision TaskOrder is oversized");
    validateTask(d.task);
  }
  if (d.action === "recommend_accept" && (!operation.task_results[d.task_id] || graph.nodes[d.task_id].scheduler_status !== "result_available")) throw new Error("HeadDecision cannot recommend unavailable acceptance");
  if (d.action === "block" && (!text(d.blocked_action, 500) || !text(d.required_condition, 500))) throw new Error("Head Blocker requires an action and a condition");
  return d;
}

export function headReport(decision, registry) {
  const report = { version: 1, operation_id: decision.operation_id, head_id: decision.head_id, domain: registry.heads[decision.head_id].domain,
    recommendation: { action: decision.action, ...(decision.task_id ? { task_id: decision.task_id } : {}),
      ...(decision.action === "recommend_dispatch" ? { task: { task_id: decision.task.task_id, owner: decision.task.owner, permission: decision.task.permission,
        scope: decision.task.scope, verification: decision.task.verification,
        ...(decision.task.constraints !== undefined ? { constraints: decision.task.constraints } : {}),
        ...(decision.task.acceptance_criteria !== undefined ? { acceptance_criteria: decision.task.acceptance_criteria } : {}),
        ...(decision.task.review_evidence !== undefined ? { review_evidence: decision.task.review_evidence } : {}) } } : {}) },
    summary: decision.reason, blocker: decision.action === "block" ? { blocked_action: decision.blocked_action, required_condition: decision.required_condition, ...(decision.task_id ? { task_id: decision.task_id } : {}) } : null };
  return report;
}
