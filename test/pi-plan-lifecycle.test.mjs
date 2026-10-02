import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stablePromptSections } from "../lib/context-economics.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import { PLAN_ENTRY } from "../lib/plan.mjs";
import { addWorkTask, claimWorkTask, createWork, recordWorkChild, WORK_ENTRY } from "../lib/work.mjs";
import { readEvidence } from "../lib/evidence.mjs";
import { DEFAULT_PI_EXECUTABLE, defaultPiEnv } from "./helpers/default-pi.mjs";

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
  "pi_harness_start_work",
  "pi_harness_delegate",
  "pi_harness_work",
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

function jsonObjectAfter(text, marker) {
  const start = text.lastIndexOf(marker);
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  return undefined;
}

function lastToolCall(messages) {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.tool_calls?.length);
  const call = assistant?.tool_calls?.at(-1);
  if (!call) return undefined;
  return {
    name: call.function?.name,
    arguments: JSON.parse(call.function?.arguments ?? "{}"),
  };
}

class DisposableProvider {
  constructor(root, project, agentDir, mode = "normal") {
    this.root = root;
    this.project = project;
    this.agentDir = agentDir;
    this.mode = mode;
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
      if (message.role === "user" && (messageText(message).includes("CALL_") || messageText(message).includes("[PI_HARNESS_WORK_CONTINUE]"))) return index;
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
    let responseText = "DONE";
    if (this.mode === "commander-recovery") {
      const fullText = messages.map(messageText).join("\n");
      const workerPromptIndex = messages.findLastIndex((message) => message.role === "user" && /^TaskOrder T-[A-Za-z0-9-]+\nOperation W-/m.test(messageText(message)));
      if (workerPromptIndex >= 0) {
        const workerHasToolResult = messages.slice(workerPromptIndex + 1).some((message) => message.role === "tool");
        if (!workerHasToolResult) {
          const workerCwd = messageText(messages.find((message) => message.role === "system") ?? {}).match(/^Working directory: (.+)$/m)?.[1];
          toolName = "write";
          argumentsForTool = { path: "recovery-evidence.txt", content: `verified from the assigned worktree\nWorker working directory: ${workerCwd}\n` };
        } else responseText = "The Worker wrote the requested Evidence file.";
      } else if (marker?.includes("[PI_HARNESS_WORK_CONTINUE]")) {
        const previousCall = lastToolCall(messages);
        if (this.phase === "old") {
          if (!hasToolResultAfterMarker) {
            toolName = "pi_harness_work";
            argumentsForTool = { action: "resolve", task_id: this.oldTaskId };
          } else {
            toolName = "pi_harness_goal";
            argumentsForTool = { status: "blocked", evidence: "The exact child is unavailable and remains unknown.", blocker: "The prior child outcome cannot be established." };
          }
        } else if (this.phase === "new") {
          if (!hasToolResultAfterMarker) {
            toolName = "pi_harness_delegate";
            argumentsForTool = { owner: "worker", scope: "Write recovery-evidence.txt with the content 'verified from the assigned worktree'.", verification: "git diff --check", acceptance_criteria: ["The Worker verification command passes."] };
          } else if (previousCall?.name === "pi_harness_delegate") {
            const receipt = JSON.parse(messageText(messages.findLast((message) => message.role === "tool")));
            toolName = "pi_harness_work";
            argumentsForTool = { action: "accept", task_id: receipt.task.task_id, evidence: "The matching Worker Evidence and verification command satisfy the assigned criteria." };
          } else if (previousCall?.name === "pi_harness_work") {
            toolName = "pi_harness_goal";
            argumentsForTool = { status: "complete", evidence: "The accepted Worker result satisfies the original objective." };
          }
        }
      } else if (marker?.includes("CALL_WRITE") && !hasToolResultAfterMarker) {
        toolName = "write"; argumentsForTool = { path: "blocked-write.txt", content: "blocked-write.txt\n" };
      }
    }
    if (this.mode === "invalid-terminal" && marker?.includes("[PI_HARNESS_WORK_CONTINUE]") && !hasToolResultAfterMarker) {
      toolName = "pi_harness_goal";
      argumentsForTool = { status: "complete", evidence: "" };
    }
    if (this.mode !== "commander-recovery" && marker && !hasToolResultAfterMarker && (body.tools?.length ?? 0) > 0) {
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
      chunks.push(responseChunk({ role: "assistant", content: responseText }));
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
  constructor(provider, sessionPath, { skills = false, extensionPaths = [REPO_ROOT] } = {}) {
    this.provider = provider;
    this.events = [];
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(
      DEFAULT_PI_EXECUTABLE,
      [
        "--mode",
        "rpc",
        "--session",
        sessionPath,
        "--no-extensions",
        ...extensionPaths.flatMap((path) => ["-e", path]),
        "--no-skills",
        ...(skills ? ["--skill", join(REPO_ROOT, "skills")] : []),
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

async function createFixture(options = {}) {
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

  if (options.mode === "commander-recovery") {
    const projectAgents = join(project, ".pi", "agents");
    mkdirSync(projectAgents, { recursive: true });
    writeFileSync(join(projectAgents, "worker.md"), [
      "---",
      "name: worker",
      "model: fake/dummy",
      "tools: read, bash, edit, write",
      "extensions: false",
      "skills: false",
      "isolation: worktree",
      "prompt_mode: replace",
      "---",
      "Write the requested Evidence file in the assigned worktree. Do not integrate the branch.",
      "",
    ].join("\n"));
    writeFileSync(join(project, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 2, maxConcurrentForeground: 1, fleetView: false, worktreeIsolation: true }, null, 2));
    const git = (args) => {
      const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    git(["init", "--quiet"]);
    git(["config", "user.name", "Disposable Pi Test"]);
    git(["config", "user.email", "pi-test@example.invalid"]);
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "Initialize disposable Worker project"]);
  }

  const provider = new DisposableProvider(root, project, agentDir, options.mode);
  provider.phase = "old";
  const evidenceDir = join(root, "evidence");
  provider.env = {
    ...defaultPiEnv(),
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_HARNESS_CONTROL_DIR: join(root, "control"),
    PI_HARNESS_EVIDENCE_DIR: evidenceDir,
    PI_OFFLINE: "1",
  };
  await provider.start();

  return {
    root,
    project,
    evidenceDir,
    provider,
    sessionPath: join(root, "session.jsonl"),
    spawn(sessionPath = join(root, "session.jsonl"), piOptions = {}) {
      const extensionPaths = piOptions.extensionPaths ?? (options.mode === "commander-recovery"
        ? [
            join(REPO_ROOT, "extensions", "platform-guard.mjs"),
            join(REPO_ROOT, "node_modules", "@tintinweb", "pi-subagents", "dist", "index.js"),
            join(REPO_ROOT, "extensions", "pi-harness.ts"),
          ]
        : [REPO_ROOT]);
      return new DisposablePi(provider, sessionPath, { ...piOptions, extensionPaths });
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

test("Pi hides policy modes from ordinary prompts and expands them on explicit invocation", async () => {
  const fixture = await createFixture();
  const pi = fixture.spawn(undefined, { skills: true });
  try {
    await pi.prompt("Explain a closure briefly.");
    const system = messageText(fixture.provider.requests[0].body.messages.find((message) => message.role === "system"));
    assert.doesNotMatch(system, /<available_skills>|<name>requirement-check<\/name>|<name>pi-coordinator<\/name>/);
    assert.doesNotMatch(system, /multi-part work|medium\/high-impact/);
    assert.doesNotMatch(system, /ACTIVE EVERY RESPONSE|YAGNI only to additions outside it/);

    const invoke = async (name) => {
      const requestIndex = fixture.provider.requests.length;
      const result = await pi.send({ type: "prompt", message: `/skill:${name}` });
      assert.equal(result.success, true);
      for (let attempt = 0; attempt < 500 && fixture.provider.requests.length <= requestIndex; attempt++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      assert.ok(fixture.provider.requests.length > requestIndex, `${name} invocation must reach the model`);
      return fixture.provider.requests[requestIndex].body.messages.map(messageText).join("\n");
    };

    const caveman = await invoke("caveman");
    assert.match(caveman, /<skill name="caveman"/);
    assert.match(caveman, /Scope: presentation only/);
    const ponytail = await invoke("ponytail");
    assert.match(ponytail, /<skill name="ponytail"/);
    assert.match(ponytail, /requested capability/);
    assert.match(ponytail, /TaskOrder/);
    const priorModel = fixture.provider.requests.at(-1).body.model;
    const security = await invoke("security");
    assert.match(security, /<skill name="security"/);
    assert.match(security, /trust boundaries/i);
    assert.equal(fixture.provider.requests.at(-1).body.model, priorModel);
    assert.doesNotMatch(security, /<skill name="security"[^>]*model=/);
  } finally {
    await pi.close();
    await fixture.close();
  }
});

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

test("Pi RPC restart preserves one work record without inferring a child result", async () => {
  const fixture = await createFixture(); let pi;
  try {
    const added = addWorkTask(createWork("Keep interrupted work."), { owner: "research", scope: "Inspect source.", permission: "read", verification: "Review report.", acceptance_criteria: ["State the entry point."] });
    const work = claimWorkTask(added.work, added.task_id);
    const seed = SessionManager.create(fixture.project, join(fixture.root, "seeded"));
    seed.appendCustomEntry(WORK_ENTRY, { [work.work_id]: work });
    seed.appendMessage({ role: "user", content: "Persist this checkpoint.", timestamp: 1 });
    seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Checkpoint saved." }], api: "openai-completions", provider: "fake", model: "dummy", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop", timestamp: 2 });
    pi = fixture.spawn(seed.getSessionFile()); await pi.prompt("checkpoint"); await pi.close();
    seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Checkpoint saved." }], api: "openai-completions", provider: "fake", model: "dummy", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop", timestamp: 2 });
    pi = fixture.spawn(seed.getSessionFile()); await pi.prompt("checkpoint after restart");
    const restored = latestCustom((await pi.send({ type: "get_entries" })).data.entries, WORK_ENTRY)?.data;
    // Native compaction checkpoints are not needed to preserve the original entry.
    assert.equal(restored[work.work_id].objective, work.objective);
    assert.equal(restored[work.work_id].tasks[added.task_id].attempts.length, 1);
    assert.equal(restored[work.work_id].tasks[added.task_id].attempts[0].result, undefined);
  } finally { if (pi) await pi.close(); await fixture.close(); }
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
    assert.match(compact.data.summary, /^DONE(?:\n\n---\n\n\*\*Turn Context \(split turn\):\*\*\n\nDONE)?$/);

    const compactEntries = (await pi.send({ type: "get_entries" })).data.entries;
    assert.ok(compactEntries.some((entry) => entry.type === "compaction"), "a real compaction entry must be persisted");
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

test("Pi goal failure modes stop at a bounded continuation error", async () => {
  for (const mode of ["normal", "invalid-terminal"]) {
    const fixture = await createFixture({ mode });
    let pi;
    try {
      pi = fixture.spawn();
      await pi.prompt("/goal bounded failure");
      let goalEntry;
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const entries = (await pi.send({ type: "get_entries" })).data.entries;
        goalEntry = Object.values(latestCustom(entries, WORK_ENTRY)?.data ?? {})[0];
        if (goalEntry?.status !== "active") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      assert.equal(goalEntry?.status, "blocked", `${mode}: work must stop after the continuation allowance`);
      assert.match(goalEntry.evidence, /continuation allowance/);
      assert.ok(fixture.provider.requests.length <= 50, `${mode}: continuation was not bounded`);
    } finally {
      if (pi) await pi.close();
      await fixture.close();
    }
  }
});

test("Pi RPC recovery preserves an unavailable child and accepts matching Worker Evidence in fresh work", async () => {
  const fixture = await createFixture({ mode: "commander-recovery" });
  const priorEvidenceDir = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = fixture.evidenceDir;
  let pi;
  try {
    const added = addWorkTask(createWork("Recover the interrupted child."), { owner: "worker", permission: "write", scope: "Write old Evidence.", verification: "git diff --check", acceptance_criteria: ["The Worker verification command passes."] });
    const oldWork = recordWorkChild(claimWorkTask(added.work, added.task_id), added.task_id, { child_id: "worker-from-unavailable-session", role: "worker" });
    fixture.provider.oldTaskId = added.task_id;
    const seed = SessionManager.create(fixture.project, join(fixture.root, "seeded"));
    seed.appendCustomEntry(WORK_ENTRY, { [oldWork.work_id]: oldWork });
    seed.appendMessage({ role: "user", content: "Persist the interrupted work.", timestamp: 1 });
    seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Checkpoint saved." }], api: "openai-completions", provider: "fake", model: "dummy", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop", timestamp: 2 });
    pi = fixture.spawn(seed.getSessionFile());
    await pi.prompt("/work resume " + oldWork.work_id);
    const blocked = await waitForWorkState(pi, (works) => works[oldWork.work_id]?.status === "blocked", 8000);
    const oldTask = blocked[oldWork.work_id].tasks[added.task_id];
    assert.equal(oldTask.status, "unknown");
    assert.deepEqual(oldTask.attempts[0].children, [{ child_id: "worker-from-unavailable-session", role: "worker" }]);
    assert.equal(oldTask.attempts[0].result, undefined);
    assert.ok(pi.events.some((event) => event.type === "tool_execution_end" && event.toolName === "pi_harness_work" && event.isError));
    // Explicitly resume, then cancel, before starting independent work.
    await pi.prompt("/work cancel");
    fixture.provider.phase = "new";
    await pi.prompt("/goal Verify direct Commander delegation.");
    const fresh = await waitForWorkState(pi, (works) => Object.values(works).some((work) => work.status === "complete"), 45000);
    assert.equal(fresh[oldWork.work_id].status, "cancelled");
    assert.deepEqual(fresh[oldWork.work_id].tasks[added.task_id], oldTask);
    const work = Object.values(fresh).find((work) => work.status === "complete");
    const task = Object.values(work.tasks)[0], result = task.attempts[0].result;
    assert.equal(task.status, "accepted"); assert.equal(task.attempts.length, 1);
    assert.equal(result.operation_id, work.work_id); assert.equal(result.task_id, task.task_id);
    assert.equal(result.execution_status, "execution_complete"); assert.equal(result.verification_status, "verified");
    assert.ok(result.evidence_refs.length);
    for (const reference of result.evidence_refs) {
      const { metadata } = readEvidence(reference, fixture.project);
      assert.equal(metadata.operation_id, work.work_id); assert.equal(metadata.task_id, task.task_id);
    }
    const branch = result.artifact_refs[0];
    const artifact = spawnSync("git", ["-C", fixture.project, "show", `${branch}:recovery-evidence.txt`], { encoding: "utf8" });
    assert.equal(artifact.status, 0); assert.match(artifact.stdout, /^verified from the assigned worktree/);
    assert.ok(fixture.provider.requests.every((request) => request.body.model === "dummy"));
    assert.ok(!fixture.provider.requests.some((request) => request.body.messages.some((message) => messageText(message).includes('"OperationBrief"'))));
  } finally {
    if (priorEvidenceDir === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR; else process.env.PI_HARNESS_EVIDENCE_DIR = priorEvidenceDir;
    if (pi) await pi.close(); await fixture.close();
  }
});

async function waitForWorkState(pi, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let state;
  while (Date.now() < deadline) {
    state = latestCustom((await pi.send({ type: "get_entries" })).data.entries, WORK_ENTRY)?.data;
    if (state && predicate(state)) return state;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for disposable work: ${JSON.stringify(state)}`);
}
