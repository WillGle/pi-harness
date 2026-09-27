#!/usr/bin/env node
/** Pi Harness ACP bridge for Pi RPC sessions and Harness commands. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { decodeAcpPrompt } from "../lib/content.mjs";
import { createPiRpc, PiRpcError } from "../lib/pi-rpc.mjs";

const VERSION = "1.0.0";
const STATE_PATH = process.env.PI_HARNESS_ACP_STATE || join(homedir(), ".pi-harness", "acp-sessions.json");
const EXTENSION_COMMANDS = ["plan", "goal", "skill-hub", "learn"];
const sessions = new Map();
let stored = loadStored();
if (process.argv.includes("--version")) { console.log(VERSION); process.exit(0); }

function loadStored() { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; } }
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
    writeFileSync(temporary, JSON.stringify(merged, null, 2));
    renameSync(temporary, STATE_PATH);
  } catch {
    // Non-fatal persistence error
  }
}
function send(message) { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`); }
function result(id, value) { if (id !== undefined) send({ jsonrpc: "2.0", id, result: value }); }
function failure(id, error) { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error), ...(error?.code ? { data: { failure_code: error.code } } : {}) } }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function commands() { return [...EXTENSION_COMMANDS]; }
function parseLines(stream, onLine) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  });
}
function translatePiEvent(sessionId, message) {
  const type = message?.type ?? message?.method ?? "message";
  if (type === "message_update") {
    const event = message.assistantMessageEvent;
    if (event?.type === "text_delta") {
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta ?? "" }, raw: message } });
    }
  } else if (type === "text_delta") {
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.delta ?? message.text ?? "" }, raw: message } });
  } else if (type === "tool_call") {
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolName: message.toolName, input: message.input, callId: message.callId ?? message.id, raw: message } });
  } else if (type === "tool_result") {
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_result", toolName: message.toolName, result: message.result, callId: message.callId ?? message.id, raw: message } });
  } else if (type === "tool_execution_start") {
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolName: message.toolName, input: message.args ?? {}, callId: message.toolCallId, raw: message } });
  } else if (type === "tool_execution_end") {
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_result", result: message.result, callId: message.toolCallId, raw: message } });
  } else if (type === "agent_settled") {
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_settled", raw: message } });
  } else if (type === "message_end" && message.message?.role === "assistant" && message.message.stopReason === "error") {
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_error", message: message.message.errorMessage ?? "Pi request failed", raw: message } });
  } else if (/assistant|text|tool/i.test(type)) {
    notify("session/update", { sessionId, update: { sessionUpdate: type, ...message } });
  } else {
    notify("session/update", { sessionId, update: { sessionUpdate: "pi_event", event: message } });
  }
}
function spawnPi(sessionId, resumeId, cwd) {
  const id = resumeId || sessionId;
  const piBin = process.env.PI_BIN || "pi";
  const piArgs = ["--mode", "rpc"];
  if (id) {
    piArgs.push("--session-id", id);
  }
  if (process.env.PI_EXTRA_ARGS) {
    piArgs.push(...process.env.PI_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  }
  const sessionCwd = process.env.PI_CWD || cwd || process.cwd();
  const child = spawn(piBin, piArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: sessionCwd });
  const rpc = createPiRpc(child, { onEvent: message => translatePiEvent(sessionId, message) });
  const session = { child, rpc, piSessionId: id, cwd: sessionCwd, pending: rpc.pending };
  sessions.set(sessionId, session);
  session.ready = rpc.ready.then(state => {
    if (rpc.exited || sessions.get(sessionId) !== session) throw new PiRpcError("PI_RPC_EXITED");
    if (state.sessionId !== id) throw new PiRpcError("PI_RPC_SESSION_MISMATCH");
    session.isReady = true;
    stored[sessionId] = { piSessionId: id, cwd: sessionCwd, updatedAt: new Date().toISOString() };
    persist();
    return session;
  }).catch(async error => { await rpc.stop({ abort: false }); throw error; });
  void session.ready.catch(() => {});
  parseLines(child.stderr, (line) => notify("session/update", { sessionId, update: { sessionUpdate: "stderr", text: line } }));
  child.once("exit", (code, signal) => {
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    persist();
    notify("session/update", { sessionId, update: { sessionUpdate: "terminated", code, signal } });
  });
  return session;
}
async function rpcToPi(session, command) {
  await session.ready;
  try { return await session.rpc.request(command); }
  catch (error) {
    if (["PI_RPC_TIMEOUT", "PI_RPC_WRITE_FAILED"].includes(error.code)) await session.rpc.stop();
    throw error;
  }
}
async function ensureSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId).ready;
  stored = loadStored();
  const saved = stored[sessionId];
  if (!saved) throw new Error(`Unknown session: ${sessionId}`);
  return spawnPi(sessionId, saved.piSessionId, saved.cwd).ready;
}
async function handle(request) {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize":
      return result(request.id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        serverInfo: { name: "pi-harness-acp", version: VERSION },
        capabilities: { prompt: true, sessionLoad: true, toolCalling: true, sessionCancel: true },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
        },
        commands: commands(),
      });
    case "session/new": {
      const sessionId = crypto.randomUUID();
      const session = spawnPi(sessionId, undefined, params.cwd);
      await session.ready;
      return result(request.id, { sessionId, piSessionId: session.piSessionId, commands: commands() });
    }
    case "session/load": {
      const session = await ensureSession(params.sessionId);
      const stateRes = await rpcToPi(session, { type: "get_state" });
      const actualPiSessionId = stateRes?.data?.sessionId;
      const restored = Boolean(actualPiSessionId && actualPiSessionId === session.piSessionId);
      return result(request.id, {
        sessionId: params.sessionId,
        restored,
        piSessionId: actualPiSessionId,
        commands: commands(),
      });
    }
    case "session/prompt": {
      const session = await ensureSession(params.sessionId);
      const { message, images } = decodeAcpPrompt(params.prompt ?? params.text ?? "", session.cwd);
      const response = await rpcToPi(session, {
        type: "prompt",
        message,
        ...(images.length ? { images } : {}),
      });
      // Legacy bridge response means Pi preflight accepted, NOT terminal completion.
      return result(request.id, { accepted: true, commands: commands(), pi: response.data ?? { success: true, command: response.command } });
    }
    case "session/command": {
      const session = await ensureSession(params.sessionId);
      const command = String(params.command ?? "").replace(/^\//, "");
      if (!commands().includes(command)) throw new Error(`Unknown Pi Harness command: ${command}`);
      const response = await rpcToPi(session, { type: "prompt", message: `/${command}${params.args ? ` ${params.args}` : ""}` });
      return result(request.id, { accepted: true, pi: response.data ?? { success: true, command: response.command }, commands: commands() });
    }
    case "session/cancel": {
      // Do not await readiness: cancellation must also interrupt startup.
      const session = sessions.get(params.sessionId) ?? await ensureSession(params.sessionId);
      const child = session.child;
      const childPid = child?.pid;
      await session.rpc.stop();
      if (sessions.get(params.sessionId) === session) sessions.delete(params.sessionId);
      persist();
      return result(request.id, { cancelled: true, terminated: true, pid: childPid });
    }
    default:
      throw new Error(`Unknown ACP method: ${request.method}`);
  }
}
parseLines(process.stdin, (line) => {
  let request;
  try { request = JSON.parse(line); } catch (error) { failure(undefined, error); return; }
  handle(request).catch((error) => failure(request?.id, error));
});
// An idle stdio pipe does not keep the Node event loop alive on every runtime.
const lifecycleKeepalive = setInterval(() => {}, 60_000);
async function shutdown() {
  clearInterval(lifecycleKeepalive);
  await Promise.allSettled([...sessions.values()].map(session => session.rpc.stop()));
  persist();
}
let shuttingDown;
const finishShutdown = () => { shuttingDown ??= shutdown().then(() => process.exit(0)); };
process.on("SIGINT", finishShutdown);
process.on("SIGTERM", finishShutdown);
process.stdin.on("end", finishShutdown);
