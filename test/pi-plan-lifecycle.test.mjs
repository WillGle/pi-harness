import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPACT_ENTRY, PLAN_ENTRY } from "../lib/state.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "ls",
  "find",
  "grep",
  "pi_harness_hashlines",
  "pi_harness_find_symbol",
  "pi_harness_references",
  "pi_harness_patch",
  "pi_harness_coordinate",
  "pi_harness_goal",
].join(",");

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part?.text === "string" ? part.text : JSON.stringify(part)))
      .join("\n");
  }
  return JSON.stringify(message?.content ?? "");
}

function latestCustom(entries, customType) {
  return [...entries].reverse().find((entry) => entry.customType === customType);
}

function toolNames(request) {
  return (request.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
}

function responseChunk(delta, finishReason = null) {
  return {
    id: "fake-response",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

class DisposableProvider {
  constructor(root, project, agentDir) {
    this.root = root;
    this.project = project;
    this.agentDir = agentDir;
    this.requests = [];
    this.server = createServer((request, response) => this.handleRequest(request, response));
  }

  async start() {
    await new Promise((resolvePromise) => this.server.listen(0, "127.0.0.1", resolvePromise));
    const modelsPath = join(this.agentDir, "models.json");
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    models.providers.fake.baseUrl = `http://127.0.0.1:${this.server.address().port}/v1`;
    writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  }

  async handleRequest(request, response) {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }

    let raw = "";
    for await (const chunk of request) raw += chunk;

    const body = JSON.parse(raw);
    const messages = body.messages ?? [];
    const markerIndex = messages.reduce((latest, message, index) => {
      if (message.role === "user" && messageText(message).includes("CALL_")) return index;
      return latest;
    }, -1);
    const marker = markerIndex >= 0 ? messageText(messages[markerIndex]) : undefined;
    const hasToolResultAfterMarker =
      markerIndex >= 0 && messages.slice(markerIndex + 1).some((message) => message.role === "tool");
    const requestRecord = {
      body,
      trigger: marker,
      hasToolResultAfterMarker,
    };
    this.requests.push(requestRecord);

    let toolName;
    let argumentsForTool;
    if (marker && !hasToolResultAfterMarker) {
      if (marker.includes("CALL_WRITE") || marker.includes("CALL_CHILD_WRITE") || marker.includes("CALL_PARENT_WRITE")) {
        toolName = "write";
        const path = marker.includes("CALL_CHILD_WRITE")
          ? "child-write.txt"
          : marker.includes("CALL_PARENT_WRITE")
            ? "parent-write.txt"
            : "blocked-write.txt";
        argumentsForTool = { path, content: `${path}\n` };
      } else if (marker.includes("CALL_EDIT")) {
        toolName = "edit";
        argumentsForTool = { path: "edit-target.txt", oldText: "original\n", newText: "edited\n" };
      } else if (marker.includes("CALL_PATCH")) {
        toolName = "pi_harness_patch";
        argumentsForTool = {
          path: "patch-target.txt",
          start_line: 1,
          end_line: 1,
          expected_sha256: createHash("sha256").update("original").digest("hex"),
          replacement: "patched",
        };
      } else if (marker.includes("CALL_HASHLINES")) {
        toolName = "pi_harness_hashlines";
        argumentsForTool = { path: "read-target.txt", start_line: 1, end_line: 1 };
      } else if (marker.includes("CALL_BASH")) {
        toolName = "bash";
        argumentsForTool = { command: "touch blocked-bash.txt" };
      }
    }

    const chunks = [];
    if (toolName) {
      const toolCallId = `call_${randomUUID()}`;
      chunks.push(responseChunk({ role: "assistant" }));
      chunks.push(
        responseChunk({
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(argumentsForTool) },
            },
          ],
        }),
      );
      chunks.push(responseChunk({}, "tool_calls"));
    } else {
      chunks.push(responseChunk({ role: "assistant", content: "DONE" }));
      chunks.push({
        ...responseChunk({}, "stop"),
        usage: {
          prompt_tokens: 50000,
          completion_tokens: 1,
          total_tokens: 50001,
        },
      });
    }

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  }

  close() {
    return new Promise((resolvePromise) => this.server.close(resolvePromise));
  }

  firstToolRequest(trigger) {
    return this.requests.find((request) => request.trigger === trigger && !request.hasToolResultAfterMarker);
  }
}

class DisposablePi {
  constructor(provider, sessionPath) {
    this.provider = provider;
    this.events = [];
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--session",
        sessionPath,
        "-e",
        REPO_ROOT,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
        "--provider",
        "fake",
        "--model",
        "dummy",
        "--tools",
        PI_TOOLS,
      ],
      {
        cwd: provider.project,
        env: provider.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.exit = new Promise((resolvePromise) => {
      this.child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.stdout.on("data", (chunk) => this.readOutput(chunk));
  }

  readOutput(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        message.type === "extension_ui_request" &&
        ["select", "confirm", "input", "editor"].includes(message.method)
      ) {
        this.child.stdin.write(
          `${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`,
        );
      }

      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      } else {
        this.events.push(message);
      }
    }
  }

  send(command, timeoutMs = 20000) {
    const id = randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for RPC ${command.type}; stderr=${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  async waitFor(predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.events.find(predicate);
      if (match) return match;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for RPC event; stderr=${this.stderr}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }

  async prompt(message) {
    const eventIndex = this.events.length;
    const response = await this.send({ type: "prompt", message });
    assert.equal(response.success, true, `Pi rejected prompt ${message}: ${JSON.stringify(response)}`);
    if (!message.startsWith("/")) {
      await this.waitFor((event) => event.type === "agent_settled" && this.events.indexOf(event) >= eventIndex);
    }
    return response;
  }

  async close() {
    if (!this.child.killed && this.child.exitCode === null) this.child.stdin.end();
    const result = await Promise.race([
      this.exit,
      new Promise((resolvePromise) =>
        setTimeout(() => {
          this.child.kill("SIGTERM");
          resolvePromise({ code: null, signal: "SIGTERM" });
        }, 5000),
      ),
    ]);
    return result;
  }
}

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-plan-lifecycle-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 1024 } }, null, 2),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          fake: {
            api: "openai-completions",
            apiKey: "disposable-test-provider",
            baseUrl: "PLACEHOLDER",
            models: [{ id: "dummy", contextWindow: 200000, maxTokens: 1024 }],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(project, "edit-target.txt"), "original\n");
  writeFileSync(join(project, "patch-target.txt"), "original\n");
  writeFileSync(join(project, "read-target.txt"), "read me\n");

  const provider = new DisposableProvider(root, project, agentDir);
  provider.env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
  };
  await provider.start();

  return {
    root,
    project,
    provider,
    sessionPath: join(root, "session.jsonl"),
    spawn(sessionPath = join(root, "session.jsonl")) {
      return new DisposablePi(provider, sessionPath);
    },
    async close() {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertPlanEntry(entries, enabled, context) {
  const entry = latestCustom(entries, PLAN_ENTRY);
  assert.ok(entry, `${context}: missing ${PLAN_ENTRY}`);
  assert.equal(entry.data.enabled, enabled, `${context}: unexpected plan state`);
  return entry;
}

function assertNoSuccessfulTool(pi, toolName, eventIndex, context) {
  const completed = pi.events
    .slice(eventIndex)
    .filter((event) => event.type === "tool_execution_end" && event.toolName === toolName);
  assert.ok(
    completed.every((event) => event.isError === true),
    `${context}: ${toolName} unexpectedly completed successfully: ${JSON.stringify(completed)}`,
  );
}

test("Pi plan mode persists across RPC reload and restores mutations after /plan off", async () => {
  const fixture = await createFixture();
  let pi;
  try {
    pi = fixture.spawn();
    const commands = await pi.send({ type: "get_commands" });
    assert.equal(commands.success, true);
    assert.ok(commands.data.commands.some((command) => command.name === "plan"));

    await pi.prompt("/plan on");
    await pi.prompt("persisted-turn");
    assert.equal(existsSync(fixture.sessionPath), true, "the completed turn must create the session file");
    assertPlanEntry((await pi.send({ type: "get_entries" })).data.entries, true, "initial plan state");
    await pi.close();

    pi = fixture.spawn();
    assertPlanEntry((await pi.send({ type: "get_entries" })).data.entries, true, "reloaded plan state");
    await pi.prompt("/plan status");
    await pi.waitFor((event) => event.type === "extension_ui_request" && event.message === "Plan mode: on");

    const writeEvents = pi.events.length;
    await pi.prompt("CALL_WRITE");
    const writeRequest = fixture.provider.firstToolRequest("CALL_WRITE");
    assert.ok(writeRequest, "the fake provider must receive the write attempt");
    assert.equal(toolNames(writeRequest).includes("write"), false, "write must be unavailable in plan mode");
    assert.equal(existsSync(join(fixture.project, "blocked-write.txt")), false);
    assertNoSuccessfulTool(pi, "write", writeEvents, "reloaded plan mode");

    const editEvents = pi.events.length;
    await pi.prompt("CALL_EDIT");
    const editRequest = fixture.provider.firstToolRequest("CALL_EDIT");
    assert.ok(editRequest, "the fake provider must receive the edit attempt");
    assert.equal(toolNames(editRequest).includes("edit"), false, "edit must be unavailable in plan mode");
    assert.equal(readFileSync(join(fixture.project, "edit-target.txt"), "utf8"), "original\n");
    assertNoSuccessfulTool(pi, "edit", editEvents, "reloaded plan mode");

    await pi.prompt("/plan off");
    await pi.prompt("flush-after-off");
    await pi.close();

    pi = fixture.spawn();
    assertPlanEntry((await pi.send({ type: "get_entries" })).data.entries, false, "reloaded disabled plan state");
    await pi.prompt("/plan status");
    await pi.waitFor((event) => event.type === "extension_ui_request" && event.message === "Plan mode: off");
    await pi.prompt("CALL_WRITE");
    await pi.prompt("CALL_EDIT");
    assert.equal(existsSync(join(fixture.project, "blocked-write.txt")), true, "write must return after /plan off");
    assert.equal(readFileSync(join(fixture.project, "edit-target.txt"), "utf8"), "edited\n");
  } finally {
    if (pi) await pi.close();
    await fixture.close();
  }
});

test("Pi plan mode survives real compaction and still blocks built-in and Harness mutation", async () => {
  const fixture = await createFixture();
  let pi;
  try {
    pi = fixture.spawn();
    await pi.prompt("/plan on");
    const autoCompaction = await pi.send({ type: "set_auto_compaction", enabled: false });
    assert.equal(autoCompaction.success, true);
    await pi.prompt("compaction-prefix-a");
    await pi.prompt("compaction-prefix-b");
    await pi.prompt(`COMPACTION ${"context ".repeat(15000)}`);

    const compactionEventIndex = pi.events.length;
    const compact = await pi.send({ type: "compact" }, 30000);
    assert.equal(compact.success, true, `manual compact must succeed: ${JSON.stringify(compact)}`);
    const compactStart = await pi.waitFor(
      (event) => event.type === "compaction_start" && pi.events.indexOf(event) >= compactionEventIndex,
    );
    const compactEnd = await pi.waitFor(
      (event) => event.type === "compaction_end" && pi.events.indexOf(event) >= compactionEventIndex,
    );
    assert.equal(compactStart.reason, "manual");
    assert.equal(compactEnd.aborted, false);
    assert.equal(compactEnd.errorMessage, undefined);
    assert.equal(compact.data.summary, "DONE");

    const compactEntries = (await pi.send({ type: "get_entries" })).data.entries;
    assert.ok(compactEntries.some((entry) => entry.type === "compaction"), "a real compaction entry must be persisted");
    assert.ok(latestCustom(compactEntries, COMPACT_ENTRY), `missing ${COMPACT_ENTRY} after real compaction`);
    assertPlanEntry(compactEntries, true, "plan state immediately after compaction");

    const writeEvents = pi.events.length;
    await pi.prompt("CALL_WRITE");
    assert.equal(toolNames(fixture.provider.firstToolRequest("CALL_WRITE")).includes("write"), false);
    assert.equal(existsSync(join(fixture.project, "blocked-write.txt")), false);
    assertNoSuccessfulTool(pi, "write", writeEvents, "post-compaction plan mode");

    const patchEvents = pi.events.length;
    await pi.prompt("CALL_PATCH");
    assert.equal(toolNames(fixture.provider.firstToolRequest("CALL_PATCH")).includes("pi_harness_patch"), false);
    assert.equal(readFileSync(join(fixture.project, "patch-target.txt"), "utf8"), "original\n");
    assertNoSuccessfulTool(pi, "pi_harness_patch", patchEvents, "post-compaction plan mode");

    const bashEvents = pi.events.length;
    await pi.prompt("CALL_BASH");
    const bashRequest = fixture.provider.firstToolRequest("CALL_BASH");
    assert.ok(bashRequest);
    assert.equal(toolNames(bashRequest).includes("bash"), true, "bash remains available for policy filtering");
    const bashResult = pi.events
      .slice(bashEvents)
      .find((event) => event.type === "tool_execution_end" && event.toolName === "bash");
    assert.ok(bashResult, "the Harness bash policy must inspect the mutation attempt");
    assert.equal(bashResult.isError, true);
    assert.equal(existsSync(join(fixture.project, "blocked-bash.txt")), false);

    const readEvents = pi.events.length;
    await pi.prompt("CALL_HASHLINES");
    const readRequest = fixture.provider.firstToolRequest("CALL_HASHLINES");
    assert.ok(readRequest);
    assert.equal(toolNames(readRequest).includes("pi_harness_hashlines"), true);
    const readResult = pi.events
      .slice(readEvents)
      .find((event) => event.type === "tool_execution_end" && event.toolName === "pi_harness_hashlines");
    assert.ok(readResult, "read-only Harness tool must execute after compaction");
    assert.equal(readResult.isError, false);

    await pi.close();
    pi = fixture.spawn();
    const reloadedEntries = (await pi.send({ type: "get_entries" })).data.entries;
    assertPlanEntry(reloadedEntries, true, "plan state after compaction reload");
    await pi.prompt("/plan status");
    await pi.waitFor((event) => event.type === "extension_ui_request" && event.message === "Plan mode: on");
    await pi.prompt("CALL_WRITE");
    assert.equal(existsSync(join(fixture.project, "blocked-write.txt")), false);
  } finally {
    if (pi) await pi.close();
    await fixture.close();
  }
});

test("Pi plan mode is independent across real fork and switch_session operations", async () => {
  const fixture = await createFixture();
  let pi;
  try {
    pi = fixture.spawn();
    await pi.prompt("/plan on");
    await pi.prompt("parent-checkpoint");
    const parentState = (await pi.send({ type: "get_state" })).data;
    const forkMessages = await pi.send({ type: "get_fork_messages" });
    const checkpoint = forkMessages.data.messages.find((message) => message.text === "parent-checkpoint");
    assert.ok(checkpoint, "the persisted parent turn must be available to the real fork RPC");

    const fork = await pi.send({ type: "fork", entryId: checkpoint.entryId });
    assert.equal(fork.success, true);
    const childState = (await pi.send({ type: "get_state" })).data;
    assert.notEqual(childState.sessionFile, parentState.sessionFile, "fork must create a distinct session file");
    assertPlanEntry((await pi.send({ type: "get_entries" })).data.entries, true, "child inherited plan state");

    await pi.prompt("/plan off");
    const childEntries = (await pi.send({ type: "get_entries" })).data.entries;
    assertPlanEntry(childEntries, false, "child plan state after /plan off");
    await pi.prompt("CALL_CHILD_WRITE");
    assert.equal(existsSync(join(fixture.project, "child-write.txt")), true, "child mutation must be restored after /plan off");

    const switchParent = await pi.send({ type: "switch_session", sessionPath: parentState.sessionFile });
    assert.equal(switchParent.success, true);
    const parentEntries = (await pi.send({ type: "get_entries" })).data.entries;
    assertPlanEntry(parentEntries, true, "parent plan state after returning from child");
    await pi.prompt("CALL_PARENT_WRITE");
    assert.equal(existsSync(join(fixture.project, "parent-write.txt")), false, "parent must remain read-only");

    const switchChild = await pi.send({ type: "switch_session", sessionPath: childState.sessionFile });
    assert.equal(switchChild.success, true);
    assertPlanEntry((await pi.send({ type: "get_entries" })).data.entries, false, "child state after returning from parent");
  } finally {
    if (pi) await pi.close();
    await fixture.close();
  }
});
