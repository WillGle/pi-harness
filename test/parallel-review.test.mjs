import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCoordinateTask } from "../lib/coordinator.mjs";
import { createOperation } from "../lib/operation.mjs";
import { runOperation } from "../lib/operation-runner.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-parallel-review-"));
const prior = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = root;
after(() => { if (prior === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = prior; rmSync(root, { recursive: true, force: true }); });
const model = "openai/gpt-daybreak-blue-latest";
class Bus {
  handlers = new Map();
  on(name, handler) { const set = this.handlers.get(name) ?? new Set(); set.add(handler); this.handlers.set(name, set); return () => set.delete(handler); }
  emit(name, event) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("cancellation aborts both active Reviewers without a ghost-running Task", async () => {
  const events = new Bus(), reviews = [];
  const controller = new AbortController();
  let seq = 0, last;
  const tasks = [
    { task_id: "T-1", owner: "research", permission: "read", scope: "Review T-1", verification: "Check report", acceptance_criteria: ["Report T-1 valid."] },
    { task_id: "T-2", owner: "research", permission: "read", scope: "Review T-2", verification: "Check report", acceptance_criteria: ["Report T-2 valid."] },
  ];
  events.on("subagents:rpc:spawn", (req) => {
    const id = `cancel-agent-${++seq}`;
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (req.type === "research") queueMicrotask(() => events.emit("subagents:completed", { id, status: "completed", result: "Report." }));
    else {
      reviews.push(req);
      req.options.signal.addEventListener("abort", () => events.emit("subagents:failed", { id, status: "stopped" }), { once: true });
    }
  });
  const operation = createOperation({ operation_id: "O-P", objective: "Review reports.", required_task_ids: ["T-1", "T-2"] });
  const run = runOperation(operation, {
    turn: async () => JSON.stringify({ version: 1, operation_id: "O-P", action: "dispatch_batch", reason: "Both Tasks are ready.", tasks }),
    dispatch: (task) => executeCoordinateTask({ events }, task, { cwd: process.cwd(), groupId: "O-P", signal: controller.signal, timeout: 1500, rpcTimeout: 1000 }).then((record) => record.taskResult),
    save: (_op, _state, graph) => { last = graph; },
  }, { signal: controller.signal });
  for (let i = 0; i < 30 && reviews.length < 2; i++) await tick();
  assert.equal(reviews.length, 2);
  controller.abort();
  assert.ok(reviews.every((review) => review.options.signal.aborted));
  assert.equal((await run).status, "blocked");
  assert.deepEqual(Object.values(last.nodes).map((node) => node.scheduler_status), ["blocked", "blocked"]);
});

test("parallel default/security Reviewers see only their own Task Evidence and model", async () => {
  const events = new Bus(), requested = [], reviews = [];
  let seq = 0, final;
  const symbol = Symbol.for("pi-subagents:manager"), old = globalThis[symbol];
  globalThis[symbol] = { getRecord: () => ({ invocation: { modelId: model } }) };
  events.on("subagents:rpc:spawn", (req) => {
    requested.push(req);
    const id = `agent-${++seq}`;
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, { success: true, data: { id } });
    if (req.type === "research") queueMicrotask(() => events.emit("subagents:completed", { id, status: "completed", result: `PRIVATE-${req.prompt.includes("T-1") ? "T-1" : "T-2"}` }));
    else reviews.push({ req, id });
  });
  const op = createOperation({ operation_id: "O-P", objective: "Review reports.", required_task_ids: ["T-1", "T-2"] });
  const tasks = [
    { task_id: "T-1", owner: "research", permission: "read", scope: "Review T-1.", verification: "Check T-1 report.", acceptance_criteria: ["T-1 report is valid."] },
    { task_id: "T-2", owner: "research", permission: "read", scope: "Review T-2.", verification: "Check T-2 report.", acceptance_criteria: ["T-2 report is valid."], review_profile: { "T-2 report is valid.": "security" } },
  ];
  try {
    const run = runOperation(op, {
      turn: async (_prompt) => requested.length === 0 ? JSON.stringify({ version: 1, operation_id: "O-P", action: "dispatch_batch", reason: "Both Tasks are ready.", tasks })
        : JSON.stringify({ version: 1, operation_id: "O-P", action: "report", reason: "The Coordinator will accept each Task separately." }),
      dispatch: (task) => executeCoordinateTask({ events }, task, { cwd: process.cwd(), timeout: 1500, rpcTimeout: 1000, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-daybreak-blue-latest" }] } }).then((record) => record.taskResult),
      save: (operation, _state, graph) => { final = { operation, graph }; },
    });
    for (let i = 0; i < 30 && reviews.length !== 2; i++) await tick();
    assert.equal(reviews.length, 2, "both review pipelines must overlap");
    assert.deepEqual(reviews.map((item) => item.req.type).sort(), ["reviewer", "security-reviewer"]);
    for (const { req, id } of reviews) {
      const packet = JSON.parse(req.prompt.slice(req.prompt.indexOf('{"version"')));
      const own = packet.task_id, sibling = own === "T-1" ? "T-2" : "T-1";
      assert.ok(JSON.stringify(packet).includes(`PRIVATE-${own}`));
      assert.ok(!JSON.stringify(packet).includes(`PRIVATE-${sibling}`));
      assert.equal(req.options.model, own === "T-2" ? model : null);
      assert.deepEqual(packet.acceptance_criteria, [`${own} report is valid.`]);
      events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify({ version: 1, task_id: own, status: "verified", summary: "Selected Evidence checked.", criteria: [{ criterion: packet.acceptance_criteria[0], status: "passed", finding: "Selected Evidence checked.", evidence_refs: [packet.evidence[0].reference] }] }) });
    }
    await run;
    assert.deepEqual(Object.keys(final.operation.task_results).sort(), ["T-1", "T-2"]);
    assert.equal(final.operation.task_results["T-1"].semantic_verification.criteria[0].verifier, "semantic");
    assert.equal(final.operation.task_results["T-2"].semantic_verification.criteria[0].verifier, "security");
    assert.deepEqual(final.operation.accepted_task_ids, [], "verification does not accept the Operation");
    assert.deepEqual([final.graph.nodes["T-1"].scheduler_status, final.graph.nodes["T-2"].scheduler_status], ["result_available", "result_available"]);
  } finally { if (old === undefined) delete globalThis[symbol]; else globalThis[symbol] = old; }
});
