import { randomUUID } from "node:crypto";
import { validateTask } from "./task-spec.mjs";
import { processOwner } from "./process-owner.mjs";

export const WORK_ENTRY = "pi-harness-work-state";
const statuses = new Set(["active", "complete", "blocked", "cancelled", "error"]);
const taskStatuses = new Set(["ready", "running", "result_available", "accepted", "failed", "unknown"]);
const text = (value, maximum) => typeof value === "string" && !!value.trim() && value.length <= maximum;

export function validateWorks(works) {
  if (!works || typeof works !== "object" || Array.isArray(works)) throw new Error("Invalid work state");
  for (const [id, work] of Object.entries(works)) {
    if (id !== work?.work_id || !text(id, 160) || !text(work.objective, 8_000) || !statuses.has(work.status)
      || !Array.isArray(work.constraints) || work.constraints.length > 16 || work.constraints.some((item) => !text(item, 500))
      || !work.tasks || typeof work.tasks !== "object" || Array.isArray(work.tasks) || Object.keys(work.tasks).length > 64) throw new Error("Invalid work record");
    for (const [taskId, task] of Object.entries(work.tasks)) {
      if (taskId !== task?.task_id || !text(taskId, 160) || !taskStatuses.has(task.status) || !Array.isArray(task.attempts) || task.attempts.length > 2
        || !Array.isArray(task.dependencies) || new Set(task.dependencies).size !== task.dependencies.length
        || task.dependencies.some((dep) => dep === taskId || !Object.hasOwn(work.tasks, dep))) throw new Error("Invalid work Task");
      validateTask({ ...task.assignment, task_id: taskId, operation_id: id });
      if (["running", "result_available", "accepted", "failed", "unknown"].includes(task.status) && !task.attempts.length) throw new Error("Task state requires an Attempt");
      for (const attempt of task.attempts) {
        if (!["running", "result_available", "failed", "unknown", "terminal"].includes(attempt?.status) || !Array.isArray(attempt.children)
          || attempt.children.length > 8 || new Set(attempt.children.map((child) => child?.child_id)).size !== attempt.children.length
          || attempt.children.some((child) => !text(child?.child_id, 160) || !["worker", "scout", "research", "reviewer", "security-reviewer"].includes(child.role))) throw new Error("Invalid Task Attempt");
        if (attempt.result && (attempt.result.task_id !== taskId || attempt.result.operation_id !== id)) throw new Error("TaskResult lineage mismatch");
      }
      const latest = task.attempts.at(-1);
      if (["running", "result_available", "failed", "unknown"].includes(task.status) && latest.status !== task.status) throw new Error("Task and Attempt state differ");
      if (["result_available", "accepted"].includes(task.status) && !latest?.result) throw new Error("Task requires a result");
      if (task.status === "accepted" && (!text(task.acceptance, 1_000) || latest.result.execution_status !== "execution_complete"
        || !["verified", "not_verified"].includes(latest.result.verification_status) || latest.result.evidence_error || !latest.result.evidence_refs?.length)) throw new Error("Accepted Task requires Evidence and Commander review");
      if (task.status === "accepted" && task.dependencies.some((dep) => work.tasks[dep].status !== "accepted")) throw new Error("Task acceptance bypasses a Dependency");
    }
    if (work.status === "complete" && (Object.values(work.tasks).some((task) => task.status !== "accepted") || !text(work.evidence, 2_000))) throw new Error("Completed work has unresolved Tasks or missing Evidence");
  }
  return works;
}

export function createWork(objective, constraints = []) {
  const work = { work_id: `W-${randomUUID()}`, objective, constraints, status: "active", tasks: {} };
  validateWorks({ [work.work_id]: work });
  return work;
}

export function addWorkTask(work, assignment, dependencies = [], review = false) {
  if (work.status !== "active" || Object.keys(work.tasks).length >= 64 || !Array.isArray(dependencies)
    || dependencies.some((id) => work.tasks[id]?.status !== "accepted") || typeof review !== "boolean") throw new Error("Task needs active work and accepted Dependencies");
  const task_id = `T-${randomUUID()}`;
  validateTask({ ...assignment, task_id, operation_id: work.work_id });
  const next = { ...work, tasks: { ...work.tasks, [task_id]: { task_id, assignment, dependencies, review, status: "ready", attempts: [] } } };
  validateWorks({ [work.work_id]: next });
  return { work: next, task_id };
}

export function claimWorkTask(work, id) {
  const task = work.tasks[id];
  if (work.status !== "active" || !task || !["ready", "failed"].includes(task.status) || task.attempts.length >= 2
    || task.dependencies.some((dep) => work.tasks[dep].status !== "accepted")) throw new Error("Task is not ready or has exhausted its retry budget");
  return updateWorkTask(work, id, { status: "running", attempts: [...task.attempts, { status: "running", owner: processOwner(), children: [] }] });
}

export function updateWorkTask(work, id, changes) {
  if (!Object.hasOwn(work.tasks, id)) throw new Error("Unknown Task");
  const next = { ...work, tasks: { ...work.tasks, [id]: { ...work.tasks[id], ...changes } } };
  validateWorks({ [work.work_id]: next });
  return next;
}

export function recordWorkChild(work, id, reference) {
  const task = work.tasks[id], attempt = task?.attempts.at(-1);
  if (task?.status !== "running" || !attempt) throw new Error("Child reference requires a running Task");
  const existing = attempt.children.find((child) => child.child_id === reference.child_id);
  if (existing) {
    if (existing.role !== reference.role) throw new Error("Child role is immutable");
    return updateWorkTask(work, id, { attempts: [...task.attempts.slice(0, -1), { ...attempt, children: attempt.children.map((child) => child === existing ? { ...child, ...reference } : child) }] });
  }
  return updateWorkTask(work, id, { attempts: [...task.attempts.slice(0, -1), { ...attempt, children: [...attempt.children, reference] }] });
}

export function recordWorkResult(work, id, result) {
  const task = work.tasks[id];
  if (task?.status !== "running") throw new Error("Only a running Task can receive a result");
  const status = result.execution_status === "execution_complete" && ["verified", "not_verified"].includes(result.verification_status) && !result.evidence_error ? "result_available" : "failed";
  return updateWorkTask(work, id, { status, attempts: [...task.attempts.slice(0, -1), { ...task.attempts.at(-1), status, result }] });
}

export function failWorkTask(work, id, { notStarted = false, settled = false, failure_code, child_disposition }) {
  const task = work.tasks[id], attempt = task?.attempts.at(-1);
  if (task?.status !== "running") throw new Error("Only a running Task can fail");
  if (notStarted && attempt.children.length) throw new Error("Cannot refund an Attempt that owns a child");
  if (notStarted) return updateWorkTask(work, id, { status: "ready", attempts: task.attempts.slice(0, -1), failure_code });
  const status = settled ? "failed" : "unknown";
  return updateWorkTask(work, id, { status, attempts: [...task.attempts.slice(0, -1), { ...attempt, status, failure_code, ...(child_disposition ? { child_disposition } : {}) }] });
}

export function acceptWorkTask(work, id, evidence) {
  if (work.status !== "active" || work.tasks[id]?.status !== "result_available" || !text(evidence, 1_000)) throw new Error("Acceptance needs an available result and concrete Commander review");
  return updateWorkTask(work, id, { status: "accepted", acceptance: evidence });
}

export function finishWork(work, status, evidence, blocker) {
  if (work.status !== "active" || !statuses.has(status) || status === "active" || !text(evidence, 2_000)
    || ["blocked", "error"].includes(status) && !text(blocker, 1_000)) throw new Error("Terminal work state requires Evidence and a Blocker when applicable");
  const next = { ...work, status, evidence, ...(blocker ? { blocker } : {}) };
  validateWorks({ [work.work_id]: next });
  return next;
}

export function restoreWorks(works = {}) {
  validateWorks(works);
  return Object.fromEntries(Object.entries(works).map(([id, work]) => [id, { ...work, tasks: Object.fromEntries(Object.entries(work.tasks).map(([taskId, task]) => {
    if (task.status !== "running") return [taskId, task];
    return [taskId, { ...task, status: "unknown", attempts: [...task.attempts.slice(0, -1), { ...task.attempts.at(-1), status: "unknown", failure_code: "HARNESS_SESSION_INTERRUPTED" }] }];
  })) }]));
}

export function workSituation(work) {
  if (!work) return "No work selected. Use /work list and /work resume <id> for saved work.";
  const tasks = Object.values(work.tasks), pending = tasks.filter((task) => task.status !== "accepted");
  const lines = [`Work ${work.work_id}: ${work.status}`, `Original objective: ${work.objective}`, ...work.constraints.map((constraint) => `Constraint: ${constraint}`),
    `Tasks: ${tasks.length - pending.length} accepted; ${pending.length} unresolved.`];
  if (Buffer.byteLength(lines.join("\n")) > 18_000) lines.splice(1, lines.length - 2,
    "The original objective and constraints exceed the context summary budget. Inspect pi_harness_work status before acting.");
  let shown = 0;
  for (const task of pending) {
    const line = `${task.task_id}: ${task.status} — ${task.assignment.scope}`;
    if (Buffer.byteLength([...lines, line].join("\n")) > 18_000) break;
    lines.push(line); shown++;
  }
  if (shown < pending.length) lines.push(`${pending.length - shown} unresolved Tasks omitted. Inspect pi_harness_work status for the full record.`);
  return lines.join("\n");
}
