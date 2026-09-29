import { createHash } from "node:crypto";
import { operationHasTerminalDisposition, validateOperationDisposition } from "./operation.mjs";

export const MISSION_ENTRY = "pi-harness-mission-state";
const terminalTaskStatuses = new Set(["accepted", "superseded", "waived"]);
const MAX_SITUATION_BOARD_CHARACTERS = 24_000;
const boundedText = (value, maximum = 180) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
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

export function validateMissionOwnership(missions, operations, taskGraphs, attemptLedger = {}) {
  if (!missions || Array.isArray(missions) || typeof missions !== "object") throw new Error("Mission state is invalid");
  const taskOwners = new Map();
  for (const [missionId, mission] of Object.entries(missions)) {
    if (missionId !== mission?.mission_id) throw new Error("Mission key differs from Mission ID");
    createMission(mission);
    for (const operationId of mission.operation_ids) {
      const operation = operations?.[operationId];
      if (!operation || operation.mission_id !== missionId || !taskGraphs?.[operationId]) throw new Error("Mission has an invalid Operation ownership link");
      validateOperationDisposition(operation, taskGraphs[operationId]);
    }
  }
  for (const [operationId, operation] of Object.entries(operations ?? {})) {
    const mission = missions[operation?.mission_id];
    if (!mission || !mission.operation_ids.includes(operationId)) throw new Error("Operation has no owning Mission");
    const graph = taskGraphs?.[operationId];
    if (!graph) throw new Error("Operation has no TaskGraph");
    for (const taskId of operation.required_task_ids ?? []) {
      if (!graph.nodes?.[taskId]) throw new Error("TaskOrder has no owning Operation");
      const owner = taskOwners.get(taskId);
      if (owner) throw new Error(`TaskOrder ${taskId} has multiple owning Operations`);
      taskOwners.set(taskId, operationId);
    }
    if (mission.status === "complete" && !missionHasSuccessfulClosure(mission, operations, taskGraphs, attemptLedger)) throw new Error("Complete Mission has unresolved or unsuccessful Operation obligations");
  }
  for (const operationId of Object.keys(taskGraphs ?? {})) if (!Object.hasOwn(operations ?? {}, operationId)) throw new Error("TaskGraph has no owning Operation");
  return missions;
}

export function operationHasUnresolvedTasks(operation, graph) {
  if (!operation || !graph) return true;
  return (operation.required_task_ids ?? []).some((taskId) => !terminalTaskStatuses.has(graph.nodes?.[taskId]?.scheduler_status));
}

export function operationHasUnresolvedAttempts(operation, graph, attemptLedger = {}) {
  if (!operation || !graph) return true;
  return Object.values(attemptLedger).some((attempt) => attempt?.operation_id === operation.operation_id
    && (attempt.status === "running" || attempt.status === "unknown"));
}

export function missionHasSuccessfulClosure(mission, operations, taskGraphs, attemptLedger = {}) {
  if (!mission) return false;
  return mission.operation_ids.every((operationId) => {
    const operation = operations[operationId];
    try { validateOperationDisposition(operation, taskGraphs[operationId]); }
    catch { return false; }
    return operation.status === "complete"
      && operationHasTerminalDisposition(operation)
      && !operationHasUnresolvedTasks(operation, taskGraphs[operationId])
      && !operationHasUnresolvedAttempts(operation, taskGraphs[operationId], attemptLedger);
  });
}

export function missionIsClosable(mission, operations, taskGraphs, attemptLedger = {}) {
  return mission?.status === "active" && missionHasSuccessfulClosure(mission, operations, taskGraphs, attemptLedger);
}

export function missionSituationBoard(missions, operations, taskGraphs, attemptLedgerOrOptions = {}, options = {}) {
  // The fourth argument was maxTasks before the Attempt Ledger existed.
  const legacyOptions = attemptLedgerOrOptions && Object.hasOwn(attemptLedgerOrOptions, "maxTasks");
  const attemptLedger = legacyOptions ? {} : attemptLedgerOrOptions;
  const requested = legacyOptions ? attemptLedgerOrOptions : options;
  const boundedLimit = (value, maximum, fallback) => Number.isSafeInteger(value) ? Math.max(0, Math.min(maximum, value)) : fallback;
  const maxTasks = boundedLimit(requested?.maxTasks, 32, 32);
  const maxMissions = boundedLimit(requested?.maxMissions, 8, 8);
  const maxOperations = boundedLimit(requested?.maxOperations, 24, 24);
  const lines = [];
  const candidates = Object.values(missions ?? {}).filter((mission) => mission.status === "active" || mission.operation_ids.some((operationId) => {
    const operation = operations[operationId], graph = taskGraphs[operationId];
    return !operation || !graph || operationHasUnresolvedTasks(operation, graph) || operationHasUnresolvedAttempts(operation, graph, attemptLedger);
  }));
  const visibleMissions = maxMissions ? candidates.slice(-maxMissions) : [];
  const candidateOperationIds = new Set(candidates.flatMap((mission) => mission.operation_ids));
  const unresolvedAttempts = Object.values(attemptLedger).filter((attempt) => candidateOperationIds.has(attempt?.operation_id) && ["running", "unknown"].includes(attempt?.status));
  if (candidates.length > visibleMissions.length) lines.push(`${candidates.length - visibleMissions.length} additional Missions omitted from this bounded projection.`);
  let shownTasks = 0;
  let shownOperations = 0;
  let shownAttempts = 0;
  const visibleOperationIds = new Set();
  const totalUnresolvedTasks = candidates.reduce((count, mission) => count + mission.operation_ids.reduce((subtotal, operationId) => {
    const operation = operations[operationId], graph = taskGraphs[operationId];
    return subtotal + (operation && graph ? operation.planning ? 0 : operation.required_task_ids.filter((taskId) => !terminalTaskStatuses.has(graph.nodes?.[taskId]?.scheduler_status)).length : 1);
  }, 0), 0);
  const totalOperations = candidates.reduce((count, mission) => count + mission.operation_ids.length, 0);
  for (const mission of visibleMissions) {
    const hasUnresolvedObligations = mission.operation_ids.some((operationId) => {
      const operation = operations[operationId], graph = taskGraphs[operationId];
      return !operation || !graph || operationHasUnresolvedTasks(operation, graph) || operationHasUnresolvedAttempts(operation, graph, attemptLedger);
    });
    if (mission.status !== "active" && !hasUnresolvedObligations) continue;
    lines.push(`Mission ${mission.mission_id}`);
    lines.push(`Status: ${mission.status}.`);
    lines.push(`Closable: ${missionIsClosable(mission, operations, taskGraphs, attemptLedger)}.`);
    for (const operationId of mission.operation_ids) {
      if (shownOperations >= maxOperations) break;
      const operation = operations[operationId], graph = taskGraphs[operationId];
      shownOperations++;
      visibleOperationIds.add(operationId);
      if (!operation || !graph) { lines.push(`Operation ${operationId}: ownership data unavailable.`); continue; }
      lines.push(`Operation ${operationId}: ${operation.status}.`);
      if (operation.planning) lines.push("Planning Operation: awaiting semantic Task proposals; no Task IDs are materialized.");
      for (const taskId of operation.required_task_ids ?? []) {
        const node = graph.nodes?.[taskId];
        if (!node || terminalTaskStatuses.has(node.scheduler_status)) continue;
        if (shownTasks >= maxTasks) break;
        shownTasks++;
        lines.push(`TaskOrder ${taskId}: ${node.scheduler_status}.`);
        const intent = boundedText(operation.task_intents?.[taskId]);
        if (intent) lines.push(`  Intent: ${intent}`);
        if (node.dependencies.length) lines.push(`  Dependencies: ${node.dependencies.join(", ")}.`);
        const criteria = (operation.task_specs?.[taskId]?.acceptance_criteria ?? []).slice(0, 2).map((criterion) => boundedText(criterion, 140)).filter(Boolean);
        if (criteria.length) lines.push(`  Acceptance Criteria: ${criteria.join("; ")}${operation.task_specs?.[taskId]?.acceptance_criteria?.length > criteria.length ? "; additional Criteria omitted" : ""}.`);
        if (node.blocker) lines.push(`  Blocker: ${boundedText(node.blocker.required_condition)}.`);
      }
      if (shownTasks >= maxTasks) break;
    }
    if (shownOperations >= maxOperations) break;
  }
  for (const attempt of unresolvedAttempts) {
    if (shownAttempts >= 16) break;
    if (!visibleOperationIds.has(attempt.operation_id)) continue;
    lines.push(`Unresolved Attempt ${attempt.attempt_id} for TaskOrder ${attempt.task_id}: ${attempt.status}.`);
    shownAttempts++;
  }
  if (totalOperations > shownOperations) lines.push(`${totalOperations - shownOperations} additional Operations omitted from this bounded projection.`);
  if (totalUnresolvedTasks > shownTasks) lines.push(`${totalUnresolvedTasks - shownTasks} additional unresolved TaskOrders omitted from this bounded projection.`);
  if (unresolvedAttempts.length > shownAttempts) lines.push(`${unresolvedAttempts.length - shownAttempts} additional running or unknown Attempts omitted from this bounded projection.`);
  const board = lines.join("\n");
  if (board.length <= MAX_SITUATION_BOARD_CHARACTERS) return board;
  const marker = "\n[Mission Situation Board truncated; remaining obligations stay in durable Mission state. Use /mission list and resume by exact ID.]";
  let prefix = board.slice(0, MAX_SITUATION_BOARD_CHARACTERS - marker.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix.trimEnd() + marker;
}
