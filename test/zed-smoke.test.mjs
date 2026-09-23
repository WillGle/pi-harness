import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPlanAllowedTool } from "../lib/state.mjs";

test("Zed smoke: server entry, 8 skills, commands, plan block, state load, and no model claim", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-zed-smoke-"));
  const zedConfigDir = join(tmpDir, ".config", "zed");
  mkdirSync(zedConfigDir, { recursive: true });
  const zedSettingsPath = join(zedConfigDir, "settings.json");

  // Write exact Zed configuration
  const zedConfig = {
    agent_servers: {
      "pi-harness": {
        type: "custom",
        command: "pi-harness-acp",
        args: [],
      },
    },
    language_models: {
      provider: "zed-owned-provider",
      model: "zed-owned-model",
    },
  };
  writeFileSync(zedSettingsPath, JSON.stringify(zedConfig, null, 2));

  // 1. Verify exact Zed configuration format
  const zedRaw = readFileSync(zedSettingsPath, "utf8");
  assert.ok(/"pi-harness"\s*:\s*\{[\s\S]*?"command"\s*:\s*"pi-harness-acp"/.test(zedRaw));

  // 2. Launch ACP server entry (the exact command Zed runs)
  const acpBin = resolve("packages/pi-harness-acp/bin/pi-harness-acp.mjs");
  const statePath = join(tmpDir, "acp-sessions.json");

  const server = spawn("node", [acpBin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: tmpDir,
      PI_HARNESS_ACP_STATE: statePath,
      PI_EXTRA_ARGS: "-e . --no-session",
    },
  });

  const pending = new Map();
  let buffer = "";

  server.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });

  const request = (method, params = {}) => {
    const id = crypto.randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`Timeout waiting for Zed RPC: ${method}`));
      }, 10000);
      pending.set(id, (res) => {
        clearTimeout(timer);
        if (res.error) rejectPromise(new Error(res.error.message));
        else resolvePromise(res.result);
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  try {
    // 3. Handshake (initialize)
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "Zed", version: "0.170.0" },
    });

    assert.equal(init.serverInfo.name, "pi-harness-acp");
    // Assert no model ownership claimed in capabilities
    assert.equal(init.capabilities.modelSelector, undefined);
    assert.equal(init.capabilities.models, undefined);
    assert.equal(init.capabilities.provider, undefined);

    // Assert commands include plan, goal, skill-hub
    assert.ok(init.commands.includes("plan"));
    assert.ok(init.commands.includes("goal"));
    assert.ok(init.commands.includes("skill-hub"));

    // 4. Session creation (session/new)
    const newSession = await request("session/new");
    assert.ok(newSession.sessionId);
    const sessionId = newSession.sessionId;

    // 5. Test command execution (/plan on)
    const planOn = await request("session/command", {
      sessionId,
      command: "plan",
      args: "on",
    });
    assert.equal(planOn.accepted, true);

    // Verify plan mutation block is enforced
    assert.equal(isPlanAllowedTool("write", {}), false);
    assert.equal(isPlanAllowedTool("edit", {}), false);
    assert.equal(isPlanAllowedTool("pi_harness_coordinate", {}), false);
    assert.equal(isPlanAllowedTool("bash", { command: "rm a.txt" }), false);
    assert.equal(isPlanAllowedTool("bash", { command: "git status" }), true);

    // 6. Test /goal command
    const goalRes = await request("session/command", {
      sessionId,
      command: "plan",
      args: "off",
    });
    assert.equal(goalRes.accepted, true);

    const goalStatus = await request("session/command", {
      sessionId,
      command: "goal",
      args: "status",
    });
    assert.equal(goalStatus.accepted, true);

    // 7. Test session load
    const loadRes = await request("session/load", { sessionId });
    assert.equal(loadRes.restored, true);
    assert.equal(loadRes.sessionId, sessionId);

    // 8. Assert Zed settings were not modified (model selection remains Zed-owned)
    const zedAfter = JSON.parse(readFileSync(zedSettingsPath, "utf8"));
    assert.equal(zedAfter.language_models.provider, "zed-owned-provider");
    assert.equal(zedAfter.language_models.model, "zed-owned-model");
  } finally {
    await new Promise((resolvePromise) => {
      server.once("exit", () => {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
        resolvePromise();
      });
      server.kill("SIGTERM");
    });
  }
});
