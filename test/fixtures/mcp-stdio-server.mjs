#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueOf = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const serverName = valueOf("--name") ?? "fixture";
const toolNames = (valueOf("--tools") ?? "echo").split(",").filter(Boolean);
const mode = process.env.MCP_FIXTURE_MODE ?? "normal";
const pidFile = process.env.MCP_FIXTURE_PID_FILE;
const handshakeFile = process.env.MCP_FIXTURE_HANDSHAKE_FILE;
const toolsFile = process.env.MCP_FIXTURE_TOOLS_FILE;
const callsFile = process.env.MCP_FIXTURE_CALLS_FILE;
const cancelFile = process.env.MCP_FIXTURE_CANCEL_FILE;
const contextFile = process.env.MCP_FIXTURE_CONTEXT_FILE;
const descendantFile = process.env.MCP_FIXTURE_DESCENDANT_FILE;
const secret = process.env.MCP_FIXTURE_SECRET;
let buffer = "";
let pendingCall;
let callCount = 0;

if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);
if (contextFile) writeFileSync(contextFile, JSON.stringify({ pid: process.pid, cwd: process.cwd(), configuredValue: process.env.MCP_FIXTURE_CONFIGURED_VALUE ?? null }));
if (mode === "spawn-descendant") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (descendantFile) appendFileSync(descendantFile, `${descendant.pid}\n`);
}
if (secret) process.stderr.write(`fixture stderr secret: ${secret}\n`);

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function append(path, value) {
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function onMessage(message) {
  if (message.method === "initialize") {
    if (mode === "startup-failure") {
      process.exit(71);
      return;
    }
    if (mode === "malformed-init") {
      process.stdout.write(`${secret ?? "not-json"}\n`, () => process.exit(74));
      return;
    }
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `fixture-${serverName}`, version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    if (handshakeFile) appendFileSync(handshakeFile, "initialized\n");
    return;
  }
  if (message.method === "tools/list") {
    if (toolsFile) append(toolsFile, { serverName, cursor: message.params?.cursor ?? null });
    if (mode === "malformed-tools") {
      reply(message.id, { tools: "invalid" });
      return;
    }
    reply(message.id, {
      tools: toolNames.map(name => ({
        name,
        description: `Return a fixture result from ${serverName}.`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: "Value to return" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    });
    return;
  }
  if (message.method === "tools/call") {
    callCount += 1;
    append(callsFile, { serverName, tool: message.params.name, arguments: message.params.arguments });
    if (mode === "exit-on-call") {
      process.exit(72);
      return;
    }
    if (mode === "pending-once" && callCount === 1) {
      pendingCall = message.id;
      return;
    }
    reply(message.id, {
      content: [{ type: "text", text: `MCP_RESULT:${serverName}:${message.params.arguments.value}` }],
      isError: false,
    });
    return;
  }
  if (message.method === "notifications/cancelled") {
    append(cancelFile, { serverName, requestId: message.params.requestId, reason: message.params.reason });
    pendingCall = undefined;
    return;
  }
  if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
  }
}

process.stdin.on("data", chunk => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); }
    catch { process.exit(73); }
  }
});
process.stdin.on("end", () => process.exit(0));
