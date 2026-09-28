import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { decodeAcpPrompt } from "../packages/pi-harness-acp/lib/content.mjs";
import { defaultPiEnv } from "./helpers/default-pi.mjs";

function createAcpClient(envOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-acp-test-"));
  const statePath = envOverrides.PI_HARNESS_ACP_STATE ?? join(tmpDir, "acp-sessions.json");
  const pidPath = join(tmpDir, "fixture-pid");
  const sessionPath = join(tmpDir, "fixture-session");
  const promptPath = join(tmpDir, "fixture-prompt");
  const binPath = resolve("packages/pi-harness-acp/bin/pi-harness-acp.mjs");
  const child = spawn("node", [binPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...defaultPiEnv(),
      PI_HARNESS_ACP_STATE: statePath,
      PI_EXTRA_ARGS: "-e . --no-session",
      ...envOverrides,
      FIXTURE_PI_PID_PATH: pidPath,
      FIXTURE_PI_SESSION_PATH: sessionPath,
      FIXTURE_PI_PROMPT_PATH: promptPath,
    },
  });

  const pending = new Map();
  const notifications = [];
  const notificationWaiters = new Set();
  let buffer = "";
  let stderrTail = "";
  let childExit;
  child.stderr.on("data", chunk => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2048); });
  child.once("exit", (code, signal) => { childExit = { code, signal }; });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (Object.hasOwn(msg, "id") && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        notifications.push(msg);
        for (const waiter of notificationWaiters) {
          if (waiter.predicate(msg)) {
            clearTimeout(waiter.timer);
            notificationWaiters.delete(waiter);
            waiter.resolve(msg);
          }
        }
      }
    }
  });

  function sendRequest(method, params = {}) {
    const id = randomUUID();
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const childState = childExit ? `exited ${childExit.code ?? childExit.signal}` : "still running";
        rejectPromise(new Error(`Timeout waiting for ${method} (ACP child ${childState}; stderr: ${stderrTail.trim() || "empty"})`));
      }, 15000);
      pending.set(id, response => {
        clearTimeout(timer);
        resolvePromise(response);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    return { id, promise };
  }

  async function request(method, params = {}) {
    const response = await sendRequest(method, params).promise;
    if (response.error) return { error: response.error };
    return response.result;
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function close() {
    return new Promise((resolvePromise, rejectPromise) => {
      let forceTimer;
      let forced = false;
      const cleanup = () => {
        clearTimeout(forceTimer);
        for (const waiter of notificationWaiters) clearTimeout(waiter.timer);
        rmSync(tmpDir, { recursive: true, force: true });
        if (forced) rejectPromise(new Error("ACP process required SIGKILL during cleanup"));
        else resolvePromise();
      };
      if (child.exitCode !== null || child.signalCode) { cleanup(); return; }
      child.once("exit", cleanup);
      forceTimer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 5000);
      child.kill("SIGTERM");
    });
  }

  function waitForNotification(predicate) {
    const existing = notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          notificationWaiters.delete(waiter);
          reject(new Error("ACP notification timeout"));
        }, 15000),
      };
      notificationWaiters.add(waiter);
    });
  }

  return { child, request, sendRequest, notify, notifications, statePath, tmpDir, pidPath, sessionPath, promptPath, close, waitForNotification };
}

async function initialize(acp) {
  return acp.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "ACP acceptance test", version: "1.0.0" },
  });
}

function controlledAcp(mode, statePath) {
  const fixture = resolve("test/helpers/fake-pi-rpc.mjs");
  chmodSync(fixture, 0o755);
  return createAcpClient({
    PI_BIN: fixture,
    PI_EXTRA_ARGS: "",
    FIXTURE_PI_MODE: mode,
    ...(statePath ? { PI_HARNESS_ACP_STATE: statePath } : {}),
  });
}

const commandUpdate = notification => notification.method === "session/update"
  && notification.params?.update?.sessionUpdate === "available_commands_update";
const assistantChunk = notification => notification.method === "session/update"
  && notification.params?.update?.sessionUpdate === "agent_message_chunk";
const waitForFile = async path => {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  return readFileSync(path, "utf8");
};
const assertDead = pid => assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });


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
    assert.deepEqual(decodeAcpPrompt([{ type: "text", text: "legacy prompt" }], dir), { message: "legacy prompt", images: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("ACP v1 lifecycle: negotiate, create, complete, close, and resume a Pi session", async () => {
  const statePath = join(tmpdir(), `pi-acp-state-${randomUUID()}.json`);
  const first = controlledAcp("settle-delay", statePath);
  let second;
  try {
    const init = await initialize(first);
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, "pi-harness-acp");
    assert.equal(init.agentCapabilities.loadSession, false);
    assert.equal(init.agentCapabilities.sessionCapabilities.resume !== undefined, true);
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);

    let created = false;
    const create = first.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] });
    const createResponse = create.promise.then(response => { created = true; return response; });
    const pid = await waitForFile(first.pidPath);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    assert.equal(created, false, "session/new must wait for correlated native readiness");
    const response = await createResponse;
    assert.equal(response.error, undefined);
    assert.deepEqual(Object.keys(response.result), ["sessionId"]);
    const sessionId = response.result.sessionId;
    assert.ok(sessionId);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8"))[sessionId].piSessionId, readFileSync(first.sessionPath, "utf8"));

    const advertised = await first.waitForNotification(commandUpdate);
    assert.deepEqual(advertised.params.update.availableCommands.map(command => command.name), ["plan", "goal", "skill-hub", "learn"]);
    const promptRequest = first.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "ordinary prompt" }] });
    let promptCompleted = false;
    void promptRequest.promise.then(() => { promptCompleted = true; });
    const chunk = await first.waitForNotification(assistantChunk);
    assert.equal(chunk.params.update.content.type, "text");
    assert.equal(chunk.params.update.content.text, "fixture response");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    assert.equal(promptCompleted, false, "prompt must wait for Pi agent_settled after its RPC response");
    assert.deepEqual((await promptRequest.promise).result, { stopReason: "end_turn" });

    const command = await first.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/plan status" }] });
    assert.deepEqual(command, { stopReason: "end_turn" });
    await first.close();
    assertDead(pid);
    second = controlledAcp("delay", statePath);
    const resumedInit = await initialize(second);
    assert.equal(resumedInit.agentCapabilities.sessionCapabilities.resume !== undefined, true);
    const resumed = await second.request("session/resume", { sessionId, cwd: process.cwd(), mcpServers: [] });
    assert.deepEqual(resumed, {});
    const resumeCommands = await second.waitForNotification(commandUpdate);
    assert.equal(resumeCommands.params.sessionId, sessionId);
    assert.equal(second.notifications.some(assistantChunk), false, "session/resume must not replay prior messages");
  } finally {
    if (second) await second.close();
    if (first.child.exitCode === null && first.child.signalCode === null) await first.close();
    rmSync(statePath, { force: true });
  }
});


test("ACP session/cancel is a notification and resolves the pending prompt as cancelled", async () => {
  const acp = controlledAcp("pending");
  try {
    await initialize(acp);
    const session = await acp.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const pid = await waitForFile(acp.pidPath);
    const prompt = acp.sendRequest("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "wait for cancellation" }] });
    await waitForFile(acp.promptPath);
    acp.notify("session/cancel", { sessionId: session.sessionId });
    const response = await prompt.promise;
    assert.deepEqual(response.result, { stopReason: "cancelled" });
    assert.doesNotThrow(() => process.kill(Number(pid), 0), "a cancelled turn does not close the session");
  } finally {
    const pid = existsSync(acp.pidPath) ? readFileSync(acp.pidPath, "utf8") : undefined;
    await acp.close();
    if (pid) assertDead(pid);
  }
});


test("ACP $/cancel_request aborts an active Pi prompt without closing its session", async () => {
  const acp = controlledAcp("pending");
  try {
    await initialize(acp);
    const session = await acp.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const prompt = acp.sendRequest("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "cancel active prompt" }],
    });
    const pid = await waitForFile(acp.pidPath);
    await waitForFile(acp.promptPath);
    acp.notify("$/cancel_request", { requestId: prompt.id });
    const response = await prompt.promise;
    assert.ok(response.error || response.result?.stopReason === "cancelled");
    assert.doesNotThrow(() => process.kill(Number(pid), 0), "the Pi session stays available after a cancelled turn");
  } finally {
    const pid = existsSync(acp.pidPath) ? readFileSync(acp.pidPath, "utf8") : undefined;
    await acp.close();
    if (pid) assertDead(pid);
  }
});


test("ACP $/cancel_request during startup cleans the owned Pi child", async () => {
  const acp = controlledAcp("never");
  try {
    await initialize(acp);
    const create = acp.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] });
    const pid = await waitForFile(acp.pidPath);
    acp.notify("$/cancel_request", { requestId: create.id });
    const response = await create.promise;
    assert.ok(response.error, "cancelled session/new must not return an orphan session");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    assertDead(pid);
  } finally {
    await acp.close();
  }
});


test("ACP $/cancel_request stops waiting while a persisted session becomes ready", async () => {
  const acp = controlledAcp("never");
  const sessionId = randomUUID();
  const piSessionId = randomUUID();
  writeFileSync(acp.statePath, JSON.stringify({
    [sessionId]: { piSessionId, cwd: process.cwd(), updatedAt: new Date().toISOString() },
  }));
  try {
    await initialize(acp);
    const prompt = acp.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "cancel startup" }],
    });
    const pid = await waitForFile(acp.pidPath);
    acp.notify("$/cancel_request", { requestId: prompt.id });
    const response = await prompt.promise;
    assert.ok(response.error, "a cancelled prompt must not wait for the readiness deadline");
    assert.doesNotThrow(() => process.kill(Number(pid), 0), "the saved session remains available for a later resume");
  } finally {
    const pid = existsSync(acp.pidPath) ? readFileSync(acp.pidPath, "utf8") : undefined;
    await acp.close();
    if (pid) assertDead(pid);
  }
});


test("ACP legacy custom command and load methods are not advertised or accepted", async () => {
  const acp = controlledAcp("delay");
  try {
    await initialize(acp);
    const rejectedMcp = await acp.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [{ type: "http", name: "remote", url: "https://mcp.example.invalid", headers: [] }],
    });
    assert.ok(rejectedMcp.error, `unexpected HTTP MCP session response: ${JSON.stringify(rejectedMcp)}`);
    assert.equal(rejectedMcp.error.code, -32602);
    assert.equal(existsSync(acp.pidPath), false, "unsupported HTTP MCP transport must be rejected before Pi starts");
    const session = await acp.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const legacyCommand = await acp.request("session/command", { sessionId: session.sessionId, command: "plan", args: "status" });
    assert.ok(legacyCommand.error);
    const loadSession = await acp.request("session/load", { sessionId: session.sessionId, cwd: process.cwd(), mcpServers: [] });
    assert.ok(loadSession.error);
  } finally {
    await acp.close();
  }
});
