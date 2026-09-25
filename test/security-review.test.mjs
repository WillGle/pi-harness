import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCoordinateTask, validateTask, cancelCoordinateTasks, securityReviewModel } from "../lib/coordinator.mjs";
import { taskOrder, taskResult } from "../lib/communication.mjs";

const dir = mkdtempSync(join(tmpdir(), "pi-security-test-"));
const previous = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = dir;
after(() => { if (previous === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
class Bus {
  handlers = new Map();
  on(name, handler) { const set = this.handlers.get(name) ?? new Set(); set.add(handler); this.handlers.set(name, set); return () => set.delete(handler); }
  emit(name, event) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
}
const modelRegistry = { getAvailable: () => [{ provider: "openai", id: "gpt-daybreak-blue-latest" }] };
const criteria = ["The API rejects unauthorized access.", "The response matches the contract."];
const input = (task_id = "SEC") => ({ owner: "research", task_id, scope: "Inspect API boundaries", verification: "Review selected report", permission: "read", acceptance_criteria: criteria, review_profile: { [criteria[0]]: "security", [criteria[1]]: "default" }, review_evidence: { [criteria[0]]: "report" } });
function fake({ available = true, failed = false, stalled = false } = {}) {
  const events = new Bus(), spawns = [];
  events.on("subagents:rpc:spawn", (request) => {
    spawns.push(request);
    const id = `${request.type}-${spawns.length}`;
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (stalled && request.type === "security-reviewer") {
      request.options.signal.addEventListener("abort", () => events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
      return;
    }
    queueMicrotask(() => {
      if (request.type === "research") return events.emit("subagents:completed", { id, status: "completed", result: "Selected API report" });
      if (!available && request.type === "security-reviewer") return events.emit("subagents:failed", { id, status: "failed", result: "model unavailable" });
      const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"version"')));
      const status = failed && request.type === "reviewer" ? "failed" : "passed";
      events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify({ version: 1, task_id: packet.task_id, status: status === "passed" ? "verified" : "failed", summary: "Checked selected Evidence.", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status, finding: "Checked selected Evidence.", evidence_refs: status === "passed" ? [packet.criterion_evidence[criterion]] : [] })) }) });
    });
  });
  return { events, spawns };
}

test("Review Profile validation is exact, independent, bounded, and opt-in", () => {
  assert.doesNotThrow(() => validateTask({ ...input(), review_profile: undefined }));
  assert.doesNotThrow(() => validateTask(input()));
  assert.doesNotThrow(() => validateTask({ ...input(), acceptance_criteria: ["toString"], review_profile: {}, review_evidence: {} }));
  for (const review_profile of [{ foreign: "security" }, { [criteria[0]]: "unknown" }, Array(33).fill(0), null]) assert.throws(() => validateTask({ ...input(), review_profile }));
  assert.throws(() => validateTask({ ...input(), acceptance_criteria: [criteria[0], criteria[0]] }));
  assert.equal(securityReviewModel(), "openai/gpt-daybreak-blue-latest");
  const profile = readFileSync(".pi/agents/security-reviewer.md", "utf8");
  for (const setting of ["tools: none", "extensions: false", "skills: false", "prompt_mode: replace"]) assert.ok(profile.includes(setting));
});

test("mixed criteria partition and model route; only selected Evidence and no transcripts", async () => {
  const f = fake();
  const symbol = Symbol.for("pi-subagents:manager"), prior = globalThis[symbol];
  globalThis[symbol] = { getRecord: () => ({ invocation: { modelId: securityReviewModel() } }) };
  try {
    const result = await executeCoordinateTask(f, input(), { cwd: process.cwd(), timeout: 1000, rpcTimeout: 1000, modelRegistry });
    assert.deepEqual(f.spawns.map((s) => s.type), ["research", "reviewer", "security-reviewer"]);
    assert.equal(f.spawns[1].options.model, null);
    assert.equal(f.spawns[2].options.model, securityReviewModel());
    assert.equal(result.taskResult.verification_status, "verified");
    assert.deepEqual(result.taskResult.semantic_verification.criteria.map((c) => [c.criterion, c.verifier]), [[criteria[0], "security"], [criteria[1], "semantic"]]);
    for (const [index, criterion] of [[1, criteria[1]], [2, criteria[0]]]) {
      const prompt = f.spawns[index].prompt;
      assert.ok(prompt.includes(criterion));
      assert.ok(!prompt.includes(criteria[index === 1 ? 0 : 1]));
      for (const text of ["Worker transcript", "Head transcript", "Coordinator transcript", "Commander transcript", dir]) assert.ok(!prompt.includes(text));
    }
  } finally { if (prior === undefined) delete globalThis[symbol]; else globalThis[symbol] = prior; }
});

test("security availability fails closed without default fallback or false provenance", async () => {
  const f = fake({ available: false });
  const result = await executeCoordinateTask(f, { ...input(), acceptance_criteria: [criteria[0]], review_profile: { [criteria[0]]: "security" } }, { cwd: process.cwd(), timeout: 1000, rpcTimeout: 1000, modelRegistry });
  assert.deepEqual(f.spawns.map((s) => s.type), ["research", "security-reviewer"]);
  assert.equal(result.taskResult.verification_status, "blocked");
  assert.match(result.taskResult.verification_summary, /not available through the current Pi\/provider configuration/);
  assert.equal(result.taskResult.semantic_verification.criteria[0].verifier, "security");
  assert.equal(result.taskResult.semantic_verification.criteria[0].status, "not_checked");
  const missing = fake();
  const blocked = await executeCoordinateTask(missing, { ...input("NO-MODEL"), acceptance_criteria: [criteria[0]], review_profile: { [criteria[0]]: "security" } }, { cwd: process.cwd(), timeout: 1000, rpcTimeout: 1000, modelRegistry: { getAvailable: () => [] } });
  assert.equal(blocked.taskResult.verification_status, "blocked");
  assert.deepEqual(missing.spawns.map((s) => s.type), ["research"]);
  const symbol = Symbol.for("pi-subagents:manager"), prior = globalThis[symbol];
  globalThis[symbol] = { getRecord: () => ({ invocation: { modelId: "openai/some-other-model" } }) };
  try {
    const wrong = fake();
    const task = { ...input("WRONG-MODEL"), acceptance_criteria: [criteria[0]], review_profile: { [criteria[0]]: "security" } };
    const outcome = await executeCoordinateTask(wrong, task, { cwd: process.cwd(), timeout: 1000, rpcTimeout: 1000, modelRegistry });
    assert.equal(outcome.taskResult.verification_status, "blocked");
    assert.equal(outcome.taskResult.semantic_verification.criteria[0].status, "not_checked");
  } finally { if (prior === undefined) delete globalThis[symbol]; else globalThis[symbol] = prior; }
});

test("security pass cannot override general failure; group cancellation aborts security reviewer", async () => {
  const symbol = Symbol.for("pi-subagents:manager"), prior = globalThis[symbol];
  globalThis[symbol] = { getRecord: () => ({ invocation: { modelId: securityReviewModel() } }) };
  try {
    const f = fake({ failed: true });
    const result = await executeCoordinateTask(f, input("FAIL"), { cwd: process.cwd(), timeout: 1000, rpcTimeout: 1000, modelRegistry });
    assert.equal(result.taskResult.verification_status, "failed");
    const worker = taskOrder({ ...input("GATE-FAIL"), owner: "worker", permission: "write", acceptance_criteria: [criteria[0]], review_profile: { [criteria[0]]: "security" } });
    assert.equal(taskResult(worker, { status: "completed", verificationRan: true, gatePassed: false }, { semanticVerification: { ...result.taskResult.semantic_verification, task_id: worker.task_id, status: "verified" } }).verification_status, "failed");
    const pending = fake({ stalled: true });
    const a = executeCoordinateTask(pending, { ...input("CANCEL"), acceptance_criteria: [criteria[0]], review_profile: { [criteria[0]]: "security" } }, { cwd: process.cwd(), groupId: "G-SEC", timeout: 1000, rpcTimeout: 1000, modelRegistry });
    for (let i = 0; i < 30 && !pending.spawns.some((s) => s.type === "security-reviewer"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = executeCoordinateTask(pending, { ...input("OTHER"), acceptance_criteria: [criteria[0]], review_profile: { [criteria[0]]: "security" } }, { cwd: process.cwd(), groupId: "G-OTHER", timeout: 1000, rpcTimeout: 1000, modelRegistry });
    for (let i = 0; i < 30 && pending.spawns.filter((s) => s.type === "security-reviewer").length !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const [cancelledRequest, unrelatedRequest] = pending.spawns.filter((s) => s.type === "security-reviewer");
    assert.equal(cancelCoordinateTasks("G-SEC"), 1);
    assert.equal(cancelledRequest.options.signal.aborted, true);
    assert.equal(unrelatedRequest.options.signal.aborted, false);
    cancelCoordinateTasks("G-OTHER");
    assert.equal((await other).taskResult.verification_status, "blocked");
    assert.equal((await a).taskResult.verification_status, "blocked");
  } finally { if (prior === undefined) delete globalThis[symbol]; else globalThis[symbol] = prior; }
});
