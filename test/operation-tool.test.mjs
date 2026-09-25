import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import harness from "../extensions/pi-harness.ts";
import { OPERATION_ENTRY } from "../lib/operation.mjs";
import { TASK_GRAPH_ENTRY } from "../lib/task-graph.mjs";

function makePi(entries) {
  const tools = new Map(), handlers = new Map(), listeners = new Map();
  const pi = {
    tools, entries,
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry(customType, data) { entries.push({ customType, data }); },
    events: {
      on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
      emit(name, event) { for (const fn of [...(listeners.get(name) ?? [])]) fn(event); },
    },
    start() { handlers.get("session_start")?.({}, { sessionManager: { getEntries: () => entries }, mode: "rpc" }); },
  };
  harness(pi);
  pi.start();
  return pi;
}

async function call(pi, name, input) { return JSON.parse((await pi.tools.get(name).execute("test", input)).content[0].text); }

test("Operation tool records only the Harness TaskResult and requires Coordinator acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-operation-tool-"));
  const old = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = dir;
  try {
    const entries = [];
    const pi = makePi(entries);
    await call(pi, "pi_harness_operation", { action: "create", operation_id: "O-test", objective: "Inspect logic.", required_task_ids: ["T-test"] });
    let counter = 0;
    pi.events.on("subagents:rpc:spawn", (request) => {
      const id = `agent-${++counter}`;
      pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
      queueMicrotask(() => {
        if (request.type === "research") return pi.events.emit("subagents:completed", { id, status: "completed", result: "RAW PRIVATE REPORT: The report identifies `lib/coordinator.mjs`." });
        const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf("{\"version\"")));
        const response = { version: 1, task_id: packet.task_id, status: "verified", summary: "The semantic Verifier checked the report.", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status: "passed", finding: "The semantic Verifier checked the selected report.", evidence_refs: [packet.evidence[0].reference] })) };
        pi.events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify(response) });
      });
    });
    assert.equal(entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-test"].nodes["T-test"].scheduler_status, "ready");
    const taskResult = await call(pi, "pi_harness_coordinate", { owner: "research", task_id: "T-test", operation_id: "O-test", scope: "Inspect logic.", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies `lib/coordinator.mjs`."] });
    assert.equal(taskResult.verification_status, "verified");
    assert.equal(taskResult.operation_id, "O-test");
    assert.ok(!JSON.stringify(taskResult).includes("RAW PRIVATE REPORT"));
    const pending = await call(pi, "pi_harness_operation", { action: "status", operation_id: "O-test" });
    assert.equal(pending.status, "open");
    assert.equal(pending.task_results["T-test"].verification_status, "verified");
    assert.equal(entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data.task_graphs["O-test"].nodes["T-test"].scheduler_status, "result_available");
    assert.equal((await call(pi, "pi_harness_operation", { action: "accept_task", operation_id: "O-test", task_id: "T-test" })).status, "complete");
    assert.equal(entries.some((entry) => entry.customType === "pi-harness-goal-state"), false);
    assert.ok(entries.some((entry) => entry.customType === OPERATION_ENTRY));
    const snapshot = entries.filter((entry) => entry.customType === TASK_GRAPH_ENTRY).at(-1).data;
    assert.deepEqual(snapshot.operations["O-test"].accepted_task_ids, ["T-test"]);
    assert.equal(snapshot.task_graphs["O-test"].nodes["T-test"].scheduler_status, "accepted");
    const restored = makePi(entries);
    assert.equal((await call(restored, "pi_harness_operation", { action: "status", operation_id: "O-test" })).status, "complete");
    await assert.rejects(() => call(restored, "pi_harness_operation", { action: "accept_task", operation_id: "O-test", task_id: "T-test" }));
  } finally {
    if (old === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR;
    else process.env.PI_HARNESS_EVIDENCE_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
