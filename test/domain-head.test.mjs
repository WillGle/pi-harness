import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOperation } from "../lib/operation.mjs";
import { acceptTaskResult, recordTaskResult } from "../lib/operation.mjs";
import { acceptGraphTask, claimTask, createTaskGraph, recordTaskGraphResult } from "../lib/task-graph.mjs";
import { createHeadRegistry, domainBrief, headReport, headState, parseHeadDecision, validateHeadRegistry } from "../lib/domain-head.mjs";
import { parseCoordinatorDecision, runOperation } from "../lib/operation-runner.mjs";

const operation = () => createOperation({ operation_id: "O-G", objective: "Complete both domains.", required_task_ids: ["T-ARCH", "T-TEST", "T-FREE"], dependencies: { "T-TEST": ["T-ARCH"] }, constraints: ["Do not integrate branches."], acceptance_criteria: ["The Operation has checked domain evidence."], task_intents: { "T-ARCH": "Assess the architecture boundary.", "T-TEST": "Verify cancellation behavior.", "T-FREE": "Write unrelated documentation." } });
const heads = [{ head_id: "H-A", domain: "architecture", task_ids: ["T-ARCH"] }, { head_id: "H-T", domain: "testing", task_ids: ["T-TEST"] }];
const decision = (action, extra = {}) => JSON.stringify({ version: 1, operation_id: "O-G", head_id: "H-A", action, reason: "The Head recommends the assigned TaskOrder.", ...extra });
const coordinator = (action, extra = {}) => JSON.stringify({ version: 1, operation_id: "O-G", action, reason: "The Coordinator needs domain advice.", ...extra });
const task = { task_id: "T-ARCH", owner: "scout", scope: "Inspect architecture.", permission: "read", verification: "Report findings." };

test("static registry validates IDs and permits unassigned Tasks and no Heads", () => {
  const op = operation();
  assert.deepEqual(createHeadRegistry(op).heads, {});
  assert.equal(validateHeadRegistry(createHeadRegistry(op, heads), op).heads["H-T"].domain, "testing");
  for (const invalid of [
    [heads[0], heads[0]],
    [{ ...heads[0], task_ids: ["T-ARCH", "T-ARCH"] }],
    [{ ...heads[0], task_ids: ["OTHER"] }],
    [{ ...heads[0], task_ids: [] }],
    [{ ...heads[0], domain: " " }],
    [heads[0], { ...heads[1], task_ids: ["T-ARCH"] }],
  ]) assert.throws(() => createHeadRegistry(op, invalid));
});

test("Operation rejects unknown or oversized Task intent and invalid shared constraints", () => {
  const base = { operation_id: "O-G", objective: "Verify work.", required_task_ids: ["T-A"] };
  assert.throws(() => createOperation({ ...base, task_intents: { "T-OTHER": "Foreign intent." } }));
  assert.throws(() => createOperation({ ...base, task_intents: { "T-A": "x".repeat(501) } }));
  assert.throws(() => createOperation({ ...base, constraints: [" "] }));
  assert.equal(createOperation(base).task_intents, undefined);
});

test("DomainBrief isolates assigned Tasks and exposes foreign Dependencies only as accepted status", () => {
  const op = operation(), graph = createTaskGraph(op), registry = createHeadRegistry(op, heads);
  const packet = domainBrief(op, graph, registry, "H-T", headState("O-G", "H-T"));
  assert.deepEqual(packet.DomainBrief.ready_task_ids, []);
  assert.deepEqual(packet.DomainBrief.pending_task_ids, ["T-TEST"]);
  assert.deepEqual(packet.DomainBrief.dependencies["T-TEST"], [{ task_id: "T-ARCH", status: "pending" }]);
  assert.deepEqual(packet.DomainBrief.task_ids, ["T-TEST"]);
  assert.equal(packet.DomainBrief.objective, "Complete both domains.");
  assert.deepEqual(packet.DomainBrief.task_intents, { "T-TEST": "Verify cancellation behavior." });
  assert.deepEqual(packet.DomainBrief.constraints, ["Do not integrate branches."]);
  assert.deepEqual(packet.DomainBrief.acceptance_criteria, ["The Operation has checked domain evidence."]);
  assert.ok(!JSON.stringify(packet).includes("T-FREE"));
  for (const forbidden of ["Commander transcript", "Worker transcript", "Reviewer transcript", "raw Evidence", "diff", "stdout", "stderr"]) assert.ok(!JSON.stringify(packet).includes(forbidden));
  assert.deepEqual(domainBrief(op, graph, registry, "H-A", headState("O-G", "H-A")).DomainBrief.ready_task_ids, ["T-ARCH"]);
  const claimed = claimTask(graph, op, "T-ARCH");
  const result = recordTaskResult(op, { version: 1, operation_id: "O-G", task_id: "T-ARCH", execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] });
  const available = recordTaskGraphResult(claimed, result, "T-ARCH");
  const accepted = acceptTaskResult(result, "T-ARCH");
  const acceptedGraph = acceptGraphTask(available, result, accepted, "T-ARCH");
  const after = domainBrief(accepted, acceptedGraph, registry, "H-T", headState("O-G", "H-T")).DomainBrief;
  assert.deepEqual(after.ready_task_ids, ["T-TEST"]);
  assert.deepEqual(after.dependencies["T-TEST"], [{ task_id: "T-ARCH", status: "accepted" }]);
  assert.ok(!Object.hasOwn(after.task_results, "T-ARCH"));
});

test("HeadDecision rejects foreign identity, pending dispatch and malformed authority", () => {
  const op = operation(), graph = createTaskGraph(op), registry = createHeadRegistry(op, heads);
  const parse = (raw, id = "H-A") => parseHeadDecision(raw, op, graph, registry, id);
  const valid = parse(decision("recommend_dispatch", { task_id: "T-ARCH", task }));
  assert.equal(headReport(valid, registry).recommendation.task_id, "T-ARCH");
  assert.deepEqual(headReport(valid, registry).recommendation.task, task);
  const detailed = { ...task, constraints: ["Do not integrate."], acceptance_criteria: ["Check the boundary."], review_evidence: { "Check the boundary.": "report" } };
  assert.deepEqual(headReport(parse(decision("recommend_dispatch", { task_id: "T-ARCH", task: detailed })), registry).recommendation.task, detailed);
  for (const raw of ["nonsense", decision("recommend_dispatch", { task_id: "T-TEST", task: { ...task, task_id: "T-TEST" } }), decision("recommend_dispatch", { task_id: "T-ARCH", task: { ...task, owner: "head" } }), decision("complete_mission"), decision("recommend_accept", { task_id: "T-ARCH" }), decision("report", { spawn: "worker" }), decision("report").replace('"O-G"', '"O-FOREIGN"'), decision("report").replace('"H-A"', '"H-T"')]) assert.throws(() => parse(raw));
  assert.throws(() => parse(JSON.stringify({ ...JSON.parse(decision("recommend_dispatch", { task_id: "T-TEST", task: { ...task, task_id: "T-TEST" } })), head_id: "H-T" }), "H-T"));
  assert.throws(() => parseCoordinatorDecision(coordinator("consult_head", { head_id: " " }), op));
  assert.deepEqual(graph, createTaskGraph(op));
  assert.deepEqual(op.accepted_task_ids, []);
});

test("consultation returns advice without dispatch or acceptance; repeated advice blocks", async () => {
  const op = operation(), graph = createTaskGraph(op), registry = createHeadRegistry(op, heads);
  let calls = 0, dispatches = 0, snapshot;
  const report = await runOperation(op, {
    turn: async (prompt) => {
      if (calls > 0) {
        const packet = JSON.parse(prompt.slice(prompt.indexOf('{"OperationBrief"')));
        assert.equal(packet.OperationBrief.head_report.recommendation.action, "recommend_dispatch");
        assert.deepEqual(packet.OperationBrief.head_report.recommendation.task, task);
        assert.ok(!JSON.stringify(packet).includes("Head transcript"));
      }
      return coordinator("consult_head", { head_id: "H-A" });
    },
    headTurn: async (prompt) => { calls++; assert.ok(prompt.includes('"DomainBrief"')); return decision("recommend_dispatch", { task_id: "T-ARCH", task }); },
    dispatch: async () => { dispatches++; throw Error("must not dispatch"); },
    save: (next, state, nextGraph, states) => { snapshot = { next, state, nextGraph, states }; },
  }, { registry, graph });
  assert.equal(calls, 3);
  assert.equal(dispatches, 0);
  assert.match(report.blocker, /cannot consult a Head/);
  assert.deepEqual(snapshot.next, op);
  assert.deepEqual(snapshot.nextGraph, graph);
  assert.equal(snapshot.states["H-A"].turns, 3);
  assert.equal(snapshot.states["H-A"].decisions.length, 3);
  assert.ok(!JSON.stringify(snapshot.states).includes("Head transcript"));
});

test("foreign Head cannot be consulted; invalid HeadDecision fails closed", async () => {
  const op = operation(), registry = createHeadRegistry(op, heads);
  let called = false;
  const report = await runOperation(op, { turn: async () => coordinator("consult_head", { head_id: "H-UNKNOWN" }), headTurn: async () => { called = true; } }, { registry });
  assert.equal(called, false);
  assert.equal(report.status, "blocked");
  const malformed = await runOperation(op, { turn: async () => coordinator("consult_head", { head_id: "H-A" }), headTurn: async () => "Head transcript" }, { registry });
  assert.equal(malformed.status, "blocked");
  assert.deepEqual(malformed.accepted_task_ids, []);
});

test("Head profile has no child or Harness tool authority", () => {
  const profile = readFileSync(new URL("../.pi/agents/head.md", import.meta.url), "utf8");
  assert.match(profile, /tools: read/);
  assert.match(profile, /extensions: false/);
  assert.match(profile, /skills: false/);
  assert.match(profile, /prompt_mode: replace/);
  assert.doesNotMatch(profile.split("---")[1], /bash|edit|write|Agent|pi_harness_coordinate/);
});
