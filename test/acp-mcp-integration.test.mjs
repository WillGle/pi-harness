import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createMcpPiToolNames } from "../packages/pi-harness-acp/lib/mcp-tools.mjs";
import { defaultPiEnv } from "./helpers/default-pi.mjs";

const root = process.cwd();
const bridgePath = resolve(root, "packages/pi-harness-acp/bin/pi-harness-acp.mjs");
const mcpFixturePath = resolve(root, "test/fixtures/mcp-stdio-server.mjs");
const providerExtension = resolve(root, "test/fixtures/pi-mcp-test-provider.mjs");
const tempRoots = new Set();

function makeWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-acp-mcp-test-"));
  tempRoots.add(directory);
  const cwd = join(directory, "workspace");
  mkdirSync(cwd);
  return { directory, cwd };
}

function startAcp(directory, { toolNames = [], providerPlan = ["tool", "text"] } = {}) {
  const env = {
    ...defaultPiEnv(),
    PI_HARNESS_ACP_STATE: join(directory, "acp-sessions.json"),
    PI_CODING_AGENT_DIR: join(directory, "pi-agent"),
    PI_CODING_AGENT_SESSION_DIR: join(directory, "pi-sessions"),
    PI_EXTRA_ARGS: `-e ${providerExtension} --model pi-harness-mcp-test/fixture`,
    PI_HARNESS_TEST_TOOL_NAMES: JSON.stringify(toolNames),
    PI_HARNESS_TEST_PROVIDER_PLAN: JSON.stringify(providerPlan),
    PI_HARNESS_TEST_PROVIDER_TRACE: join(directory, "provider-trace.jsonl"),
    PI_OFFLINE: "1",
  };
  const child = spawn(process.execPath, [bridgePath], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
  return { child, env, get stderr() { return stderr; } };
}

function createMcpServer(directory, name, {
  key = name,
  tool = "echo",
  mode = "normal",
  secret,
  configuredValue = "from-acp-config",
} = {}) {
  const files = {
    pid: join(directory, `${key}.pids`),
    handshake: join(directory, `${key}.handshake`),
    tools: join(directory, `${key}.tools.jsonl`),
    calls: join(directory, `${key}.calls.jsonl`),
    cancel: join(directory, `${key}.cancel.jsonl`),
    context: join(directory, `${key}.context.json`),
    descendants: join(directory, `${key}.descendants`),
  };
  const env = {
    MCP_FIXTURE_MODE: mode,
    MCP_FIXTURE_PID_FILE: files.pid,
    MCP_FIXTURE_HANDSHAKE_FILE: files.handshake,
    MCP_FIXTURE_TOOLS_FILE: files.tools,
    MCP_FIXTURE_CALLS_FILE: files.calls,
    MCP_FIXTURE_CANCEL_FILE: files.cancel,
    MCP_FIXTURE_CONTEXT_FILE: files.context,
    MCP_FIXTURE_DESCENDANT_FILE: files.descendants,
    MCP_FIXTURE_CONFIGURED_VALUE: configuredValue,
    ...(secret ? { MCP_FIXTURE_SECRET: secret } : {}),
  };
  return {
    server: {
      name,
      command: process.execPath,
      args: [mcpFixturePath, "--name", name, "--tools", tool],
      env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
    },
    files,
  };
}

function connectSdk(agent, callback) {
  const updates = [];
  const stream = acp.ndJsonStream(Writable.toWeb(agent.child.stdin), Readable.toWeb(agent.child.stdout));
  const connected = acp.client({ name: "pi-harness-mcp-integration", version: "1.0.0" })
    .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
    .connectWith(stream, ctx => callback(ctx, updates));
  return connected;
}

function waitForFile(path, predicate = value => value.length > 0, timeoutMs = 15_000) {
  const read = () => {
    try {
      const content = readFileSync(path, "utf8");
      return predicate(content) ? content : undefined;
    } catch { return undefined; }
  };
  const current = read();
  if (current !== undefined) return Promise.resolve(current);
  return new Promise((resolvePromise, rejectPromise) => {
    const watcher = watch(dirname(path), () => {
      const content = read();
      if (content !== undefined) finish(null, content);
    });
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${path}`)), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      watcher.close();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    watcher.on("error", error => finish(error));
    const afterWatch = read();
    if (afterWatch !== undefined) finish(null, afterWatch);
  });
}

function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => finish(new Error("Process did not exit before cleanup deadline.")), timeoutMs);
    const finish = error => {
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onExit = () => finish();
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

async function stopAcp(agent) {
  if (!agent || agent.child.exitCode !== null || agent.child.signalCode !== null) return;
  agent.child.kill("SIGTERM");
  try { await waitForExit(agent.child); }
  catch {
    agent.child.kill("SIGKILL");
    await waitForExit(agent.child);
  }
}

function readPids(path) {
  return readFileSync(path, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
}

function assertDead(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

function textUpdates(updates) {
  return updates
    .filter(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
    .map(({ update }) => update.content.text)
    .join("");
}

function newSessionRequest(cwd, servers) {
  return { cwd, mcpServers: servers };
}

test("ACP SDK 1.5.0 creates stdio MCP session and Pi calls the MCP tool through the model tool loop", async () => {
  const { directory, cwd } = makeWorkspace();
  const fixture = createMcpServer(directory, "alpha", { mode: "spawn-descendant", secret: "MCP_STDERR_SECRET_DO_NOT_LEAK" });
  const toolName = createMcpPiToolNames([{ name: "alpha", tools: [{ name: "echo" }] }])[0].name;
  const agent = startAcp(directory, { toolNames: [toolName] });
  try {
    let mcpPid;
    const result = await connectSdk(agent, async (ctx, updates) => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "MCP integration test", version: "1.0.0" },
      });
      assert.equal(initialized.protocolVersion, 1);
      assert.equal(initialized.agentCapabilities.loadSession, false);
      assert.equal(initialized.agentCapabilities.mcpCapabilities?.http, undefined);
      assert.equal(initialized.agentCapabilities.mcpCapabilities?.sse, undefined);

      const session = await ctx.buildSession(newSessionRequest(cwd, [fixture.server])).start();
      mcpPid = readPids(fixture.files.pid)[0];
      assert.ok(mcpPid > 0);
      assert.equal(readFileSync(fixture.files.handshake, "utf8").trim(), "initialized");
      assert.ok(readFileSync(fixture.files.tools, "utf8").includes('"serverName":"alpha"'));
      assert.deepEqual(JSON.parse(readFileSync(fixture.files.context, "utf8")), {
        pid: mcpPid,
        cwd,
        configuredValue: "from-acp-config",
      });
      await waitForFile(fixture.files.descendants);
      const [descendantPid] = readPids(fixture.files.descendants);

      const prompt = await session.prompt("Call the available fixture tool.");
      assert.equal(prompt.stopReason, "end_turn");
      assert.equal(readFileSync(fixture.files.calls, "utf8").includes('"value":"from-pi-model"'), true);
      assert.match(textUpdates(updates), /MCP_RESULT:alpha:from-pi-model/);
      assert.ok(updates.some(({ update }) => update.sessionUpdate === "tool_call" && update.name === toolName));

      session.dispose();
      await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
      assertDead(mcpPid);
      assertDead(descendantPid);
      return { sessionId: session.sessionId, mcpPid, descendantPid };
    });
    assert.ok(result.sessionId);
    await stopAcp(agent);
    assertDead(result.mcpPid);
    assert.equal(agent.stderr.includes("MCP_STDERR_SECRET_DO_NOT_LEAK"), false);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("multiple servers with identical tool names receive deterministic collision-free Pi names", async () => {
  const { directory, cwd } = makeWorkspace();
  const alpha = createMcpServer(directory, "alpha");
  const beta = createMcpServer(directory, "beta", { key: "beta" });
  const configurations = [
    { name: "alpha", tools: [{ name: "echo" }] },
    { name: "beta", tools: [{ name: "echo" }] },
  ];
  const names = createMcpPiToolNames(configurations).map(item => item.name);
  assert.equal(new Set(names).size, 2);
  assert.deepEqual(createMcpPiToolNames(configurations).map(item => item.name), names);
  const namesByServer = (serverList, toolList) => toolList
    .map(item => [serverList[item.serverIndex].name, serverList[item.serverIndex].tools[item.toolIndex].name, item.name])
    .sort(([leftServer], [rightServer]) => leftServer.localeCompare(rightServer));
  assert.deepEqual(
    namesByServer(configurations, createMcpPiToolNames(configurations)),
    namesByServer([...configurations].reverse(), createMcpPiToolNames([...configurations].reverse())),
  );
  const agent = startAcp(directory, { toolNames: names });
  try {
    const result = await connectSdk(agent, async (ctx, updates) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const session = await ctx.buildSession(newSessionRequest(cwd, [alpha.server, beta.server])).start();
      const pids = [readPids(alpha.files.pid)[0], readPids(beta.files.pid)[0]];
      assert.ok(pids.every(pid => pid > 0));
      assert.equal(readFileSync(alpha.files.handshake, "utf8").trim(), "initialized");
      assert.equal(readFileSync(beta.files.handshake, "utf8").trim(), "initialized");
      const prompt = await session.prompt("Use both tools.");
      assert.equal(prompt.stopReason, "end_turn");
      const text = textUpdates(updates);
      assert.match(text, /MCP_RESULT:alpha:from-pi-model/);
      assert.match(text, /MCP_RESULT:beta:from-pi-model/);
      assert.deepEqual(new Set(updates.filter(({ update }) => update.sessionUpdate === "tool_call").map(({ update }) => update.name)), new Set(names));
      session.dispose();
      await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
      pids.forEach(assertDead);
      return { pids };
    });
    await stopAcp(agent);
    result.pids.forEach(assertDead);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("MCP startup and handshake failures fail session/new closed and terminate started children", async () => {
  const { directory, cwd } = makeWorkspace();
  const fixture = createMcpServer(directory, "startup-failure", { mode: "startup-failure" });
  const agent = startAcp(directory);
  try {
    await connectSdk(agent, async ctx => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const creation = ctx.request(acp.methods.agent.session.new, newSessionRequest(cwd, [fixture.server]));
      const pidContents = await waitForFile(fixture.files.pid);
      const [pid] = readPids(fixture.files.pid);
      assert.ok(pid > 0);
      await assert.rejects(creation, error => error.code === -32603);
      assertDead(pid);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "acp-sessions.json"), "utf8")), {});
      return pidContents;
    });
    await stopAcp(agent);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("malformed MCP initialize and tools/list responses fail closed without exposing raw secrets", async () => {
  const { directory, cwd } = makeWorkspace();
  const secret = "MCP_RAW_SECRET_MUST_NOT_ESCAPE";
  const malformedInit = createMcpServer(directory, "malformed-init", { key: "init", mode: "malformed-init", secret });
  const malformedTools = createMcpServer(directory, "malformed-tools", { key: "tools", mode: "malformed-tools", secret });
  const agent = startAcp(directory);
  try {
    await connectSdk(agent, async (ctx, updates) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      for (const fixture of [malformedInit, malformedTools]) {
        const creation = ctx.request(acp.methods.agent.session.new, newSessionRequest(cwd, [fixture.server]));
        await waitForFile(fixture.files.pid);
        const [pid] = readPids(fixture.files.pid);
        await assert.rejects(creation, error => error.code === -32603);
        assertDead(pid);
      }
      assert.equal(existsSync(malformedInit.files.handshake), false);
      assert.equal(existsSync(malformedTools.files.handshake), true);
      assert.equal(textUpdates(updates).includes(secret), false);
      return true;
    });
    await stopAcp(agent);
    assert.equal(agent.stderr.includes(secret), false);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("an MCP child exit during a Pi tool call fails the tool without leaking raw errors", async () => {
  const { directory, cwd } = makeWorkspace();
  const fixture = createMcpServer(directory, "exit-server", { mode: "exit-on-call" });
  const toolName = createMcpPiToolNames([{ name: "exit-server", tools: [{ name: "echo" }] }])[0].name;
  const agent = startAcp(directory, { toolNames: [toolName] });
  try {
    const result = await connectSdk(agent, async (ctx, updates) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const session = await ctx.buildSession(newSessionRequest(cwd, [fixture.server])).start();
      const [pid] = readPids(fixture.files.pid);
      const prompt = await session.prompt("Call the MCP tool that exits.");
      assert.equal(prompt.stopReason, "end_turn");
      assert.equal(existsSync(fixture.files.calls), true);
      assertDead(pid);
      assert.match(textUpdates(updates), /MCP tool call failed\./);
      assert.equal(textUpdates(updates).includes("MCP_RAW"), false);
      session.dispose();
      await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
      return pid;
    });
    await stopAcp(agent);
    assertDead(result);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("session/resume reconnects the complete requested stdio MCP set", async () => {
  const { directory, cwd } = makeWorkspace();
  const fixture = createMcpServer(directory, "resume-server");
  const firstAgent = startAcp(directory);
  let sessionId;
  let firstPid;
  try {
    await connectSdk(firstAgent, async ctx => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const session = await ctx.buildSession(newSessionRequest(cwd, [fixture.server])).start();
      sessionId = session.sessionId;
      firstPid = readPids(fixture.files.pid)[0];
      session.dispose();
      await ctx.request(acp.methods.agent.session.close, { sessionId });
      assertDead(firstPid);
    });
    await stopAcp(firstAgent);

    const secondAgent = startAcp(directory);
    try {
      const result = await connectSdk(secondAgent, async ctx => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
        await assert.rejects(
          ctx.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers: [] }),
          error => error.code === -32602,
        );
        const resumed = await ctx.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [fixture.server],
        });
        assert.deepEqual(resumed, {});
        await waitForFile(fixture.files.pid, value => value.trim().split(/\s+/).length === 2);
        const secondPids = readPids(fixture.files.pid);
        assert.equal(secondPids.length, 2);
        assert.notEqual(secondPids[1], firstPid);
        assertDead(firstPid);
        assert.equal(readFileSync(fixture.files.handshake, "utf8").trim().split(/\s+/).length, 2);

        assert.deepEqual(await ctx.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [fixture.server],
        }), {});
        await waitForFile(fixture.files.pid, value => value.trim().split(/\s+/).length === 3);
        const pids = readPids(fixture.files.pid);
        assert.equal(pids.length, 3);
        assert.notEqual(pids[2], secondPids[1]);
        assertDead(secondPids[1]);
        assert.equal(readFileSync(fixture.files.handshake, "utf8").trim().split(/\s+/).length, 3);
        await ctx.request(acp.methods.agent.session.close, { sessionId });
        assertDead(pids[2]);
        return pids;
      });
      result.forEach(assertDead);
      await stopAcp(secondAgent);
    } finally {
      await stopAcp(secondAgent);
    }
  } finally {
    await stopAcp(firstAgent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("session/cancel cancels MCP work but keeps the session-owned connection reusable", async () => {
  const { directory, cwd } = makeWorkspace();
  const fixture = createMcpServer(directory, "cancel-server", { mode: "pending-once" });
  const toolName = createMcpPiToolNames([{ name: "cancel-server", tools: [{ name: "echo" }] }])[0].name;
  const agent = startAcp(directory, { toolNames: [toolName], providerPlan: ["tool", "tool", "text"] });
  try {
    const result = await connectSdk(agent, async (ctx, updates) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const session = await ctx.buildSession(newSessionRequest(cwd, [fixture.server])).start();
      const [pid] = readPids(fixture.files.pid);
      const cancelledPrompt = session.prompt("Start a cancellable MCP call.");
      await waitForFile(fixture.files.calls);
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      assert.equal((await cancelledPrompt).stopReason, "cancelled");
      assert.ok(await waitForFile(fixture.files.cancel));
      assert.equal(process.kill(pid, 0), true);

      const reusedPrompt = await session.prompt("Use the same MCP connection again.");
      assert.equal(reusedPrompt.stopReason, "end_turn");
      assert.match(textUpdates(updates), /MCP_RESULT:cancel-server:from-pi-model/);
      assert.equal(readPids(fixture.files.pid).length, 1);
      session.dispose();
      await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
      assertDead(pid);
      return pid;
    });
    await stopAcp(agent);
    assertDead(result);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("ACP process shutdown drains session-owned MCP children", async () => {
  const { directory, cwd } = makeWorkspace();
  const fixture = createMcpServer(directory, "shutdown-server", { mode: "spawn-descendant" });
  const agent = startAcp(directory);
  let mcpPid;
  let descendantPid;
  try {
    await connectSdk(agent, async ctx => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      await ctx.buildSession(newSessionRequest(cwd, [fixture.server])).start();
      [mcpPid] = readPids(fixture.files.pid);
      await waitForFile(fixture.files.descendants);
      [descendantPid] = readPids(fixture.files.descendants);
      agent.child.kill("SIGTERM");
      return true;
    }).catch(error => {
      if (agent.child.exitCode === null && agent.child.signalCode === null) throw error;
    });
    await waitForExit(agent.child);
    assertDead(mcpPid);
    assertDead(descendantPid);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test("empty MCP lists stay valid and HTTP/SSE transports reject as unsupported parameters", async () => {
  const { directory, cwd } = makeWorkspace();
  const agent = startAcp(directory);
  try {
    await connectSdk(agent, async ctx => {
      const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      assert.equal(initialized.agentCapabilities.mcpCapabilities?.http, undefined);
      assert.equal(initialized.agentCapabilities.mcpCapabilities?.sse, undefined);
      const session = await ctx.buildSession(newSessionRequest(cwd, [])).start();
      session.dispose();
      await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId });

      for (const server of [
        { type: "http", name: "http", url: "https://mcp.example.invalid", headers: [] },
        { type: "sse", name: "sse", url: "https://mcp.example.invalid/events", headers: [] },
        { name: "relative", command: "node", args: [], env: [] },
      ]) {
        await assert.rejects(
          ctx.request(acp.methods.agent.session.new, newSessionRequest(cwd, [server])),
          error => error.code === -32602,
        );
      }
      return true;
    });
    await stopAcp(agent);
  } finally {
    await stopAcp(agent);
    rmSync(directory, { recursive: true, force: true });
    tempRoots.delete(directory);
  }
});

test.after(() => {
  for (const directory of tempRoots) rmSync(directory, { recursive: true, force: true });
});
