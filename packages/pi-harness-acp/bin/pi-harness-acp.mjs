#!/usr/bin/env node
/** ACP v1 bridge for Pi RPC sessions and Pi Harness commands. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { decodeAcpPrompt } from "../lib/content.mjs";
import { createPiRpc, PiRpcError } from "../lib/pi-rpc.mjs";

const VERSION = "1.0.0";
const STATE_PATH = process.env.PI_HARNESS_ACP_STATE || join(homedir(), ".pi-harness", "acp-sessions.json");
const EXTENSION_COMMANDS = ["plan", "goal", "skill-hub", "learn"];
const sessions = new Map();
let stored = loadStored();
if (process.argv.includes("--version")) { console.log(VERSION); process.exit(0); }

function loadStored() {
  try {
    const value = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function persist() {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const temporary = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
    stored = loadStored();
    const merged = { ...stored };
    for (const [id, session] of sessions) {
      if (!session.isReady) continue;
      merged[id] = { piSessionId: session.piSessionId, cwd: session.cwd, updatedAt: new Date().toISOString() };
    }
    writeFileSync(temporary, JSON.stringify(merged, null, 2), { mode: 0o600 });
    renameSync(temporary, STATE_PATH);
  } catch {
    // State persistence must not interrupt ACP session processing.
  }
}

function enqueueUpdate(session, client, update) {
  const queued = session.updateChain.then(() => client.notify(acp.methods.client.session.update, {
    sessionId: session.id,
    update,
  }));
  session.updateChain = queued.catch(error => { session.updateError ??= error; });
  return session.updateChain;
}

function updateForPiEvent(session, message) {
  const type = message?.type ?? message?.method;
  if (type === "message_update") {
    const event = message.assistantMessageEvent;
    if (event?.type === "text_delta") {
      session.messageId ??= randomUUID();
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: session.messageId,
        content: { type: "text", text: event.delta ?? "" },
      };
    }
    if (event?.type === "thinking_delta") {
      session.messageId ??= randomUUID();
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId: session.messageId,
        content: { type: "text", text: event.delta ?? "" },
      };
    }
  } else if (type === "text_delta") {
    session.messageId ??= randomUUID();
    return {
      sessionUpdate: "agent_message_chunk",
      messageId: session.messageId,
      content: { type: "text", text: message.delta ?? message.text ?? "" },
    };
  } else if (type === "message_start" && message.message?.role === "assistant") {
    session.messageId = randomUUID();
  } else if (type === "message_end") {
    if (message.message?.role === "assistant" && message.message.stopReason === "error" && session.activeTurn) {
      session.activeTurn.error = new Error("Pi could not complete the prompt.");
    }
    if (message.message?.role === "assistant") session.messageId = undefined;
  } else if (type === "tool_execution_start") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: message.toolCallId,
      title: message.toolName,
      name: message.toolName,
      kind: "other",
      status: "in_progress",
      rawInput: message.args,
    };
  } else if (type === "tool_execution_end") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: message.toolCallId,
      status: message.isError ? "failed" : "completed",
    };
  }
}

function onPiEvent(session, message) {
  if (message?.type === "agent_settled") {
    const turn = session.activeTurn;
    if (turn) void session.updateChain.then(turn.resolveSettled, turn.resolveSettled);
    return;
  }
  if (message?.type === "extension_ui_request" && message.method === "notify" && session.activeTurn) {
    const update = {
      sessionUpdate: "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text: String(message.message ?? "") },
    };
    const queued = session.client ? enqueueUpdate(session, session.client, update) : Promise.resolve();
    if (session.activeTurn.isHarnessCommand) void queued.then(session.activeTurn.resolveSettled, session.activeTurn.resolveSettled);
    return;
  }
  const update = updateForPiEvent(session, message);
  if (update && session.client) void enqueueUpdate(session, session.client, update);
}

function spawnPi(sessionId, resumeId, cwd, client) {
  const id = resumeId || sessionId;
  const piBin = process.env.PI_BIN || "pi";
  const piArgs = ["--mode", "rpc", "--session-id", id];
  if (process.env.PI_EXTRA_ARGS) piArgs.push(...process.env.PI_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  const child = spawn(piBin, piArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: cwd || process.cwd() });
  const session = {
    id: sessionId,
    child,
    piSessionId: id,
    cwd: cwd || process.cwd(),
    client,
    updateChain: Promise.resolve(),
    activeTurn: undefined,
    messageId: undefined,
    updateError: undefined,
  };
  const rpc = createPiRpc(child, { onEvent: message => onPiEvent(session, message) });
  session.rpc = rpc;
  sessions.set(sessionId, session);
  session.ready = rpc.ready.then(state => {
    if (rpc.exited || sessions.get(sessionId) !== session) throw new PiRpcError("PI_RPC_EXITED");
    if (state.sessionId !== id) throw new PiRpcError("PI_RPC_SESSION_MISMATCH");
    session.isReady = true;
    stored[sessionId] = { piSessionId: id, cwd: session.cwd, updatedAt: new Date().toISOString() };
    persist();
    return session;
  }).catch(async error => {
    await rpc.stop({ abort: false });
    throw error;
  });
  void session.ready.catch(() => {});
  child.stderr.resume();
  child.once("exit", () => {
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    if (session.activeTurn) {
      session.activeTurn.error ??= new Error("Pi session ended before the prompt completed.");
      session.activeTurn.resolveSettled();
    }
    persist();
  });
  return session;
}

async function ensureSession(sessionId, client, signal) {
  const active = sessions.get(sessionId);
  if (active) {
    active.client = client;
    await waitForSignal(active.ready, signal);
    return active;
  }
  stored = loadStored();
  const saved = stored[sessionId];
  if (!saved) throw new Error(`Unknown session: ${sessionId}`);
  const session = spawnPi(sessionId, saved.piSessionId, saved.cwd, client);
  await waitForSignal(session.ready, signal);
  return session;
}

function advertiseCommands(session, client) {
  const update = {
    sessionUpdate: "available_commands_update",
    availableCommands: EXTENSION_COMMANDS.map(name => ({
      name,
      description: `Run the Pi Harness ${name} command.`,
      input: { hint: "arguments" },
    })),
  };
  void enqueueUpdate(session, client, update);
}

function requireNoMcpServers(servers = []) {
  if (servers.length) throw new Error("Pi Harness ACP does not support MCP servers.");
}

async function newSession({ params, client, signal }) {
  requireNoMcpServers(params.mcpServers);
  const sessionId = randomUUID();
  const session = spawnPi(sessionId, undefined, params.cwd, client);
  try {
    await waitForSignal(session.ready, signal);
  } catch (error) {
    await session.rpc.stop();
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    delete stored[sessionId];
    persist();
    throw error;
  }
  advertiseCommands(session, client);
  return { sessionId };
}

async function resumeSession({ params, client, signal }) {
  requireNoMcpServers(params.mcpServers);
  stored = loadStored();
  const saved = stored[params.sessionId];
  if (!saved) throw new Error(`Unknown session: ${params.sessionId}`);
  if (saved.cwd !== params.cwd) throw new Error("Session working directory does not match.");
  const session = sessions.get(params.sessionId) ?? spawnPi(params.sessionId, saved.piSessionId, saved.cwd, client);
  session.client = client;
  await waitForSignal(session.ready, signal);
  advertiseCommands(session, client);
  return {};
}

function waitForSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled."));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Request cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

async function cancelTurn(session, turn) {
  if (!turn.cancelPromise) {
    turn.cancelled = true;
    turn.controller.abort(new Error("ACP prompt cancelled."));
    turn.cancelPromise = (async () => {
      try {
        await session.rpc.request({ type: "abort" }, { timeout: 500 });
      } catch {
        try { await session.rpc.stop(); }
        catch {
          turn.cancelError = new Error("Pi could not confirm prompt cancellation.");
          turn.resolveSettled();
        }
      }
      await turn.settled;
      await session.updateChain;
    })();
  }
  return turn.cancelPromise;
}

async function prompt({ params, client, signal }) {
  const session = await ensureSession(params.sessionId, client, signal);
  if (session.activeTurn) throw new Error("A prompt is already active for this session.");
  const { message, images } = decodeAcpPrompt(params.prompt, session.cwd);
  if (!message && images.length === 0) throw new Error("The prompt contains no supported content.");

  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  const controller = new AbortController();
  const commandName = message.match(/^\/([^\s]+)/)?.[1];
  const turn = {
    cancelled: false,
    error: undefined,
    cancelError: undefined,
    isHarnessCommand: EXTENSION_COMMANDS.includes(commandName),
    resolveSettled,
    settled,
    controller,
  };
  session.activeTurn = turn;
  const onRequestAbort = () => {
    void cancelTurn(session, turn).catch(error => {
      turn.cancelError ??= error;
      turn.resolveSettled();
    });
  };
  if (signal?.aborted) onRequestAbort();
  else signal?.addEventListener("abort", onRequestAbort, { once: true });
  try {
    const response = session.rpc.request({
      type: "prompt",
      message,
      ...(images.length ? { images } : {}),
    }, { signal: controller.signal });
    await response;
    await settled;
    await session.updateChain;
    if (session.updateError) throw new Error("ACP client update delivery failed.");
    if (turn.error && !turn.cancelled) throw turn.error;
    return { stopReason: turn.cancelled ? "cancelled" : "end_turn" };
  } catch (error) {
    if (turn.cancelled) {
      await settled;
      await session.updateChain;
      if (turn.cancelError) throw turn.cancelError;
      return { stopReason: "cancelled" };
    }
    if (["PI_RPC_TIMEOUT", "PI_RPC_WRITE_FAILED"].includes(error.code)) {
      await session.rpc.stop().catch(() => {});
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onRequestAbort);
    if (session.activeTurn === turn) session.activeTurn = undefined;
  }
}

async function cancel({ params }) {
  const session = sessions.get(params.sessionId);
  if (session?.activeTurn) await cancelTurn(session, session.activeTurn);
}

async function closeSession({ params }) {
  const session = sessions.get(params.sessionId);
  if (!session) return {};
  if (session.activeTurn) {
    session.activeTurn.cancelled = true;
    session.activeTurn.controller.abort(new Error("ACP session closed."));
  }
  await session.rpc.stop();
  if (sessions.get(params.sessionId) === session) sessions.delete(params.sessionId);
  persist();
  return {};
}

const app = acp.agent({ name: "pi-harness-acp" })
  .onRequest("initialize", ({ params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "pi-harness-acp", version: VERSION },
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { resume: {}, close: {} },
    },
    authMethods: [],
  }))
  .onRequest("session/new", newSession)
  .onRequest("session/resume", resumeSession)
  .onRequest("session/prompt", prompt)
  .onRequest("session/close", closeSession)
  .onNotification("session/cancel", cancel);

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
let shutdownPromise;
function shutdown() {
  shutdownPromise ??= Promise.allSettled([...sessions.values()].map(session => session.rpc.stop()));
  return shutdownPromise;
}
process.stdin.once("end", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
void connection.closed.then(() => shutdown());
