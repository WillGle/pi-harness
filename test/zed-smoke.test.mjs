import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultPiEnv } from "./helpers/default-pi.mjs";
import { isPlanAllowedTool } from "../lib/plan.mjs";

const validUpdates = new Set([
  "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update",
  "plan", "plan_update", "plan_removed", "available_commands_update", "current_mode_update",
  "config_option_update", "session_info_update", "usage_update", "notice", "compaction_update",
  "compaction_summary_chunk",
]);

test("ACP v1 subprocess smoke uses terminal responses, commands, and safe session resume", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-zed-smoke-"));
  const zedConfigDir = join(tmpDir, ".config", "zed");
  mkdirSync(zedConfigDir, { recursive: true });
  const zedSettingsPath = join(zedConfigDir, "settings.json");
  const acpBin = resolve("packages/pi-harness-acp/bin/pi-harness-acp.mjs");
  const zedConfig = {
    agent_servers: {
      "pi-harness": { type: "custom", command: "node", args: [acpBin] },
    },
    language_models: { provider: "zed-owned-provider", model: "zed-owned-model" },
  };
  writeFileSync(zedSettingsPath, JSON.stringify(zedConfig, null, 2));
  const zedRaw = readFileSync(zedSettingsPath, "utf8");
  assert.match(zedRaw, /"pi-harness"\s*:\s*\{[\s\S]*?"command"\s*:\s*"node"/);

  const statePath = join(tmpDir, "acp-sessions.json");
  const server = spawn("node", [acpBin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...defaultPiEnv(),
      HOME: tmpDir,
      PI_HARNESS_ACP_STATE: statePath,
      PI_EXTRA_ARGS: "-e . --no-session",
    },
  });
  const pending = new Map();
  const notifications = [];
  const waiters = new Set();
  let buffer = "";
  let stderr = "";
  server.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
  server.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (Object.hasOwn(message, "id") && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        notifications.push(message);
        for (const waiter of waiters) {
          if (notifications.length - 1 >= waiter.afterIndex && waiter.predicate(message)) {
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            waiter.resolve(message);
          }
        }
      }
    }
  });

  const request = (method, params = {}) => new Promise((resolvePromise, rejectPromise) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Timeout waiting for ${method}; stderr: ${stderr.trim() || "empty"}`));
    }, 20000);
    pending.set(id, response => {
      clearTimeout(timer);
      if (response.error) rejectPromise(new Error(response.error.message));
      else resolvePromise(response.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const waitFor = (predicate, afterIndex = 0) => {
    const existing = notifications.slice(afterIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        predicate,
        afterIndex,
        resolve: resolvePromise,
        timer: setTimeout(() => { waiters.delete(waiter); rejectPromise(new Error("ACP notification timeout")); }, 15000),
      };
      waiters.add(waiter);
    });
  };

  try {
    const init = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: {}, terminal: false },
      clientInfo: { name: "Zed", version: "0.229.0" },
    });
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, "pi-harness-acp");
    assert.equal(init.agentCapabilities.loadSession, false);
    assert.equal(init.agentCapabilities.sessionCapabilities.resume !== undefined, true);
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);
    assert.equal(init.agentCapabilities.modelSelector, undefined);

    const session = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
    assert.deepEqual(Object.keys(session), ["sessionId"]);
    const commands = await waitFor(message => message.method === "session/update" && message.params?.update?.sessionUpdate === "available_commands_update");
    assert.deepEqual(commands.params.update.availableCommands.map(command => command.name), ["plan", "goal", "skill-hub", "learn"]);

    const prompt = await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "/plan status" }] });
    assert.equal(prompt.stopReason, "end_turn");
    assert.equal(isPlanAllowedTool("write", {}), false);
    assert.equal(isPlanAllowedTool("edit", {}), false);
    assert.equal(isPlanAllowedTool("pi_harness_coordinate", {}), false);
    assert.equal(isPlanAllowedTool("bash", { command: "rm a.txt" }), false);
    assert.equal(isPlanAllowedTool("bash", { command: "git status" }), true);

    assert.ok(notifications.length > 0, "the ACP server emits session/update notifications");
    for (const notification of notifications.filter(message => message.method === "session/update")) {
      assert.ok(validUpdates.has(notification.params.update.sessionUpdate), `invalid ACP update ${notification.params.update.sessionUpdate}`);
      assert.equal(notification.params.update.raw, undefined, "Pi-internal event payloads are not copied into ACP");
    }

    await request("session/close", { sessionId: session.sessionId });
    const resumeNotificationIndex = notifications.length;
    const resumed = await request("session/resume", { sessionId: session.sessionId, cwd: process.cwd(), mcpServers: [] });
    assert.deepEqual(resumed, {});
    const resumedCommands = await waitFor(
      message => message.method === "session/update" && message.params?.update?.sessionUpdate === "available_commands_update" && message.params.sessionId === session.sessionId,
      resumeNotificationIndex,
    );
    assert.equal(resumedCommands.params.sessionId, session.sessionId);
    for (const notification of notifications.filter(message => message.method === "session/update")) {
      assert.ok(validUpdates.has(notification.params.update.sessionUpdate), `invalid ACP update ${notification.params.update.sessionUpdate}`);
    }

    const zedAfter = JSON.parse(readFileSync(zedSettingsPath, "utf8"));
    assert.equal(zedAfter.language_models.provider, "zed-owned-provider");
    assert.equal(zedAfter.language_models.model, "zed-owned-model");
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise(resolvePromise => {
        const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
        server.once("exit", () => { clearTimeout(timer); resolvePromise(); });
        server.kill("SIGTERM");
      });
    }
    for (const waiter of waiters) clearTimeout(waiter.timer);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
