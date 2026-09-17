import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function createAcpClient(envOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-acp-test-"));
  const statePath = join(tmpDir, "acp-sessions.json");
  const binPath = resolve("packages/pi-harness-acp/bin/pi-harness-acp.mjs");

  const child = spawn("node", [binPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_HARNESS_ACP_STATE: statePath,
      PI_EXTRA_ARGS: "-e . --no-session",
      ...envOverrides,
    },
  });

  const pending = new Map();
  const notifications = [];
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
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        } else if (msg.method) {
          notifications.push(msg);
        }
      } catch {}
    }
  });

  function request(method, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`Timeout waiting for response to ${method}`));
      }, 15000);

      pending.set(id, (res) => {
        clearTimeout(timer);
        if (res.error) rejectPromise(new Error(res.error.message));
        else resolvePromise(res.result);
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
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

  return { child, request, notifications, statePath, tmpDir, close };
}

test("ACP lifecycle: initialize, new, prompt, load, cancel, reconnect, and cleanup", async () => {
  const acp = createAcpClient();

  try {
    // 1. initialize
    const initRes = await acp.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(initRes.serverInfo.name, "pi-harness-acp");
    assert.ok(initRes.commands.includes("plan"));
    assert.ok(initRes.commands.includes("goal"));
    assert.ok(initRes.commands.includes("skill-hub"));
    assert.equal(initRes.capabilities.prompt, true);
    assert.equal(initRes.capabilities.sessionLoad, true);

    // 2. session/new
    const newRes = await acp.request("session/new");
    assert.ok(newRes.sessionId, "sessionId must be returned");
    const sessionId = newRes.sessionId;

    // Check state persistence on disk
    const savedState = JSON.parse(readFileSync(acp.statePath, "utf8"));
    assert.ok(savedState[sessionId], "session must be recorded in persistence state");
    assert.ok(savedState[sessionId].piSessionId);

    // 3. session/prompt
    const promptRes = await acp.request("session/prompt", {
      sessionId,
      prompt: "echo test",
    });
    assert.equal(promptRes.accepted, true);

    // 4. session/load
    const loadRes = await acp.request("session/load", { sessionId });
    assert.equal(loadRes.restored, true);
    assert.equal(loadRes.sessionId, sessionId);

    // 5. session/cancel
    const cancelRes = await acp.request("session/cancel", { sessionId });
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.terminated, true);
    if (cancelRes.pid) {
      let isAlive = false;
      try {
        process.kill(cancelRes.pid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      assert.equal(isAlive, false, `Pi child process ${cancelRes.pid} must be terminated after cancel`);
    }

    // 6. Reconnect with a second fresh ACP client pointing to the same statePath
    const binPath = resolve("packages/pi-harness-acp/bin/pi-harness-acp.mjs");
    const acp2Child = spawn("node", [binPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_HARNESS_ACP_STATE: acp.statePath,
        PI_EXTRA_ARGS: "-e . --no-session",
      },
    });

    let buffer2 = "";
    const pending2 = new Map();
    acp2Child.stdout.on("data", (chunk) => {
      buffer2 += chunk.toString("utf8");
      for (;;) {
        const idx = buffer2.indexOf("\n");
        if (idx < 0) break;
        const line = buffer2.slice(0, idx).trim();
        buffer2 = buffer2.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending2.has(msg.id)) {
            pending2.get(msg.id)(msg);
            pending2.delete(msg.id);
          }
        } catch {}
      }
    });

    const request2 = (method, params = {}) => {
      const id = crypto.randomUUID();
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending2.delete(id);
          rejectPromise(new Error(`Timeout waiting for response to ${method}`));
        }, 15000);
        pending2.set(id, (res) => {
          clearTimeout(timer);
          if (res.error) rejectPromise(new Error(res.error.message));
          else resolvePromise(res.result);
        });
        acp2Child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };

    // Reconnect to existing sessionId
    const reconnectLoad = await request2("session/load", { sessionId });
    assert.equal(reconnectLoad.restored, true);
    assert.equal(reconnectLoad.sessionId, sessionId);
    assert.ok(reconnectLoad.piSessionId, "piSessionId must be present and verified");
    assert.equal(reconnectLoad.piSessionId, savedState[sessionId].piSessionId);

    // Cleanup second client
    await new Promise((resolvePromise) => {
      acp2Child.once("exit", resolvePromise);
      acp2Child.kill("SIGTERM");
    });
  } finally {
    await acp.close();
  }
});

test("ACP command forwarding and event updates", async () => {
  const acp = createAcpClient();

  try {
    await acp.request("initialize", { protocolVersion: "2025-06-18" });
    const newRes = await acp.request("session/new");
    const sessionId = newRes.sessionId;

    // Test slash command execution via session/command
    const planRes = await acp.request("session/command", {
      sessionId,
      command: "plan",
      args: "status",
    });
    assert.equal(planRes.accepted, true);

    // Test prompt command execution and notification arrival
    await acp.request("session/prompt", {
      sessionId,
      prompt: "test notification",
    });

    // Verify notifications were received
    assert.ok(acp.notifications.length > 0, "session/update notifications should be received");
    assert.ok(acp.notifications.every((n) => n.method === "session/update"));
  } finally {
    await acp.close();
  }
});

