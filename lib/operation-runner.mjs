import { domainBrief, headPrompt, headReport, headState, parseHeadDecision, validateHeadRegistry } from "./domain-head.mjs";
import { acceptOperationCriterion, acceptTaskResult, recordTaskResult, rejectTaskResult } from "./operation.mjs";
import { validateTask } from "./coordinator.mjs";
import { acceptGraphTask, blockGraphTask, claimTasks, migrateTaskGraph, readyTaskIds, recordTaskGraphResult, rejectGraphTask, schedulerSummary, validateTaskGraph } from "./task-graph.mjs";

export const COORDINATOR_ENTRY = "pi-harness-coordinator-state";
export const MAX_COORDINATOR_TURNS = 12;
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
  const results = Object.fromEntries(operation.required_task_ids.filter((id) => operation.task_results[id]).map((id) => [id, operation.task_results[id]]));
  const brief = { version: 1, operation_id: operation.operation_id, ...(mission ? { mission } : {}), objective: operation.objective,
    required_task_ids: operation.required_task_ids, dependencies: operation.dependencies,
    acceptance_criteria: operation.acceptance_criteria, criterion_evidence: operation.criterion_evidence,
    ...schedulerSummary(graph, operation, parallelLimit), rejected_task_ids: operation.rejected_task_ids,
    task_results: results, status: operation.status,
    ...(registry && Object.keys(registry.heads).length ? { heads: Object.values(registry.heads).map(({ head_id, domain, task_ids }) => ({ head_id, domain, task_ids })), ...(report ? { head_report: report } : {}) } : {}) };
  const packet = { OperationBrief: brief, CoordinatorState: state };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET) throw new Error("The bounded Coordinator packet exceeds its limit");
  return packet;
}

export function coordinatorPrompt(packet) {
  return ["The Coordinator must return one JSON CoordinatorDecision. Version: 1.",
    "The Scheduler ready_task_ids are the only TaskOrders available for dispatch. A Dependency must be accepted before its dependent TaskOrder is ready.",
    "The Harness validates every decision. The Coordinator must not declare a Mission complete.",
    "Actions: dispatch, dispatch_batch, accept_task, reject_task, accept_criterion, consult_head, block, report. A HeadReport is advice. The Coordinator must issue a later decision to dispatch or accept.",
    "For dispatch return task {task_id, owner, scope, permission, verification, constraints?, acceptance_criteria?, review_evidence?, review_profile?}. For dispatch_batch return tasks with 2 to available_slots distinct ready TaskOrders using the same fields. Harness decides Dependency truth and capacity. No Coordinator or Head turn runs while a Task wave is active.",
    "For accept_criterion return criterion and evidence_refs. For block return blocked_action, required_condition, optional registered task_id for a Scheduler Blocker, and question only if strategic authority is required.",
    "Return no raw Evidence or transcript. Preserve conditions and exact technical identifiers.",
    JSON.stringify(packet)].join("\n");
}

function shape(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}
export function parseCoordinatorDecision(raw, operation) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8_000) throw new Error("CoordinatorDecision exceeds its size limit");
  let decision;
  try { decision = JSON.parse(raw); } catch { throw new Error("CoordinatorDecision is malformed JSON"); }
  const fields = ["version", "operation_id", "action", "reason", "task", "tasks", "task_id", "criterion", "evidence_refs", "blocked_action", "required_condition", "question", "head_id"];
  if (!shape(decision, fields) || decision.version !== 1 || decision.operation_id !== operation.operation_id || !["dispatch", "dispatch_batch", "accept_task", "reject_task", "accept_criterion", "block", "report", "consult_head"].includes(decision.action) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 300) throw new Error("CoordinatorDecision is invalid or belongs to a foreign Operation");
  const actionFields = { dispatch: ["task"], dispatch_batch: ["tasks"], accept_task: ["task_id"], reject_task: ["task_id"], accept_criterion: ["criterion", "evidence_refs"], block: ["task_id", "blocked_action", "required_condition", "question"], report: [], consult_head: ["head_id"] };
  if (!shape(decision, ["version", "operation_id", "action", "reason", ...actionFields[decision.action]])) throw new Error("CoordinatorDecision contains fields outside its action");
  const required = (key) => typeof decision[key] === "string" && decision[key].trim() && decision[key].length <= 1000;
  if (decision.action === "consult_head" && !required("head_id")) throw new Error("Coordinator consultation requires a Head ID");
  if (["dispatch", "dispatch_batch"].includes(decision.action)) {
    const tasks = decision.action === "dispatch" ? [decision.task] : decision.tasks;
    if (!Array.isArray(tasks) || (decision.action === "dispatch_batch" && (tasks.length < 2 || tasks.length > MAX_PARALLEL_TASKS)) || new Set(tasks.map((task) => task?.task_id)).size !== tasks.length) throw new Error("Coordinator proposed an invalid TaskOrder batch");
    for (const task of tasks) {
      if (!shape(task, ["task_id", "owner", "scope", "permission", "verification", "constraints", "acceptance_criteria", "review_evidence", "review_profile"]) || !operation.required_task_ids.includes(task.task_id) || task.scope?.length > 1000 || task.verification?.length > 500) throw new Error("Coordinator proposed an unknown or oversized TaskOrder");
      validateTask(task);
    }
  }
  if (["accept_task", "reject_task"].includes(decision.action) && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) throw new Error("Coordinator proposed an unknown TaskOrder ID");
  if (decision.action === "accept_criterion" && (!required("criterion") || !operation.acceptance_criteria.includes(decision.criterion) || !Array.isArray(decision.evidence_refs) || !decision.evidence_refs.length || decision.evidence_refs.some((ref) => typeof ref !== "string"))) throw new Error("Coordinator proposed an invalid Operation Acceptance Criterion");
  if (decision.action === "block" && (!required("blocked_action") || !required("required_condition") || (decision.task_id !== undefined && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) || (decision.question !== undefined && !required("question")))) throw new Error("Coordinator Blocker requires the blocked action and required condition");
  return decision;
}

export function operationReport(operation, state, blocker = undefined, question = undefined, graph = undefined) {
  const status = operation.status === "complete" ? "complete" : "blocked";
  const major_findings = operation.accepted_task_ids.flatMap((id) => (operation.task_results[id]?.findings ?? []).filter((finding) => finding.verification_status === "verified")).slice(0, 5);
  const report = { version: 1, operation_id: operation.operation_id, status,
    summary: status === "complete" ? "The Coordinator accepted all required TaskResults and Operation Acceptance Criteria. The Commander must evaluate the Mission Definition of Done."
      : "The Coordinator cannot continue the Operation until the stated Blocker is removed.",
    accepted_task_ids: [...operation.accepted_task_ids], blocked_task_ids: graph ? schedulerSummary(graph, operation).blocked_task_ids : operation.required_task_ids.filter((id) => operation.task_results[id]?.verification_status === "blocked"),
    major_findings, blocker: status === "complete" ? null : blocker ?? "The Coordinator cannot continue the Operation until the Commander replans after the turn limit.",
    ...(question ? { escalation: { type: "strategic_decision_required", operation_id: operation.operation_id, question, blocker } } : {}),
    commander_action_required: true };
  while (Buffer.byteLength(JSON.stringify(report)) > 24_000 && report.major_findings.length) report.major_findings.pop();
  if (Buffer.byteLength(JSON.stringify(report)) > 24_000) throw new Error("The bounded OperationReport exceeds its limit");
  return report;
}

export async function runOperation(initial, callbacks, { mission, state = coordinatorState(initial), graph = migrateTaskGraph(initial), cwd = process.cwd(), signal, registry, headStates = {}, parallelLimit = DEFAULT_PARALLEL_TASKS } = {}) {
  if (!Number.isInteger(parallelLimit) || parallelLimit < 1 || parallelLimit > MAX_PARALLEL_TASKS) throw new Error("Invalid Harness parallel limit");
  let operation = initial;
  validateTaskGraph(graph, operation);
  if (registry) validateHeadRegistry(registry, operation);
  let consultations = state.consultations_since_progress ?? 0;
  let latestReport;
  state = { version: 1, operation_id: operation.operation_id, turns: state.turns ?? 0, decisions: (state.decisions ?? []).slice(-7), blocker: state.blocker ?? null, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: consultations } : {}) };
  const save = () => callbacks.save?.(operation, state, graph, headStates);
  const stop = (blocker, question) => {
    state = { ...state, blocker };
    save();
    return operationReport(operation, state, blocker, question, graph);
  };
  for (; state.turns < MAX_COORDINATOR_TURNS && operation.status !== "complete";) {
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
    let raw;
    try { raw = await callbacks.turn(coordinatorPrompt(operationBrief(operation, state, mission, graph, registry, latestReport, parallelLimit))); }
    catch { return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until a new Coordinator turn is available."); }
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
    let decision;
    try { decision = parseCoordinatorDecision(raw, operation); }
    catch { return stop("The Coordinator cannot continue the Operation until it returns a valid CoordinatorDecision."); }
    state = { ...state, blocker: null, turns: state.turns + 1, decisions: [...state.decisions.slice(-6), { action: decision.action, reason: decision.reason }] };
    try {
      if (decision.action === "consult_head") {
        if (!registry?.heads[decision.head_id] || !callbacks.headTurn) throw new Error("Coordinator selected an unregistered Head");
        if (consultations >= MAX_HEAD_CONSULTATIONS_WITHOUT_PROGRESS) return stop("The Coordinator cannot consult a Head until the TaskGraph or Operation makes progress.");
        const previous = headStates[decision.head_id] ?? headState(operation.operation_id, decision.head_id);
        const rawHead = await callbacks.headTurn(headPrompt(domainBrief(operation, graph, registry, decision.head_id, previous)), decision.head_id);
        if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
        const proposal = parseHeadDecision(rawHead, operation, graph, registry, decision.head_id);
        latestReport = headReport(proposal, registry);
        headStates = { ...headStates, [decision.head_id]: { ...previous, turns: previous.turns + 1, decisions: [...previous.decisions.slice(-2), { action: proposal.action, ...(proposal.task_id ? { task_id: proposal.task_id } : {}), reason: proposal.reason }], blocker: proposal.action === "block" ? proposal.required_condition : null } };
        consultations++;
        state = { ...state, consultations_since_progress: consultations };
      } else if (decision.action === "dispatch" || decision.action === "dispatch_batch") {
        const tasks = decision.action === "dispatch" ? [decision.task] : decision.tasks;
        const ids = tasks.map((task) => task.task_id);
        if (decision.action === "dispatch_batch" && ids.length > parallelLimit) throw new Error("Coordinator batch exceeds Harness capacity");
        if (ids.some((id) => graph.nodes[id].scheduler_status === "exhausted")) return stop("The Scheduler cannot dispatch this TaskOrder until the Commander replans after the retry limit.");
        const previousGraph = graph;
        graph = claimTasks(graph, operation, ids, parallelLimit);
        consultations = 0; latestReport = undefined; state = { ...state, ...(registry && Object.keys(registry.heads).length ? { consultations_since_progress: 0 } : {}) };
        try { save(); } // One durable running snapshot for every selected Task, before any spawn.
        catch { graph = previousGraph; throw new Error("The Scheduler could not persist the atomic Task wave claim"); }
        // JS runs each transition and synchronous persistence without an await.
        // Each pipeline settles independently; the Coordinator waits for the wave.
        const outcomes = await Promise.allSettled(tasks.map(async (task) => {
          try {
            const result = await callbacks.dispatch({ ...task, operation_id: operation.operation_id });
            if (signal?.aborted) throw new Error("The Task wave was cancelled");
            const nextOperation = recordTaskResult(operation, result);
            const nextGraph = recordTaskGraphResult(graph, nextOperation, task.task_id);
            operation = nextOperation; graph = nextGraph;
            save();
          } catch {
            // A rejected dispatch has an unknown child outcome. Never refund an
            // attempt or leave a running node; siblings retain their own results.
            if (graph.nodes[task.task_id].scheduler_status === "running") {
              graph = blockGraphTask(graph, operation, task.task_id, "resume an interrupted TaskOrder", "the Coordinator checks the unknown child outcome");
              save();
            }
            throw new Error("The Task pipeline did not produce a safely persisted TaskResult");
          }
        }));
        if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
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
      else return stop("The Coordinator cannot continue the Operation until the Commander resolves the missing executable action.");
    } catch (error) {
      return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Scheduler rejected the CoordinatorDecision or the TaskOrder failed; the Coordinator cannot continue until it replans the Operation.");
    } finally { save(); }
  }
  if (operation.status !== "complete") return stop("The Coordinator cannot continue the Operation until the Commander replans after the turn limit.");
  return operationReport(operation, state, undefined, undefined, graph);
}
