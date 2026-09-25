import { acceptOperationCriterion, acceptTaskResult, recordTaskResult, rejectTaskResult } from "./operation.mjs";
import { validateTask } from "./coordinator.mjs";

export const COORDINATOR_ENTRY = "pi-harness-coordinator-state";
export const MAX_COORDINATOR_TURNS = 12;
const MAX_DISPATCHES = 2;
const MAX_PACKET = 16_000;

export function coordinatorState(operation) {
  return { version: 1, operation_id: operation.operation_id, turns: 0, dispatch_counts: {}, decisions: [], blocker: null };
}

export function operationBrief(operation, state, mission = undefined) {
  const results = Object.fromEntries(operation.required_task_ids.filter((id) => operation.task_results[id]).map((id) => [id, operation.task_results[id]]));
  const brief = { version: 1, operation_id: operation.operation_id, ...(mission ? { mission } : {}), objective: operation.objective,
    required_task_ids: operation.required_task_ids, dependencies: operation.dependencies,
    acceptance_criteria: operation.acceptance_criteria, criterion_evidence: operation.criterion_evidence,
    accepted_task_ids: operation.accepted_task_ids, rejected_task_ids: operation.rejected_task_ids,
    pending_task_ids: operation.required_task_ids.filter((id) => !operation.accepted_task_ids.includes(id)),
    task_results: results, status: operation.status };
  const packet = { OperationBrief: brief, CoordinatorState: state };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET) throw new Error("The bounded Coordinator packet exceeds its limit");
  return packet;
}

export function coordinatorPrompt(packet) {
  return ["The Coordinator must return one JSON CoordinatorDecision. Version: 1.",
    "If a Dependency is not accepted, the Coordinator must not dispatch or accept the dependent TaskOrder.",
    "The Harness validates every decision. The Coordinator must not declare a Mission complete.",
    "Actions: dispatch, accept_task, reject_task, accept_criterion, block, report.",
    "For dispatch return task {task_id, owner, scope, permission, verification, constraints?, acceptance_criteria?, review_evidence?}.",
    "For accept_criterion return criterion and evidence_refs. For block return blocked_action, required_condition and question only if strategic authority is required.",
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
  const fields = ["version", "operation_id", "action", "reason", "task", "task_id", "criterion", "evidence_refs", "blocked_action", "required_condition", "question"];
  if (!shape(decision, fields) || decision.version !== 1 || decision.operation_id !== operation.operation_id || !["dispatch", "accept_task", "reject_task", "accept_criterion", "block", "report"].includes(decision.action) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 300) throw new Error("CoordinatorDecision is invalid or belongs to a foreign Operation");
  const actionFields = { dispatch: ["task"], accept_task: ["task_id"], reject_task: ["task_id"], accept_criterion: ["criterion", "evidence_refs"], block: ["blocked_action", "required_condition", "question"], report: [] };
  if (!shape(decision, ["version", "operation_id", "action", "reason", ...actionFields[decision.action]])) throw new Error("CoordinatorDecision contains fields outside its action");
  const required = (key) => typeof decision[key] === "string" && decision[key].trim() && decision[key].length <= 1000;
  if (decision.action === "dispatch") {
    if (!shape(decision.task, ["task_id", "owner", "scope", "permission", "verification", "constraints", "acceptance_criteria", "review_evidence"]) || !operation.required_task_ids.includes(decision.task.task_id) || decision.task.scope?.length > 1000 || decision.task.verification?.length > 500) throw new Error("Coordinator proposed an unknown or oversized TaskOrder");
    validateTask(decision.task);
  }
  if (["accept_task", "reject_task"].includes(decision.action) && (!required("task_id") || !operation.required_task_ids.includes(decision.task_id))) throw new Error("Coordinator proposed an unknown TaskOrder ID");
  if (decision.action === "accept_criterion" && (!required("criterion") || !operation.acceptance_criteria.includes(decision.criterion) || !Array.isArray(decision.evidence_refs) || !decision.evidence_refs.length || decision.evidence_refs.some((ref) => typeof ref !== "string"))) throw new Error("Coordinator proposed an invalid Operation Acceptance Criterion");
  if (decision.action === "block" && (!required("blocked_action") || !required("required_condition") || (decision.question !== undefined && !required("question")))) throw new Error("Coordinator Blocker requires the blocked action and required condition");
  return decision;
}

export function operationReport(operation, state, blocker = undefined, question = undefined) {
  const status = operation.status === "complete" ? "complete" : "blocked";
  const major_findings = operation.accepted_task_ids.flatMap((id) => (operation.task_results[id]?.findings ?? []).filter((finding) => finding.verification_status === "verified")).slice(0, 5);
  const report = { version: 1, operation_id: operation.operation_id, status,
    summary: status === "complete" ? "The Coordinator accepted all required TaskResults and Operation Acceptance Criteria. The Commander must evaluate the Mission Definition of Done."
      : "The Coordinator cannot continue the Operation until the stated Blocker is removed.",
    accepted_task_ids: [...operation.accepted_task_ids], blocked_task_ids: operation.required_task_ids.filter((id) => operation.task_results[id]?.verification_status === "blocked"),
    major_findings, blocker: status === "complete" ? null : blocker ?? "The Coordinator cannot continue the Operation until the Commander replans after the turn limit.",
    ...(question ? { escalation: { type: "strategic_decision_required", operation_id: operation.operation_id, question, blocker } } : {}),
    commander_action_required: true };
  while (Buffer.byteLength(JSON.stringify(report)) > 24_000 && report.major_findings.length) report.major_findings.pop();
  if (Buffer.byteLength(JSON.stringify(report)) > 24_000) throw new Error("The bounded OperationReport exceeds its limit");
  return report;
}

export async function runOperation(initial, callbacks, { mission, state = coordinatorState(initial), cwd = process.cwd(), signal } = {}) {
  let operation = initial;
  const save = () => callbacks.save?.(operation, state);
  const stop = (blocker, question) => {
    state = { ...state, blocker };
    save();
    return operationReport(operation, state, blocker, question);
  };
  for (; state.turns < MAX_COORDINATOR_TURNS && operation.status !== "complete";) {
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
    let raw;
    try { raw = await callbacks.turn(coordinatorPrompt(operationBrief(operation, state, mission))); }
    catch { return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until a new Coordinator turn is available."); }
    if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
    let decision;
    try { decision = parseCoordinatorDecision(raw, operation); }
    catch { return stop("The Coordinator cannot continue the Operation until it returns a valid CoordinatorDecision."); }
    state = { ...state, blocker: null, turns: state.turns + 1, decisions: [...state.decisions.slice(-6), { action: decision.action, reason: decision.reason }] };
    try {
      if (decision.action === "dispatch") {
        const task = decision.task;
        if (operation.accepted_task_ids.includes(task.task_id) || (operation.dependencies[task.task_id] ?? []).some((id) => !operation.accepted_task_ids.includes(id))) throw new Error("The TaskOrder is accepted or its Dependency is not accepted.");
        const count = state.dispatch_counts[task.task_id] ?? 0;
        if (count >= MAX_DISPATCHES) return stop("The Coordinator cannot dispatch this TaskOrder again until the Commander replans after the retry limit.");
        state = { ...state, dispatch_counts: { ...state.dispatch_counts, [task.task_id]: count + 1 } }; save();
        const result = await callbacks.dispatch({ ...task, operation_id: operation.operation_id });
        if (signal?.aborted) return stop("The Coordinator cannot continue this Operation until the Commander restarts the cancelled run.");
        operation = recordTaskResult(operation, result);
      } else if (decision.action === "accept_task") operation = acceptTaskResult(operation, decision.task_id);
      else if (decision.action === "reject_task") operation = rejectTaskResult(operation, decision.task_id);
      else if (decision.action === "accept_criterion") {
        if (decision.evidence_refs.some((ref) => !operation.accepted_task_ids.some((id) => operation.task_results[id]?.evidence_refs?.includes(ref)))) throw new Error("The Coordinator supplied Evidence outside accepted TaskResults");
        operation = acceptOperationCriterion(operation, decision.criterion, decision.evidence_refs, cwd);
      } else if (decision.action === "block") return stop(`The Coordinator cannot ${decision.blocked_action} until ${decision.required_condition}.`, decision.question);
      else return stop("The Coordinator cannot continue the Operation until the Commander resolves the missing executable action.");
    } catch (error) {
      return stop(signal?.aborted ? "The Coordinator cannot continue this Operation until the Commander restarts the cancelled run." : "The Coordinator cannot continue the Operation until it corrects the rejected CoordinatorDecision or replans the failed TaskOrder.");
    } finally { save(); }
  }
  if (operation.status !== "complete") return stop("The Coordinator cannot continue the Operation until the Commander replans after the turn limit.");
  return operationReport(operation, state);
}
