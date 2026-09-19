#!/usr/bin/env node
/** Pi Harness ACP bridge for Pi RPC sessions and Harness commands. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

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
      merged[id] = { piSessionId: session.piSessionId, updatedAt: new Date().toISOString() };
    }
    writeFileSync(temporary, JSON.stringify(merged, null, 2));
    renameSync(temporary, STATE_PATH);
  } catch {
    // Non-fatal persistence error
  }
}
function send(message) { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function failure(id, error) { send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
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
function spawnPi(sessionId, resumeId) {
  const id = resumeId || sessionId;
  const piBin = process.env.PI_BIN || "pi";
  const piArgs = ["--mode", "rpc"];
  if (id) {
    piArgs.push("--session-id", id);
  }
  if (process.env.PI_EXTRA_ARGS) {
    piArgs.push(...process.env.PI_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  }
  const child = spawn(piBin, piArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: process.env.PI_CWD || process.cwd() });
  const session = { child, piSessionId: id, pending: new Map() };
  sessions.set(sessionId, session);
  stored[sessionId] = { piSessionId: id, updatedAt: new Date().toISOString() };
  parseLines(child.stdout, (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "extension_ui_request") {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id })}\n`);
      }
      if (message.id && session.pending.has(message.id)) {
        session.pending.get(message.id)(message);
        session.pending.delete(message.id);
      }
      translatePiEvent(sessionId, message);
    } catch {
      notify("session/update", { sessionId, update: { sessionUpdate: "pi_raw", text: line } });
    }
  });
  parseLines(child.stderr, (line) => notify("session/update", { sessionId, update: { sessionUpdate: "stderr", text: line } }));
  child.once("exit", (code, signal) => {
    sessions.delete(sessionId);
    persist();
    notify("session/update", { sessionId, update: { sessionUpdate: "terminated", code, signal } });
  });
  persist();
  return session;
}
function rpcToPi(session, command) {
  const id = crypto.randomUUID();
  if (!session.child.stdin.writable) throw new Error("Pi RPC process is not writable");
  session.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { session.pending.delete(id); resolve(undefined); }, 30_000);
    session.pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
  });
}
async function ensureSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  stored = loadStored();
  const saved = stored[sessionId];
  if (!saved) throw new Error(`Unknown session: ${sessionId}`);
  return spawnPi(sessionId, saved.piSessionId);
}
async function handle(request) {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize":
      return result(request.id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        serverInfo: { name: "pi-harness-acp", version: VERSION },
        capabilities: { prompt: true, sessionLoad: true, toolCalling: true, sessionCancel: true },
        commands: commands(),
      });
    case "session/new": {
      const sessionId = crypto.randomUUID();
      const session = spawnPi(sessionId);
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
      const text = params.prompt ?? params.text ?? "";
      const response = await rpcToPi(session, { type: "prompt", message: text });
      return result(request.id, { accepted: true, commands: commands(), pi: response?.data });
    }
    case "session/command": {
      const session = await ensureSession(params.sessionId);
      const command = String(params.command ?? "").replace(/^\//, "");
      if (!commands().includes(command)) throw new Error(`Unknown Pi Harness command: ${command}`);
      const response = await rpcToPi(session, { type: "prompt", message: `/${command}${params.args ? ` ${params.args}` : ""}` });
      return result(request.id, { accepted: true, pi: response?.data, commands: commands() });
    }
    case "session/cancel": {
      const session = await ensureSession(params.sessionId);
      const child = session.child;
      const childPid = child?.pid;
      try {
        await rpcToPi(session, { type: "abort" });
      } catch {}
      if (child && !child.killed) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            resolve();
          }, 1500);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      sessions.delete(params.sessionId);
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
function shutdown() {
  clearInterval(lifecycleKeepalive);
  for (const session of sessions.values()) {
    try {
      if (!session.child.killed) {
        session.child.kill("SIGTERM");
      }
    } catch {}
  }
  persist();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
