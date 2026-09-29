import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachOperation, createMission, missionIsClosable } from "../lib/mission.mjs";
import { reconcileAttemptLedger } from "../lib/attempt-ledger.mjs";
import { contextTelemetry, deterministicContextEdits } from "../lib/context-economics.mjs";
import { createOperation, acceptTaskResult, recordTaskResult, rejectTaskResult } from "../lib/operation.mjs";
import { storeEvidence } from "../lib/evidence.mjs";
import { acceptGraphTask, claimTask, createTaskGraph, recordTaskGraphResult, rejectGraphTask } from "../lib/task-graph.mjs";

const cwd = mkdtempSync(join(tmpdir(), "pi-harness-context-benchmark-"));
const previousEvidenceDir = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = join(cwd, "evidence");

try {
  const session = SessionManager.inMemory(cwd);
  const missionId = "M-BENCHMARK";
  const operationId = "O-CONTEXT";
  const taskId = "T-CONTEXT";
  let mission = createMission({ mission_id: missionId, objective: "Verify the current control-plane lifecycle and close it with retained evidence." });
  let operation = createOperation({ operation_id: operationId, mission_id: missionId, objective: "Verify one bounded TaskOrder.", required_task_ids: [taskId] });
  let graph = createTaskGraph(operation);
  const missions = { [missionId]: mission };

  session.appendMessage({ role: "user", content: "[PI_HARNESS_MISSION_CONTINUE]\nMission: Verify the current control-plane lifecycle and close it with retained evidence.", timestamp: 1 });
  const previousBoard = session.appendCustomMessageEntry("pi-harness-situation-board", `Mission ${missionId}\nStatus: active.\nOperation ${operationId}: open.\nTaskOrder ${taskId}: ready.`, false);
  session.appendMessage({ role: "toolResult", toolCallId: "attempt-1", toolName: "pi_harness_coordinate", content: [{ type: "text", text: JSON.stringify({
    version: 1, mission_id: missionId, operation_id: operationId, task_id: taskId,
    execution_status: "execution_complete", verification_status: "failed",
    failure_code: "HARNESS_VERIFIER_FAILED", summary: "The first Attempt did not satisfy verification.", evidence_refs: [],
  }) }], isError: false, timestamp: 2 });
  session.appendMessage({ role: "toolResult", toolCallId: "run-1", toolName: "pi_harness_run_operation", content: [{ type: "text", text: JSON.stringify({
    version: 1, mission_id: missionId, operation_id: operationId, status: "blocked",
    summary: "The Operation remains open after the first Attempt.", blocked_task_ids: [taskId],
    blockers: [{ task_id: taskId, blocked_action: "accept the TaskResult", required_condition: "a verified TaskResult is available" }],
  }) }], isError: false, timestamp: 3 });
  session.appendMessage({ role: "user", content: "[PI_HARNESS_MISSION_CONTINUE]\nMission: Verify the current control-plane lifecycle and close it with retained evidence.", timestamp: 4 });

  graph = claimTask(graph, operation, taskId);
  operation = recordTaskResult(operation, {
    version: 1, mission_id: missionId, operation_id: operationId, task_id: taskId,
    execution_status: "execution_complete", verification_status: "failed",
    failure_code: "HARNESS_VERIFIER_FAILED", summary: "The first Attempt did not satisfy verification.", evidence_refs: [],
  });
  graph = recordTaskGraphResult(graph, operation, taskId);
  operation = rejectTaskResult(operation, taskId);
  graph = rejectGraphTask(graph, operation, taskId);

  graph = claimTask(graph, operation, taskId);
  const evidence = storeEvidence({ cwd, missionId, operationId, taskId, kind: "report", content: "The second Attempt passed the registered deterministic checks." });
  operation = recordTaskResult(operation, {
    version: 1, mission_id: missionId, operation_id: operationId, task_id: taskId,
    execution_status: "execution_complete", verification_status: "verified",
    summary: "The second Attempt passed verification.", evidence_refs: [evidence.reference],
  });
  graph = recordTaskGraphResult(graph, operation, taskId);
  const accepted = acceptTaskResult(operation, taskId);
  graph = acceptGraphTask(graph, operation, accepted, taskId);
  operation = accepted;
  const operations = { [operationId]: operation };
  const taskGraphs = { [operationId]: graph };
  const attemptLedger = reconcileAttemptLedger({}, operations, taskGraphs);
  if (!missionIsClosable(mission, operations, taskGraphs, attemptLedger)) throw new Error("Benchmark lifecycle did not reach a valid Mission closure.");
  mission = createMission({ ...mission, status: "complete" });
  const completedMissions = { [missionId]: mission };

  session.appendMessage({ role: "toolResult", toolCallId: "task-result", toolName: "pi_harness_coordinate", content: [{ type: "text", text: JSON.stringify({
    version: 1, mission_id: missionId, operation_id: operationId, task_id: taskId,
    execution_status: "execution_complete", verification_status: "verified",
    summary: "The second Attempt passed verification.", evidence_refs: [evidence.reference],
  }) }], isError: false, timestamp: 5 });
  session.appendMessage({ role: "toolResult", toolCallId: "run-2", toolName: "pi_harness_run_operation", content: [{ type: "text", text: JSON.stringify({
    version: 1, mission_id: missionId, operation_id: operationId, status: "complete",
    accepted_task_ids: [taskId], summary: "The Coordinator accepted the verified TaskResult.",
  }) }], isError: false, timestamp: 6 });
  session.appendMessage({ role: "toolResult", toolCallId: "mission-close", toolName: "pi_harness_goal", content: [{ type: "text", text: JSON.stringify({
    mission_id: missionId, status: "complete", evidence: "The Commander checked the completed Operation and retained Evidence.",
  }) }], isError: false, timestamp: 7 });
  session.appendMessage({ role: "user", content: "Show the completed Mission result.", timestamp: 8 });

  const beforeBytes = Buffer.byteLength(JSON.stringify(session.buildSessionProjection().messages));
  const collected = deterministicContextEdits(session.buildSessionProjection().entries, { missions: completedMissions, operations, taskGraphs });
  const boardReplacement = { type: "context_edit", targetId: previousBoard, replacement: { content: "[Superseded Mission Situation Board; terminal Mission state is durable.]" } };
  for (const edit of [...collected.edits, boardReplacement]) session.appendContextEdit(edit.targetId, edit.replacement);
  const afterBytes = Buffer.byteLength(JSON.stringify(session.buildSessionProjection().messages));
  const entries = session.getEntries();
  const telemetry = contextTelemetry(entries, undefined, { missions: completedMissions, operations, taskGraphs, attemptLedger });
  const result = {
    benchmark: "current-control-plane-lifecycle",
    provider_requests: 0,
    lifecycle: { missions: 1, operations: 1, tasks: 1, attempts: 2, accepted_tasks: operation.accepted_task_ids.length, completed_missions: 1 },
    before: { context_bytes: beforeBytes, context_tokens: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, runtime_catalog_cost: null, provider_reported_cost: null },
    after: { context_bytes: afterBytes, context_tokens: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, runtime_catalog_cost: null, provider_reported_cost: null },
    context_bytes_removed: Math.max(0, beforeBytes - afterBytes),
    gc_bytes_removed: collected.bytesRemoved,
    context_edits: entries.filter((entry) => entry.type === "context_edit").length,
    compaction_count: telemetry.compaction_count,
    warming_requests: telemetry.warming_requests,
    retained_control_state: { mission_status: mission.status, operation_status: operation.status, task_status: graph.nodes[taskId].scheduler_status, attempt_statuses: Object.values(attemptLedger).map((attempt) => attempt.status) },
    note: "Token, provider usage, cache, and cost values are unknown because this offline benchmark makes no provider request.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (previousEvidenceDir === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR;
  else process.env.PI_HARNESS_EVIDENCE_DIR = previousEvidenceDir;
  rmSync(cwd, { recursive: true, force: true });
}
