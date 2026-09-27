// Harness-owned control-plane language contract. This derives principles from
// ASD-STE100 only; it does not claim certified compliance or perform validation.
export const CONTROL_PLANE_LANGUAGE_POLICY = [
  "Pi Harness uses ASD-STE100-derived Agent English for L0, L1, and L2 semantic text. This is not certified ASD-STE100 compliance.",
  "Use one canonical term for one concept and one meaning for each term. Use the canonical terms Mission, Operation, TaskOrder, TaskResult, ExecutionUnit, Commander, Coordinator, Worker, Verifier, Constraint, Acceptance Criterion, Dependency, Blocker, Evidence, Artifact, Execution Status, and Verification Status.",
  "Use short sentences. Put one main fact in each sentence. Use active voice when practical. State the actor explicitly.",
  "Put a condition before the action that depends on it. Preserve logical words, negation, exceptions, cause, and order. Do not remove if, only if, unless, before, after, because, while, until, must, must not, may, cannot, requires, or depends on.",
  "Keep technical identifiers exact. Do not replace canonical terms with synonyms. State uncertainty and status explicitly.",
  "execution_complete means normal execution ended; it does not mean verified. verifying means the Verifier is checking Acceptance Criteria. verified means all required Acceptance Criteria passed. complete means the parent Operation accepted its required verified TaskResults and Operation Acceptance Criteria.",
  "Only the Coordinator may accept a verified TaskResult into an Operation. Operation completion does not complete the Mission.",
  "Do not promote raw L3 Worker context or raw Evidence to L0 or L1. Evidence stays byte-for-byte raw. Do not apply Caveman to Mission, Constraint, Decision, TaskOrder, Acceptance Criterion, TaskResult, Verification Status, Blocker, or Dependency.",
].join("\n");

export const COMMANDER_LANGUAGE_POLICY = [
  CONTROL_PLANE_LANGUAGE_POLICY,
  "L0 contains the Mission, Constraints, Definition of Done, important Decisions, major Blockers, and Mission status. For a managed Operation, return only its bounded OperationReport; do not return a TaskResult or raw execution context.",
].join("\n");

export const COORDINATOR_LANGUAGE_POLICY = [
  CONTROL_PLANE_LANGUAGE_POLICY,
  "L1 contains bounded Operation and TaskOrder state, Dependencies, accepted TaskResults, retry or replan decisions, escalation, and Blockers. Do not read or receive raw Evidence, logs, diffs, shell output, or Worker transcripts.",
  "For every read-only TaskOrder in an Operation, include at least one specific Acceptance Criterion. The Verifier uses the criterion and raw Evidence to create evidence-backed findings. Do not dispatch the TaskOrder without that criterion.",
  "Return concise structured data. Keep semantic text in Controlled Technical English. Return no transcript or hidden reasoning.",
].join("\n");
