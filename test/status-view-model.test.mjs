import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildStatusViewModel, formatExpandedStatus, formatStatusFooter } from "../lib/status-view-model.mjs";

const task = (id, status, owner, scope, role = owner) => ({ task_id: id, status, assignment: { owner, scope }, attempts: [{ children: [{ child_id: `child-${id}`, role }] }] });
const work = { work_id: "W-1", objective: "core-hardening status redesign", status: "active", tasks: {
  T01: task("T01", "accepted", "worker", "accepted setup work"),
  T02: task("T02", "running", "worker", "fix reviewer contract"),
  T03: task("T03", "running", "worker", "semantic verification", "reviewer"),
  T04: task("T04", "ready", "worker", "add regression coverage"),
  T05: task("T05", "unknown", "research", "recover interrupted inspection"),
  T06: task("T06", "failed", "scout", "confirm additional result"),
} };
const usage = { tokens: 164_000, contextWindow: 272_000, percent: 60.3 };
const telemetry = {
  cache_hit_ratio: 0.94, cache_read_tokens: 2_200_000, cache_write_tokens: 0,
  warming_requests: 0, warming_runtime_catalog_cost: null, input_tokens: 127_000,
  output_tokens: 26_000, runtime_catalog_cost: 0.047, gc_bytes_removed: 0,
};
const fixture = (overrides = {}) => buildStatusViewModel({
  works: { [work.work_id]: work }, selectedWorkId: work.work_id, contextUsage: usage, telemetry,
  runtime: { modelDisplayName: "GPT-5.6 Sol", effort: "high" }, ...overrides,
});

test("idle footer gives Work identity and runtime/economics their dedicated rows", () => {
  const idle = buildStatusViewModel({ contextUsage: usage, telemetry, runtime: { modelDisplayName: "GPT-5.6 Sol", effort: "medium" } });
  const lines = formatStatusFooter(idle, 160);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Work Idle/);
  assert.match(lines[0], /Context 164k\/272k 60%/);
  assert.match(lines[1], /GPT-5\.6 Sol · Medium/);
  assert.match(lines[1], /✓0 ●0 ○0 !0 W0 V0/);
  assert.match(lines[1], /within limit · Cache 94% · Est \$0\.047/);
  assert.doesNotMatch(lines[0], /GPT|Operation|Commander|Cmd/);
  assert.doesNotMatch(lines[1], /cache read|read 2\.2M|Warm|I\/O|Input|Output/i);

  const terminalWork = buildStatusViewModel({ works: { "W-1": { ...work, status: "complete" } }, selectedWorkId: "W-1" });
  assert.match(formatStatusFooter(terminalWork, 120)[0], /Work Idle/);
});

test("active Work and Task counts use the compact row vocabulary", () => {
  const model = fixture();
  const lines = formatStatusFooter(model, 160);
  assert.match(lines[0], /Work core-hardening status redesign/);
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
  for (const [line, rightLabel] of [[wide[0], "Context "], [wide[1], "within limit"]]) {
    const rightStart = line.indexOf(rightLabel);
    const leftAndGap = line.slice(0, rightStart);
    assert.ok(rightStart > 0, `wide right section contains ${rightLabel}`);
    assert.match(leftAndGap, / +$/, "left and right columns have a readable gap");
    assert.equal(visibleWidth(line), 160, "the right section reaches the terminal edge");
  }
  assert.match(wide[0], /Context 164k\/272k 60%/);
  assert.match(wide[1], /within limit · Cache 94% · Est \$0\.047/);
  assert.match(medium[0], /Context 164k\/272k 60%/);
  assert.match(medium[1], /✓1 ●2 ○1 !2 W1 V1/);
  assert.match(medium[1], /within limit · Cache 94%/);
  assert.doesNotMatch(medium[1], /Est /);
  assert.match(narrow[0], /Work core-harden/);
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

test("parallel Workers and Verifiers appear from Task lifecycle state", () => {
  const parallelWork = { ...work, tasks: { T02: work.tasks.T02, T03: work.tasks.T02, T04: work.tasks.T03 } };
  const model = buildStatusViewModel({ works: { "W-1": parallelWork }, selectedWorkId: "W-1" });
  assert.deepEqual(model.counts, { accepted: 0, running: 3, pending: 0, blocked: 0, workers: 2, verifiers: 1 });
  assert.match(formatStatusFooter(model, 160)[1], /W2 V1/);
});

test("idle, running, blocked, resumed, and completed snapshots use one work record", () => {
  const idle = buildStatusViewModel({ works: { "W-1": { ...work, tasks: {} } }, selectedWorkId: "W-1" });
  assert.equal(idle.commander.state, "idle");
  assert.match(formatExpandedStatus(idle), /No active Workers or Verifiers/);
  const running = fixture();
  assert.equal(running.commander.state, "executing");
  assert.equal(running.counts.running, 2);
  const blocked = buildStatusViewModel({ works: { "W-1": { ...work, tasks: { T05: work.tasks.T05 } } }, selectedWorkId: "W-1" });
  assert.equal(blocked.commander.state, "blocked");
  const completed = buildStatusViewModel({ works: { "W-1": { ...work, status: "complete", tasks: { T01: work.tasks.T01 } } }, selectedWorkId: "W-1" });
  assert.equal(completed.commander.state, "complete");
  assert.equal(completed.counts.accepted, 1);
});

test("unknown telemetry stays unknown and native compaction outranks high-context status", () => {
  const unknown = buildStatusViewModel({ works: { [work.work_id]: work }, selectedWorkId: work.work_id,
    contextUsage: { tokens: null, contextWindow: 272_000, percent: null } });
  const unknownLines = formatStatusFooter(unknown, 160);
  assert.match(unknownLines[0], /Context —\/272k —%/);
  assert.match(unknownLines[1], /— · —/);
  assert.match(unknownLines[1], /Cache —/);
  assert.match(unknownLines[1], /Est —/);

  const high = fixture({ contextUsage: { tokens: 260_000, contextWindow: 272_000, percent: 95.6 }, gcPending: true });
  assert.equal(high.context.ecoState, "near limit");
  assert.match(formatStatusFooter(high, 160)[1], /near limit/);
  const compacting = fixture({ piCompacting: true, gcPending: true });
  assert.equal(compacting.context.ecoState, "Pi compacting");
});

test("expanded status is bounded and excludes attempt IDs, TaskSpecs, transcripts, and raw Evidence", () => {
  const model = fixture();
  assert.doesNotMatch(JSON.stringify(model), /A-raw-id|result_available|task_specs|scheduler_status|attempts/i);
  const text = formatExpandedStatus(model);
  assert.match(text, /Work\n  core-hardening status redesign/);
  assert.doesNotMatch(text, /Operation:/);
  assert.match(text, /Worker 01\s+T02/);
  assert.match(text, /Verifier 01\s+T03/);
  assert.match(text, /Cache read\s+2\.2M/);
  assert.match(text, /Est\. cost\s+\$0\.047/);
  assert.match(text, /T05 — recover interrupted inspection blocked/);
  assert.doesNotMatch(text, /A-raw-id|PRIVATE RAW EVIDENCE MUST NOT APPEAR|task_specs|execution.policy|\u001b\[/i);
  assert.ok(text.length < 8_000);
});
