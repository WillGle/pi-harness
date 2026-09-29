import { domainBrief, headPrompt, headReport, headState, parseHeadDecision, validateHeadRegistry } from "./domain-head.mjs";
import { acceptOperationCriterion, acceptTaskResult, materializeOperation, recordTaskResult, rejectTaskResult } from "./operation.mjs";
import { assertSupportedPlatform } from "./platform.mjs";
import { registeredTask, TASK_SPEC_FIELDS } from "./task-spec.mjs";
import { safeFailureCode } from "./failure-codes.mjs";
import { isChildOutcomeStatus, isManagedWorkerBranch, safeChildDisposition } from "./child-disposition.mjs";
import { acceptGraphTask, blockGraphTask, claimTasks, markTaskVerifying, migrateTaskGraph, readyTaskIds, recordTaskGraphResult, rejectGraphTask, schedulerSummary, validateTaskGraph } from "./task-graph.mjs";

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
export const MAX_HEAD_CONSULTATIONS_WITHOUT_PROGRESS = 3;

export function coordinatorState(operation) {
  return { version: 1, operation_id: operation.operation_id, turns: 0, decisions: [], blocker: null };
}

export function operationBrief(operation, state, mission = undefined, graph = migrateTaskGraph(operation), registry = undefined, report = undefined, parallelLimit = DEFAULT_PARALLEL_TASKS) {
  const taskIds = operation.required_task_ids ?? [];
  const results = Object.fromEntries(taskIds.filter((id) => operation.task_results[id]).map((id) => [id, operation.task_results[id]]));
  const brief = { version: 1, operation_id: operation.operation_id, ...(mission ? { mission } : {}), ...(operation.planning ? { planning: true, allowed_policy_ids: operation.allowed_policy_ids } : {}),
    objective: operation.objective,
    ...(operation.constraints?.length ? { constraints: operation.constraints } : {}),
    ...(operation.task_intents && Object.keys(operation.task_intents).length ? { task_intents: operation.task_intents } : {}),
    ...(operation.planning ? {} : { required_task_ids: operation.required_task_ids, dependencies: operation.dependencies }),
    acceptance_criteria: operation.acceptance_criteria, criterion_evidence: operation.criterion_evidence,
    ...schedulerSummary(graph, operation, parallelLimit), rejected_task_ids: operation.rejected_task_ids,
    task_results: results, status: operation.status,
    ...(registry && Object.keys(registry.heads).length ? { heads: Object.values(registry.heads).map(({ head_id, domain, task_ids }) => ({ head_id, domain, task_ids })), ...(report ? { head_report: report } : {}) } : {}) };
  const packet = { OperationBrief: brief, CoordinatorState: state };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET) throw new Error("The bounded Coordinator packet exceeds its limit");
  return packet;
}

export function coordinatorPrompt(packet) {
  return ["The Coordinator must return one JSON CoordinatorDecision. Version: 1. Every decision must include version, operation_id, action, and a nonempty reason of at most 300 characters, including block and report actions.",
    packet.OperationBrief.planning ? "This is a planning Operation. Return plan_tasks with semantic Task proposals containing local_ref, role, scope, dependencies by local_ref, acceptance_criteria, and execution_policy_id from allowed_policy_ids. Do not supply Task IDs, TaskSpecs, permissions, shell commands, timeouts, isolation, or model settings." : "Harness uses each exact OperationBrief.task_intents value as the scope and OperationBrief.constraints as shared constraints. If a ready Task ID has no intent, return a Blocker. Harness resolves and validates trusted TaskSpecs; do not reconstruct mechanical fields from prose.",
    "The Scheduler ready_task_ids are the only TaskOrders available for dispatch after Harness materialization. A Dependency must be accepted before its dependent TaskOrder is ready.",
    "Actions: plan_tasks (planning only), dispatch, dispatch_batch, accept_task, reject_task, accept_criterion, consult_head, block, report. A HeadReport is advice. The Coordinator must issue a later decision to dispatch or accept.",
    "The Harness validates every decision. The Coordinator must not declare a Mission complete.",
    "For dispatch return task_id only. For dispatch_batch return task_ids containing 2 to available_slots distinct ready Task IDs. Harness resolves trusted registered TaskSpecs; never invent verification commands, owner, permission, or review fields. Harness decides Dependency truth and capacity. No Coordinator or Head turn runs while a Task wave is active.",
    "For accept_criterion return an exact Acceptance Criterion that is not already a key in criterion_evidence, plus evidence_refs from an accepted TaskResult. Never repeat an accepted criterion. The Operation completes automatically when every required TaskResult and Acceptance Criterion is accepted.",
    "For block return blocked_action, required_condition, optional registered task_id for a Scheduler Blocker, and question only if strategic authority is required.",
    "Return no raw Evidence or transcript. Preserve conditions and exact technical identifiers.",
    JSON.stringify(packet)].join("\n");
}

export function coordinatorRepairPrompt(packet, failure) {
  const reason = String(failure?.message ?? "CoordinatorDecision failed deterministic validation").replace(/[\r\n\t]+/g, " ").slice(0, 300);
  return `${coordinatorPrompt(packet)}\nRepair Required: The previous CoordinatorDecision failed deterministic validation (${reason}). Return only one corrected JSON CoordinatorDecision. Do not repeat non-JSON text.`;
}

function shape(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}
export function parseCoordinatorDecision(raw, operation) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8_000) throw new Error("CoordinatorDecision exceeds its size limit");
  let decision;
  try { decision = JSON.parse(raw); } catch { throw new Error("CoordinatorDecision is malformed JSON"); }
  const fields = ["version", "operation_id", "action", "reason", "task", "tasks", "task_id", "task_ids", "criterion", "evidence_refs", "blocked_action", "required_condition", "question", "head_id"];
  if (!shape(decision, fields) || decision.version !== 1 || decision.operation_id !== operation.operation_id || !["plan_tasks", "dispatch", "dispatch_batch", "accept_task", "reject_task", "accept_criterion", "block", "report", "consult_head"].includes(decision.action) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 300) throw new Error("CoordinatorDecision is invalid or belongs to a foreign Operation");
  const actionFields = { plan_tasks: ["tasks"], dispatch: ["task", "task_id"], dispatch_batch: ["tasks", "task_ids"], accept_task: ["task_id"], reject_task: ["task_id"], accept_criterion: ["criterion", "evidence_refs"], block: ["task_id", "blocked_action", "required_condition", "question"], report: [], consult_head: ["head_id"] };
  if (!shape(decision, ["version", "operation_id", "action", "reason", ...actionFields[decision.action]])) throw new Error("CoordinatorDecision contains fields outside its action");
  const required = (key) => typeof decision[key] === "string" && decision[key].trim() && decision[key].length <= 1000;
  if (decision.action === "consult_head" && !required("head_id")) throw new Error("Coordinator consultation requires a Head ID");
  if (decision.action === "plan_tasks") {
    if (!operation.planning || !Array.isArray(decision.tasks)) throw new Error("plan_tasks is valid only for a planning Operation");
    materializeOperation(operation, decision.tasks);
  } else if (operation.planning && !["block", "report"].includes(decision.action)) throw new Error("A planning Operation accepts only plan_tasks, block, or report");
  if (["dispatch", "dispatch_batch"].includes(decision.action)) {
    if ((decision.task && decision.task_id) || (decision.tasks && decision.task_ids)) throw new Error("Coordinator must choose one dispatch representation");
    const tasks = decision.action === "dispatch" ? [decision.task ?? { task_id: decision.task_id }] : decision.tasks ?? decision.task_ids?.map(task_id => ({ task_id }));
    if (!Array.isArray(tasks) || (decision.action === "dispatch_batch" && (tasks.length < 2 || tasks.length > MAX_PARALLEL_TASKS)) || new Set(tasks.map((task) => task?.task_id)).size !== tasks.length) throw new Error("Coordinator proposed an invalid TaskOrder batch");
    for (const task of tasks) {
      if (!shape(task, ["task_id", "owner", "scope", "permission", "verification", "constraints", "acceptance_criteria", "review_evidence", "review_profile"]) || !operation.required_task_ids.includes(task.task_id) || task.scope?.length > 1000 || task.verification?.length > 500) throw new Error("Coordinator proposed an unknown or oversized TaskOrder");
      const trusted = registeredTask(operation, task.task_id);
      if (Object.keys(task).length === 1) continue;
      const intent = operation.task_intents?.[task.task_id];
      if (typeof intent !== "string" || task.scope !== intent) throw new Error("Coordinator TaskOrder scope must match its registered Task intent");
      const constraints = operation.constraints ?? [];
      if (task.constraints !== undefined && (!Array.isArray(task.constraints) || task.constraints.length !== constraints.length || task.constraints.some((item, index) => item !== constraints[index]))) throw new Error("Coordinator TaskOrder cannot replace shared Operation Constraints");
      for (const key of TASK_SPEC_FIELDS) {
        if (JSON.stringify(task[key]) !== JSON.stringify(trusted[key])) throw new Error(`Coordinator cannot replace trusted TaskSpec field ${key}`);
      }
    }
  }
  if (["accept_task", "reject_task"].includes(decision.action) && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) throw new Error("Coordinator proposed an unknown TaskOrder ID");
  if (decision.action === "accept_criterion" && (!required("criterion") || !operation.acceptance_criteria.includes(decision.criterion) || Object.hasOwn(operation.criterion_evidence ?? {}, decision.criterion) || !Array.isArray(decision.evidence_refs) || !decision.evidence_refs.length || decision.evidence_refs.some((ref) => typeof ref !== "string"))) throw new Error(Object.hasOwn(operation.criterion_evidence ?? {}, decision.criterion) ? "Coordinator proposed an already accepted Operation Acceptance Criterion" : "Coordinator proposed an invalid Operation Acceptance Criterion");
  if (decision.action === "block" && (!required("blocked_action") || !required("required_condition") || (decision.task_id !== undefined && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) || (decision.question !== undefined && !required("question")))) throw new Error("Coordinator Blocker requires the blocked action and required condition");
  return decision;
}

export function operationReport(operation, state, blocker = undefined, question = undefined, graph = undefined) {
  const status = operation.status === "complete" ? "complete" : "blocked";
  const taskIds = operation.required_task_ids ?? [];
  const major_findings = operation.accepted_task_ids.flatMap((id) => (operation.task_results[id]?.findings ?? []).filter((finding) => finding.verification_status === "verified")).slice(0, 5).map(({ statement, criterion, verifier, source_role, verification_status }) => ({ statement, criterion, verifier, source_role, verification_status }));
  const blockedIds = operation.planning ? [] : graph ? schedulerSummary(graph, operation).blocked_task_ids : taskIds.filter((id) => operation.task_results[id]?.verification_status === "blocked");
  // Promote Scheduler state only. A child notification and raw execution data
  // cannot become a TaskResult or a Commander-facing Blocker.
  const scheduler_blockers = graph ? blockedIds.slice(0, 32).map((id) => {
    const { task_id, blocked_action, required_condition, failure_code, child_disposition, child_status } = graph.nodes[id].blocker;
    return { task_id, blocked_action, required_condition, ...(failure_code ? { failure_code: safeFailureCode(failure_code) } : {}), ...(child_disposition ? { child_disposition: safeChildDisposition(child_disposition) } : {}), ...(child_status ? { child_status } : {}) };
  }) : [];
  const failure_codes = taskIds.flatMap((id) => {
    const code = operation.task_results[id]?.failure_code;
    return code ? [{ task_id: id, failure_code: safeFailureCode(code) }] : [];
  }).slice(0, 32);
  const report = { version: 1, ...(operation.mission_id ? { mission_id: operation.mission_id } : {}), operation_id: operation.operation_id, status,
    ...(state.failure_code ? { failure_code: safeFailureCode(state.failure_code) } : {}),
    ...(failure_codes.length ? { failure_codes } : {}),
    summary: status === "complete" ? "The Coordinator accepted all required TaskResults and Operation Acceptance Criteria. The Commander must evaluate the Mission Definition of Done."
      : "The Coordinator cannot continue the Operation until the stated Blocker is removed.",
    accepted_task_ids: [...operation.accepted_task_ids], blocked_task_ids: blockedIds, scheduler_blockers,
    major_findings, blocker: status === "complete" ? null : blocker ?? "The Coordinator cannot continue the Operation until the Commander replans after the turn limit.",
    ...(question ? { escalation: { type: "strategic_decision_required", operation_id: operation.operation_id, question, blocker } } : {}),
    commander_action_required: true };
  while (Buffer.byteLength(JSON.stringify(report)) > 24_000 && (report.major_findings.length || report.scheduler_blockers.length || failure_codes.length)) {
    if (report.major_findings.length) report.major_findings.pop();
    else if (report.scheduler_blockers.length) report.scheduler_blockers.pop();
    else failure_codes.pop();
  }
  if (Buffer.byteLength(JSON.stringify(report)) > 24_000) throw new Error("The bounded OperationReport exceeds its limit");
  return report;
}

export async function runOperation(initial, callbacks, { mission, state = coordinatorState(initial), graph = migrateTaskGraph(initial), cwd = process.cwd(), signal, registry, headStates = {}, parallelLimit = DEFAULT_PARALLEL_TASKS } = {}) {
  assertSupportedPlatform();
  if (!Number.isInteger(parallelLimit) || parallelLimit < 1 || parallelLimit > MAX_PARALLEL_TASKS) throw new Error("Invalid Harness parallel limit");
  let operation = initial;
  validateTaskGraph(graph, operation);
  if (registry) validateHeadRegistry(registry, operation);
  let consultations = state.consultations_since_progress ?? 0;
  let latestReport;
  const restoredTurns = Number.isSafeInteger(state.turns) && state.turns >= 0 ? Math.min(state.turns, MAX_COORDINATOR_TURNS) : 0;
  state = { version: 1, operation_id: operation.operation_id, turns: restoredTurns, decisions: (state.decisions ?? []).slice(-7), blocker: state.blocker ?? null, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: consultations } : {}) };
  let persistenceFailed = false;
  const save = () => {
    try { callbacks.save?.(operation, state, graph, headStates); }
    catch { persistenceFailed = true; throw Object.assign(new Error("Harness state persistence failed"), { code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" }); }
  };
  const beginTurn = () => {
    if (state.turns >= MAX_COORDINATOR_TURNS) return false;
    state = { ...state, turns: state.turns + 1 };
    try { save(); return true; }
    catch { state = { ...state, turns: state.turns - 1 }; return false; }
  };
  const stop = (blocker, question, failureCode = undefined) => {
    state = { ...state, blocker, ...(persistenceFailed ? { failure_code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" } : failureCode ? { failure_code: safeFailureCode(failureCode) } : {}) };
    try { save(); } catch { state = { ...state, failure_code: "HARNESS_SCHEDULER_PERSISTENCE_FAILED" }; }
    return operationReport(operation, state, blocker, question, graph);
  };
  for (; state.turns < MAX_COORDINATOR_TURNS && operation.status !== "complete";) {
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
    if (!beginTurn()) return stop("The Coordinator cannot continue the Operation until it can persist a bounded Coordinator turn.", undefined, "HARNESS_SCHEDULER_REJECTED");
    let raw;
    try { raw = await callbacks.turn(coordinatorPrompt(operationBrief(operation, state, mission, graph, registry, latestReport, parallelLimit))); }
    catch (error) { return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until a new Coordinator turn is available.", undefined, signal?.aborted ? "HARNESS_CANCELLED" : safeFailureCode(error?.code)); }
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
    let decision;
    try { decision = parseCoordinatorDecision(raw, operation); }
    catch (failure) {
      if (MAX_COORDINATOR_REPAIRS_PER_DECISION < 1 || !beginTurn()) return stop("The Coordinator cannot continue the Operation until it returns a valid CoordinatorDecision.", undefined, "HARNESS_COORDINATOR_DECISION_INVALID");
      try { raw = await callbacks.turn(coordinatorRepairPrompt(operationBrief(operation, state, mission, graph, registry, latestReport, parallelLimit), failure)); }
      catch (error) { return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until a new Coordinator turn is available.", undefined, signal?.aborted ? "HARNESS_CANCELLED" : safeFailureCode(error?.code)); }
      if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
      try { decision = parseCoordinatorDecision(raw, operation); }
      catch { return stop("The Coordinator cannot continue the Operation until it returns a valid CoordinatorDecision.", undefined, "HARNESS_COORDINATOR_DECISION_INVALID"); }
    }
    if (state.failure_code) {
      const { failure_code: _previousFailure, ...withoutFailureCode } = state;
      state = withoutFailureCode;
    }
    state = { ...state, blocker: null, decisions: [...state.decisions.slice(-6), { action: decision.action, reason: decision.reason }] };
    try {
      if (decision.action === "plan_tasks") {
        const planned = materializeOperation(operation, decision.tasks);
        operation = planned.operation;
        graph = planned.graph;
        save();
      } else if (decision.action === "consult_head") {
        if (!registry?.heads[decision.head_id] || !callbacks.headTurn) throw new Error("Coordinator selected an unregistered Head");
        if (consultations >= MAX_HEAD_CONSULTATIONS_WITHOUT_PROGRESS) return stop("The Coordinator cannot consult a Head until the TaskGraph or Operation makes progress.");
        const previous = headStates[decision.head_id] ?? headState(operation.operation_id, decision.head_id);
        const rawHead = await callbacks.headTurn(headPrompt(domainBrief(operation, graph, registry, decision.head_id, previous)), decision.head_id);
        if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.", undefined, "HARNESS_CANCELLED");
        const proposal = parseHeadDecision(rawHead, operation, graph, registry, decision.head_id);
        latestReport = headReport(proposal, registry);
        headStates = { ...headStates, [decision.head_id]: { ...previous, turns: previous.turns + 1, decisions: [...previous.decisions.slice(-2), { action: proposal.action, ...(proposal.task_id ? { task_id: proposal.task_id } : {}), reason: proposal.reason }], blocker: proposal.action === "block" ? proposal.required_condition : null } };
        consultations++;
        state = { ...state, consultations_since_progress: consultations };
      } else if (decision.action === "dispatch" || decision.action === "dispatch_batch") {
        const tasks = decision.action === "dispatch" ? [decision.task ?? { task_id: decision.task_id }] : decision.tasks ?? decision.task_ids.map(task_id => ({ task_id }));
        const ids = tasks.map((task) => task.task_id);
        const taskOrders = tasks.map(task => registeredTask(operation, task.task_id));
        if (decision.action === "dispatch_batch" && ids.length > parallelLimit) throw new Error("Coordinator batch exceeds Harness capacity");
        if (ids.some((id) => graph.nodes[id].scheduler_status === "exhausted")) return stop("The Scheduler cannot dispatch this TaskOrder until the Commander replans after the retry limit.");
        const previousGraph = graph;
        graph = claimTasks(graph, operation, ids, parallelLimit);
        consultations = 0; latestReport = undefined; state = { ...state, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: 0 } : {}) };
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
            // A rejected dispatch has an unknown child outcome. Never refund an
            // attempt or leave a running node; siblings retain their own results.
            if (graph.nodes[task.task_id].scheduler_status === "running") {
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
        if (outcomes.some((outcome) => outcome.status === "rejected")) return stop("The Coordinator cannot continue until it checks the blocked TaskOrder outcomes.");
      } else if (decision.action === "accept_task") {
        const nextOperation = acceptTaskResult(operation, decision.task_id);
        const nextGraph = acceptGraphTask(graph, operation, nextOperation, decision.task_id);
        operation = nextOperation; graph = nextGraph;
        consultations = 0; latestReport = undefined; state = { ...state, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: 0 } : {}) };
      } else if (decision.action === "reject_task") {
        const nextOperation = rejectTaskResult(operation, decision.task_id);
        const nextGraph = rejectGraphTask(graph, nextOperation, decision.task_id);
        operation = nextOperation; graph = nextGraph;
        consultations = 0; latestReport = undefined; state = { ...state, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: 0 } : {}) };
      }
      else if (decision.action === "accept_criterion") {
        if (decision.evidence_refs.some((ref) => !operation.accepted_task_ids.some((id) => operation.task_results[id]?.evidence_refs?.includes(ref)))) throw new Error("The Coordinator supplied Evidence outside accepted TaskResults");
        operation = acceptOperationCriterion(operation, decision.criterion, decision.evidence_refs, cwd);
        consultations = 0; latestReport = undefined; state = { ...state, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: 0 } : {}) };
      } else if (decision.action === "block") {
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
  return operationReport(operation, state, undefined, undefined, graph);
}
