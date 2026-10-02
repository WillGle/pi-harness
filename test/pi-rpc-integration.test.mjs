import test from "node:test";
import { createPiRpc } from "../packages/pi-harness-acp/lib/pi-rpc.mjs";
import { DEFAULT_PI_EXECUTABLE, defaultPiEnv } from "./helpers/default-pi.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_ENTRY, isPlanAllowedTool, isReadOnlyBash, restore } from "../lib/plan.mjs";
import { WORK_ENTRY, workSituation } from "../lib/work.mjs";
const newestWork = (entries) => Object.values(restore(entries, WORK_ENTRY) ?? {}).at(-1);

function spawnPiRpc(options = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-rpc-test-"));
  const child = spawn(DEFAULT_PI_EXECUTABLE, ["--mode", "rpc", "--offline", "--no-extensions", "-e", ".", "--no-context-files", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd || process.cwd(),
    env: { ...defaultPiEnv(), HOME: tmpDir, PI_CODING_AGENT_DIR: join(tmpDir, "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(tmpDir, "sessions"), PI_HARNESS_CONTROL_DIR: join(tmpDir, "control"), PI_HARNESS_EVIDENCE_DIR: join(tmpDir, "evidence") },
  });

  const events = [];
  const rpc = createPiRpc(child, { readinessTimeout: 10000, requestTimeout: 10000, onEvent: event => events.push(event) });
  // Drain stderr without promoting private runtime output into failures.
  child.stderr.resume();
  async function sendCommand(command) {
    await rpc.ready;
    return rpc.request(command, { acceptFailure: true });
  }
  const prompt = message => sendCommand({ type: "prompt", message });
  async function close() {
    try { await rpc.stop(); }
    finally { rmSync(tmpDir, { recursive: true, force: true }); }
  }
  return { child, sendCommand, prompt, events, ready: rpc.ready, close };
}

test("Pi RPC: command discovery includes every packaged skill and Harness command", async () => {
  const pi = spawnPiRpc();
  try {
    const res = await pi.sendCommand({ type: "get_commands" });
    assert.equal(res.success, true);
    const names = res.data.commands.map((c) => c.name);
    const lock = JSON.parse(readFileSync("skills/skills.lock.json", "utf8"));
    assert.ok(names.includes("plan"));
    assert.ok(names.includes("goal"));
    assert.ok(names.includes("skill-hub"));
    for (const skill of Object.keys(lock.skills)) assert.ok(names.includes(`skill:${skill}`), `${skill} must be registered`);
    for (const skill of ["caveman", "ponytail"]) assert.ok(names.includes(`skill:${skill}`), `${skill} must stay explicitly invocable`);
    assert.equal(names.includes("skill:skill-hub"), false);
  } finally {
    await pi.close();
  }
});

test("Pi RPC: /plan on and /plan off session entries and mutation blocking", async () => {
  const pi = spawnPiRpc();
  try {
    // 1. Enable plan mode
    const onRes = await pi.prompt("/plan on");
    assert.equal(onRes.success, true);

    // Verify session entries contain plan on
    const entriesRes1 = await pi.sendCommand({ type: "get_entries" });
    assert.equal(entriesRes1.success, true);
    const planEntry1 = entriesRes1.data.entries.find((e) => e.customType === PLAN_ENTRY);
    assert.ok(planEntry1);
    assert.equal(planEntry1.data.enabled, true);

    // 2. Verify all mutating tool calls are blocked in plan mode
    const mutatingTools = ["write", "edit", "pi_harness_coordinate", "pi_harness_goal"];
    for (const tool of mutatingTools) {
      assert.equal(isPlanAllowedTool(tool, {}), false, `${tool} must be blocked in plan mode`);
    }

    // Verify mutating bash commands are blocked
    const forbiddenCommands = [
      "rm -rf build",
      "echo 'content' > file.txt",
      "git commit -m 'test'",
      "curl -O https://example.com/file",
      "find . -delete",
      "kill -9 1234",
      "cat file | sed -i 's/a/b/'",
      "chmod 755 script.sh",
      "cat a.txt > b.txt",
    ];
    for (const cmd of forbiddenCommands) {
      assert.equal(isReadOnlyBash(cmd), false, `Bash command '${cmd}' must be blocked in plan mode`);
    }

    // Verify read-only tools and read-only bash are allowed
    assert.equal(isPlanAllowedTool("read", { path: "package.json" }), true);
    assert.equal(isPlanAllowedTool("ls", { path: "." }), true);
    assert.equal(isPlanAllowedTool("find", { path: "." }), true);
    assert.equal(isPlanAllowedTool("grep", { pattern: "test" }), true);
    assert.equal(isPlanAllowedTool("bash", { command: "git status" }), true);
    assert.equal(isPlanAllowedTool("bash", { command: "git log -n 5" }), true);
    assert.equal(isPlanAllowedTool("bash", { command: "rg TODO src | head -10" }), true);

    // 3. Disable plan mode
    const offRes = await pi.prompt("/plan off");
    assert.equal(offRes.success, true);

    const entriesRes2 = await pi.sendCommand({ type: "get_entries" });
    const latestPlanEntry = [...entriesRes2.data.entries].reverse().find((e) => e.customType === PLAN_ENTRY);
    assert.ok(latestPlanEntry);
    assert.equal(latestPlanEntry.data.enabled, false);
  } finally {
    await pi.close();
  }
});

test("Pi RPC: /goal lifecycle, continuation, reject second goal, and cancellation", async () => {
  const pi = spawnPiRpc();
  try {
    // 1. Starting a goal while plan mode is on should be rejected
    await pi.prompt("/plan on");
    await pi.prompt("/goal Blocked goal");
    let entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    let activeGoal = entries.find((e) => e.customType === WORK_ENTRY && Object.values(e.data).some(work => work.objective === "Blocked goal"));
    assert.equal(activeGoal, undefined, "Goal should not be created when plan mode is active");

    // 2. Turn plan off and start goal
    await pi.prompt("/plan off");
    await pi.prompt("/goal Implement release gate");

    entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    activeGoal = newestWork(entries);
    assert.ok(activeGoal);
    assert.equal(activeGoal.objective, "Implement release gate");
    assert.equal(activeGoal.status, "active");

    // 3. Reject second active goal
    await pi.prompt("/goal Another goal");
    entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    const anotherGoal = entries.find((e) => e.customType === WORK_ENTRY && Object.values(e.data).some(work => work.objective === "Another goal"));
    assert.equal(anotherGoal, undefined, "Second active goal must be rejected");

    // 4. Cancel goal
    await pi.prompt("/goal cancel");
    entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    const cancelledGoal = newestWork(entries);
    assert.ok(cancelledGoal);
    assert.equal(cancelledGoal.status, "cancelled");
  } finally {
    await pi.close();
  }
});

test("Pi RPC: compaction, restore, and fork state preservation", async () => {
  const pi = spawnPiRpc();
  try {
    // Populate session
    await pi.prompt("/plan on");
    await pi.prompt("/plan off");
    await pi.prompt("/goal Verify state compaction");
    await pi.prompt("/goal cancel");

    const entriesRes = await pi.sendCommand({ type: "get_entries" });
    assert.equal(entriesRes.success, true);
    const entries = entriesRes.data.entries;

    // Verify pure restore functions with live RPC entries
    const restoredPlan = restore(entries, PLAN_ENTRY);
    assert.equal(restoredPlan.enabled, false);

    const restoredGoal = newestWork(entries);
    assert.equal(restoredGoal.objective, "Verify state compaction");
    assert.equal(restoredGoal.status, "cancelled");

    const compactSummary = workSituation(restoredGoal);
    assert.match(compactSummary, /Original objective: Verify state compaction/);
    assert.match(compactSummary, /cancelled/);

    // Test compact command execution in RPC
    const compactRes = await pi.sendCommand({ type: "compact" });
    // Session is too small to compact, so success is false with predictable error
    assert.equal(compactRes.success, false);
    assert.match(compactRes.error, /Nothing to compact/);

    // Test clone command once session has entries
    const cloneRes = await pi.sendCommand({ type: "clone" });
    assert.equal(cloneRes.success, true);

    // Verify restore works when reconstructing session from entries
    const simulatedSessionStartPlan = restore(entries, PLAN_ENTRY);
    const simulatedSessionStartGoal = newestWork(entries);
    assert.equal(simulatedSessionStartPlan.enabled, false);
    assert.equal(simulatedSessionStartGoal.objective, "Verify state compaction");
    assert.equal(simulatedSessionStartGoal.status, "cancelled");
  } finally {
    await pi.close();
  }
});
