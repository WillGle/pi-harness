import { acceptOperationCriterion, acceptTaskResult, materializeOperation, recordTaskResult, rejectTaskResult } from "./operation.mjs";
import { assertSupportedPlatform } from "./platform.mjs";
import { registeredTask } from "./task-spec.mjs";
import { safeFailureCode } from "./failure-codes.mjs";
import { isChildOutcomeStatus, isManagedWorkerBranch, safeChildDisposition } from "./child-disposition.mjs";
import { TRUSTED_EXECUTION_POLICIES } from "./task-policy.mjs";
import { acceptGraphTask, blockGraphTask, claimTasks, markTaskVerifying, migrateTaskGraph, recordTaskGraphResult, rejectGraphTask, releaseResolvedTaskForRetry, rollbackSpawnFailure, schedulerSummary, validateTaskGraph } from "./task-graph.mjs";
import { attemptId, rollbackUnstartedAttempt } from "./attempt-ledger.mjs";

export const COORDINATOR_ENTRY = "pi-harness-coordinator-state";
export const MAX_COORDINATOR_TURNS = 12;
export const MAX_COORDINATOR_REPAIRS_PER_DECISION = 1;
export const DEFAULT_PARALLEL_TASKS = 2;
export const MAX_PARALLEL_TASKS = 4;
export function parallelTaskLimit(value = process.env.PI_HARNESS_MAX_PARALLEL_TASKS) {
  if (value === undefined) return DEFAULT_PARALLEL_TASKS;
  if (typeof value !== "string" || !/^[1-4]$/.test(value)) throw new Error("PI_HARNESS_MAX_PARALLEL_TASKS must be an integer from 1 to 4");
  return Number(value);
}
const MAX_PACKET = 16_000;
const failureStages = new Set(["worktree_preflight", "worker_branch_result"]);

export function coordinatorState(operation) {
  return { version: 2, operation_id: operation.operation_id, turns: 0, total_turns: 0, run_count: 0, decisions: [], blocker: null };
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function migrateCoordinatorState(operation, state = coordinatorState(operation)) {
  return { version: 2, operation_id: operation.operation_id, turns: Math.min(boundedCount(state.turns), MAX_COORDINATOR_TURNS),
    total_turns: state.version === 2 ? boundedCount(state.total_turns) : boundedCount(state.turns),
    run_count: state.version === 2 ? boundedCount(state.run_count) : 0,
    decisions: (state.decisions ?? []).slice(-7), blocker: state.blocker ?? null,
    ...(state.failure_code ? { failure_code: safeFailureCode(state.failure_code) } : {}),
    ...(failureStages.has(state.failure_stage) ? { failure_stage: state.failure_stage } : {}),
    ...(operation.required_task_ids?.includes(state.failure_task_id) ? { failure_task_id: state.failure_task_id } : {}) };
}

function taskRetryBlocker(operation, graph, attemptLedger, id, allowResolved = true) {
  const node = graph?.nodes?.[id], result = operation?.task_results?.[id];
  if (operation?.status !== "open" || !Array.isArray(operation.required_task_ids) || !operation.required_task_ids.includes(id) || !node) return "TaskOrder is not registered in an open Operation";
  if (node.attempts >= node.max_attempts) return "TaskOrder exhausted its retry budget; register a replacement TaskOrder";
  if (allowResolved && canRetryResolvedAttempt(operation, graph, attemptLedger, id)) return null;
  if (!["result_available", "blocked"].includes(node.scheduler_status)) return "TaskOrder has no failed TaskResult awaiting retry";
  if (result?.operation_id !== operation.operation_id || result.task_id !== id || result.execution_status !== "execution_complete") return "TaskOrder has no completed TaskResult; check the child outcome";
  if (!["failed", "blocked"].includes(result.verification_status)) return "TaskResult is not failed; the Coordinator must accept or resolve it";
  if (operation.rejected_task_ids?.includes(id)) return "TaskResult was already rejected";
  if (node.scheduler_status === "blocked" && (node.blocker?.failure_code || node.blocker?.child_status || node.blocker?.child_disposition)) return "Blocked child outcome requires separate inspection";
  if (!attemptLedger || attemptLedger[attemptId(operation.operation_id, id, node.attempts)]?.status !== "execution_complete"
    || Object.values(attemptLedger).some((attempt) => attempt?.operation_id === operation.operation_id && attempt.task_id === id && ["running", "unknown"].includes(attempt.status))) return "A previous Attempt outcome is unresolved; check the child outcome";
  return null;
}

export function canRetryTaskResult(operation, graph, attemptLedger, id) {
  return taskRetryBlocker(operation, graph, attemptLedger, id, false) === null;
}

export function canRetryResolvedAttempt(operation, graph, attemptLedger, id) {
  try { releaseResolvedTaskForRetry(graph, operation, id, attemptLedger); return true; }
  catch { return false; }
}

export function operationBrief(operation, state, mission = undefined, graph = migrateTaskGraph(operation), parallelLimit = DEFAULT_PARALLEL_TASKS) {
  const taskIds = operation.required_task_ids ?? [];
  const results = Object.fromEntries(taskIds.filter((id) => operation.task_results[id]).map((id) => [id, operation.task_results[id]]));
  const brief = { version: 1, operation_id: operation.operation_id, ...(mission ? { mission } : {}), ...(operation.planning ? { planning: true, allowed_policy_ids: operation.allowed_policy_ids } : {}),
    objective: operation.objective,
    ...(operation.constraints?.length ? { constraints: operation.constraints } : {}),
    ...(operation.task_intents && Object.keys(operation.task_intents).length ? { task_intents: operation.task_intents } : {}),
    ...(operation.planning ? {} : { required_task_ids: operation.required_task_ids, dependencies: operation.dependencies }),
    acceptance_criteria: operation.acceptance_criteria, criterion_evidence: operation.criterion_evidence,
    ...schedulerSummary(graph, operation, parallelLimit), rejected_task_ids: operation.rejected_task_ids,
    task_results: results, status: operation.status };
  const packet = { OperationBrief: brief, CoordinatorState: state };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET) throw new Error("The bounded Coordinator packet exceeds its limit");
  return packet;
}

export function coordinatorPrompt(packet) {
  const planningContract = packet.OperationBrief.planning
    ? `This is a planning Operation. Return action "plan_tasks" and put semantic proposals in the top-level "tasks" array, never "proposals". Each proposal must contain only local_ref, role, scope, dependencies by local_ref, acceptance_criteria, and execution_policy_id. role must be exactly scout, research, or worker and must match its policy owner. Create only meaningful Tasks that benefit from isolated execution, separate verification, a real Dependency, parallel execution, bounded retry, or separate context ownership. Prefer the smallest useful TaskGraph. Do not split one coherent edit into artificial Tasks. Allowed policy-to-role mapping: ${JSON.stringify(Object.fromEntries(packet.OperationBrief.allowed_policy_ids.map((id) => [id, TRUSTED_EXECUTION_POLICIES[id].owner])))}. Do not supply Task IDs, TaskSpecs, permissions, shell commands, timeouts, isolation, or model settings.`
    : "Harness uses each exact OperationBrief.task_intents value as the scope and OperationBrief.constraints as shared constraints. If a ready Task ID has no intent, return a Blocker. Harness resolves and validates trusted TaskSpecs; do not reconstruct mechanical fields from prose.";
  return ["The Coordinator must return one JSON CoordinatorDecision. Version: 1. Every decision must include version, operation_id, action, and a nonempty reason of at most 300 characters, including block actions.",
    planningContract,
    "The Scheduler ready_task_ids are the only TaskOrders available for dispatch after Harness materialization. A Dependency must be accepted before its dependent TaskOrder is ready.",
    "Actions: plan_tasks (planning only), dispatch, dispatch_batch, accept_task, reject_task, accept_criterion, block.",
    "If a TaskResult is result_available, accept it when verified or reject it when verification failed or is blocked. Rejecting a TaskResult releases its TaskOrder for a remaining retry or exhausts its retry budget. Do not block a TaskOrder that has a recorded TaskResult.",
    "The Harness validates every decision. The Coordinator must not declare a Mission complete.",
    "For dispatch return task_id only. For dispatch_batch return task_ids containing 2 to available_slots distinct ready Task IDs. Harness resolves trusted registered TaskSpecs; never invent verification commands, owner, permission, or review fields. Harness decides Dependency truth and capacity. The Coordinator does not run while a Task wave is active.",
    "For accept_criterion return an exact Acceptance Criterion that is not already a key in criterion_evidence, plus evidence_refs from an accepted TaskResult. Never repeat an accepted criterion. The Operation completes automatically when every required TaskResult and Acceptance Criterion is accepted.",
    "For block return blocked_action, required_condition, optional registered task_id for a Scheduler Blocker, and question only if strategic authority is required.",
    "Return no raw Evidence or transcript. Preserve conditions and exact technical identifiers.",
    JSON.stringify(packet)].join("\n");
}

export function coordinatorRepairPrompt(packet, failure) {
  const reason = String(failure?.message ?? "CoordinatorDecision failed deterministic validation").replace(/[\r\n\t]+/g, " ").slice(0, 300);
  const repairShape = packet.OperationBrief.planning ? "Keep action plan_tasks and put the proposal array in the top-level tasks field." : "Use only the fields required by the selected action.";
  return `${coordinatorPrompt(packet)}\nRepair Required: The previous CoordinatorDecision failed deterministic validation (${reason}). Return only one corrected JSON CoordinatorDecision. ${repairShape} Do not repeat non-JSON text.`;
}

function shape(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}
export function parseCoordinatorDecision(raw, operation) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8_000) throw new Error("CoordinatorDecision exceeds its size limit");
  let decision;
  try { decision = JSON.parse(raw); } catch { throw new Error("CoordinatorDecision is malformed JSON"); }
  const fields = ["version", "operation_id", "action", "reason", "tasks", "task_id", "task_ids", "criterion", "evidence_refs", "blocked_action", "required_condition", "question"];
  if (!shape(decision, fields) || decision.version !== 1 || decision.operation_id !== operation.operation_id || !["plan_tasks", "dispatch", "dispatch_batch", "accept_task", "reject_task", "accept_criterion", "block"].includes(decision.action) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 300) throw new Error("CoordinatorDecision is invalid or belongs to a foreign Operation");
  const actionFields = { plan_tasks: ["tasks"], dispatch: ["task_id"], dispatch_batch: ["task_ids"], accept_task: ["task_id"], reject_task: ["task_id"], accept_criterion: ["criterion", "evidence_refs"], block: ["task_id", "blocked_action", "required_condition", "question"] };
  if (!shape(decision, ["version", "operation_id", "action", "reason", ...actionFields[decision.action]])) throw new Error("CoordinatorDecision contains fields outside its action");
  const required = (key) => typeof decision[key] === "string" && decision[key].trim() && decision[key].length <= 1000;
  if (decision.action === "plan_tasks") {
    if (!operation.planning || !Array.isArray(decision.tasks)) throw new Error("plan_tasks is valid only for a planning Operation");
    materializeOperation(operation, decision.tasks);
  } else if (operation.planning && decision.action !== "block") throw new Error("A planning Operation accepts only plan_tasks or block");
  if (["dispatch", "dispatch_batch"].includes(decision.action)) {
    const ids = decision.action === "dispatch" ? [decision.task_id] : decision.task_ids;
    if (!Array.isArray(ids) || (decision.action === "dispatch_batch" && (ids.length < 2 || ids.length > MAX_PARALLEL_TASKS))
      || ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 1000)
      || new Set(ids).size !== ids.length) throw new Error("Coordinator proposed an invalid TaskOrder batch");
    for (const id of ids) registeredTask(operation, id);
  }
  if (["accept_task", "reject_task"].includes(decision.action) && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) throw new Error("Coordinator proposed an unknown TaskOrder ID");
  if (decision.action === "accept_criterion" && (!required("criterion") || !operation.acceptance_criteria.includes(decision.criterion) || Object.hasOwn(operation.criterion_evidence ?? {}, decision.criterion) || !Array.isArray(decision.evidence_refs) || !decision.evidence_refs.length || decision.evidence_refs.some((ref) => typeof ref !== "string"))) throw new Error(Object.hasOwn(operation.criterion_evidence ?? {}, decision.criterion) ? "Coordinator proposed an already accepted Operation Acceptance Criterion" : "Coordinator proposed an invalid Operation Acceptance Criterion");
  if (decision.action === "block" && (!required("blocked_action") || !required("required_condition") || (decision.task_id !== undefined && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) || (decision.question !== undefined && !required("question")))) throw new Error("Coordinator Blocker requires the blocked action and required condition");
  return decision;
}

export function operationReport(operation, state, blocker = undefined, question = undefined, graph = undefined, attemptLedger = {}, blockerTaskId = undefined) {
  const status = operation.status === "complete" ? "complete" : "blocked";
  const taskIds = operation.required_task_ids ?? [];
  const major_findings = operation.accepted_task_ids.flatMap((id) => (operation.task_results[id]?.findings ?? []).filter((finding) => finding.verification_status === "verified")).slice(0, 5).map(({ statement, criterion, verifier, source_role, verification_status }) => ({ statement, criterion, verifier, source_role, verification_status }));
  const scheduler = graph ? schedulerSummary(graph, operation) : undefined;
  const retryable_task_ids = graph ? taskIds.filter((id) => canRetryTaskResult(operation, graph, attemptLedger, id) || canRetryResolvedAttempt(operation, graph, attemptLedger, id)) : [];
  const blockedIds = operation.planning ? [] : graph ? scheduler.blocked_task_ids : taskIds.filter((id) => operation.task_results[id]?.verification_status === "blocked");
  // Promote Scheduler state only. A child notification and raw execution data
  // cannot become a TaskResult or a Commander-facing Blocker.
  if (blockerTaskId !== undefined && !blockedIds.includes(blockerTaskId)) throw new Error("Exact recovery lookup requires a blocked TaskOrder in this Operation");
  const scheduler_blockers = graph ? (blockerTaskId === undefined ? blockedIds.slice(0, 32) : [blockerTaskId]).map((id) => {
    const { task_id, blocked_action, required_condition, failure_code, child_disposition, child_status } = graph.nodes[id].blocker;
    const attempt = attemptLedger[attemptId(operation.operation_id, id, graph.nodes[id].attempts)];
    const retryable = retryable_task_ids.includes(id);
    const next_action = retryable ? "retry_task" : attempt?.status === "unknown" && attempt.child_refs?.length ? "resolve_attempt" : attempt ? "inspect_child" : "replan";
    const stage = (operation.rejected_task_ids.includes(id) ? undefined : operation.task_results[id]?.failure_stage) ?? (state.failure_task_id === id ? state.failure_stage : undefined);
    return { task_id, blocked_action, required_condition, ...(failure_code ? { failure_code: safeFailureCode(failure_code) } : {}),
      ...(failureStages.has(stage) ? { failure_stage: stage } : {}),
      ...(child_disposition ? { child_disposition: safeChildDisposition(child_disposition) } : {}), ...(isChildOutcomeStatus(child_status) ? { child_status } : {}),
      recovery_status: retryable ? "retryable" : !attempt ? "unavailable" : ["running", "unknown"].includes(attempt.status) ? "unresolved" : "blocked", next_action,
      ...(attempt ? { attempt_id: attempt.attempt_id, attempt_status: attempt.status,
        children: (attempt.child_refs ?? []).slice(0, 8).map(({ child_id, role }) => ({ child_id, role,
          child_status: attempt.child_resolutions?.find((entry) => entry.child_id === child_id)?.child_status ?? "unknown" })) } : {}) };
  }) : [];
  const failure_codes = taskIds.flatMap((id) => {
    const code = operation.task_results[id]?.failure_code;
    const stage = operation.task_results[id]?.failure_stage;
    return code ? [{ task_id: id, failure_code: safeFailureCode(code), ...(failureStages.has(stage) ? { failure_stage: stage } : {}) }] : [];
  }).slice(0, 32);
  const report = { version: 1, ...(operation.mission_id ? { mission_id: operation.mission_id } : {}), operation_id: operation.operation_id, status,
    turns: state.turns, total_turns: state.total_turns, run_count: state.run_count,
    turn_limit: MAX_COORDINATOR_TURNS, turn_limit_reached: state.turns >= MAX_COORDINATOR_TURNS,
    ...(state.failure_code ? { failure_code: safeFailureCode(state.failure_code) } : {}),
    ...(failureStages.has(state.failure_stage) ? { failure_stage: state.failure_stage } : {}),
    ...(taskIds.includes(state.failure_task_id) ? { failure_task_id: state.failure_task_id } : {}),
    ready_task_ids: scheduler?.ready_task_ids ?? [], retryable_task_ids, waived_task_ids: scheduler?.waived_task_ids ?? [],
    ...(failure_codes.length ? { failure_codes } : {}),
    summary: status === "complete" ? "The Coordinator accepted all required TaskResults and Operation Acceptance Criteria. The Commander must evaluate the Mission Definition of Done."
      : "The Coordinator cannot continue the Operation until the stated Blocker is removed.",
    accepted_task_ids: [...operation.accepted_task_ids], blocked_task_ids: blockerTaskId === undefined ? [...blockedIds] : [blockerTaskId], scheduler_blockers,
    omitted_blocked_task_id_count: blockerTaskId === undefined ? 0 : blockedIds.length - 1,
    omitted_blocker_count: blockedIds.length - scheduler_blockers.length,
    blocker_lookup: "Use action status with an exact blocked task_id for omitted recovery evidence.",
    major_findings, blocker: status === "complete" ? null : blocker ?? "The Coordinator cannot continue the Operation until the Commander replans after the turn limit.",
    ...(question ? { escalation: { type: "strategic_decision_required", operation_id: operation.operation_id, question, blocker } } : {}),
    commander_action_required: true };
  // Reserve half the report for recovery details when the ID list is oversized.
  // Normal-sized lists remain complete; omitted IDs can use exact lookup.
  while (Buffer.byteLength(JSON.stringify(report.blocked_task_ids)) > 12_000 && report.blocked_task_ids.length > 1) {
    report.blocked_task_ids.pop(); report.omitted_blocked_task_id_count++;
  }
  while (Buffer.byteLength(JSON.stringify(report)) > 24_000 && (report.major_findings.length || report.scheduler_blockers.length || failure_codes.length)) {
    if (report.major_findings.length) report.major_findings.pop();
    else if (report.scheduler_blockers.length && blockerTaskId === undefined) { report.scheduler_blockers.pop(); report.omitted_blocker_count++; }
    else if (blockerTaskId !== undefined && !failure_codes.length) break;
    else failure_codes.pop();
  }
  if (Buffer.byteLength(JSON.stringify(report)) > 24_000) throw new Error("The bounded OperationReport exceeds its limit");
  return report;
}

export async function runOperation(initial, callbacks, { mission, state = coordinatorState(initial), graph = migrateTaskGraph(initial), cwd = process.cwd(), signal, parallelLimit = DEFAULT_PARALLEL_TASKS, retryTaskId, attemptLedger } = {}) {
  assertSupportedPlatform();
  if (!Number.isInteger(parallelLimit) || parallelLimit < 1 || parallelLimit > MAX_PARALLEL_TASKS) throw new Error("Invalid Harness parallel limit");
  let operation = initial;
  validateTaskGraph(graph, operation);
  state = migrateCoordinatorState(operation, state);
  state = { ...state, turns: 0, run_count: Math.min(state.run_count + 1, Number.MAX_SAFE_INTEGER) };
  let persistenceFailed = false;
  const save = () => {
    try { callbacks.save?.(operation, state, graph); }
    catch { persistenceFailed = true; throw Object.assign(new Error("Harness state persistence failed"), { code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" }); }
  };
  const stop = (blocker, question, failureCode = undefined) => {
    state = { ...state, blocker, ...(persistenceFailed ? { failure_code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" } : failureCode ? { failure_code: safeFailureCode(failureCode) } : {}) };
    try { save(); } catch { state = { ...state, failure_code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" }; }
    return operationReport(operation, state, blocker, question, graph, callbacks.getAttemptLedger?.() ?? attemptLedger);
  };
  try { save(); }
  catch { return stop("The Harness cannot start this Coordinator run until state persistence is available.", undefined, "HARNESS_SCHEDULER_PERSISTENCE_FAILED"); }
  if (retryTaskId !== undefined) {
    if (signal?.aborted) throw Object.assign(new Error("Task retry was cancelled before it started"), { code: "HARNESS_CANCELLED" });
    const blocker = taskRetryBlocker(operation, graph, attemptLedger, retryTaskId);
    if (blocker) throw new Error(blocker);
    if (canRetryResolvedAttempt(operation, graph, attemptLedger, retryTaskId)) {
      graph = releaseResolvedTaskForRetry(graph, operation, retryTaskId, attemptLedger);
    } else {
      const nextOperation = rejectTaskResult(operation, retryTaskId);
      graph = rejectGraphTask(graph, nextOperation, retryTaskId);
      operation = nextOperation;
    }
    state = { ...coordinatorState(operation), turns: state.turns, total_turns: state.total_turns, run_count: state.run_count };
    save();
  }
  const beginTurn = () => {
    if (state.turns >= MAX_COORDINATOR_TURNS) return false;
    const previousState = state;
    state = { ...state, turns: state.turns + 1, total_turns: Math.min(state.total_turns + 1, Number.MAX_SAFE_INTEGER) };
    try { save(); return true; }
    catch { state = previousState; return false; }
  };
  for (; state.turns < MAX_COORDINATOR_TURNS && operation.status !== "complete";) {
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
    if (!beginTurn()) return stop("The Coordinator cannot continue the Operation until it can persist a bounded Coordinator turn.", undefined, "HARNESS_SCHEDULER_REJECTED");
    let raw;
    try { raw = await callbacks.turn(coordinatorPrompt(operationBrief(operation, state, mission, graph, parallelLimit))); }
    catch (error) { return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until a new Coordinator turn is available.", undefined, signal?.aborted ? "HARNESS_CANCELLED" : safeFailureCode(error?.code)); }
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
    let decision;
    try { decision = parseCoordinatorDecision(raw, operation); }
    catch (failure) {
      if (MAX_COORDINATOR_REPAIRS_PER_DECISION < 1 || !beginTurn()) return stop("The Coordinator cannot continue the Operation until it returns a valid CoordinatorDecision.", undefined, "HARNESS_COORDINATOR_DECISION_INVALID");
      try { raw = await callbacks.turn(coordinatorRepairPrompt(operationBrief(operation, state, mission, graph, parallelLimit), failure)); }
      catch (error) { return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until a new Coordinator turn is available.", undefined, signal?.aborted ? "HARNESS_CANCELLED" : safeFailureCode(error?.code)); }
      if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
      try { decision = parseCoordinatorDecision(raw, operation); }
      catch { return stop("The Coordinator cannot continue the Operation until it returns a valid CoordinatorDecision.", undefined, "HARNESS_COORDINATOR_DECISION_INVALID"); }
    }
    if (state.failure_code) {
      const { failure_code: _previousFailure, failure_stage: _previousStage, failure_task_id: _previousTask, ...withoutFailureCode } = state;
      state = withoutFailureCode;
    }
    state = { ...state, blocker: null, decisions: [...state.decisions.slice(-6), { action: decision.action, reason: decision.reason }] };
    try {
      if (decision.action === "plan_tasks") {
        const planned = materializeOperation(operation, decision.tasks);
        operation = planned.operation;
        graph = planned.graph;
        save();
      } else if (decision.action === "dispatch" || decision.action === "dispatch_batch") {
        const ids = decision.action === "dispatch" ? [decision.task_id] : decision.task_ids;
        const taskOrders = ids.map((id) => registeredTask(operation, id));
        if (decision.action === "dispatch_batch" && ids.length > parallelLimit) throw new Error("Coordinator batch exceeds Harness capacity");
        if (ids.some((id) => graph.nodes[id].scheduler_status === "exhausted")) return stop("The Scheduler cannot dispatch this TaskOrder until the Commander replans after the retry limit.");
        const previousGraph = graph;
        graph = claimTasks(graph, operation, ids, parallelLimit);
        try { save(); } // One durable running snapshot for every selected Task, before any spawn.
        catch { graph = previousGraph; throw Object.assign(new Error("The Scheduler could not persist the atomic Task wave claim"), { code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" }); }
        // JS runs each transition and synchronous persistence without an await.
        // Each pipeline settles independently; the Coordinator waits for the wave.
        const outcomes = await Promise.allSettled(taskOrders.map(async (task) => {
          try {
            const result = await callbacks.dispatch({ ...task, operation_id: operation.operation_id }, {
              onVerificationStart: () => {
                graph = markTaskVerifying(graph, operation, task.task_id);
                save();
              },
            });
            if (signal?.aborted) {
              const branch = task.owner === "worker" ? result?.artifact_refs?.find(isManagedWorkerBranch) : undefined;
              const child_disposition = task.owner === "worker" ? safeChildDisposition(branch ? { branch_status: "preserved", branch, worktree_status: "unknown" } : { branch_status: "unknown", worktree_status: "unknown" }) : undefined;
              const child_status = result?.failure_code === "HARNESS_CANCELLED" ? "cancelled" : "unknown";
              throw Object.assign(new Error("The Task wave was cancelled"), { code: "HARNESS_CANCELLED", child_status, ...(child_disposition ? { child_disposition } : {}) });
            }
            // A completion is not a managed result unless the Harness can bind
            // it to the claimed TaskOrder before persisting it.
            if (result?.operation_id !== operation.operation_id || result.task_id !== task.task_id) throw Object.assign(new Error("The TaskResult has no matching managed TaskOrder lineage"), { code: "HARNESS_LINEAGE_MISMATCH" });
            const nextOperation = recordTaskResult(operation, result);
            const nextGraph = recordTaskGraphResult(graph, nextOperation, task.task_id);
            operation = nextOperation; graph = nextGraph;
            save();
          } catch (error) {
            // Only an explicit no-child outcome can refund a Scheduler claim.
            // Other dispatch failures retain their Attempt and child provenance.
            if (graph.nodes[task.task_id].scheduler_status === "running") {
              if (error?.childOutcome === "not_started") {
                const id = attemptId(operation.operation_id, task.task_id, graph.nodes[task.task_id].attempts);
                const nextGraph = rollbackSpawnFailure(graph, operation, task.task_id);
                if (callbacks.rollbackAttempt) attemptLedger = callbacks.rollbackAttempt(id);
                else if (attemptLedger) {
                  rollbackUnstartedAttempt(attemptLedger, id);
                  delete attemptLedger[id];
                }
                graph = nextGraph;
                state = { ...state, failure_code: safeFailureCode(error?.code), ...(failureStages.has(error?.failure_stage) ? { failure_stage: error.failure_stage } : {}), failure_task_id: task.task_id };
                save();
                throw new Error("The TaskOrder did not start");
              }
              const spawnRejected = error?.childOutcome === "spawn_rejected";
              const childSettled = error?.childSettled === true;
              const childStatus = ["completed", "steered", "error", "stopped", "aborted"].includes(error?.childStatus) ? error.childStatus : "terminal";
              const childOutcomeStatus = isChildOutcomeStatus(error?.child_status) ? error.child_status
                : error?.childOutcome === "spawn_rejected" ? undefined
                  : error?.childSettled === true && signal?.aborted && ["stopped", "aborted"].includes(error?.childStatus) ? "cancelled"
                    : error?.childSettled === true && error?.childStatus === "stopped" ? "stopped" : "unknown";
              const timedOut = ["HARNESS_CHILD_TERMINAL_TIMEOUT", "HARNESS_CHILD_SETTLEMENT_TIMEOUT"].includes(error?.code);
              const failureCode = signal?.aborted ? "HARNESS_CANCELLED" : spawnRejected ? "HARNESS_CHILD_SPAWN_FAILED" : safeFailureCode(error?.code);
              graph = blockGraphTask(graph, operation, task.task_id,
                spawnRejected ? "resolve the confirmed child spawn failure" : childSettled ? "resolve the settled child outcome" : "resolve an unknown child outcome",
                spawnRejected
                  ? "the Commander resolves the bounded spawn failure and replans with a fresh Task ID"
                  : childSettled
                    ? `the child reached terminal status ${childStatus}; the Commander records this outcome without accepting a TaskResult and replans with a fresh Task ID`
                    : timedOut
                      ? "the Commander checks the child outcome after the Harness terminal wait timed out and replans with a fresh Task ID"
                      : "the Commander checks the child outcome and replans with a fresh Task ID",
                failureCode, safeChildDisposition(error?.child_disposition), childOutcomeStatus);
              save();
            }
            throw new Error("The Task pipeline did not produce a safely persisted TaskResult");
          }
        }));
        if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
        if (state.failure_stage === "worktree_preflight") return stop("The Coordinator cannot dispatch the ready TaskOrder until the worktree preflight succeeds.", undefined, state.failure_code);
        if (outcomes.some((outcome) => outcome.status === "rejected")) return stop("The Coordinator cannot continue until it checks the blocked TaskOrder outcomes.");
      } else if (decision.action === "accept_task") {
        const nextOperation = acceptTaskResult(operation, decision.task_id);
        const nextGraph = acceptGraphTask(graph, operation, nextOperation, decision.task_id);
        operation = nextOperation; graph = nextGraph;
      } else if (decision.action === "reject_task") {
        if (graph.nodes[decision.task_id]?.scheduler_status === "blocked") {
          const blocker = taskRetryBlocker(operation, graph, attemptLedger, decision.task_id, false);
          if (blocker) throw new Error(blocker);
        }
        const nextOperation = rejectTaskResult(operation, decision.task_id);
        const nextGraph = rejectGraphTask(graph, nextOperation, decision.task_id);
        operation = nextOperation; graph = nextGraph;
      }
      else if (decision.action === "accept_criterion") {
        if (decision.evidence_refs.some((ref) => !operation.accepted_task_ids.some((id) => operation.task_results[id]?.evidence_refs?.includes(ref)))) throw new Error("The Coordinator supplied Evidence outside accepted TaskResults");
        operation = acceptOperationCriterion(operation, decision.criterion, decision.evidence_refs, cwd);
      } else if (decision.action === "block") {
        if (decision.task_id && graph.nodes[decision.task_id]?.scheduler_status === "result_available") return stop("The Coordinator must accept or reject the recorded TaskResult before it blocks this TaskOrder.");
        if (decision.task_id) graph = blockGraphTask(graph, operation, decision.task_id, decision.blocked_action, decision.required_condition);
        return stop(`The Coordinator cannot ${decision.blocked_action} until ${decision.required_condition}.`, decision.question);
      }
      else return stop("The Coordinator cannot continue the Operation until the Commander resolves the missing executable action.", undefined, "HARNESS_COORDINATOR_DECISION_INVALID");
    } catch (error) {
      return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Scheduler rejected the CoordinatorDecision or the TaskOrder failed; the Coordinator cannot continue until it replans the Operation.", undefined, signal?.aborted ? "HARNESS_CANCELLED" : error?.code === "HARNESS_SCHEDULER_PERSISTENCE_FAILED" ? error.code : "HARNESS_SCHEDULER_REJECTED");
    } finally { try { save(); } catch { /* Return only a bounded persistence failure. */ } }
    if (persistenceFailed) return stop("The Harness cannot continue until state persistence is available.", undefined, "HARNESS_SCHEDULER_PERSISTENCE_FAILED");
  }
  if (operation.status !== "complete") return stop("The Coordinator cannot continue the Operation until the Commander replans after the turn limit.", undefined, "HARNESS_COORDINATOR_TURN_LIMIT");
  return operationReport(operation, state, undefined, undefined, graph, callbacks.getAttemptLedger?.() ?? attemptLedger);
}
