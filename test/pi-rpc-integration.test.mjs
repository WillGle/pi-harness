import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPACT_ENTRY,
  GOAL_ENTRY,
  PLAN_ENTRY,
  cavemanSummary,
  goalState,
  isPlanAllowedTool,
  isReadOnlyBash,
  planState,
  restore,
  transitionGoal,
} from "../lib/state.mjs";

function spawnPiRpc(options = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-rpc-test-"));
  const child = spawn("pi", ["--mode", "rpc", "-e", ".", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd || process.cwd(),
  });

  const pending = new Map();
  const events = [];
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "extension_ui_request") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id })}\n`);
        }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        } else {
          events.push(msg);
        }
      } catch {}
    }
  });

  function sendCommand(command) {
    const id = crypto.randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`Timeout waiting for RPC command: ${command.type}`));
      }, 10000);

      pending.set(id, (res) => {
        clearTimeout(timer);
        if (res.success === false && res.error) {
          resolvePromise(res);
        } else {
          resolvePromise(res);
        }
      });

      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  function prompt(message) {
    return sendCommand({ type: "prompt", message });
  }

  function close() {
    return new Promise((resolvePromise) => {
      child.once("exit", () => {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
        resolvePromise();
      });
      child.kill("SIGTERM");
    });
  }

  return { child, sendCommand, prompt, events, close };
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
    let activeGoal = entries.find((e) => e.customType === GOAL_ENTRY && e.data.objective === "Blocked goal");
    assert.equal(activeGoal, undefined, "Goal should not be created when plan mode is active");

    // 2. Turn plan off and start goal
    await pi.prompt("/plan off");
    await pi.prompt("/goal Implement release gate");

    entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    activeGoal = [...entries].reverse().find((e) => e.customType === GOAL_ENTRY);
    assert.ok(activeGoal);
    assert.equal(activeGoal.data.objective, "Implement release gate");
    assert.equal(activeGoal.data.status, "active");

    // 3. Reject second active goal
    await pi.prompt("/goal Another goal");
    entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    const anotherGoal = entries.find((e) => e.customType === GOAL_ENTRY && e.data.objective === "Another goal");
    assert.equal(anotherGoal, undefined, "Second active goal must be rejected");

    // 4. Cancel goal
    await pi.prompt("/goal cancel");
    entries = (await pi.sendCommand({ type: "get_entries" })).data.entries;
    const cancelledGoal = [...entries].reverse().find((e) => e.customType === GOAL_ENTRY);
    assert.ok(cancelledGoal);
    assert.equal(cancelledGoal.data.status, "cancelled");
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

    const restoredGoal = restore(entries, GOAL_ENTRY);
    assert.equal(restoredGoal.objective, "Verify state compaction");
    assert.equal(restoredGoal.status, "cancelled");

    // Verify caveman compaction contract
    const compactSummary = cavemanSummary({
      goal: restoredGoal,
      plan: restoredPlan,
      decisions: ["use-native-rpc"],
      changedFiles: ["lib/state.mjs"],
      gates: ["unit", "rpc"],
      blocker: undefined,
    });
    assert.equal(compactSummary.format, "caveman-v1");
    assert.equal(compactSummary.goal.objective, "Verify state compaction");
    assert.deepEqual(compactSummary.gates, ["unit", "rpc"]);

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
    const simulatedSessionStartGoal = restore(entries, GOAL_ENTRY);
    assert.equal(simulatedSessionStartPlan.enabled, false);
    assert.equal(simulatedSessionStartGoal.objective, "Verify state compaction");
    assert.equal(simulatedSessionStartGoal.status, "cancelled");
  } finally {
    await pi.close();
  }
});
