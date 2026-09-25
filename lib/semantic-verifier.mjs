import { readEvidence, storeEvidence } from "./evidence.mjs";
import { truncateText } from "./worker-gate.mjs";
import { semanticCriteria } from "./verifier.mjs";

const MAX_PACKET_BYTES = 24_000;
const MAX_REVIEW_BYTES = 8_000;
const STATUSES = new Set(["passed", "failed", "blocked", "not_checked"]);

function blocked(order, reason, evidenceRefs = []) {
  return { version: 1, task_id: order.task_id, verifier: "semantic", status: "blocked", criteria: semanticCriteria(order).map((criterion) => ({ criterion, status: "not_checked", finding: reason, evidence_refs: [] })), summary: reason, evidence_refs: evidenceRefs };
}

// Select a single relevant Evidence kind, never the entire execution record.
// The Reviewer receives raw bytes from the Store, not file paths or store access.
export function verificationPacket(order, result, cwd) {
  const candidates = result.evidence_refs.map((reference) => readEvidence(reference, cwd));
  const criteria = semanticCriteria(order);
  const criterion_evidence = Object.create(null);
  const selected = new Map();
  for (const criterion of criteria) {
    const kind = order.review_evidence?.[criterion] ?? (order.role === "worker" ? "diff" : "report");
    const item = candidates.find(({ metadata }) => metadata.kind === kind && metadata.task_id === order.task_id);
    if (!item) throw new Error("The required Evidence is not available for semantic verification.");
    if (item.metadata.truncated) throw new Error("The selected Evidence is truncated. The Verifier cannot decide the Acceptance Criteria.");
    criterion_evidence[criterion] = item.metadata.reference;
    selected.set(item.metadata.reference, { reference: item.metadata.reference, kind, content: item.content.toString("utf8") });
  }
  const packet = {
    version: 1, task_id: order.task_id, objective: order.objective,
    acceptance_criteria: criteria,
    changed_paths: result.changed_paths,
    constraints: order.constraints,
    criterion_evidence,
    evidence: [...selected.values()],
  };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET_BYTES) throw new Error("The VerificationOrder exceeds the review packet limit.");
  return packet;
}

export function formatVerificationOrder(packet) {
  return [
    "VerificationOrder: The semantic Verifier must check each Acceptance Criterion against only the selected Evidence.",
    "The semantic Verifier must not change the TaskOrder or accept an Operation.",
    "If Evidence is insufficient, return blocked or not_checked with a reason.",
    "Return only JSON: {version:1,task_id,status,criteria:[{criterion,status,finding,evidence_refs}],summary}.",
    "Use passed, failed, blocked, or not_checked for each criterion. State the actor and uncertainty explicitly.",
    JSON.stringify(packet),
  ].join("\n");
}

export function validateSemanticReview(order, packet, raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("The semantic Verifier returned malformed JSON."); }
  const refs = packet.evidence.map((item) => item.reference);
  if (parsed?.version !== 1 || parsed.task_id !== order.task_id || !Array.isArray(parsed.criteria) || parsed.criteria.length !== semanticCriteria(order).length || typeof parsed.summary !== "string" || !parsed.summary.trim() || parsed.summary.length > 1500) throw new Error("The semantic Verifier returned an invalid result.");
  for (let index = 0; index < parsed.criteria.length; index++) {
    const item = parsed.criteria[index];
    if (item?.criterion !== semanticCriteria(order)[index] || !STATUSES.has(item.status) || typeof item.finding !== "string" || !item.finding.trim() || item.finding.length > 1500 || !Array.isArray(item.evidence_refs) || item.evidence_refs.some((ref) => ref !== packet.criterion_evidence[item.criterion]) || (item.status === "passed" && !item.evidence_refs.length)) throw new Error("The semantic Verifier returned an invalid criterion result.");
  }
  const status = parsed.criteria.some((item) => item.status === "failed") ? "failed"
    : parsed.criteria.some((item) => item.status !== "passed") ? "blocked" : "verified";
  if (parsed.status !== status) throw new Error("The semantic Verifier returned a contradictory status.");
  return {
    version: 1, task_id: order.task_id, verifier: "semantic", status,
    criteria: parsed.criteria.map(({ criterion, status: criterionStatus, finding, evidence_refs }) => ({ criterion, status: criterionStatus, finding, evidence_refs })),
    summary: status === "verified" ? "The semantic Verifier passed all selected Acceptance Criteria."
      : status === "failed" ? "The semantic Verifier failed an Acceptance Criterion."
        : "The semantic Verifier could not check all Acceptance Criteria.",
    evidence_refs: refs,
  };
}

export async function reviewTask(order, result, cwd, run) {
  let packet;
  try { packet = verificationPacket(order, result, cwd); }
  catch { return blocked(order, "The selected Evidence is missing, invalid, or too large."); }
  let event;
  try { event = await run(formatVerificationOrder(packet)); }
  catch { return blocked(order, "The semantic Verifier did not return a result.", packet.evidence.map((item) => item.reference)); }
  const raw = truncateText(event?.result ?? "", MAX_REVIEW_BYTES);
  let reviewRef;
  try { reviewRef = storeEvidence({ cwd, taskId: order.task_id, kind: "semantic_review", content: raw.text, truncated: raw.truncated }).reference; }
  catch { return blocked(order, "The Evidence Store could not persist the semantic Verifier result."); }
  const refs = [...packet.evidence.map((item) => item.reference), reviewRef];
  if (!(["completed", "steered"].includes(event?.status)) || raw.truncated) return blocked(order, "The semantic Verifier stopped or returned a truncated result.", refs);
  try { return { ...validateSemanticReview(order, packet, raw.text), evidence_refs: refs }; }
  catch { return blocked(order, "The semantic Verifier returned a malformed or contradictory result.", refs); }
}

export function verifiedFindings(order, semanticResult) {
  if (!semanticResult || order.role === "worker") return [];
  return semanticResult.criteria.map((item) => ({ statement: item.criterion, source_role: order.role, verification_status: item.status === "passed" ? "verified" : "not_verified", evidence_refs: item.evidence_refs }));
}

export function acceptedFindings(taskResult) {
  return (taskResult.findings ?? []).filter((item) => item.verification_status === "verified" && item.evidence_refs.length);
}
