import { createHash } from "node:crypto";

export const MISSION_ENTRY = "pi-harness-mission-state";
const terminalTaskStatuses = new Set(["accepted", "superseded", "waived"]);
const validId = (value) => typeof value === "string" && !!value.trim();

export function legacyMissionId(seed) {
  return `M-legacy-${createHash("sha256").update(String(seed)).digest("hex").slice(0, 16)}`;
}

export function createMission({ mission_id, objective, status = "active", operation_ids = [] }) {
  if (!validId(mission_id) || !validId(objective) || !["active", "complete", "blocked", "cancelled", "error"].includes(status) || !Array.isArray(operation_ids) || operation_ids.some((id) => !validId(id)) || new Set(operation_ids).size !== operation_ids.length) throw new Error("Mission state is invalid");
  return { version: 1, mission_id, objective: objective.trim(), status, operation_ids: [...operation_ids] };
}

export function attachOperation(missions, missionId, operationId) {
  const mission = missions?.[missionId];
  if (!mission || !validId(operationId) || mission.operation_ids.includes(operationId)) throw new Error("Mission cannot attach this Operation");
  return { ...missions, [missionId]: createMission({ ...mission, operation_ids: [...mission.operation_ids, operationId] }) };
}

export function validateMissionOwnership(missions, operations, taskGraphs) {
  if (!missions || Array.isArray(missions) || typeof missions !== "object") throw new Error("Mission state is invalid");
  for (const [missionId, mission] of Object.entries(missions)) {
    if (missionId !== mission?.mission_id) throw new Error("Mission key differs from Mission ID");
    createMission(mission);
    for (const operationId of mission.operation_ids) {
      const operation = operations?.[operationId];
      if (!operation || operation.mission_id !== missionId || !taskGraphs?.[operationId]) throw new Error("Mission has an invalid Operation ownership link");
    }
  }
  for (const [operationId, operation] of Object.entries(operations ?? {})) {
    const mission = missions[operation?.mission_id];
    if (!mission || !mission.operation_ids.includes(operationId)) throw new Error("Operation has no owning Mission");
    const graph = taskGraphs?.[operationId];
    if (!graph) throw new Error("Operation has no TaskGraph");
    for (const taskId of operation.required_task_ids ?? []) if (!graph.nodes?.[taskId]) throw new Error("TaskOrder has no owning Operation");
  }
  return missions;
}

export function operationHasUnresolvedTasks(operation, graph) {
  if (!operation || !graph) return true;
  return (operation.required_task_ids ?? []).some((taskId) => !terminalTaskStatuses.has(graph.nodes?.[taskId]?.scheduler_status));
}

export function missionIsClosable(mission, operations, taskGraphs) {
  if (!mission || mission.status !== "active") return false;
  return mission.operation_ids.every((operationId) => !operationHasUnresolvedTasks(operations[operationId], taskGraphs[operationId]));
}

export function missionSituationBoard(missions, operations, taskGraphs, { maxTasks = 32 } = {}) {
  const lines = [];
  for (const mission of Object.values(missions ?? {})) {
    if (mission.status !== "active") continue;
    lines.push(`Mission ${mission.mission_id}`);
    lines.push(`Closable: ${missionIsClosable(mission, operations, taskGraphs)}.`);
    let shown = 0;
    for (const operationId of mission.operation_ids) {
      const operation = operations[operationId], graph = taskGraphs[operationId];
      if (!operation || !graph) continue;
      lines.push(`Operation ${operationId}: ${operation.status}.`);
      for (const taskId of operation.required_task_ids ?? []) {
        const node = graph.nodes?.[taskId];
        if (!node || terminalTaskStatuses.has(node.scheduler_status)) continue;
        if (shown++ >= maxTasks) { lines.push("Additional unresolved TaskOrders are omitted from this bounded projection."); break; }
        const blocker = node.blocker ? ` Blocker: ${node.blocker.required_condition}` : "";
        lines.push(`TaskOrder ${taskId}: ${node.scheduler_status}.${blocker}`);
      }
    }
  }
  return lines.join("\n");
}
