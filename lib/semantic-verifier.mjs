import { safeFailureCode } from "./failure-codes.mjs";
import { readEvidence, storeEvidence } from "./evidence.mjs";
import { CONTROL_PLANE_LANGUAGE_POLICY } from "./agent-english.mjs";
import { truncateText } from "./worker-gate.mjs";
import { semanticCriteria } from "./verifier.mjs";

const MAX_PACKET_BYTES = 24_000;
const MAX_REVIEW_BYTES = 8_000;
const STATUSES = new Set(["passed", "failed", "blocked", "not_checked"]);

function blocked(order, reason, evidenceRefs = [], verifier = "semantic", failureCode = verifier === "security" ? "HARNESS_SECURITY_REVIEW_FAILED" : "HARNESS_SEMANTIC_REVIEW_FAILED") {
  return { version: 1, task_id: order.task_id, verifier, status: "blocked", failure_code: safeFailureCode(failureCode), criteria: semanticCriteria(order).map((criterion) => ({ criterion, status: "not_checked", finding: reason, evidence_refs: [] })), summary: reason, evidence_refs: evidenceRefs };
}

// Select a single relevant Evidence kind, never the entire execution record.
// The Reviewer receives raw bytes from the Store, not file paths or store access.
export function verificationPacket(order, result, cwd) {
  const candidates = result.evidence_refs.map((reference) => readEvidence(reference, cwd));
  const criteria = semanticCriteria(order);
  const criterion_evidence = Object.create(null);
  const selected = new Map();
  for (const criterion of criteria) {
    const kind = Object.hasOwn(order.review_evidence ?? {}, criterion) ? order.review_evidence[criterion] : (order.role === "worker" ? "diff" : "report");
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
    CONTROL_PLANE_LANGUAGE_POLICY,
    "VerificationOrder: The semantic Verifier must check each Acceptance Criterion against only the selected Evidence.",
    "Constraints provide TaskOrder context; they are not additional Acceptance Criteria. Do not block an Acceptance Criterion because an unrelated constraint cannot be established from its selected Evidence.",
    "The semantic Verifier must not change the TaskOrder or accept an Operation.",
    "If Evidence is insufficient, return blocked or not_checked with a reason.",
    "Return only JSON: {version:1,task_id,status,criteria:[{criterion,status,finding,evidence_refs}],summary}.",
    "Use passed, failed, blocked, or not_checked only for each criterion. The top-level status is limited to verified, failed, or blocked: use verified when every criterion passed, failed when any criterion failed, and blocked when any criterion is blocked or not_checked. Never use passed or not_checked as the top-level status.",
    "State the actor and uncertainty explicitly. Write each finding in concise Controlled Technical English. Do not rewrite or reproduce the Evidence payload.",
    JSON.stringify(packet),
  ].join("\n");
}

function repeatsEvidenceText(text, packet) {
  const finding = text.trim();
  return packet.evidence.some(({ content }) => {
    const source = String(content ?? "");
    return source.trim() === finding
      || (finding.length >= 64 && source.includes(finding))
      || source.split(/\r?\n/).some((line) => line.trim().length >= 48 && finding.includes(line.trim()));
  });
}

export function validateSemanticReview(order, packet, raw, verifier = "semantic") {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("The semantic Verifier returned malformed JSON."); }
  const refs = packet.evidence.map((item) => item.reference);
  if (parsed?.version !== 1 || parsed.task_id !== order.task_id || !Array.isArray(parsed.criteria) || parsed.criteria.length !== semanticCriteria(order).length || typeof parsed.summary !== "string" || !parsed.summary.trim() || parsed.summary.length > 1500) throw new Error("The semantic Verifier returned an invalid result.");
  for (let index = 0; index < parsed.criteria.length; index++) {
    const item = parsed.criteria[index];
    if (item?.criterion !== semanticCriteria(order)[index] || !STATUSES.has(item.status) || typeof item.finding !== "string" || !item.finding.trim() || item.finding.length > 1500 || repeatsEvidenceText(item.finding, packet) || !Array.isArray(item.evidence_refs) || item.evidence_refs.some((ref) => ref !== packet.criterion_evidence[item.criterion]) || (item.status === "passed" && !item.evidence_refs.length)) throw new Error("The semantic Verifier returned an invalid criterion result.");
  }
  const status = parsed.criteria.some((item) => item.status === "failed") ? "failed"
    : parsed.criteria.some((item) => item.status !== "passed") ? "blocked" : "verified";
  if (parsed.status !== status) throw new Error("The semantic Verifier returned a contradictory status.");
  return {
    version: 1, task_id: order.task_id, verifier, status,
    criteria: parsed.criteria.map(({ criterion, status: criterionStatus, finding, evidence_refs }) => ({ criterion, status: criterionStatus, finding, evidence_refs })),
    summary: status === "verified" ? "The semantic Verifier passed all selected Acceptance Criteria."
      : status === "failed" ? "The semantic Verifier failed an Acceptance Criterion."
        : "The semantic Verifier could not check all Acceptance Criteria.",
    evidence_refs: refs,
  };
}

export async function reviewTask(order, result, cwd, run, verifier = "semantic") {
  let packet;
  try { packet = verificationPacket(order, result, cwd); }
  catch { return blocked(order, "The selected Evidence is missing, invalid, or too large.", [], verifier, "HARNESS_EVIDENCE_FAILED"); }
  let event;
  try { event = await run(formatVerificationOrder(packet)); }
  catch (error) { return blocked(order, verifier === "security" ? "The configured security-reviewer model is not available through the current Pi/provider configuration or the security-reviewer did not return a result." : "The semantic Verifier did not return a result.", packet.evidence.map((item) => item.reference), verifier, error?.code ?? (verifier === "security" ? "HARNESS_SECURITY_REVIEW_FAILED" : "HARNESS_SEMANTIC_REVIEW_FAILED")); }
  const raw = truncateText(event?.result ?? "", MAX_REVIEW_BYTES);
  let reviewRef;
  try { reviewRef = storeEvidence({ cwd, taskId: order.task_id, operationId: order.operation_id, kind: verifier === "security" ? "security_review" : "semantic_review", content: raw.text, truncated: raw.truncated }).reference; }
  catch { return blocked(order, "The Evidence Store could not persist the semantic Verifier result.", [], verifier, "HARNESS_EVIDENCE_FAILED"); }
  const refs = [...packet.evidence.map((item) => item.reference), reviewRef];
  if (!(["completed", "steered"].includes(event?.status)) || raw.truncated) return blocked(order, "The semantic Verifier stopped or returned a truncated result.", refs, verifier);
  try { return { ...validateSemanticReview(order, packet, raw.text, verifier), evidence_refs: refs }; }
  catch { return blocked(order, "The semantic Verifier returned a malformed or contradictory result.", refs, verifier); }
}

export function verifiedFindings(order, semanticResult) {
  if (!semanticResult || order.role === "worker") return [];
  return semanticResult.criteria.map((item) => ({ statement: item.criterion, criterion: item.criterion, finding: item.finding,
    verifier: item.verifier ?? "semantic", source_role: order.role, verification_status: item.status === "passed" ? "verified" : "not_verified", evidence_refs: item.evidence_refs }));
}

export function acceptedFindings(taskResult) {
  return (taskResult.findings ?? []).filter((item) => item.verification_status === "verified" && item.evidence_refs.length);
}
