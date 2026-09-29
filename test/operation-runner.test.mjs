import { mockSettlement } from "./helpers/mock-settlement.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import harness from "../extensions/pi-harness.ts";
import { trackControlPi } from "./helpers/control-state-isolation.mjs";
import { readControlState } from "../lib/control-state-store.mjs";
import { createOperation as registerOperation } from "../lib/operation.mjs";
import { coordinatorPrompt, coordinatorState, MAX_COORDINATOR_TURNS, operationBrief, operationReport, parseCoordinatorDecision, runOperation } from "../lib/operation-runner.mjs";
import { cancelCoordinateTasks, executeCoordinateTask, executeCoordinatorTurn, hasActiveCoordinateTasks } from "../lib/coordinator.mjs";
import { blockGraphTask, createTaskGraph, TASK_GRAPH_ENTRY, validateTaskGraph } from "../lib/task-graph.mjs";
import { readEvidence } from "../lib/evidence.mjs";

const dir = mkdtempSync(join(tmpdir(), "pi-phasee-test-"));
const prior = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = dir;
after(() => { if (prior === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = prior; rmSync(dir, { recursive: true, force: true }); });
// Test fixtures register trusted fields explicitly; production has no defaults.
const fixtureSpecs = input => Object.fromEntries(Object.entries(input.task_intents ?? {}).map(([id]) => [id, { owner: "research", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies \u0060lib/coordinator.mjs\u0060."] }]));
const createOperation = input => registerOperation({ ...input, task_specs: input.task_specs ?? fixtureSpecs(input) });
const op = () => createOperation({ operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1", "T-2"], dependencies: { "T-2": ["T-1"] }, acceptance_criteria: ["The Coordinator checked the result."], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`.", "T-2": "Inspect `lib/coordinator.mjs`." } });
const decision = (action, fields = {}) => JSON.stringify({ version: 1, operation_id: "O-1", action, reason: "The Coordinator checked the Operation state.", ...fields });
const task = (id) => ({ task_id: id, owner: "research", scope: "Inspect `lib/coordinator.mjs`.", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies `lib/coordinator.mjs`."] });

test("Coordinator packet contains bounded semantic state, not transcripts", () => {
  const operation = op();
  const packet = operationBrief(operation, coordinatorState(operation), "Mission objective.");
  assert.equal(packet.OperationBrief.mission, "Mission objective.");
  assert.deepEqual(packet.OperationBrief.ready_task_ids, ["T-1"]);
  assert.deepEqual(packet.OperationBrief.pending_task_ids, ["T-2"]);
  assert.match(coordinatorPrompt(packet), /Every decision must include version, operation_id, action, and a nonempty reason/);
  assert.match(coordinatorPrompt(packet), /Harness uses each exact OperationBrief\.task_intents value as the scope/);
  assert.doesNotMatch(coordinatorPrompt(packet), /ASD-STE100-derived Agent English/, "stable Coordinator doctrine belongs in the Coordinator profile");
  assert.match(coordinatorPrompt(packet), /Harness resolves trusted registered TaskSpecs/);
  assert.ok(!coordinatorPrompt(packet).includes("raw Worker transcript"));
  const profile = readFileSync(".pi/agents/coordinator.md", "utf8");
  assert.match(profile, /tools: read/);
  assert.match(profile, /extensions: false/);
  assert.match(profile, /skills: false/);
  assert.doesNotMatch(profile, /tools:.*\b(?:bash|write|edit|Agent)\b/);
  assert.match(profile, /ASD-STE100-derived Agent English/);
  assert.match(profile, /Only the Coordinator may accept a verified TaskResult/);
});

test("operationBrief exposes validated Operation constraints and Task intents unchanged", () => {
  const operation = createOperation({
    operation_id: "O-1",
    objective: "Implement context economics.",
    required_task_ids: ["T-1", "T-2"],
    constraints: ["Do not bypass Coordinator.", "Do not change Scheduler authority."],
    task_intents: {
      "T-1": "Implement stable prompt and deterministic context maintenance.",
      "T-2": "Verify cache/compaction lifecycle and telemetry.",
    },
  });
  const brief = operationBrief(operation, coordinatorState(operation)).OperationBrief;
  assert.deepEqual(brief.constraints, operation.constraints);
  assert.deepEqual(brief.task_intents, operation.task_intents);
});

test("operationBrief keeps the existing MAX_PACKET limit for large Operation inputs", () => {
  const required_task_ids = Array.from({ length: 20 }, (_, index) => `T-${index}`);
  const operation = createOperation({
    operation_id: "O-1",
    objective: "Check packet bounds.",
    required_task_ids,
    constraints: Array.from({ length: 16 }, () => "c".repeat(500)),
    task_intents: Object.fromEntries(required_task_ids.map((id) => [id, "i".repeat(500)])),
  });
  assert.throws(() => operationBrief(operation, coordinatorState(operation)), /bounded Coordinator packet exceeds its limit/);
});

test("pi-subagents 0.19.0 RPC cannot safely resume a completed Coordinator session", () => {
  const source = readFileSync("node_modules/@tintinweb/pi-subagents/dist/index.js", "utf8");
  const start = source.indexOf("const spawnTopLevel =");
  const end = source.indexOf("const resolveAgentRef =", start);
  assert.ok(start > 0 && end > start);
  assert.match(source.slice(start, end), /delete safeOptions\.resumeSessionFile/);
  assert.match(source, /spawn: spawnTopLevel/);
  assert.match(source, /resumeSessionFile: entry\.sessionFile/);
  const manager = readFileSync("node_modules/@tintinweb/pi-subagents/dist/agent-manager.js", "utf8");
  const settle = manager.slice(manager.indexOf("settleRun(record, guardCallback, pool)"), manager.indexOf("abortOwnedChildren(parentId)"));
  assert.match(settle, /this\.runningBackground--/);
  assert.match(settle, /this\.drainQueue\(\)/);
  assert.match(manager, /armQueuedAbort\(id, options\.signal\)/);
  // The package permits an internal @handle resume, but rejects an RPC caller's
  // resumeSessionFile. Fresh turns release the serial slot before a Worker runs.
});

test("malformed or unauthorized CoordinatorDecision fails closed", () => {
  for (const raw of ["not JSON", decision("dispatch", { task: task("UNKNOWN") }), decision("dispatch", { task: { ...task("T-1"), owner: "write Worker", permission: "write" } }), decision("dispatch", { task: { task_id: "T-1", owner: "research", scope: "Inspect.", permission: "read", verification: "Check." } }), decision("accept_task", { task_id: "UNKNOWN" }), decision("report", { mission_complete: true }), decision("accept_task", { task_id: "T-1", task: task("T-1") }), JSON.stringify({ version: 1, operation_id: "O-1", action: "block", blocked_action: "dispatch", required_condition: "the registered Task intent is available" }), JSON.stringify({ ...JSON.parse(decision("report")), operation_id: "O-foreign" })]) assert.throws(() => parseCoordinatorDecision(raw, op()));
  const state = coordinatorState(op());
  assert.deepEqual(Object.keys(state).sort(), ["blocker", "decisions", "operation_id", "turns", "version"]);
});

test("Coordinator decision repair is bounded; dispatch uses the registered intent and shared Constraints", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Inspect the registered source.", required_task_ids: ["T-1"], task_specs: { "T-1": { owner: "research", permission: "read", verification: "Check the report.", acceptance_criteria: ["The report identifies the source."] } }, constraints: ["Do not run shell commands."], task_intents: { "T-1": "Inspect the exact registered source." } });
  const validTask = { task_id: "T-1", owner: "research", scope: "Inspect the exact registered source.", permission: "read", verification: "Check the report.", acceptance_criteria: ["The report identifies the source."] };
  assert.throws(() => parseCoordinatorDecision(decision("dispatch", { task: { ...validTask, scope: "Coordinator changed the exact scope." } }), operation), /registered Task intent/);
  assert.throws(() => parseCoordinatorDecision(decision("dispatch", { task: { ...validTask, constraints: ["Coordinator added a Constraint."] } }), operation), /shared Operation Constraints/);
  const unscoped = createOperation({ operation_id: "O-1", objective: "No registered intent.", required_task_ids: ["T-1"] });
  assert.throws(() => parseCoordinatorDecision(decision("dispatch", { task: validTask }), unscoped), /registered Task intent/);

  const prompts = [], snapshots = [];
  let dispatched;
  const report = await runOperation(operation, {
    turn: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) return decision("dispatch", { task: { ...validTask, scope: "Coordinator changed the exact scope." } });
      if (prompts.length === 2) {
        assert.match(prompt, /Repair Required:.*registered Task intent/);
        assert.ok(!prompt.includes("Coordinator changed the exact scope."));
        return decision("dispatch", { task: validTask });
      }
      return decision("accept_task", { task_id: "T-1" });
    },
    dispatch: async (taskOrder) => {
      dispatched = taskOrder;
      return { version: 1, operation_id: "O-1", task_id: "T-1", execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] };
    },
    save: (_operation, state) => snapshots.push(state.turns),
  });
  assert.equal(report.status, "complete");
  assert.deepEqual(dispatched.constraints, ["Do not run shell commands."]);
  assert.equal(dispatched.scope, "Inspect the exact registered source.");
  assert.ok(snapshots.includes(1) && snapshots.includes(2) && snapshots.includes(3));
});

test("Coordinator RPC failure exposes only a bounded failure code", async () => {
  const report = await runOperation(op(), {
    turn: async () => { throw Object.assign(new Error("private provider failure"), { code: "HARNESS_RPC_TIMEOUT" }); },
  });
  assert.equal(report.failure_code, "HARNESS_RPC_TIMEOUT");
  assert.ok(!JSON.stringify(report).includes("private provider failure"));
});

test("invalid Coordinator output receives only one repair attempt", async () => {
  let calls = 0;
  let latestState;
  const report = await runOperation(op(), {
    turn: async () => { calls++; return "not JSON"; },
    save: (_operation, state) => { latestState = state; },
  });
  assert.equal(calls, 2);
  assert.equal(latestState.turns, 2);
  assert.match(report.blocker, /valid CoordinatorDecision/);
  assert.equal(report.failure_code, "HARNESS_COORDINATOR_DECISION_INVALID");
});

test("Coordinator repairs consume the same persisted turn limit", async () => {
  let calls = 0;
  let saved;
  const operation = op();
  const state = { ...coordinatorState(operation), turns: MAX_COORDINATOR_TURNS - 1 };
  const report = await runOperation(operation, {
    turn: async () => { calls++; return "not JSON"; },
    save: (_operation, nextState) => { saved = nextState; },
  }, { state });
  assert.equal(calls, 1, "the final allowed call cannot be followed by a repair beyond the turn limit");
  assert.equal(saved.turns, MAX_COORDINATOR_TURNS);
  assert.equal(report.status, "blocked");
});

test("Coordinator cannot dispatch an unregistered TaskOrder", async () => {
  let spawns = 0;
  const report = await runOperation(op(), {
    turn: async () => decision("dispatch", { task: task("T-X") }),
    dispatch: async () => { spawns++; throw new Error("an unregistered TaskOrder must not spawn"); },
  });
  assert.equal(report.status, "blocked");
  assert.match(report.blocker, /valid CoordinatorDecision/);
  assert.equal(spawns, 0);
});

test("Harness rejects Dependency bypass and unverified acceptance", async () => {
  const reports = [];
  for (const proposed of [decision("dispatch", { task: task("T-2") }), decision("accept_task", { task_id: "T-1" }), decision("dispatch", { task: { ...task("T-1"), owner: "research", permission: "write" } })]) {
    let spawns = 0;
    const report = await runOperation(op(), { turn: async () => proposed, dispatch: async () => { spawns++; throw Error("must not execute"); } });
    assert.equal(report.status, "blocked");
    assert.equal(spawns, 0);
    reports.push(report);
  }
  assert.equal(reports[0].commander_action_required, true);
});

test("Verification Status enters verifying while Execution Status stays separate", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Verify the read-only report.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  const snapshots = [];
  let turn = 0;
  const report = await runOperation(operation, {
    turn: async () => turn++ === 0 ? decision("dispatch", { task: task("T-1") }) : decision("accept_task", { task_id: "T-1" }),
    dispatch: async (order, progress) => {
      progress.onVerificationStart();
      return { version: 1, operation_id: "O-1", task_id: order.task_id, execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] };
    },
    save: (_operation, _state, graph) => snapshots.push(structuredClone(graph)),
  });
  assert.equal(report.status, "complete");
  const checking = snapshots.find((graph) => graph.nodes["T-1"].verification_status === "verifying");
  assert.ok(checking);
  assert.equal(checking.nodes["T-1"].scheduler_status, "running");
  assert.equal(checking.nodes["T-1"].verification_status, "verifying");
  assert.equal(Object.hasOwn(checking.nodes["T-1"], "execution_status"), false);
  assert.ok(snapshots.some((graph) => graph.nodes["T-1"].scheduler_status === "result_available" && !Object.hasOwn(graph.nodes["T-1"], "verification_status")));
});

test("strategic block escalates, but ordinary retry failure stays operational", async () => {
  const blocked = await runOperation(op(), { turn: async () => decision("block", { blocked_action: "change Mission scope", required_condition: "the Commander approves the scope change", question: "May the Coordinator change the Mission scope?" }) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.escalation.type, "strategic_decision_required");
  assert.match(blocked.blocker, /until the Commander approves/);
});

test("OperationReport promotes only bounded structured Scheduler Blockers", () => {
  const operation = op();
  const graph = blockGraphTask(createTaskGraph(operation), operation, "T-1", "resolve an unknown child outcome", "the Commander checks the child outcome and replans with a fresh Task ID", "HARNESS_UNKNOWN", undefined, "unknown");
  const report = operationReport(operation, coordinatorState(operation), "The TaskOrder outcome is unknown.", undefined, graph);
  assert.deepEqual(report.blocked_task_ids, ["T-1"]);
  assert.deepEqual(report.scheduler_blockers, [{ task_id: "T-1", blocked_action: "resolve an unknown child outcome", required_condition: "the Commander checks the child outcome and replans with a fresh Task ID", failure_code: "HARNESS_UNKNOWN", child_status: "unknown" }]);
  assert.deepEqual(Object.keys(report.scheduler_blockers[0]).sort(), ["blocked_action", "child_status", "failure_code", "required_condition", "task_id"]);
  assert.equal(Buffer.byteLength(JSON.stringify(report)) <= 24_000, true);
  assert.equal(JSON.stringify(report).includes("raw_evidence"), false);
});

test("timed-out Worker disposition is bounded and carried into the OperationReport", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Report a partial Worker branch.", task_specs: { "T-1": { ...fixtureSpecs({task_intents:{"T-1":"Inspect."}})["T-1"], owner: "worker", permission: "write" } }, required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect the partial Worker branch." } });
  const child_disposition = { branch_status: "preserved", branch: "pi-agent-partial", commit_sha: "b".repeat(40), commit_count: 1, worktree_status: "unknown" };
  const snapshots = [];
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch", { task: { ...task("T-1"), owner: "worker", scope: operation.task_intents["T-1"], permission: "write" } }),
    dispatch: async () => { throw Object.assign(new Error("private child details and /tmp/private/worktree"), { code: "HARNESS_CHILD_SETTLEMENT_TIMEOUT", child_disposition }); },
    save: (_operation, _state, graph) => snapshots.push(JSON.parse(JSON.stringify(graph))),
  });
  assert.deepEqual(report.scheduler_blockers[0].child_disposition, child_disposition);
  assert.equal(report.scheduler_blockers[0].child_status, "unknown");
  assert.deepEqual(validateTaskGraph(snapshots.at(-1), operation).nodes["T-1"].blocker.child_disposition, child_disposition);
  assert.ok(!JSON.stringify(report).includes("/tmp/private"));
  assert.ok(!JSON.stringify(report).includes("private child details"));
});

test("cancelled Worker wave blocks promotion but retains the reported branch disposition", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Cancel a partial Worker result.", task_specs: { "T-1": { ...fixtureSpecs({task_intents:{"T-1":"Inspect."}})["T-1"], owner: "worker", permission: "write" } }, required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect the partial Worker branch." } });
  const controller = new AbortController();
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch", { task: { ...task("T-1"), owner: "worker", scope: operation.task_intents["T-1"], permission: "write" } }),
    dispatch: async () => {
      controller.abort();
      return { failure_code: "HARNESS_CANCELLED", artifact_refs: ["pi-agent-partial"] };
    },
  }, { signal: controller.signal });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.accepted_task_ids, []);
  assert.equal(report.scheduler_blockers[0].failure_code, "HARNESS_CANCELLED");
  assert.equal(report.scheduler_blockers[0].child_status, "cancelled");
  assert.deepEqual(report.scheduler_blockers[0].child_disposition, { branch_status: "preserved", branch: "pi-agent-partial", worktree_status: "unknown" });
});

test("Scheduler Blocker projection stays within the existing report size bound", () => {
  const ids = Array.from({ length: 40 }, (_, index) => `T-${index}`);
  const operation = createOperation({ operation_id: "O-1", objective: "Bound blocked report.", required_task_ids: ids });
  let graph = createTaskGraph(operation);
  for (const id of ids) graph = blockGraphTask(graph, operation, id, "a".repeat(500), "b".repeat(500));
  const report = operationReport(operation, coordinatorState(operation), "The TaskOrders are blocked.", undefined, graph);
  assert.deepEqual(report.blocked_task_ids, ids);
  assert.ok(report.scheduler_blockers.length < ids.length);
  const failedOperation = { ...operation, task_results: Object.fromEntries(ids.map((task_id) => [task_id, { task_id, failure_code: "HARNESS_UNKNOWN" }])) };
  const withFailureCodes = operationReport(failedOperation, coordinatorState(operation), "The TaskOrders are blocked.", undefined, graph);
  assert.ok(withFailureCodes.failure_codes.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(withFailureCodes)) <= 24_000);
});

test("an unbound child completion cannot become a managed TaskResult", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Verify lineage.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch", { task: task("T-1") }),
    dispatch: async () => ({ version: 1, operation_id: "O-foreign", task_id: "T-1", execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] }),
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.accepted_task_ids, []);
  assert.deepEqual(report.scheduler_blockers, [{ task_id: "T-1", blocked_action: "resolve an unknown child outcome", required_condition: "the Commander checks the child outcome and replans with a fresh Task ID", failure_code: "HARNESS_LINEAGE_MISMATCH", child_status: "unknown" }]);
});

test("a rejected spawn is blocked as a confirmed child startup failure", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Verify spawn failure.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch", { task: task("T-1") }),
    dispatch: async () => { throw Object.assign(new Error("private startup detail"), { childOutcome: "spawn_rejected" }); },
  });
  assert.deepEqual(report.accepted_task_ids, []);
  assert.deepEqual(report.scheduler_blockers, [{ task_id: "T-1", blocked_action: "resolve the confirmed child spawn failure", required_condition: "the Commander resolves the bounded spawn failure and replans with a fresh Task ID", failure_code: "HARNESS_CHILD_SPAWN_FAILED" }]);
  assert.ok(!JSON.stringify(report).includes("private startup detail"));
});

test("a child acknowledged after spawn timeout remains blocked without a TaskResult", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Verify late child outcome.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  let restoredGraph;
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch", { task: task("T-1") }),
    dispatch: async () => { throw Object.assign(new Error("bounded timeout"), { code: "HARNESS_RPC_TIMEOUT", childSettled: true, childStatus: "stopped" }); },
    save: (_operation, _state, graph) => { restoredGraph = JSON.parse(JSON.stringify(graph)); },
  });
  assert.deepEqual(report.accepted_task_ids, []);
  assert.deepEqual(report.scheduler_blockers, [{ task_id: "T-1", blocked_action: "resolve the settled child outcome", required_condition: "the child reached terminal status stopped; the Commander records this outcome without accepting a TaskResult and replans with a fresh Task ID", failure_code: "HARNESS_RPC_TIMEOUT", child_status: "stopped" }]);
  assert.equal(restoredGraph.nodes["T-1"].blocker.failure_code, "HARNESS_RPC_TIMEOUT");
  validateTaskGraph(restoredGraph, operation);
  assert.ok(!JSON.stringify(report).includes("childStatus"));
});

test("a timed-out child remains blocked with bounded timeout provenance, not a TaskResult", async () => {
  const operation = createOperation({ operation_id: "O-1", objective: "Verify timeout.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  const report = await runOperation(operation, {
    turn: async () => decision("dispatch", { task: task("T-1") }),
    dispatch: async () => { throw Object.assign(new Error("private child output"), { code: "HARNESS_CHILD_TERMINAL_TIMEOUT" }); },
  });
  assert.deepEqual(report.accepted_task_ids, []);
  assert.deepEqual(report.scheduler_blockers.map(({ task_id, blocked_action, failure_code }) => ({ task_id, blocked_action, failure_code })), [{ task_id: "T-1", blocked_action: "resolve an unknown child outcome", failure_code: "HARNESS_CHILD_TERMINAL_TIMEOUT" }]);
  assert.match(report.scheduler_blockers[0].required_condition, /terminal wait timed out/);
  assert.ok(!JSON.stringify(report).includes("private child output"));
});

test("Harness bounds repeated failed TaskOrders without an infinite loop", async () => {
  let spawns = 0;
  const report = await runOperation(createOperation({ operation_id: "O-1", objective: "Retry task.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } }), {
    turn: async (prompt) => JSON.parse(prompt.slice(prompt.indexOf('{"OperationBrief"'))).OperationBrief.result_available_task_ids.includes("T-1")
      ? decision("reject_task", { task_id: "T-1" }) : decision("dispatch", { task: task("T-1") }),
    dispatch: async () => { spawns++; return { task_id: "T-1", operation_id: "O-1", execution_status: "execution_complete", verification_status: "failed", failure_code: "HARNESS_VERIFIER_FAILED", evidence_refs: [] }; },
  });
  assert.equal(spawns, 2);
  assert.equal(report.status, "blocked");
  assert.match(report.blocker, /retry limit/);
  assert.equal(report.escalation, undefined);
  assert.equal(report.accepted_task_ids.length, 0);
  assert.deepEqual(report.failure_codes, [{ task_id: "T-1", failure_code: "HARNESS_VERIFIER_FAILED" }]);
});

function fakePi(entries = []) {
  const tools = new Map(), events = new Map(), lifecycle = new Map(), commands = new Map();
  const pi = { tools, entries, commands,
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { pi.entries.push({ customType, data }); },
    on(name, handler) { lifecycle.set(name, handler); },
    events: {
      on(name, handler) { const set = events.get(name) ?? new Set(); set.add(handler); events.set(name, set); return () => set.delete(handler); },
      emit(name, payload) { if (this.mockSettlement !== false) mockSettlement(name, payload); for (const handler of [...(events.get(name) ?? [])]) handler(payload); },
    },
  };
  harness(pi);
  pi.sessionStart = (nextEntries) => { pi.entries = nextEntries; pi.sessionReady = lifecycle.get("session_start")({}, { mode: "rpc", sessionManager: { getEntries: () => nextEntries } }); return pi.sessionReady; };
  pi.shutdown = () => lifecycle.get("session_shutdown")?.();
  pi.sessionStart(entries);
  return trackControlPi(pi);
}
const call = async (pi, tool, input, signal) => {
  await pi.sessionReady;
  if (tool === "pi_harness_operation" && input.action === "create") input = { ...input, task_specs: input.task_specs ?? fixtureSpecs(input) };
  return JSON.parse((await pi.tools.get(tool).execute("id", input, signal)).content[0].text);
};
const startMission = async (pi, objective) => { await pi.sessionReady; return pi.commands.get("goal").handler(objective, {}); };

test("legacy Operation state without a persisted Mission ownership link fails closed", async () => {
  const operation = op();
  const verified = { version: 1, operation_id: "O-1", task_id: "T-1", execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] };
  const legacy = { ...operation, accepted_task_ids: ["T-1"], task_results: { "T-1": verified } };
  const pi = fakePi([{ customType: "pi-harness-operation-state", data: { "O-1": legacy } }]);
  await assert.rejects(pi.sessionReady, /no persisted Mission ownership; restore fails closed/);
});

test("timed-out parallel Task aborts only its child; late completion cannot change the TaskGraph", async () => {
  const pi = fakePi();
  const operation = createOperation({ operation_id: "O-1", objective: "Check parallel timeout.", required_task_ids: ["T-1", "T-2"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`.", "T-2": "Inspect `lib/coordinator.mjs`." } });
  let graphSnapshot, operationSnapshot;
  const requests = new Map(), records = new Map(), resolvers = new Map();
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  globalThis[managerKey] = { getRecord: (id) => records.get(id) };
  pi.events.on("subagents:rpc:spawn", (req) => {
    const id = req.prompt.includes("TaskOrder T-1") ? "slow" : "fast";
    const record = { status: "running", promise: new Promise((resolve) => resolvers.set(id, resolve)) };
    records.set(id, record);
    requests.set(id, req);
    pi.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (id === "fast") setTimeout(() => {
      record.status = "completed"; resolvers.get(id)();
      pi.events.emit("subagents:completed", { id, status: "completed", result: "Verified only as execution." });
    }, 5);
    else req.options.signal.addEventListener("abort", () => {
      record.status = "stopped"; resolvers.get(id)();
      pi.events.emit("subagents:failed", { id, status: "stopped" });
    }, { once: true });
  });
  try {
    const report = await runOperation(operation, {
      turn: async (prompt) => {
        const brief = JSON.parse(prompt.slice(prompt.indexOf('{"OperationBrief"'))).OperationBrief;
        return brief.ready_task_ids.length === 2 ? decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }) : decision("report");
      },
      dispatch: async (selected) => (await executeCoordinateTask(pi, selected, { timeout: 100, rpcTimeout: 1000 })).taskResult,
      save: (nextOperation, _state, graph) => { operationSnapshot = nextOperation; graphSnapshot = graph; },
    });
    assert.equal(report.status, "blocked");
    assert.equal(requests.get("slow").options.signal.aborted, true);
    assert.equal(requests.get("fast").options.signal.aborted, false);
    assert.equal(graphSnapshot.nodes["T-1"].scheduler_status, "blocked");
    assert.equal(graphSnapshot.nodes["T-2"].scheduler_status, "result_available");
    assert.equal(operationSnapshot.task_results["T-1"], undefined);
    assert.deepEqual(report.scheduler_blockers.map((item) => item.task_id), ["T-1"]);
    assert.equal(hasActiveCoordinateTasks(), false);
    const before = JSON.stringify([operationSnapshot, graphSnapshot]);
    pi.events.emit("subagents:completed", { id: "slow", status: "completed", result: "LATE PRIVATE RESULT" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify([operationSnapshot, graphSnapshot]), before);
  } finally {
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
  }
});

test("goal cancellation aborts the Coordinator turn; an unrelated turn is unaffected", async () => {
  const pi = fakePi();
  const requests = new Map();
  let seq = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = `coordinator-${++seq}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    requests.set(request.prompt, { id, request });
    request.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
  });
  await pi.commands.get("goal").handler("Mission objective.", {});
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  const managed = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  const unrelated = executeCoordinatorTurn(pi, "Unrelated OperationBrief", { groupId: "other", timeout: 1000, rpcTimeout: 1000 });
  for (let i = 0; i < 20 && requests.size < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.size, 2);
  await assert.rejects(() => call(pi, "pi_harness_operation", { action: "status", operation_id: "O-1" }), /Operation is running/);
  await assert.rejects(() => pi.tools.get("pi_harness_operation").execute("test", { action: "accept_task", operation_id: "O-1", task_id: "T-1" }), /Only the Harness Coordinator/);
  await pi.commands.get("goal").handler("cancel", {});
  assert.equal([...requests.values()].find((value) => value.request.prompt.includes("O-1")).request.options.signal.aborted, true);
  const other = [...requests.values()].find((value) => value.request.prompt === "Unrelated OperationBrief");
  assert.equal(other.request.options.signal.aborted, false);
  pi.events.emit("subagents:completed", { id: other.id, status: "completed", result: "unrelated result" });
  assert.equal(await unrelated, "unrelated result");
  assert.equal((await managed).status, "blocked");
  const persisted = pi.entries.filter((entry) => entry.customType === "pi-harness-coordinator-state").at(-1).data["O-1"];
  assert.match(persisted.blocker, /restarts the cancelled run/);
  assert.equal(cancelCoordinateTasks("other"), 0);
});

test("switching sessions aborts the run without writing old Coordinator state into the new session", async () => {
  const pi = fakePi(); await startMission(pi, "Check reports.");
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  let request;
  pi.events.on("subagents:rpc:spawn", (next) => {
    request = next;
    pi.events.emit(`subagents:rpc:spawn:reply:${next.requestId}`, { success: true, data: { id: "coord" } });
    next.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id: "coord", status: "stopped" }), { once: true });
  });
  const oldRun = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 20 && !request; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(request);
  const newEntries = [];
  await pi.sessionStart(newEntries);
  assert.equal(request.options.signal.aborted, true);
  assert.equal((await oldRun).status, "blocked");
  assert.ok(newEntries.some((entry) => entry.customType === TASK_GRAPH_ENTRY), "the durable Mission obligations are restored into the new Pi session");
  assert.equal((await call(pi, "pi_harness_operation", { action: "status", operation_id: "O-1" })).status, "open");
  await assert.rejects(() => call(pi, "pi_harness_run_operation", { operation_id: "O-1" }), /selected Mission/);
  const missionId = Object.keys(newEntries.filter((entry) => entry.customType === "pi-harness-mission-state").at(-1).data)[0];
  await pi.commands.get("mission").handler(`resume ${missionId}`, {});
  assert.equal((await call(pi, "pi_harness_operation", { action: "status", operation_id: "O-1" })).status, "open");
});

test("session shutdown invalidates late child callbacks before a new session resumes the Mission", async () => {
  const old = fakePi(); await startMission(old, "Resume only after the old child is fenced.");
  await call(old, "pi_harness_operation", { action: "create", operation_id: "O-SHUTDOWN", objective: "Inspect a bounded report.", required_task_ids: ["T-SHUTDOWN"], task_intents: { "T-SHUTDOWN": "Inspect `lib/coordinator.mjs`." } });
  let workerRequest;
  old.events.on("subagents:rpc:spawn", (request) => {
    const id = request.type === "coordinator" ? "shutdown-coordinator" : "shutdown-worker";
    old.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "coordinator") queueMicrotask(() => old.events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify({ version: 1, operation_id: "O-SHUTDOWN", action: "dispatch", reason: "Resume after a verified report.", task: { task_id: "T-SHUTDOWN", owner: "research", scope: "Inspect `lib/coordinator.mjs`.", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies `lib/coordinator.mjs`."] } }) }));
    else {
      workerRequest = request;
      request.options.signal.addEventListener("abort", () => old.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    }
  });
  const oldRun = call(old, "pi_harness_run_operation", { operation_id: "O-SHUTDOWN" });
  for (let i = 0; i < 30 && !workerRequest; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(workerRequest);
  assert.equal(readControlState(process.cwd()).task_graphs["O-SHUTDOWN"].nodes["T-SHUTDOWN"].scheduler_status, "running");

  await old.shutdown();
  assert.equal(workerRequest.options.signal.aborted, true);
  assert.equal((await oldRun).status, "blocked");
  const fresh = fakePi([]);
  const restored = fresh.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(restored.task_graphs["O-SHUTDOWN"].nodes["T-SHUTDOWN"].scheduler_status, "blocked");
  assert.equal(restored.attempt_ledger["A-O-SHUTDOWN-T-SHUTDOWN-01"].status, "unknown");
  const missionId = Object.keys(restored.missions)[0];
  await fresh.commands.get("mission").handler(`resume ${missionId}`, {});
  const stable = readControlState(process.cwd());
  old.events.emit("subagents:completed", { id: "shutdown-worker", status: "completed", result: "Late report after resume." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readControlState(process.cwd()), stable, "the closed session cannot change resumed durable state");
});

test("Scheduler attempt budget remains intact after explicit durable Mission resume", async () => {
  const pi = fakePi(); await startMission(pi, "Inspect report.");
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Inspect report.", required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`." } });
  let counter = 0;
  const steps = [decision("dispatch", { task: task("T-1") }), decision("reject_task", { task_id: "T-1" }), decision("block", { blocked_action: "choose another report", required_condition: "the Coordinator checks an alternate source" })];
  pi.events.on("subagents:rpc:spawn", (req) => {
    const id = `agent-${++counter}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: req.type === "coordinator" ? steps.shift() : "A read-only report." }));
  });
  assert.equal((await call(pi, "pi_harness_run_operation", { operation_id: "O-1" })).status, "blocked");
  let snapshot = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].attempts, 1);
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].scheduler_status, "ready");
  const missionId = pi.entries.filter((entry) => entry.customType === "pi-harness-goal-state").at(-1).data.mission_id;
  await pi.sessionStart([...pi.entries]);
  await pi.commands.get("mission").handler(`resume ${missionId}`, {});
  snapshot = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].attempts, 1);
  assert.equal(snapshot.task_graphs["O-1"].nodes["T-1"].scheduler_status, "ready");
});

test("old managed TaskResult cannot mutate a durably resumed Mission", async () => {
  const pi = fakePi(); await startMission(pi, "Old session.");
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Old session.", task_specs: { "T-1": { owner: "research", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies the requested source."] } }, required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect old session." } });
  let workerRequest;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = request.type === "coordinator" ? "old-coordinator" : "old-worker";
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "coordinator") {
      queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: decision("dispatch", { task: { ...task("T-1"), scope: "Inspect old session.", acceptance_criteria: ["The report identifies the requested source."] } }) }));
    } else {
      workerRequest = request;
      request.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    }
  });
  const oldRun = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 30 && !workerRequest; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(workerRequest);
  const nextEntries = [];
  await pi.sessionStart(nextEntries);
  assert.equal(workerRequest.options.signal.aborted, true);
  assert.equal((await oldRun).status, "blocked");
  const restored = nextEntries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.equal(restored.task_graphs["O-1"].nodes["T-1"].scheduler_status, "blocked");
  assert.equal(restored.attempt_ledger["A-O-1-T-1-01"].status, "unknown");
  const missionId = Object.keys(restored.missions)[0];
  await pi.commands.get("mission").handler(`resume ${missionId}`, {});
  const stableSnapshot = structuredClone(nextEntries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data);
  pi.events.emit("subagents:completed", { id: "old-worker", status: "completed", result: "Late report." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(nextEntries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data, stableSnapshot, "the old callback cannot overwrite resumed durable state");
});

test("goal cancellation aborts the active managed ExecutionUnit", async () => {
  const pi = fakePi();
  await pi.commands.get("goal").handler("Mission objective.", {});
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Inspect report.", task_specs: { "T-1": { owner: "research", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies the requested source."] } }, required_task_ids: ["T-1"], task_intents: { "T-1": "Inspect report." } });
  let workerSignal;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = request.type === "coordinator" ? "coord-1" : "worker-1";
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: decision("dispatch", { task: { task_id: "T-1", owner: "research", scope: "Inspect report.", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies the requested source."] } }) }));
    else { workerSignal = request.options.signal; workerSignal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true }); }
  });
  const pending = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 20 && !workerSignal; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(workerSignal);
  await pi.commands.get("goal").handler("cancel", {});
  assert.equal(workerSignal.aborted, true);
  assert.equal((await pending).status, "blocked");
  const graph = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.equal(graph.nodes["T-1"].scheduler_status, "blocked");
});

test("managed Operation cancellation aborts all claimed wave Tasks and blocks ghost-running nodes", async () => {
  const pi = fakePi(); await startMission(pi, "Cancel wave.");
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Cancel wave.", required_task_ids: ["T-1", "T-2"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`.", "T-2": "Inspect `lib/coordinator.mjs`." } });
  const active = [];
  pi.events.on("subagents:rpc:spawn", (req) => {
    const id = `agent-${active.length}-${req.type}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (req.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: decision("dispatch_batch", { tasks: [task("T-1"), task("T-2")] }) }));
    else {
      active.push(req);
      req.options.signal.addEventListener("abort", () => pi.events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    }
  });
  const pending = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 40 && active.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(active.length, 2);
  const snapshotBefore = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.deepEqual(Object.values(snapshotBefore.nodes).map((node) => node.scheduler_status), ["running", "running"]);
  await call(pi, "pi_harness_cancel_operation", { operation_id: "O-1" });
  assert.ok(active.every((req) => req.options.signal.aborted));
  assert.equal((await pending).status, "blocked");
  const snapshotAfter = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.deepEqual(Object.values(snapshotAfter.nodes).map((node) => node.scheduler_status), ["blocked", "blocked"]);
});

test("late results from both old-session parallel Tasks cannot overwrite the new session", async () => {
  const pi = fakePi(); await startMission(pi, "Old wave.");
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-OLD", objective: "Old wave.", required_task_ids: ["T-1", "T-2"], task_intents: { "T-1": "Inspect `lib/coordinator.mjs`.", "T-2": "Inspect `lib/coordinator.mjs`." } });
  const workers = [];
  pi.events.on("subagents:rpc:spawn", (req) => {
    const id = req.type === "coordinator" ? "old-coordinator" : `old-${workers.length + 1}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (req.type === "coordinator") queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify({ version: 1, operation_id: "O-OLD", action: "dispatch_batch", reason: "Both Tasks are independent.", tasks: [task("T-1"), task("T-2")] }) }));
    else workers.push({ id, req }); // Hold terminal events even after abort to test late completions.
  });
  const NativeAbortController = globalThis.AbortController;
  const controllers = [];
  let old;
  try {
    globalThis.AbortController = class extends NativeAbortController {
      constructor() { super(); controllers.push(this); }
    };
    old = call(pi, "pi_harness_run_operation", { operation_id: "O-OLD" });
    for (let i = 0; i < 40 && workers.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  } finally { globalThis.AbortController = NativeAbortController; }
  assert.equal(workers.length, 2);
  assert.equal(controllers[0].signal.aborted, false, "the managed Operation is active before session_start");
  const running = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-OLD"];
  assert.deepEqual([running.nodes["T-1"].scheduler_status, running.nodes["T-2"].scheduler_status], ["running", "running"]);
  assert.ok(workers.every(({ req }) => !req.options.signal.aborted));

  const freshEntries = [];
  await pi.sessionStart(freshEntries);
  assert.equal(controllers[0].signal.aborted, true, "session_start aborts the old managed Operation controller");
  assert.ok(workers.every(({ req }) => req.options.signal.aborted), "session_start aborts both ExecutionUnits");
  await startMission(pi, "New session sentinel.");
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-NEW", objective: "New session sentinel.", required_task_ids: ["T-NEW"], heads: [{ head_id: "H-NEW", domain: "testing", task_ids: ["T-NEW"] }] });
  const expectedEntries = structuredClone(freshEntries);
  const assertFresh = () => {
    assert.deepEqual(freshEntries, expectedEntries, "stale callbacks must not append or overwrite any new-session entry");
    const snapshot = freshEntries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
    assert.deepEqual(Object.keys(snapshot.operations), ["O-OLD", "O-NEW"]);
    assert.equal(snapshot.task_graphs["O-OLD"].nodes["T-1"].scheduler_status, "blocked");
    assert.equal(snapshot.attempt_ledger["A-O-OLD-T-1-01"].status, "unknown");
    assert.equal(snapshot.operations["O-NEW"].objective, "New session sentinel.");
    assert.deepEqual(Object.keys(snapshot.operations["O-NEW"].task_results), []);
    assert.deepEqual([snapshot.task_graphs["O-NEW"].nodes["T-NEW"].scheduler_status, snapshot.task_graphs["O-NEW"].nodes["T-NEW"].attempts], ["ready", 0]);
  };
  assertFresh();
  // Reverse completion order: both old child results arrive after O-NEW exists.
  for (const child of [...workers].reverse()) {
    pi.events.emit("subagents:completed", { id: child.id, status: "completed", result: `Late private report from ${child.id}.` });
    await new Promise((resolve) => setImmediate(resolve));
    assertFresh();
  }
  assert.equal((await old).status, "blocked");
  assertFresh();
});

test("managed Coordinator receives Operation inputs and dispatches a registered Worker", async () => {
  const pi = fakePi(); await startMission(pi, "Implement context economics.");
  const constraints = ["Do not bypass Coordinator.", "Do not change Scheduler authority."];
  const task_intents = { "T-1": "Implement stable prompt and deterministic context maintenance." };
  await call(pi, "pi_harness_operation", {
    action: "create", operation_id: "O-1", objective: "Implement context economics.",
    required_task_ids: ["T-1"], constraints, task_intents, task_specs: { "T-1": { owner: "worker", permission: "write", verification: "true" } },
  });
  let workerRequest;
  let sequence = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    const id = `agent-${++sequence}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "coordinator") {
      queueMicrotask(() => {
        const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"OperationBrief"')));
        assert.deepEqual(packet.OperationBrief.constraints, constraints);
        assert.deepEqual(packet.OperationBrief.task_intents, task_intents);
        assert.deepEqual(packet.OperationBrief.ready_task_ids, ["T-1"]);
        pi.events.emit("subagents:completed", {
          id, status: "completed",
          result: decision("dispatch", { task: {
            task_id: "T-1", owner: "worker", scope: "Implement stable prompt and deterministic context maintenance.",
            permission: "write", verification: "true",
          } }),
        });
      });
    } else if (request.type === "worker") {
      workerRequest = request;
      request.options.signal.addEventListener("abort", () => {
        pi.events.emit("subagents:failed", { id, status: "stopped" });
      }, { once: true });
    }
  });

  const run = call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  for (let i = 0; i < 40 && !workerRequest; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(workerRequest, "the registered Worker TaskOrder must spawn");
  assert.equal(workerRequest.options.isolation, "worktree");
  assert.match(workerRequest.prompt, /Implement stable prompt and deterministic context maintenance/);
  assert.match(workerRequest.prompt, /Operation O-1/);
  const graph = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
  assert.equal(graph.nodes["T-1"].scheduler_status, "running");

  await call(pi, "pi_harness_cancel_operation", { operation_id: "O-1" });
  assert.equal((await run).status, "blocked");
});

test("serial Coordinator turns dispatch through Harness; Commander receives only OperationReport", async () => {
  const pi = fakePi(); await startMission(pi, "Check reports.");
  const constraints = ["Do not bypass Coordinator.", "Do not change Scheduler authority."];
  const task_intents = { "T-1": "Inspect the first registered task.", "T-2": "Inspect the dependent registered task." };
  await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-1", objective: "Check reports.", required_task_ids: ["T-1", "T-2"], dependencies: { "T-2": ["T-1"] }, acceptance_criteria: ["The Coordinator checked the result."], constraints, task_intents });
  const types = [], prompts = [], order = ["T-1", "T-2"];
  let stage = 0, seq = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    types.push(request.type); prompts.push(request.prompt);
    if (request.type === "research") {
      assert.match(request.prompt, /Constraint: Do not bypass Coordinator\./);
      assert.match(request.prompt, /Constraint: Do not change Scheduler authority\./);
      const graph = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-1"];
      const currentTask = types.filter((type) => type === "research").length === 1 ? "T-1" : "T-2";
      assert.equal(graph.nodes[currentTask].scheduler_status, "running", "claim must persist before package spawn");
      assert.equal(graph.nodes[currentTask].attempts, 1);
    }
    const id = `agent-${++seq}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => {
      if (request.type === "coordinator") {
        const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"OperationBrief"')));
        assert.deepEqual(packet.OperationBrief.constraints, constraints);
        assert.deepEqual(packet.OperationBrief.task_intents, task_intents);
        assert.ok(!request.prompt.includes("RAW PRIVATE REPORT"));
        assert.ok(!request.prompt.includes("RAW REVIEWER OUTPUT"));
        const steps = [
          () => decision("dispatch", { task: { ...task("T-1"), scope: task_intents["T-1"] } }),
          () => decision("accept_task", { task_id: "T-1" }),
          () => decision("dispatch", { task: { ...task("T-2"), scope: task_intents["T-2"] } }),
          () => decision("accept_task", { task_id: "T-2" }),
          () => decision("accept_criterion", { criterion: "The Coordinator checked the result.", evidence_refs: [packet.OperationBrief.task_results["T-1"].evidence_refs[0]] }),
        ];
        return pi.events.emit("subagents:completed", { id, status: "completed", result: steps[stage++]() });
      }
      if (request.type === "research") return pi.events.emit("subagents:completed", { id, status: "completed", result: `RAW PRIVATE REPORT ${order.shift()}: The report identifies \`lib/coordinator.mjs\`.` });
      const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"version"')));
      const response = { version: 1, task_id: packet.task_id, status: "verified", summary: "RAW REVIEWER OUTPUT", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status: "passed", finding: "The semantic Verifier checked the selected report.", evidence_refs: [packet.evidence[0].reference] })) };
      pi.events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify(response) });
    });
  });
  const report = await call(pi, "pi_harness_run_operation", { operation_id: "O-1" });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.accepted_task_ids, ["T-1", "T-2"]);
  assert.equal(report.commander_action_required, true);
  assert.ok(!JSON.stringify(report).includes("RAW PRIVATE REPORT"));
  assert.ok(!JSON.stringify(report).includes("RAW REVIEWER OUTPUT"));
  assert.deepEqual(types, ["coordinator", "research", "reviewer", "coordinator", "coordinator", "research", "reviewer", "coordinator", "coordinator"]);
  const managedSnapshot = pi.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  for (const id of ["T-1", "T-2"]) {
    const result = managedSnapshot.operations["O-1"].task_results[id];
    assert.equal(result.operation_id, "O-1");
    assert.equal(result.task_id, id);
    assert.equal(result.execution_status, "execution_complete");
    assert.equal(result.verification_status, "verified");
    assert.equal(managedSnapshot.task_graphs["O-1"].nodes[id].scheduler_status, "accepted");
    for (const ref of result.evidence_refs) assert.deepEqual([readEvidence(ref).metadata.operation_id, readEvidence(ref).metadata.task_id], ["O-1", id]);
  }
  assert.ok(prompts.filter((_, i) => types[i] === "coordinator").every((text) => !text.includes("RAW PRIVATE REPORT")));
  assert.equal(pi.entries.some((entry) => entry.customType === "pi-harness-goal-state"), true);
  const restored = fakePi(pi.entries);
  assert.equal(restored.entries.filter((entry) => entry.customType === "pi-harness-operation-state").at(-1).data["O-1"].status, "complete");
  const snapshot = restored.entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
  assert.deepEqual(snapshot.operations["O-1"].accepted_task_ids, Object.keys(snapshot.task_graphs["O-1"].nodes).filter((id) => snapshot.task_graphs["O-1"].nodes[id].scheduler_status === "accepted"));
  assert.ok(!JSON.stringify(snapshot.task_graphs).includes("RAW PRIVATE REPORT"));
  assert.ok(!JSON.stringify(snapshot.task_graphs).includes("RAW REVIEWER OUTPUT"));
  const status = await call(restored, "pi_harness_operation", { action: "status", operation_id: "O-1" });
  assert.equal(status.status, "complete");
  assert.equal(Object.hasOwn(status, "task_results"), false);
});

test("trusted TaskSpec resolves ID-only dispatch and rejects mechanical substitution", async () => {
  const operation=op();
  let dispatched;
  const report=await runOperation(operation, {
    turn: async()=>dispatched ? decision("report") : decision("dispatch", {task_id:"T-1"}),
    dispatch: async task=>{dispatched=task;return {version:1,operation_id:"O-1",task_id:"T-1",execution_status:"execution_complete",verification_status:"verified",evidence_refs:[]};}
  });
  assert.equal(report.status,"blocked");
  assert.equal(dispatched.verification,"Inspect report.");
  assert.equal(dispatched.permission,"read");
  for (const mutation of [{verification:"printenv"},{owner:"worker",permission:"write"},{review_profile:{"The report identifies \u0060lib/coordinator.mjs\u0060.":"security"}}]) {
    assert.throws(()=>parseCoordinatorDecision(decision("dispatch",{task:{...task("T-1"),...mutation}}),operation),/trusted TaskSpec/);
  }
  const legacy=registerOperation({operation_id:"O-1",objective:"Legacy",required_task_ids:["T-1"],task_intents:{"T-1":"Inspect."}});
  assert.throws(()=>parseCoordinatorDecision(decision("dispatch",{task_id:"T-1"}),legacy),/trusted registered TaskSpec/);
  assert.throws(()=>registerOperation({...operation,task_specs:{"FOREIGN":operation.task_specs["T-1"]}}),/unregistered/);
  assert.throws(()=>registerOperation({...operation,task_specs:{"T-1":{...operation.task_specs["T-1"],permission:"unlimited"}}}),/permission/);
  assert.throws(()=>parseCoordinatorDecision(decision("dispatch_batch",{task_ids:["T-1","T-1"]}),operation),/invalid TaskOrder batch/);
  const copy=structuredClone(operation.task_specs);copy["T-1"].verification="changed";
  assert.equal(operation.task_specs["T-1"].verification,"Inspect report.");
});

test("failure projection is bounded across transport, execution, persistence and restore", async () => {
  const codes=["HARNESS_RPC_TIMEOUT","HARNESS_CHILD_SPAWN_FAILED","HARNESS_CHILD_TERMINAL_TIMEOUT","HARNESS_CANCELLED","HARNESS_LINEAGE_MISMATCH","HARNESS_WORKTREE_FAILED","HARNESS_EVIDENCE_FAILED","HARNESS_VERIFIER_FAILED","HARNESS_GATE_TIMEOUT","HARNESS_SECURITY_REVIEW_UNAVAILABLE","HARNESS_SEMANTIC_REVIEW_FAILED"];
  for(const code of codes) {
    let snapshot;
    const report=await runOperation(op(),{
      turn:async()=>decision("dispatch",{task_id:"T-1"}),
      dispatch:async()=>{throw Object.assign(new Error("PRIVATE_STDOUT PRIVATE_STDERR /tmp/private-worktree"),{code});},
      save:(operation,state,graph)=>{snapshot={operation,state,graph};}
    });
    assert.equal(report.scheduler_blockers[0].failure_code,code);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE|private-worktree/);
    assert.deepEqual(operationReport(snapshot.operation,snapshot.state,undefined,undefined,snapshot.graph).scheduler_blockers,report.scheduler_blockers);
  }
  let spawned=false;
  const failed=await runOperation(op(),{
    turn:async()=>decision("dispatch",{task_id:"T-1"}),
    dispatch:async()=>{spawned=true;},
    save:()=>{throw new Error("PRIVATE_PERSISTENCE_PASSWORD");}
  });
  assert.equal(spawned,false);
  assert.equal(failed.failure_code,"HARNESS_SCHEDULER_PERSISTENCE_FAILED");
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_PERSISTENCE/);
});

test("Commander findings omit model-authored execution bytes and Evidence references",()=>{
  const operation={...op(),accepted_task_ids:["T-1"],task_results:{"T-1":{findings:[{statement:"Registered criterion.",criterion:"Registered criterion.",verification_status:"verified",source_role:"research",verifier:"semantic",finding:"PRIVATE_WORKER_STDOUT",evidence_refs:["PRIVATE_RAW_EVIDENCE"]}]}}};
  const report=operationReport(operation,coordinatorState(operation));
  assert.equal(report.major_findings[0].statement,"Registered criterion.");
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
});
