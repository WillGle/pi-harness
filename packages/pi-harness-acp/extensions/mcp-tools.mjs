import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import spawn from "cross-spawn";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { createMcpPiToolNames } from "../lib/mcp-tools.mjs";
import { assertLinuxCliSupported } from "../lib/platform.mjs";

const CONFIG_ENV = "PI_HARNESS_ACP_MCP_CONFIG_FILE";
const STATUS_ENV = "PI_HARNESS_ACP_MCP_STATUS_FILE";
const INITIALIZE_TIMEOUT_MS = 10_000;
const LIST_TOOLS_TIMEOUT_MS = 10_000;
const CALL_TOOL_TIMEOUT_MS = 300_000;
const MAX_MCP_MESSAGE_BYTES = 10 * 1024 * 1024;

function writeStatus(path, status) {
  if (!path) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
  renameSync(temporary, path);
}

function processIsClosed(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child, isClosed, timeoutMs) {
  if (isClosed() || processIsClosed(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = closed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed || isClosed() || processIsClosed(child));
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

function processGroupExists(pgid) {
  if (process.platform !== "linux") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function waitForProcessGroupExit(pgid, timeoutMs) {
  if (!processGroupExists(pgid)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timer);
      resolve(!processGroupExists(pgid));
    };
    const interval = setInterval(() => {
      if (!processGroupExists(pgid)) finish();
    }, 20);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function signalOwnedProcess(child, signal) {
  try {
    if (process.platform === "linux" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

// MCP SDK 1.30 keeps transport internals private. This pinned adapter starts
// the same stdio transport in its own POSIX process group and owns its exit.
class OwnedStdioClientTransport extends StdioClientTransport {
  #ownedChild;
  #closed = false;
  #closePromise;

  async start() {
    if (this._process) throw new Error("StdioClientTransport already started.");
    return new Promise((resolve, reject) => {
      this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
        env: { ...getDefaultEnvironment(), ...this._serverParams.env },
        stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
        shell: false,
        windowsHide: process.platform === "win32",
        detached: process.platform === "linux",
        cwd: this._serverParams.cwd,
      });
      this.#ownedChild = this._process;
      this._process.on("error", error => {
        reject(error);
        this.onerror?.(error);
      });
      this._process.on("spawn", () => resolve());
      this._process.on("close", () => {
        this.#closed = true;
        this._process = undefined;
        this.onclose?.();
      });
      this._process.stdin?.on("error", error => this.onerror?.(error));
      this._process.stdout?.on("data", chunk => {
        try {
          this._readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error);
          this.close().catch(() => {});
        }
      });
      this._process.stdout?.on("error", error => this.onerror?.(error));
    });
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    const child = this.#ownedChild ?? this._process;
    if (!child) {
      this._readBuffer?.clear();
      return Promise.resolve();
    }

    this.#closePromise = (async () => {
      const closed = () => this.#closed || processIsClosed(child);
      const pgid = child.pid;
      try { child.stdin?.end(); } catch {}
      await waitForClose(child, closed, 150);
      signalOwnedProcess(child, "SIGTERM");
      if (process.platform === "linux" && pgid) {
        if (!await waitForProcessGroupExit(pgid, 300)) signalOwnedProcess(child, "SIGKILL");
        if (!await waitForProcessGroupExit(pgid, 1_000)) throw new Error("MCP process-group cleanup failed.");
      } else {
        if (!closed()) signalOwnedProcess(child, "SIGKILL");
        if (!await waitForClose(child, closed, 1_000)) throw new Error("MCP child cleanup failed.");
      }
      this._readBuffer?.clear();
    })();
    return this.#closePromise;
  }
}

function recordEnv(entries = []) {
  const result = Object.create(null);
  for (const entry of entries) result[entry.name] = entry.value;
  return result;
}

function inputSchemaForPi(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw new Error("Invalid MCP tool input schema.");
  }
  const schema = structuredClone(inputSchema);
  delete schema.$schema;
  delete schema.$id;
  if (schema.type !== "object" && !schema.properties && !schema.allOf && !schema.anyOf && !schema.oneOf) {
    throw new Error("MCP tool input schema must describe an object.");
  }
  return Type.Unsafe(schema);
}

function toPiContent(blocks) {
  const content = [];
  for (const block of blocks ?? []) {
    if (block?.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      content.push({ type: "text", text: block.resource.text });
    } else {
      content.push({ type: "text", text: "[MCP result contains an unsupported content block.]" });
    }
  }
  return content.length ? content : [{ type: "text", text: "(empty MCP result)" }];
}

function makeConnection(server) {
  if (!server || typeof server.name !== "string" || !server.name || typeof server.command !== "string") {
    throw new Error("Invalid MCP stdio server configuration.");
  }
  if (!Array.isArray(server.args) || !Array.isArray(server.env)) {
    throw new Error("Invalid MCP stdio server arguments or environment.");
  }

  const transport = new OwnedStdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: process.cwd(),
    env: recordEnv(server.env),
    stderr: "ignore",
    maxBufferSize: MAX_MCP_MESSAGE_BYTES,
  });
  const client = new Client({ name: "pi-harness-acp", version: "1.0.0" }, { capabilities: {} });
  const connection = { server, client, transport, tools: [] };
  return connection;
}

async function initializeConnection(connection) {
  await connection.client.connect(connection.transport, {
    timeout: INITIALIZE_TIMEOUT_MS,
    maxTotalTimeout: INITIALIZE_TIMEOUT_MS,
  });

  let cursor;
  do {
    const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIST_TOOLS_TIMEOUT_MS,
      maxTotalTimeout: LIST_TOOLS_TIMEOUT_MS,
    });
    connection.tools.push(...result.tools);
    cursor = result.nextCursor || undefined;
  } while (cursor);
}

async function closeConnections(connections) {
  const results = await Promise.allSettled(connections.map(async connection => {
    try { await connection.client.close(); } finally { await connection.transport.close(); }
  }));
  if (results.some(result => result.status === "rejected")) {
    throw new Error("MCP child cleanup failed.");
  }
}

function registerMcpTools(pi, connections) {
  const definitions = connections.map(connection => ({ name: connection.server.name, tools: connection.tools }));
  const names = createMcpPiToolNames(definitions);
  const nameByPosition = new Map(names.map(item => [`${item.serverIndex}:${item.toolIndex}`, item.name]));
  let total = 0;

  connections.forEach((connection, serverIndex) => {
    connection.tools.forEach((tool, toolIndex) => {
      const name = nameByPosition.get(`${serverIndex}:${toolIndex}`);
      pi.registerTool({
        name,
        label: `${connection.server.name}: ${tool.name}`,
        description: tool.description || `MCP tool ${tool.name} from server ${connection.server.name}.`,
        parameters: inputSchemaForPi(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          try {
            const result = await connection.client.callTool(
              { name: tool.name, arguments: params },
              undefined,
              { signal, timeout: CALL_TOOL_TIMEOUT_MS, resetTimeoutOnProgress: true },
            );
            if (result.isError) throw new Error("MCP tool returned an error.");
            return {
              content: toPiContent(result.content),
              details: { server: connection.server.name, tool: tool.name },
            };
          } catch {
            if (signal?.aborted) throw new Error("MCP tool call cancelled.");
            throw new Error("MCP tool call failed.");
          }
        },
      });
      total += 1;
    });
  });
  return total;
}

export default async function piHarnessAcpMcpExtension(pi) {
  assertLinuxCliSupported();
  const configPath = process.env[CONFIG_ENV];
  if (!configPath) return;
  const statusPath = process.env[STATUS_ENV];
  const connections = [];

  try {
    const servers = JSON.parse(readFileSync(configPath, "utf8"));
    if (!Array.isArray(servers) || servers.length === 0) throw new Error("Invalid MCP session configuration.");
    rmSync(configPath, { force: true });

    for (const server of servers) connections.push(makeConnection(server));
    const initialized = await Promise.allSettled(connections.map(connection => initializeConnection(connection)));
    if (initialized.some(result => result.status === "rejected")) throw new Error("MCP handshake failed.");

    const toolCount = registerMcpTools(pi, connections);
    pi.on("session_shutdown", async () => closeConnections(connections));
    writeStatus(statusPath, { ok: true, serverCount: connections.length, toolCount });
  } catch {
    await closeConnections(connections).catch(() => {});
    writeStatus(statusPath, { ok: false });
    throw new Error("MCP session initialization failed.");
  } finally {
    rmSync(configPath, { force: true });
  }
}
