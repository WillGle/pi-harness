import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskOrder, taskResult, promoteTaskResult } from "../lib/communication.mjs";
import { storeEvidence, readEvidence } from "../lib/evidence.mjs";
import { reviewTask, verificationPacket, validateSemanticReview, acceptedFindings } from "../lib/semantic-verifier.mjs";
import { executeCoordinateTask, cancelCoordinateTasks } from "../lib/coordinator.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-semantic-test-"));
const old = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = root;
after(() => { if (old === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = old; rmSync(root, { recursive: true, force: true }); });
const cwd = process.cwd();

function order(role = "worker", taskId = "T-1") {
  return taskOrder({ owner: role, task_id: taskId, scope: "Review `lib/coordinator.mjs`.", verification: "npm test", permission: role === "worker" ? "write" : "read", acceptance_criteria: ["The Coordinator retains the cancellation condition."] });
}
function resultFor(orderValue, evidenceRefs) { return { task_id: orderValue.task_id, changed_paths: ["lib/coordinator.mjs"], evidence_refs: evidenceRefs }; }
function reviewerReply(packet, status = "passed") {
  return JSON.stringify({ version: 1, task_id: packet.task_id, status: status === "passed" ? "verified" : status === "failed" ? "failed" : "blocked", summary: "The semantic Verifier checked the criterion.", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status, finding: "The semantic Verifier checked the selected Evidence.", evidence_refs: status === "passed" ? [packet.evidence[0].reference] : [] })) });
}

test("semantic review selects one Evidence kind and validates every criterion", async () => {
  const task = order();
  const diff = storeEvidence({ cwd, taskId: task.task_id, kind: "diff", content: "diff --git a/lib/coordinator.mjs b/lib/coordinator.mjs" });
  const gate = storeEvidence({ cwd, taskId: task.task_id, kind: "gate", content: "secret-unrelated-gate" });
  const input = resultFor(task, [gate.reference, diff.reference]);
  const packet = verificationPacket(task, input, cwd);
  assert.deepEqual(packet.evidence.map((item) => item.reference), [diff.reference]);
  const gateOnly = { ...task, review_evidence: { [task.acceptance_criteria[0]]: "gate" } };
  assert.deepEqual(verificationPacket(gateOnly, input, cwd).evidence.map((item) => item.reference), [gate.reference]);
  assert.ok(!JSON.stringify(packet).includes("secret-unrelated-gate"));
  const review = await reviewTask(task, input, cwd, async (prompt) => {
    assert.ok(!prompt.includes("secret-unrelated-gate"));
    assert.ok(!prompt.includes(gate.reference));
    return { status: "completed", result: reviewerReply(packet) };
  });
  assert.equal(review.status, "verified");
  assert.equal(review.criteria[0].status, "passed");
  assert.equal(readEvidence(review.evidence_refs.at(-1), cwd).metadata.kind, "semantic_review");
  const record = { status: "completed", verificationRan: true, gatePassed: true, branch: "branch", commitCheck: { valid: true }, commitCount: 1 };
  const verified = taskResult(task, record, { evidenceRefs: [...input.evidence_refs, ...review.evidence_refs], semanticVerification: review });
  assert.equal(verified.verification_status, "verified");
  assert.ok(!JSON.stringify(verified).includes("diff --git"));
  assert.equal(taskResult(task, { ...record, gatePassed: false }, { semanticVerification: review }).verification_status, "failed");
  assert.equal(taskResult(task, record, { evidenceError: true, semanticVerification: review }).verification_status, "failed");
  assert.equal(taskResult(task, record).verification_status, "not_verified");
});

test("malformed, unresolved, truncated or tampered Evidence fails closed", async () => {
  const task = order("research", "T-2");
  const report = storeEvidence({ cwd, taskId: task.task_id, kind: "report", content: "Research observation." });
  const input = resultFor(task, [report.reference]);
  const packet = verificationPacket(task, input, cwd);
  assert.throws(() => validateSemanticReview(task, packet, "not json"));
  assert.throws(() => validateSemanticReview(task, packet, JSON.stringify({ ...JSON.parse(reviewerReply(packet)), criteria: [] })));
  const malformed = await reviewTask(task, input, cwd, async () => ({ status: "completed", result: "verified" }));
  assert.equal(malformed.status, "blocked");
  const failed = await reviewTask(task, input, cwd, async () => ({ status: "completed", result: reviewerReply(packet, "failed") }));
  assert.equal(failed.status, "failed");
  assert.equal(taskResult(task, { status: "completed" }, { semanticVerification: failed }).verification_status, "failed");
  const unresolved = await reviewTask(task, input, cwd, async () => ({ status: "completed", result: reviewerReply(packet, "not_checked") }));
  assert.equal(unresolved.status, "blocked");
  assert.equal(taskResult(task, { status: "completed" }, { semanticVerification: unresolved }).verification_status, "blocked");
  const bad = storeEvidence({ cwd, taskId: task.task_id, kind: "report", content: "truncated", truncated: true });
  assert.equal((await reviewTask(task, resultFor(task, [bad.reference]), cwd, async () => { throw Error("must not spawn"); })).status, "blocked");
  assert.deepEqual(acceptedFindings({ findings: [{ statement: "unverified", verification_status: "not_verified", evidence_refs: [report.reference] }] }), []);
});

class Bus {
  handlers = new Map();
  on(name, handler) { const handlers = this.handlers.get(name) ?? new Set(); handlers.add(handler); this.handlers.set(name, handlers); return () => handlers.delete(handler); }
  emit(name, event) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
}

test("Harness-owned read-only reviewer returns verified Finding, not raw reviewer context", async () => {
  const events = new Bus();
  const unrelated = storeEvidence({ cwd, taskId: "OTHER", kind: "report", content: "UNRELATED PRIVATE DATA" });
  const spawns = [];
  events.on("subagents:rpc:spawn", (req) => {
    spawns.push(req);
    const id = `agent-${spawns.length}`;
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => {
      if (req.type === "research") return events.emit("subagents:completed", { id, status: "completed", result: "`executeCoordinateTask` persists Evidence before TaskResult." });
      const packet = JSON.parse(req.prompt.slice(req.prompt.indexOf("{\"version\"")));
      assert.ok(!req.prompt.includes("UNRELATED PRIVATE DATA"));
      assert.ok(!req.prompt.includes(unrelated.reference));
      events.emit("subagents:completed", { id, status: "completed", result: reviewerReply(packet) });
    });
  });
  const result = await executeCoordinateTask({ events }, { owner: "research", task_id: "T-RESEARCH", scope: "Inspect `lib/coordinator.mjs`.", verification: "file evidence", permission: "read", acceptance_criteria: ["`executeCoordinateTask` persists Evidence before TaskResult."] }, { cwd, timeout: 1000, rpcTimeout: 1000 });
  assert.deepEqual(spawns.map((req) => req.type), ["research", "reviewer"]);
  assert.equal(spawns[1].options.isolation, "off");
  assert.equal(result.taskResult.verification_status, "verified");
  assert.equal(acceptedFindings(result.taskResult)[0].source_role, "research");
  assert.equal(acceptedFindings(result.taskResult)[0].verification_status, "verified");
  assert.ok(!JSON.stringify(promoteTaskResult(result)).includes("Research observation."));
  assert.ok(!JSON.stringify(promoteTaskResult(result)).includes("UNRELATED PRIVATE DATA"));
  const reviewer = readFileSync(".pi/agents/reviewer.md", "utf8");
  assert.match(reviewer, /tools: read, grep, find, ls/);
  assert.doesNotMatch(reviewer, /tools:.*\bbash\b/);
});

test("group cancellation stops only the active semantic Reviewer", async () => {
  const events = new Bus();
  const reviewers = new Map();
  let id = 0;
  events.on("subagents:rpc:spawn", (req) => {
    const agentId = `agent-${++id}`;
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id: agentId } });
    if (req.type === "research") queueMicrotask(() => events.emit("subagents:completed", { id: agentId, status: "completed", result: "report" }));
    else {
      reviewers.set(req.prompt.includes("T-A") ? "T-A" : "T-B", { req, agentId });
      req.options.signal.addEventListener("abort", () => events.emit("subagents:failed", { id: agentId, status: "stopped" }), { once: true });
    }
  });
  const input = (task_id) => ({ owner: "research", task_id, scope: "Find report", verification: "inspect", permission: "read", acceptance_criteria: ["The report identifies a source."] });
  const a = executeCoordinateTask({ events }, input("T-A"), { cwd, groupId: "A", timeout: 1500, rpcTimeout: 1000 });
  const b = executeCoordinateTask({ events }, input("T-B"), { cwd, groupId: "B", timeout: 1500, rpcTimeout: 1000 });
  for (let i = 0; i < 20 && reviewers.size !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reviewers.size, 2);
  assert.equal(cancelCoordinateTasks("A"), 1);
  assert.equal(reviewers.get("T-A").req.options.signal.aborted, true);
  assert.equal(reviewers.get("T-B").req.options.signal.aborted, false);
  const packet = JSON.parse(reviewers.get("T-B").req.prompt.slice(reviewers.get("T-B").req.prompt.indexOf("{\"version\"")));
  events.emit("subagents:completed", { id: reviewers.get("T-B").agentId, status: "completed", result: reviewerReply(packet) });
  assert.equal((await a).taskResult.verification_status, "blocked");
  assert.equal((await b).taskResult.verification_status, "verified");
});
