const terminalStatuses = new Set(["execution_complete", "terminal", "unknown"]);
const validId = (value) => typeof value === "string" && !!value.trim();

export function attemptId(operationId, taskId, ordinal) {
  return `A-${operationId}-${taskId}-${String(ordinal).padStart(2, "0")}`;
}

function attemptStatus(node, operation, taskId, ordinal) {
  if (ordinal === node.attempts && node.scheduler_status === "running") return "running";
  if (operation.task_results?.[taskId] && ordinal === node.attempts) return "execution_complete";
  // Failure codes identify the Harness path. They do not prove the child outcome.
  if (node.scheduler_status === "blocked" && ordinal === node.attempts
    && (node.blocker?.child_status === "unknown" || node.blocker?.failure_code === "HARNESS_SESSION_INTERRUPTED")) return "unknown";
  return "terminal";
}

export function reconcileAttemptLedger(ledger = {}, operations = {}, taskGraphs = {}) {
  const next = { ...ledger };
  for (const [operationId, operation] of Object.entries(operations)) {
    const graph = taskGraphs[operationId];
    if (!graph || !validId(operation.mission_id)) throw new Error("Attempt Ledger requires Mission-owned Operation state");
    for (const taskId of operation.required_task_ids ?? []) {
      const node = graph.nodes?.[taskId];
      if (!node) throw new Error("Attempt Ledger requires every TaskGraph node");
      for (let ordinal = 1; ordinal <= node.attempts; ordinal++) {
        const id = attemptId(operationId, taskId, ordinal);
        const status = attemptStatus(node, operation, taskId, ordinal);
        const result = ordinal === node.attempts ? operation.task_results?.[taskId] : undefined;
        const candidate = { version: 1, attempt_id: id, mission_id: operation.mission_id, operation_id: operationId, task_id: taskId, ordinal, status,
          ...(result?.failure_code ? { failure_code: result.failure_code } : node.blocker?.failure_code && ordinal === node.attempts ? { failure_code: node.blocker.failure_code } : {}),
          ...(result?.evidence_refs?.length ? { evidence_refs: [...result.evidence_refs] } : {}) };
        const previous = next[id];
        if (previous && (previous.mission_id !== candidate.mission_id || previous.operation_id !== operationId || previous.task_id !== taskId || previous.ordinal !== ordinal)) throw new Error("Attempt Ledger lineage is immutable");
        // A settled Attempt records history. A later Task disposition cannot rewrite
        // its outcome or provenance. Only a running Attempt can receive an outcome.
        next[id] = previous && previous.status !== "running" ? previous : candidate;
      }
    }
  }
  validateAttemptLedger(next, operations, taskGraphs);
  return next;
}

export function validateAttemptLedger(ledger, operations, taskGraphs) {
  if (!ledger || Array.isArray(ledger) || typeof ledger !== "object") throw new Error("Attempt Ledger is invalid");
  for (const [id, attempt] of Object.entries(ledger)) {
    if (id !== attempt?.attempt_id || attempt.version !== 1 || !validId(attempt.mission_id) || !validId(attempt.operation_id) || !validId(attempt.task_id) || !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1 || !["running", ...terminalStatuses].includes(attempt.status) || (attempt.failure_code !== undefined && (typeof attempt.failure_code !== "string" || !attempt.failure_code.startsWith("HARNESS_"))) || (attempt.evidence_refs !== undefined && (!Array.isArray(attempt.evidence_refs) || attempt.evidence_refs.some((ref) => !validId(ref))))) throw new Error("Attempt Ledger entry is invalid");
    const operation = operations?.[attempt.operation_id], node = taskGraphs?.[attempt.operation_id]?.nodes?.[attempt.task_id];
    if (!operation || operation.mission_id !== attempt.mission_id || !node || attempt.ordinal > node.attempts) throw new Error("Attempt Ledger entry has no owning TaskOrder");
  }
  return ledger;
}

export function attemptTelemetry(ledger = {}) {
  const values = Object.values(ledger);
  return { attempts_started: values.length, attempts_terminal: values.filter((attempt) => terminalStatuses.has(attempt.status)).length, attempts_unknown: values.filter((attempt) => attempt.status === "unknown").length };
}
