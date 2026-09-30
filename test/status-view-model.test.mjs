import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildStatusViewModel, formatExpandedStatus, formatStatusFooter } from "../lib/status-view-model.mjs";

const mission = { mission_id: "M-1", objective: "core-hardening status redesign", status: "active", operation_ids: ["O-1"] };
const operation = {
  operation_id: "O-1", objective: "verifier-fix status work", status: "open", required_task_ids: ["T01", "T02", "T03", "T04", "T05", "T06"],
  task_intents: {
    T01: "accepted setup work", T02: "fix reviewer contract", T03: "semantic verification", T04: "add regression coverage",
    T05: "recover interrupted inspection", T06: "confirm additional result",
  },
  task_specs: { T01: { owner: "worker" }, T02: { owner: "worker" }, T03: { owner: "worker" }, T04: { owner: "worker" }, T05: { owner: "research" }, T06: { owner: "scout" } },
  task_results: { T06: { verification_status: "failed", verification_summary: "PRIVATE RAW EVIDENCE MUST NOT APPEAR" } },
};
const graph = { nodes: {
  T01: { task_id: "T01", scheduler_status: "accepted", attempts: 1 },
  T02: { task_id: "T02", scheduler_status: "running", verification_status: "not_verified", attempts: 1 },
  T03: { task_id: "T03", scheduler_status: "running", verification_status: "verifying", attempts: 1 },
  T04: { task_id: "T04", scheduler_status: "ready", attempts: 0 },
  T05: { task_id: "T05", scheduler_status: "blocked", blocker: { child_status: "unknown" }, attempts: 1 },
  T06: { task_id: "T06", scheduler_status: "result_available", attempts: 1 },
} };
const usage = { tokens: 164_000, contextWindow: 272_000, percent: 60.3 };
const telemetry = {
  cache_hit_ratio: 0.94, cache_read_tokens: 2_200_000, cache_write_tokens: 0,
  warming_requests: 0, warming_runtime_catalog_cost: null, input_tokens: 127_000,
  output_tokens: 26_000, runtime_catalog_cost: 0.047, gc_bytes_removed: 0,
};
const fixture = (overrides = {}) => buildStatusViewModel({
  missions: { [mission.mission_id]: mission }, operations: { [operation.operation_id]: operation },
  taskGraphs: { [operation.operation_id]: graph }, selectedMissionId: mission.mission_id,
  attemptLedger: { "A-raw-id-must-not-display": { operation_id: operation.operation_id, status: "unknown" } },
  activeOperationId: operation.operation_id, contextUsage: usage, telemetry,
  runtime: { modelDisplayName: "GPT-5.6 Sol", effort: "high" }, ...overrides,
});

test("idle footer gives Mission identity and runtime/economics their dedicated rows", () => {
  const idle = buildStatusViewModel({ contextUsage: usage, telemetry, runtime: { modelDisplayName: "GPT-5.6 Sol", effort: "medium" } });
  const lines = formatStatusFooter(idle, 160);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Mission Idle/);
  assert.match(lines[0], /Context 164k\/272k 60%/);
  assert.match(lines[1], /GPT-5\.6 Sol · Medium/);
  assert.match(lines[1], /✓0 ●0 ○0 !0 W0 V0/);
  assert.match(lines[1], /GC clean · Cache 94% · Est \$0\.047/);
  assert.doesNotMatch(lines[0], /GPT|Operation|Commander|Cmd/);
  assert.doesNotMatch(lines[1], /cache read|read 2\.2M|Warm|I\/O|Input|Output/i);

  const terminalMission = buildStatusViewModel({ missions: { "M-1": { ...mission, status: "complete" } }, selectedMissionId: "M-1" });
  assert.match(formatStatusFooter(terminalMission, 120)[0], /Mission Idle/);
});

test("active Mission and Scheduler counts use the compact row vocabulary", () => {
  const model = fixture();
  const lines = formatStatusFooter(model, 160);
  assert.match(lines[0], /Mission core-hardening status redesign/);
  assert.match(lines[1], /GPT-5\.6 Sol · High  ✓1 ●2 ○1 !2 W1 V1/);
  assert.doesNotMatch(lines.join("\n"), /verifier-fix|Cmd |M —|O —|T02|T03/);
});

test("blocked Tasks retain error styling and counter priority", () => {
  const seenTones = [];
  const theme = { fg(tone, text) { seenTones.push([tone, text]); return `\u001b[31m${text}\u001b[0m`; } };
  const lines = formatStatusFooter(fixture(), 100, theme);
  assert.match(lines[1], /!2/);
  assert.ok(seenTones.some(([tone, text]) => tone === "error" && text === "!2"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("wide columns right-align economics and medium and narrow forms reduce before truncating", () => {
  const model = fixture();
  const wide = formatStatusFooter(model, 160);
  const medium = formatStatusFooter(model, 65);
  const narrow = formatStatusFooter(model, 40);
  const veryNarrow = formatStatusFooter(model, 20);
  for (const [width, lines] of [[160, wide], [65, medium], [40, narrow], [20, veryNarrow]]) {
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `all lines fit ${width} columns`);
  }
  for (const [line, rightLabel] of [[wide[0], "Context "], [wide[1], "GC "]]) {
    const rightStart = line.indexOf(rightLabel);
    const leftAndGap = line.slice(0, rightStart);
    assert.ok(rightStart > 0, `wide right section contains ${rightLabel}`);
    assert.match(leftAndGap, / +$/, "left and right columns have a readable gap");
    assert.equal(visibleWidth(line), 160, "the right section reaches the terminal edge");
  }
  assert.match(wide[0], /Context 164k\/272k 60%/);
  assert.match(wide[1], /GC clean · Cache 94% · Est \$0\.047/);
  assert.match(medium[0], /Context 164k\/272k 60%/);
  assert.match(medium[1], /✓1 ●2 ○1 !2 W1 V1/);
  assert.match(medium[1], /GC clean · Cache 94%/);
  assert.doesNotMatch(medium[1], /Est /);
  assert.match(narrow[0], /Mission core-harden/);
  assert.match(narrow[1], /GPT-5\.6 Sol · High/);
  assert.match(veryNarrow[0], /Ctx 60%/);
});

test("missing model and effort render as em dashes without a fabricated fallback", () => {
  const noIdentity = buildStatusViewModel({ contextUsage: usage });
  assert.equal(noIdentity.runtime.modelDisplayName, null);
  assert.equal(noIdentity.runtime.effort, null);
  assert.match(formatStatusFooter(noIdentity, 120)[1], /— · —/);

  const noModel = buildStatusViewModel({ contextUsage: usage, runtime: { effort: "high" } });
  assert.match(formatStatusFooter(noModel, 120)[1], /— · High/);
  const noEffort = buildStatusViewModel({ contextUsage: usage, runtime: { modelDisplayName: "Daybreak Blue" } });
  assert.match(formatStatusFooter(noEffort, 120)[1], /Daybreak Blue · —/);
});

test("parallel Workers and Verifiers appear from TaskGraph lifecycle state", () => {
  const parallelOperation = { ...operation, required_task_ids: ["T02", "T03", "T04"], task_specs: { T02: { owner: "worker" }, T03: { owner: "worker" }, T04: { owner: "worker" } } };
  const parallelGraph = { nodes: {
    T02: { task_id: "T02", scheduler_status: "running", attempts: 1 },
    T03: { task_id: "T03", scheduler_status: "running", attempts: 1 },
    T04: { task_id: "T04", scheduler_status: "running", verification_status: "verifying", attempts: 1 },
  } };
  const model = buildStatusViewModel({ missions: { [mission.mission_id]: mission }, operations: { "O-1": parallelOperation }, taskGraphs: { "O-1": parallelGraph }, selectedMissionId: mission.mission_id, activeOperationId: "O-1" });
  assert.deepEqual(model.counts, { accepted: 0, running: 3, pending: 0, blocked: 0, workers: 2, verifiers: 1 });
  assert.match(formatStatusFooter(model, 160)[1], /W2 V1/);
});

test("idle, running, verifying, blocked, resumed, and completed snapshots preserve authoritative lifecycle", () => {
  const idle = buildStatusViewModel({ missions: { [mission.mission_id]: mission }, selectedMissionId: mission.mission_id });
  assert.equal(idle.commander.state, "idle");
  assert.match(formatExpandedStatus(idle), /No active Workers or Verifiers/);

  const blocked = buildStatusViewModel({ missions: { [mission.mission_id]: mission }, operations: { "O-1": operation }, taskGraphs: { "O-1": graph }, selectedMissionId: mission.mission_id });
  assert.equal(blocked.commander.state, "blocked");
  assert.match(formatExpandedStatus(blocked), /! blocked    2/);

  const running = fixture();
  assert.equal(running.commander.state, "coordinating");
  assert.equal(running.counts.running, 2);
  assert.equal(running.counts.verifiers, 1);

  const resumedLedger = { "A-1": { operation_id: "O-1", task_id: "T02", status: "execution_complete" } };
  const resumed = buildStatusViewModel({ missions: { [mission.mission_id]: mission }, operations: { "O-1": operation }, taskGraphs: { "O-1": graph }, selectedMissionId: mission.mission_id, attemptLedger: resumedLedger });
  assert.equal(resumed.counts.running, 2, "a resumed Mission retains the registered TaskGraph state");
  assert.equal(resumed.commander.state, "blocked", "no current managed run is inferred from old Attempt history");

  const completeOperation = { ...operation, status: "complete", required_task_ids: ["T01"], accepted_task_ids: ["T01"], task_results: { T01: { verification_status: "verified" } }, task_specs: { T01: { owner: "worker" } }, task_intents: { T01: "accepted setup work" } };
  const completeGraph = { nodes: { T01: { task_id: "T01", scheduler_status: "accepted", attempts: 1 } } };
  const completed = buildStatusViewModel({ missions: { [mission.mission_id]: mission }, operations: { "O-1": completeOperation }, taskGraphs: { "O-1": completeGraph }, selectedMissionId: mission.mission_id });
  assert.equal(completed.commander.state, "complete");
  assert.equal(completed.counts.accepted, 1);
});

test("unknown telemetry stays unknown and GC pending outranks high-context status", () => {
  const unknown = buildStatusViewModel({ missions: { [mission.mission_id]: mission }, selectedMissionId: mission.mission_id,
    contextUsage: { tokens: null, contextWindow: 272_000, percent: null } });
  const unknownLines = formatStatusFooter(unknown, 160);
  assert.match(unknownLines[0], /Context —\/272k —%/);
  assert.match(unknownLines[1], /— · —/);
  assert.match(unknownLines[1], /Cache —/);
  assert.match(unknownLines[1], /Est —/);

  const high = fixture({ contextUsage: { tokens: 260_000, contextWindow: 272_000, percent: 95.6 }, gcPending: true });
  assert.equal(high.context.ecoState, "GC pending");
  assert.match(formatStatusFooter(high, 160)[1], /GC pending/);
  const compacting = fixture({ piCompacting: true, gcPending: true });
  assert.equal(compacting.context.ecoState, "Pi compacting");
});

test("expanded status is bounded and excludes attempt IDs, TaskSpecs, transcripts, and raw Evidence", () => {
  const model = fixture();
  assert.doesNotMatch(JSON.stringify(model), /A-raw-id|result_available|task_specs|scheduler_status|attempts/i);
  const text = formatExpandedStatus(model);
  assert.match(text, /Mission\n  core-hardening status redesign/);
  assert.match(text, /Operation: verifier-fix status work/);
  assert.match(text, /Worker 01\s+T02/);
  assert.match(text, /Verifier 01\s+T03/);
  assert.match(text, /Cache read\s+2\.2M/);
  assert.match(text, /Est\. cost\s+\$0\.047/);
  assert.match(text, /T05 — recover interrupted inspection blocked/);
  assert.doesNotMatch(text, /A-raw-id|PRIVATE RAW EVIDENCE MUST NOT APPEAR|task_specs|execution.policy|\u001b\[/i);
  assert.ok(text.length < 8_000);
});
