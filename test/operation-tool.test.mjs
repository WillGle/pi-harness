import { mockSettlement } from "./helpers/mock-settlement.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import harness from "../extensions/pi-harness.ts";
import { addWorkTask, claimWorkTask, createWork, WORK_ENTRY } from "../lib/work.mjs";
import { readControlState } from "../lib/control-state-store.mjs";
import { trackControlPi } from "./helpers/control-state-isolation.mjs";

function makePi(entries = []) {
  const tools = new Map(), handlers = new Map(), listeners = new Map();
  const pi = {
    tools, entries, commands: new Map(), spawns: 0, followUps: [],
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { this.commands.set(name, command); },
    sendUserMessage(text, options) { this.followUps.push({ text, options }); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    events: {
      on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
      emit(name, event) { mockSettlement(name, event); if (name === "subagents:rpc:spawn") pi.spawns++; for (const fn of [...(listeners.get(name) ?? [])]) fn(event); },
    },
    ready() { return handlers.get("session_start")({}, { sessionManager: { getEntries: () => entries }, mode: "rpc" }); },
    shutdown() { return handlers.get("session_shutdown")?.(); },
    contextPrompt() { const event = { systemPromptOptions: { sections: {} } }; handlers.get("before_agent_start")(event, {}); return event.systemPromptOptions.sections.pi_harness_contract; },
  };
  harness(pi); pi.sessionReady = pi.ready(); return trackControlPi(pi);
}
async function call(pi, name, input) { await pi.sessionReady; return JSON.parse((await pi.tools.get(name).execute("test", input)).content[0].text); }
async function resume(pi, id) { await pi.sessionReady; return pi.commands.get("work").handler("resume " + id, {}); }

test("Commander context receives the Harness contract without skill selection", async () => {
  const pi = makePi(); await pi.sessionReady;
  assert.match(pi.contextPrompt(), /You are the Commander/);
  assert.match(pi.contextPrompt(), /original objective/);
  assert.doesNotMatch(pi.contextPrompt(), /ASD-STE100|Only the Coordinator|CoordinatorDecision/);
});
test("natural-language Commander starts work and retains its Constraints", async () => {
  const pi = makePi();
  const started = await call(pi, "pi_harness_start_work", { objective: "Fix authentication.", constraints: ["Preserve the API."] });
  assert.equal(started.status, "active"); assert.match(started.work_id, /^W-/);
  assert.deepEqual(started.constraints, ["Preserve the API."]); assert.equal(pi.spawns, 0);
  assert.match(pi.followUps.at(-1).text, /Fix authentication/);
  await assert.rejects(call(pi, "pi_harness_start_work", { objective: "Conflicting work." }), /active work/);
  const previousEvidence = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = process.env.PI_HARNESS_CONTROL_DIR + "/evidence";
  let sequence = 0;
  pi.events.on("subagents:rpc:spawn", (request) => {
    assert.equal(request.type, "research", "optional reviewers must not spawn by default");
    const id = `direct-research-${++sequence}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => pi.events.emit("subagents:completed", { id, status: "completed", result: "The API remains compatible. Entry point: src/auth.ts." }));
  });
  try {
    const assignment = { owner: "research", scope: "Inspect authentication entry points.", acceptance_criteria: ["Identify the entry point and API compatibility."] };
    const delegated = await call(pi, "pi_harness_delegate", assignment);
    assert.equal(delegated.task.status, "result_available");
    assert.equal(delegated.task.attempts[0].result.verification_status, "not_verified");
    assert.match(delegated.task.attempts[0].result.report, /src\/auth.ts/);
    await assert.rejects(call(pi, "pi_harness_goal", { status: "complete", evidence: "The child stopped." }), /unresolved/);
    await call(pi, "pi_harness_work", { action: "reject", task_id: delegated.task.task_id, evidence: "The first report needs a stronger API compatibility explanation." });
    const retried = await call(pi, "pi_harness_delegate", { ...assignment, retry_task_id: delegated.task.task_id });
    assert.equal(retried.task.attempts.length, 2);
    const accepted = await call(pi, "pi_harness_work", { action: "accept", task_id: delegated.task.task_id, evidence: "Reviewed the entry point and confirmed API compatibility against the original constraint." });
    assert.equal(accepted.task.status, "accepted");
    assert.equal(accepted.task.attempts[1].result.verification_status, "not_verified", "Commander review does not fabricate independent verification");
    assert.equal((await call(pi, "pi_harness_goal", { status: "complete", evidence: "The authentication entry point and API compatibility were reviewed." })).status, "complete");
    assert.equal(pi.spawns, 2);
  } finally { if (previousEvidence === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = previousEvidence; }

});
test("new work does not silently select persisted work", async () => {
  const old = createWork("Old work."); const pi = makePi([{ customType: WORK_ENTRY, data: { [old.work_id]: old } }]);
  const fresh = await call(pi, "pi_harness_start_work", { objective: "New work." });
  assert.notEqual(fresh.work_id, old.work_id);
  assert.equal(pi.entries.filter((entry) => entry.customType === WORK_ENTRY).at(-1).data[old.work_id].objective, "Old work.");
});
test("Commander acceptance requires an available result and Evidence", async () => {
  let work = createWork("Inspect the source.");
  const added = addWorkTask(work, { owner: "research", scope: "Inspect source.", permission: "read", verification: "Review report.", acceptance_criteria: ["State the entry point."] });
  work = claimWorkTask(added.work, added.task_id);
  const pi = makePi([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]);
  await resume(pi, work.work_id);
  await assert.rejects(call(pi, "pi_harness_work", { action: "accept", task_id: added.task_id, evidence: "No result exists." }), /available result/);
  await assert.rejects(call(pi, "pi_harness_goal", { status: "complete", evidence: "Not enough." }), /unresolved/);
  const state = await call(pi, "pi_harness_work", { action: "status", task_id: added.task_id });
  assert.equal(state.task.status, "unknown"); assert.equal(pi.spawns, 0);
});
test("Commander can cancel work without fabricating completion", async () => {
  const pi = makePi(); await call(pi, "pi_harness_start_work", { objective: "Inspect safely." });
  const cancelled = await call(pi, "pi_harness_work", { action: "cancel" }); assert.equal(cancelled.status, "cancelled");
  await assert.rejects(call(pi, "pi_harness_goal", { status: "complete", evidence: "Cancelled." }), /resume/);
});
test("delegation requires active selected work", async () => {
  const pi = makePi(); await assert.rejects(call(pi, "pi_harness_delegate", { owner: "research", scope: "Inspect.", acceptance_criteria: ["Report findings."] }), /resume/);
});
test("Commander changes saved work only after explicit selection", async () => {
  const work = createWork("Restore safely."), pi = makePi([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]);
  await assert.rejects(call(pi, "pi_harness_goal", { status: "complete", evidence: "Reviewed." }), /resume/);
  await resume(pi, work.work_id);
  const complete = await call(pi, "pi_harness_goal", { status: "complete", evidence: "The direct investigation satisfies the objective." });
  assert.equal(complete.work_id, work.work_id); assert.equal(complete.status, "complete");
});
test("resuming work validates the existing control lease", async () => {
  const work = createWork("Resume safely."), pi = makePi([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]);
  await resume(pi, work.work_id); await resume(pi, work.work_id);
  assert.equal(readControlState().works[work.work_id].status, "active");
});
test("multiple restored work items stay unselected until an exact ID is resumed", async () => {
  const first = createWork("First."), second = createWork("Second.");
  const pi = makePi([{ customType: WORK_ENTRY, data: { [first.work_id]: first, [second.work_id]: second } }]);
  await assert.rejects(call(pi, "pi_harness_goal", { status: "complete", evidence: "Ambiguous." }), /resume/);
  await resume(pi, second.work_id);
  assert.equal((await call(pi, "pi_harness_work", { action: "status" })).work_id, second.work_id);
});
test("a Pi session cannot transfer control state to another project", async () => {
  const pi = makePi(); await pi.sessionReady;
  await assert.rejects(pi.tools.get("pi_harness_start_work").execute("test", { objective: "Different project." }, undefined, undefined, { cwd: "/tmp/pi-harness-other-project" }), /project directory/);
  assert.equal(readControlState("/tmp/pi-harness-other-project"), undefined);
});
test("completed work cannot be resumed or reopened", async () => {
  const work = { ...createWork("Already closed."), status: "complete", evidence: "Direct work was checked." };
  const pi = makePi([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]); await pi.sessionReady;
  await assert.rejects(resume(pi, work.work_id), /unfinished/);
});
test("errored work can be explicitly resumed and cancelled", async () => {
  const work = { ...createWork("Recover safely."), status: "error" };
  const pi = makePi([{ customType: WORK_ENTRY, data: { [work.work_id]: work } }]); await resume(pi, work.work_id);
  assert.equal((await call(pi, "pi_harness_work", { action: "cancel" })).status, "cancelled");
});
test("legacy state is preserved read-only and old dispatch tools are removed", async () => {
  const entries = [{ customType: "pi-harness-mission-state", data: { "M-old": { status: "active" } } }];
  const pi = makePi(entries);
  await assert.rejects(call(pi, "pi_harness_start_work", { objective: "Do not overwrite legacy state." }), /read-only/);
  for (const name of ["pi_harness_coordinate", "pi_harness_operation", "pi_harness_run_operation"]) assert.equal(pi.tools.has(name), false);
  assert.equal(entries[0].data["M-old"].status, "active"); assert.equal(pi.spawns, 0);
});
