import { isChildDisposition, safeChildDisposition } from "./child-disposition.mjs";

const terminalStatuses = new Set(["execution_complete", "terminal", "unknown"]);
const managedChildRoles = new Set(["worker", "scout", "research", "reviewer", "security-reviewer"]);
const validChildRef = (ref) => ref && typeof ref === "object" && !Array.isArray(ref)
  && Object.keys(ref).every((key) => ["child_id", "role"].includes(key))
  && typeof ref.child_id === "string" && !!ref.child_id.trim() && ref.child_id.length <= 160 && managedChildRoles.has(ref.role);

function validateChildRefs(attempt) {
  if (attempt.child_refs !== undefined && (!Array.isArray(attempt.child_refs) || attempt.child_refs.length > 8
    || attempt.child_refs.some((ref) => !validChildRef(ref))
    || new Set(attempt.child_refs.map((ref) => ref.child_id)).size !== attempt.child_refs.length)) throw new Error("Attempt child references are invalid");
}

export function recordAttemptChild(ledger, id, reference) {
  if (!ledger || Array.isArray(ledger) || typeof ledger !== "object" || !validChildRef(reference)) throw new Error("Attempt child reference is invalid");
  for (const [key, attempt] of Object.entries(ledger)) {
    validateAttemptEntry(key, attempt);
  }
  const attempt = ledger[id];
  if (!attempt) throw new Error("Attempt child reference requires the exact owning Attempt");
  const refs = attempt.child_refs ?? [];
  const existing = refs.find((ref) => ref.child_id === reference.child_id);
  if (existing) {
    if (existing.role !== reference.role) throw new Error("Attempt child role is immutable");
    return ledger;
  }
  if (attempt.child_resolutions) throw new Error("Resolved Attempt child references are immutable");
  if (refs.length >= 8) throw new Error("Attempt child references exceed the bounded limit");
  return { ...ledger, [id]: { ...attempt, child_refs: [...refs, { child_id: reference.child_id, role: reference.role }] } };
}

const resolvedChildStatuses = new Set(["completed", "steered", "error", "stopped", "aborted"]);
function validateChildResolutions(attempt) {
  if (attempt.child_resolutions === undefined) return;
  const refs = attempt.child_refs;
  if (attempt.status !== "terminal" || !refs?.length || !Array.isArray(attempt.child_resolutions)
    || attempt.child_resolutions.length !== refs.length
    || new Set(attempt.child_resolutions.map((entry) => entry?.child_id)).size !== refs.length
    || Array.from(attempt.child_resolutions).some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["child_id", "source", "child_status", "observed_at", "child_disposition"].includes(key))
      || !refs.some((ref) => ref.child_id === entry.child_id) || entry.source !== "pi-subagents"
      || !resolvedChildStatuses.has(entry.child_status)
      || typeof entry.observed_at !== "string" || entry.observed_at.length > 40 || !Number.isFinite(Date.parse(entry.observed_at))
      || new Date(entry.observed_at).toISOString() !== entry.observed_at
      || (entry.child_disposition !== undefined && !isChildDisposition(entry.child_disposition)))) throw new Error("Attempt requires terminal evidence for every exact child reference");
}

export function resolveUnknownAttempt(ledger, id, resolutions) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger) || !Object.hasOwn(ledger, id)) throw new Error("Resolution requires the exact existing Attempt");
  for (const [key, entry] of Object.entries(ledger)) validateAttemptEntry(key, entry);
  const attempt = ledger[id];
  if (attempt.status === "terminal") return ledger;
  if (attempt.status !== "unknown") throw new Error("Only an unknown Attempt can be resolved");
  if (!attempt.child_refs?.length) throw new Error("Unknown Attempt has no persisted child reference");
  const resolved = { ...attempt, status: "terminal", child_resolutions: resolutions };
  validateChildResolutions(resolved);
  resolved.child_resolutions = resolutions.map((entry) => ({ ...entry, ...(entry.child_disposition ? { child_disposition: safeChildDisposition(entry.child_disposition) } : {}) }));
  return { ...ledger, [id]: resolved };
}

const validId = (value) => typeof value === "string" && !!value.trim();

export function attemptId(operationId, taskId, ordinal) {
  return `A-${operationId}-${taskId}-${String(ordinal).padStart(2, "0")}`;
}

export function rollbackUnstartedAttempt(ledger, id) {
  const attempt = ledger?.[id];
  if (!attempt || attempt.attempt_id !== id || attempt.status !== "running"
    || attempt.child_refs?.length
    || [attempt.child_ref, attempt.child_id, attempt.agent_id, attempt.child_reference].some((ref) => ref !== undefined && ref !== null)
    || Object.values(ledger).some((other) => other.operation_id === attempt.operation_id && other.task_id === attempt.task_id && other.ordinal > attempt.ordinal)) throw new Error("Only the exact latest running Attempt without a child reference can be rolled back");
  const next = { ...ledger };
  delete next[id];
  return next;
}

function attemptStatus(node, operation, taskId, ordinal) {
  if (ordinal === node.attempts && node.scheduler_status === "running") return "running";
  if (operation.task_results?.[taskId] && !operation.rejected_task_ids?.includes(taskId) && ordinal === node.attempts) return "execution_complete";
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
        if (node.blocker?.child_disposition && ordinal === node.attempts) candidate.child_disposition = { ...node.blocker.child_disposition };
        if (previous?.child_refs) candidate.child_refs = previous.child_refs.map((ref) => ({ ...ref }));
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

function validateAttemptEntry(id, attempt) {
  if (id !== attempt?.attempt_id || attempt.version !== 1 || !validId(attempt.mission_id) || !validId(attempt.operation_id) || !validId(attempt.task_id) || !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1 || !["running", ...terminalStatuses].includes(attempt.status) || (attempt.failure_code !== undefined && (typeof attempt.failure_code !== "string" || !attempt.failure_code.startsWith("HARNESS_"))) || (attempt.evidence_refs !== undefined && (!Array.isArray(attempt.evidence_refs) || attempt.evidence_refs.some((ref) => !validId(ref))))) throw new Error("Attempt Ledger entry is invalid");
  validateChildRefs(attempt);
  if (attempt.child_disposition !== undefined && !isChildDisposition(attempt.child_disposition)) throw new Error("Attempt child disposition is invalid");
  validateChildResolutions(attempt);
}

export function validateAttemptLedger(ledger, operations, taskGraphs) {
  if (!ledger || Array.isArray(ledger) || typeof ledger !== "object") throw new Error("Attempt Ledger is invalid");
  for (const [id, attempt] of Object.entries(ledger)) {
    validateAttemptEntry(id, attempt);
    const operation = operations?.[attempt.operation_id], node = taskGraphs?.[attempt.operation_id]?.nodes?.[attempt.task_id];
    if (!operation || operation.mission_id !== attempt.mission_id || !node || attempt.ordinal > node.attempts) throw new Error("Attempt Ledger entry has no owning TaskOrder");
  }
  return ledger;
}
