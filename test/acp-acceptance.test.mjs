import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeAcpPrompt } from "../packages/pi-harness-acp/lib/content.mjs";

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
  const notificationWaiters = new Set();
  let buffer = "";
  let stderrTail = "";
  let childExit;
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2048); });
  child.once("exit", (code, signal) => { childExit = { code, signal }; });

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
          for (const waiter of notificationWaiters) if (waiter.predicate(msg)) { clearTimeout(waiter.timer); notificationWaiters.delete(waiter); waiter.resolve(msg); }
        }
      } catch {}
    }
  });

  function request(method, params = {}, raw = false) {
    const id = crypto.randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const diagnostic = stderrTail.trim().replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
        const childState = childExit ? `exited ${childExit.code ?? childExit.signal}` : "still running";
        rejectPromise(new Error(`Timeout waiting for response to ${method} (ACP child ${childState}${diagnostic ? `; stderr: ${diagnostic}` : "; stderr empty"})`));
      }, 15000);

      pending.set(id, (res) => {
        clearTimeout(timer);
        if (raw) return resolvePromise({ requestId: id, response: res });
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
      if (child.exitCode !== null || child.signalCode) { rmSync(tmpDir, { recursive: true, force: true }); resolvePromise(); }
      else child.kill("SIGTERM");
    });
  }

  function waitForNotification(predicate) {
    const existing = notifications.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { notificationWaiters.delete(waiter); reject(new Error("Notification timeout")); }, 15000) };
      notificationWaiters.add(waiter);
    });
  }
  return { child, request, notifications, statePath, tmpDir, close, waitForNotification };
}

test("ACP prompt content converts clipboard images and text/file-manager resources for Pi RPC", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-content-"));
  try {
    const textPath = join(dir, "notes.txt");
    const imagePath = join(dir, "pixel.png");
    writeFileSync(textPath, "hello from file\n");
    writeFileSync(imagePath, Buffer.from("fake png"));

    const directImage = Buffer.from("clipboard image").toString("base64");
    const decoded = decodeAcpPrompt([
      { type: "text", text: "Review these" },
      { type: "image", data: directImage, mimeType: "image/png" },
      { type: "resource", resource: { uri: "clipboard.txt", mimeType: "text/plain", text: "clipboard text" } },
      { type: "resource_link", uri: pathToFileURL(textPath).href, name: "notes.txt", mimeType: "text/plain" },
      { type: "resource_link", uri: pathToFileURL(imagePath).href, name: "pixel.png", mimeType: "image/png" },
    ], dir);

    assert.match(decoded.message, /Review these/);
    assert.match(decoded.message, /clipboard text/);
    assert.match(decoded.message, /hello from file/);
    assert.deepEqual(decoded.images[0], { type: "image", data: directImage, mimeType: "image/png" });
    assert.equal(decoded.images[1].data, Buffer.from("fake png").toString("base64"));
    assert.deepEqual(decodeAcpPrompt("legacy prompt"), { message: "legacy prompt", images: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.equal(initRes.agentCapabilities.promptCapabilities.image, true);
    assert.equal(initRes.agentCapabilities.promptCapabilities.embeddedContext, true);

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
      prompt: "/plan status",
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
    const acp2 = createAcpClient({ PI_HARNESS_ACP_STATE: acp.statePath });
    try {
      const reconnectLoad = await acp2.request("session/load", { sessionId });
      assert.equal(reconnectLoad.restored, true);
      assert.equal(reconnectLoad.sessionId, sessionId);
      assert.equal(reconnectLoad.piSessionId, savedState[sessionId].piSessionId);
    } finally { await acp2.close(); }

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
      prompt: "/plan status",
    });

    const badCommand = await acp.request("session/command", {
      sessionId,
      command: "not-a-harness-command",
    }, true);
    assert.equal(badCommand.response.id, badCommand.requestId);
    assert.match(badCommand.response.error.message, /Unknown Pi Harness command/);
    assert.ok(badCommand.response.error.message.length < 300);

    const unknownMethod = await acp.request("unknown/method", {}, true);
    assert.equal(unknownMethod.response.id, unknownMethod.requestId);
    assert.match(unknownMethod.response.error.message, /Unknown ACP method/);
    assert.ok(unknownMethod.response.error.message.length < 300);

    // Verify notifications were received
    assert.ok(acp.notifications.length > 0, "session/update notifications should be received");
    assert.ok(acp.notifications.every((n) => n.method === "session/update"));
  } finally {
    await acp.close();
  }
});


function controlledAcp(mode, statePath) {
  const fixture = resolve("test/helpers/fake-pi-rpc.mjs"); chmodSync(fixture, 0o755);
  return createAcpClient({ PI_BIN: fixture, PI_EXTRA_ARGS: "", FIXTURE_PI_MODE: mode, ...(statePath ? { PI_HARNESS_ACP_STATE: statePath } : {}) });
}
const fixtureEvent = type => notification => notification.params?.update?.event?.type === type;
const assertDead = pid => assert.throws(() => process.kill(pid,0), { code: "ESRCH" });

test("ACP delayed startup and fresh reconnect advertise readiness only after native state", async () => {
  const first = controlledAcp("delay"); let second;
  try {
    let advertised = false;
    const created = first.request("session/new").then(value => { advertised = true; return value; });
    const pending = await first.waitForNotification(fixtureEvent("fixture_startup"));
    assert.equal(advertised,false); assert.equal(existsSync(first.statePath),false);
    const session = await created;
    assert.equal(session.sessionId,pending.params.sessionId);
    const command = await first.request("session/command", { sessionId: session.sessionId, command: "plan", args: "on" });
    assert.equal(command.accepted,true); assert.deepEqual(command.pi,{ success:true, command:"prompt" });
    await first.request("session/cancel",{ sessionId:session.sessionId }); assertDead(pending.params.update.event.pid);
    second = controlledAcp("delay",first.statePath);
    let loaded = false;
    const reconnect = second.request("session/load",{sessionId:session.sessionId}).then(value=>{loaded=true;return value;});
    const starting = await second.waitForNotification(fixtureEvent("fixture_startup"));
    assert.equal(loaded,false); const restored = await reconnect;
    assert.equal(restored.restored,true); assert.equal(restored.piSessionId,session.piSessionId);
    await second.request("session/cancel",{sessionId:session.sessionId}); assertDead(starting.params.update.event.pid);
  } finally { if(second)await second.close(); await first.close(); }
});

test("ACP readiness deadline returns typed failure and cleans owned child", async () => {
  const acp = controlledAcp("never");
  try {
    const created = acp.request("session/new",{},true);
    const event = await acp.waitForNotification(fixtureEvent("fixture_startup"));
    const response = (await created).response;
    assert.equal(response.result,undefined); assert.equal(response.error.data.failure_code,"PI_RPC_NOT_READY");
    assertDead(event.params.update.event.pid);
  } finally { await acp.close(); }
});

test("ACP cancel during startup does not await readiness and does not return an orphan session", async () => {
  const acp = controlledAcp("never");
  try {
    const created = acp.request("session/new",{},true);
    const event = await acp.waitForNotification(fixtureEvent("fixture_startup"));
    const cancelled = await acp.request("session/cancel",{sessionId:event.params.sessionId});
    assert.equal(cancelled.terminated,true); assertDead(event.params.update.event.pid);
    assert.equal((await created).response.error.data.failure_code,"PI_RPC_CANCELLED");
  } finally { await acp.close(); }
});

test("ACP pending prompt cancellation is a failure, never accepted with undefined Pi data", async () => {
  const acp = controlledAcp("pending");
  try {
    const session = await acp.request("session/new");
    const prompt = acp.request("session/prompt",{sessionId:session.sessionId,prompt:"ordinary prompt"},true);
    const event = await acp.waitForNotification(fixtureEvent("fixture_prompt"));
    await acp.request("session/cancel",{sessionId:session.sessionId}); assertDead(event.params.update.event.pid);
    const response = (await prompt).response;
    assert.equal(response.result,undefined); assert.equal(response.error.data.failure_code,"PI_RPC_CANCELLED");
  } finally { await acp.close(); }
});
