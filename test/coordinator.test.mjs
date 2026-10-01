import { runWorkerVerification, validCommitMessage } from "../lib/worker-gate.mjs";
import { mockSettlement } from "./helpers/mock-settlement.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as coordinatorApi from "../lib/coordinator.mjs";
import { readEvidence } from "../lib/evidence.mjs";
import { promoteTaskResult } from "../lib/communication.mjs";
import { registerRpcHandlers } from "../node_modules/@tintinweb/pi-subagents/dist/cross-extension-rpc.js";
import { AgentManager } from "../node_modules/@tintinweb/pi-subagents/dist/agent-manager.js";
import { getAgentConfig, getAllTypes, registerAgents } from "../node_modules/@tintinweb/pi-subagents/dist/agent-types.js";
import { resolveDefaultModel } from "../node_modules/@tintinweb/pi-subagents/dist/agent-runner.js";
import { describeModel } from "../node_modules/@tintinweb/pi-subagents/dist/model-resolver.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../node_modules/@tintinweb/pi-subagents/dist/worktree.js";
import {
  cancelCoordinateTasks,
  executeCoordinateTask,
  executeCoordinatorTurn,
  hasActiveCoordinateTasks,
  managedTaskTimeout,
  DEFAULT_TERMINAL_TIMEOUT_MS,
  MANAGED_WORKER_TERMINAL_TIMEOUT_MS,
  MAX_TERMINAL_TIMEOUT_MS,
  validateTask,
} from "../lib/coordinator.mjs";

const evidenceDir = mkdtempSync(join(tmpdir(), "pi-harness-evidence-test-"));
const previousEvidenceDir = process.env.PI_HARNESS_EVIDENCE_DIR;
process.env.PI_HARNESS_EVIDENCE_DIR = evidenceDir;
after(() => {
  if (previousEvidenceDir === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR;
  else process.env.PI_HARNESS_EVIDENCE_DIR = previousEvidenceDir;
  rmSync(evidenceDir, { recursive: true, force: true });
});

class EventBus {
  #handlers = new Map();

  on(name, handler) {
    const handlers = this.#handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name, payload) { if (this.mockSettlement !== false) mockSettlement(name, payload);
    for (const handler of [...(this.#handlers.get(name) ?? [])]) handler(payload);
  }
  listenerCount(name) { return this.#handlers.get(name)?.size ?? 0; }
}

test("baseSha worktree failure is tagged before any child starts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worker-preflight-"));
  const events = new EventBus();
  let spawns = 0;
  events.on("subagents:rpc:spawn", () => { spawns++; });
  try {
    await assert.rejects(executeCoordinateTask({ events }, { owner: "worker", scope: "Edit lib/coordinator.mjs", verification: "node --check lib/coordinator.mjs", permission: "write" }, { cwd }), (error) => {
      assert.equal(error.code, "HARNESS_WORKTREE_FAILED");
      assert.equal(error.failure_stage, "worktree_preflight");
      assert.equal(error.childOutcome, "not_started");
      return true;
    });
    assert.equal(spawns, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function makeRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ]) spawnSync("git", ["-C", repo, ...args]);
  writeFileSync(join(repo, "file.txt"), "initial\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "Initial commit"]);
  return repo;
}

function head(repo) {
  return spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function installManagerRecords(records) {
  const key = Symbol.for("pi-subagents:manager");
  const previous = globalThis[key];
  globalThis[key] = { getRecord: (id) => records.get(id) };
  return () => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  };
}

function packageManagerFor(events, repo, mode = "read") {
  const calls = [];
  const records = new Map();
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  globalThis[managerKey] = { getRecord: (id) => records.get(id) };

  events.on("subagents:rpc:consume", ({ agentId }) => calls.push({ consumed: agentId }));
  events.on("subagents:rpc:spawn", (request) => {
    calls.push(request);
    const id = `agent-${calls.length}`;
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(async () => {
      try {
        if (mode === "worker-reviewed" && request.type === "reviewer") {
          const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf("{\"version\"")));
          events.emit("subagents:completed", { id, status: "completed", result: JSON.stringify({ version: 1, task_id: packet.task_id, status: "verified", summary: "The semantic Verifier checked the criterion.", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status: "passed", finding: "The semantic Verifier checked the selected diff.", evidence_refs: [packet.evidence[0].reference] })) }) });
          return;
        }
        if (mode === "worker" || mode === "worker-reviewed" || mode === "worker-delayed-cleanup") {
          const worktree = mkdtempSync(join(tmpdir(), "pi-package-worktree-"));
          rmSync(worktree, { recursive: true, force: true });
          spawnSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, "HEAD"]);
          writeFileSync(join(worktree, "file.txt"), "worker-update\n");
          spawnSync("git", ["-C", worktree, "add", "file.txt"]);
          spawnSync("git", [
            "-C",
            worktree,
            "commit",
            "-qm",
            `pi-agent: ${request.options.description}`,
          ]);
          await request.options.onBeforeWorktreeCleanup(worktree);
          if (mode === "worker-delayed-cleanup") await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          const branch = "pi-agent-smoke";
          spawnSync("git", ["-C", worktree, "branch", branch]);
          spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
          records.set(id, { worktreeResult: { branch } });
          events.emit("subagents:completed", {
            id,
            type: request.type,
            status: "completed",
            result: `Changes saved to branch \`${branch}\`.`,
          });
          return;
        }
        events.emit("subagents:completed", {
          id,
          type: request.type,
          status: "completed",
          result: mode === "long" ? "x".repeat(9_000) : `${request.type} evidence: read-only complete`,
        });
      } catch (error) {
        events.emit("subagents:failed", { id, type: request.type, status: "error", error: String(error) });
      }
    });
  });

  return {
    calls,
    restore() {
      if (previousManager === undefined) delete globalThis[managerKey];
      else globalThis[managerKey] = previousManager;
    },
  };
}

function modelRoutingPackage(repo, { configuredModel, available = true, mismatched = false, missingInvocation = false } = {}) {
  const events = new EventBus();
  events.mockSettlement = false;
  const commanderModel = Object.freeze({ provider: "commander-provider", id: "commander-model", name: "Commander" });
  const workerModel = Object.freeze({ provider: "worker-provider", id: "worker-model", name: "Worker" });
  const models = [commanderModel, ...(available ? [workerModel] : [])];
  const mutations = [];
  const authStorage = Object.freeze({ set: (...args) => mutations.push(["auth", ...args]), setRuntimeApiKey: (...args) => mutations.push(["api-key", ...args]) });
  const modelRegistry = Object.freeze({
    getAvailable: () => [...models],
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    authStorage,
  });
  const context = Object.freeze({ cwd: repo, model: commanderModel, modelRegistry });
  const pi = { events, setModel: (...args) => mutations.push(["model", ...args]) };
  const previousAgents = new Map(getAllTypes().map((name) => [name, getAgentConfig(name)]));
  registerAgents(new Map([["worker", { name: "worker", model: configuredModel }]]));
  const calls = [], records = new Map();
  const restoreManager = installManagerRecords(records);
  const manager = {
    spawn(_pi, ctx, type, _prompt, options) {
      calls.push({ type, options });
      const selected = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, getAgentConfig(type)?.model);
      const id = `route-${calls.length}`;
      const record = { status: "running", invocation: missingInvocation ? undefined : describeModel(mismatched ? commanderModel : selected) };
      records.set(id, record);
      record.promise = Promise.resolve().then(async () => {
        if (type === "worker") {
          const worktree = mkdtempSync(join(tmpdir(), "pi-route-worktree-"));
          rmSync(worktree, { recursive: true, force: true });
          assert.equal(spawnSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, "HEAD"]).status, 0);
          try {
            writeFileSync(join(worktree, "file.txt"), "worker-update\n");
            assert.equal(spawnSync("git", ["-C", worktree, "add", "file.txt"]).status, 0);
            assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", `pi-agent: ${options.description}`]).status, 0);
            await options.onBeforeWorktreeCleanup(worktree);
            const branch = "pi-agent-routing";
            assert.equal(spawnSync("git", ["-C", worktree, "branch", branch]).status, 0);
            record.worktreeResult = { branch };
          } finally {
            assert.equal(spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]).status, 0);
          }
        }
        record.status = "completed";
        events.emit("subagents:completed", { id, status: "completed", result: "Routing fixture complete." });
      });
      options.onSpawned(id);
      return id;
    },
    async awaitStartup() {},
    getRecord: (id) => records.get(id),
  };
  const handlers = registerRpcHandlers({ events, pi, getCtx: () => context, manager });
  return {
    pi, context, modelRegistry, calls, records, commanderModel,
    assertUnchanged() {
      assert.deepEqual(mutations, []);
      assert.equal(context.model, commanderModel);
      assert.equal(context.modelRegistry.authStorage, authStorage);
      assert.equal(hasActiveCoordinateTasks(), false);
    },
    restore() {
      for (const unsubscribe of Object.values(handlers)) unsubscribe();
      restoreManager();
      registerAgents(previousAgents);
    },
  };
}

test("Coordinator inherits the Commander model through null package routing", async () => {
  const repo = makeRepo("pi-coordinator-inherit-");
  const runtime = modelRoutingPackage(repo);
  try {
    assert.equal(await executeCoordinatorTurn(runtime.pi, "Inspect routing.", { cwd: repo, timeout: 1000, rpcTimeout: 1000 }), "Routing fixture complete.");
    assert.equal(runtime.calls[0].options.model, null);
    assert.equal(runtime.records.get("route-1").invocation.modelId, "commander-provider/commander-model");
    runtime.assertUnchanged();
  } finally { runtime.restore(); rmSync(repo, { recursive: true, force: true }); }
});

test("Coordinator model override is forwarded exactly and resolved by the package", async () => {
  const repo = makeRepo("pi-coordinator-override-");
  const runtime = modelRoutingPackage(repo);
  let forwarded;
  runtime.pi.events.on("subagents:rpc:spawn", (request) => { forwarded = request.options.model; });
  try {
    await executeCoordinatorTurn(runtime.pi, "Inspect routing.", { cwd: repo, model: "worker-provider/worker-model", timeout: 1000, rpcTimeout: 1000 });
    assert.equal(forwarded, "worker-provider/worker-model");
    assert.equal(runtime.calls[0].options.model.provider, "worker-provider");
    assert.equal(runtime.calls[0].options.model.id, "worker-model");
    assert.equal(runtime.records.get("route-1").invocation.modelId, forwarded);
    runtime.assertUnchanged();
  } finally { runtime.restore(); rmSync(repo, { recursive: true, force: true }); }
});

test("Worker configured model resolves at runtime when available", async (t) => {
  for (const scenario of ["registered Worker profile", "explicit task override takes precedence", "unconfigured Worker inherits without a Harness registry"]) await t.test(scenario, async () => {
    const override = scenario === "explicit task override takes precedence";
    const inherited = scenario.startsWith("unconfigured");
    const repo = makeRepo("pi-worker-model-");
    const before = head(repo);
    const runtime = modelRoutingPackage(repo, { configuredModel: inherited ? undefined : override ? "missing/profile-model" : "worker-provider/worker-model" });
    try {
      const result = await executeCoordinateTask(runtime.pi, {
        owner: "worker", scope: "file.txt", permission: "write", verification: "grep worker-update file.txt",
        acceptance_criteria: ["The Worker verification command passes."],
        ...(override ? { model: "worker-provider/worker-model" } : {}),
      }, { cwd: repo, modelRegistry: inherited ? undefined : runtime.modelRegistry, timeout: 1000, rpcTimeout: 1000 });
      assert.equal(result.model, inherited ? "commander-provider/commander-model" : "worker-provider/worker-model");
      assert.equal(result.requestedModel, override ? "worker-provider/worker-model" : null);
      assert.equal(result.success, true);
      assert.equal(result.taskResult.execution_status, "execution_complete");
      assert.equal(result.taskResult.verification_status, "verified");
      assert.equal(runtime.calls[0].options.model === null, !override);
      assert.equal(head(repo), before);
      runtime.assertUnchanged();
    } finally { runtime.restore(); rmSync(repo, { recursive: true, force: true }); }
  });
});

test("Worker model unavailable or mismatched fails before accepting a TaskResult", async (t) => {
  for (const scenario of ["profile unavailable", "override unavailable", "invocation mismatch", "invocation missing"]) await t.test(scenario, async () => {
    const repo = makeRepo("pi-worker-route-failure-");
    const before = head(repo);
    const unavailable = scenario.endsWith("unavailable");
    const override = scenario === "override unavailable";
    const runtime = modelRoutingPackage(repo, {
      configuredModel: "worker-provider/worker-model", available: !unavailable,
      mismatched: scenario === "invocation mismatch", missingInvocation: scenario === "invocation missing",
    });
    try {
      await assert.rejects(executeCoordinateTask(runtime.pi, {
        owner: "worker", scope: "file.txt", permission: "write", verification: "grep worker-update file.txt",
        acceptance_criteria: ["The Worker verification command passes."],
        ...(override ? { model: "worker-provider/worker-model" } : {}),
      }, { cwd: repo, modelRegistry: runtime.modelRegistry, timeout: 1000, rpcTimeout: 1000 }), (error) => {
        assert.equal(error.code, "HARNESS_WORKER_MODEL_UNAVAILABLE");
        assert.equal(error.failure_stage, "model_routing");
        assert.equal(error.taskResult, undefined);
        assert.equal(error.message, "The configured Worker model is unavailable or mismatched.");
        if (unavailable) assert.equal(error.childOutcome, "not_started");
        else assert.equal(error.childSettled, true);
        return true;
      });
      assert.equal(runtime.calls.length, unavailable ? 0 : 1);
      assert.equal(head(repo), before);
      runtime.assertUnchanged();
    } finally { runtime.restore(); rmSync(repo, { recursive: true, force: true }); }
  });
});

for (const role of ["worker", "scout", "research", "coordinator", "reviewer", "security-reviewer"]) {
  test(`${role}: failed spawn ACK drains an existing child before releasing ownership`, async () => {
    const events = new EventBus();
    const child = deferred();
    const records = new Map();
    const restoreManager = installManagerRecords(records);
    const repo = makeRepo("pi-harness-failed-ack-");
    const reviewing = ["reviewer", "security-reviewer"].includes(role);
    let signal;
    events.on("subagents:rpc:spawn", (request) => {
      const id = `ack-${request.type}`;
      if (reviewing && request.type === "research") {
        records.set(id, { status: "completed", promise: Promise.resolve() });
        request.options.onSpawned(id);
        events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
        queueMicrotask(() => events.emit("subagents:completed", { id, status: "completed", result: "Selected report." }));
        return;
      }
      assert.equal(request.type, role);
      signal = request.options.signal;
      records.set(id, { status: "stopped", promise: child.promise });
      request.options.onSpawned(id);
      events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "PRIVATE STARTUP ERROR" });
    });
    try {
      const pending = role === "coordinator"
        ? executeCoordinatorTurn({ events }, "Inspect.", { cwd: repo, role })
        : executeCoordinateTask({ events }, {
          owner: reviewing ? "research" : role, permission: role === "worker" ? "write" : "read", scope: "Inspect.", verification: "true",
          ...(reviewing ? { acceptance_criteria: ["The report establishes the finding."],
            review_profile: { "The report establishes the finding.": role === "security-reviewer" ? "security" : "default" } } : {}),
        }, { cwd: repo, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-daybreak-blue-latest" }] } });
      const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
      while (!signal) await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(signal.aborted, true);
      assert.equal(hasActiveCoordinateTasks(), true, "failed ACK must retain exact child ownership");
      child.resolve();
      const { value, error } = await outcome;
      if (reviewing) {
        assert.equal(value.taskResult.verification_status, "blocked");
        assert.equal(JSON.stringify(value.taskResult).includes("PRIVATE STARTUP ERROR"), false);
      } else {
        assert.equal(error.code, "HARNESS_CHILD_SPAWN_FAILED");
        assert.equal(error.childOutcome, undefined, "an existing child is not a confirmed no-child outcome");
        assert.equal(error.childSettled, true);
      }
      assert.equal(hasActiveCoordinateTasks(), false);
      assert.equal(events.listenerCount("subagents:completed"), 0);
      assert.equal(events.listenerCount("subagents:failed"), 0);
    } finally {
      child.resolve();
      restoreManager();
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("RPC spawn timeout aborts the exact child signal and waits for late startup acknowledgment", async () => {
  const events = new EventBus();
  const startup = deferred();
  const settled = deferred();
  const records = new Map();
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  globalThis[managerKey] = { getRecord: (id) => records.get(id) };
  let childSignal;
  const manager = {
    spawn(_pi, _ctx, _type, _prompt, options) {
      childSignal = options.signal;
      records.set("child-late", { promise: settled.promise });
      options.onSpawned("child-late");
      return "child-late";
    },
    awaitStartup: () => startup.promise,
  };
  const handlers = registerRpcHandlers({ events, pi: {}, getCtx: () => ({ cwd: process.cwd() }), manager });
  try {
    const pending = executeCoordinateTask({ events }, { owner: "research", scope: "lib", verification: "inspect", permission: "read" }, { rpcTimeout: 20, rpcLateReplyGrace: 200, timeout: 1000, groupId: "G-late" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    assert.equal(childSignal.aborted, true, "the Harness must abort the signal before it releases task ownership");
    assert.equal(hasActiveCoordinateTasks(), true, "ownership stays active until the exact child settles");
    startup.resolve();
    settled.resolve();
    await assert.rejects(pending, (error) => error.code === "HARNESS_RPC_TIMEOUT");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally {
    for (const unsubscribe of Object.values(handlers)) unsubscribe?.();
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
  }
});

test("pi-subagents 0.19.0 late Worker startup aborts its real worktree child", async () => {
  const repo = makeRepo("pi-harness-slow-spawn-");
  const parentHead = head(repo);
  const events = new EventBus();
  const manager = new AgentManager(() => {}, 1);
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  const previousIsolation = isWorktreeIsolationEnabled();
  globalThis[managerKey] = { getRecord: (id) => manager.getRecord(id) };
  setWorktreeIsolationEnabled(true);
  let childSignal;
  let childId;
  const originalSpawn = manager.spawn.bind(manager);
  manager.spawn = (...args) => {
    childSignal = args[4].signal;
    childId = originalSpawn(...args);
    return childId;
  };
  const pi = {
    async exec(command, args, options) {
      if (args[0] === "worktree" && args[1] === "add") await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", timeout: options.timeout });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: Boolean(result.error?.killed) };
    },
  };
  const context = { cwd: repo, getSystemPrompt: () => { throw new Error("test stops before model startup"); } };
  const handlers = registerRpcHandlers({ events, pi, getCtx: () => context, manager });
  try {
    let failure;
    try {
      await executeCoordinateTask({ events }, { owner: "worker", scope: "file.txt", verification: "true", permission: "write" }, { cwd: repo, rpcTimeout: 20, rpcLateReplyGrace: 2000, timeout: 2000 });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, "HARNESS_RPC_TIMEOUT");
    assert.equal(failure?.childSettled, true);
    assert.equal(failure?.childStatus, "stopped");
    assert.equal(childSignal.aborted, true);
    const record = manager.getRecord(childId);
    assert.equal(record.status, "stopped");
    assert.equal(record.worktreeResult?.hasChanges, false);
    assert.equal(existsSync(record.worktree.path), false, "pi-subagents removes the unchanged worktree after abort");
    assert.equal(head(repo), parentHead);
  } finally {
    for (const unsubscribe of Object.values(handlers)) unsubscribe?.();
    await manager.dispose();
    setWorktreeIsolationEnabled(previousIsolation);
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("one RPC spawn timeout does not abort its sibling ExecutionUnit", async () => {
  const events = new EventBus();
  const startup = deferred();
  const firstSettlement = deferred();
  const siblingSettlement = deferred();
  const timedAborted = deferred();
  const records = new Map();
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  globalThis[managerKey] = { getRecord: (id) => records.get(id) };
  const signals = new Map();
  const manager = {
    spawn(_pi, _ctx, _type, _prompt, options) {
      const id = options.description.includes("timeout") ? "spawn-timeout" : "spawn-sibling";
      signals.set(id, options.signal);
      if (id === "spawn-timeout") options.signal.addEventListener("abort", timedAborted.resolve, { once: true });
      const settlement = id === "spawn-timeout" ? firstSettlement : siblingSettlement;
      records.set(id, { promise: settlement.promise });
      options.onSpawned(id);
      if (id === "spawn-sibling") queueMicrotask(() => {
        settlement.resolve();
        events.emit("subagents:completed", { id, status: "completed", result: "sibling completed" });
      });
      return id;
    },
    awaitStartup(id) { return id === "spawn-timeout" ? startup.promise : Promise.resolve(); },
    consumeResult() { return true; },
  };
  const handlers = registerRpcHandlers({ events, pi: {}, getCtx: () => ({ cwd: process.cwd() }), manager });
  try {
    const timed = executeCoordinateTask({ events }, { owner: "research", scope: "timeout", verification: "inspect", permission: "read" }, { rpcTimeout: 20, rpcLateReplyGrace: 200, timeout: 1000 });
    const sibling = executeCoordinateTask({ events }, { owner: "research", scope: "sibling", verification: "inspect", permission: "read" }, { rpcTimeout: 200, rpcLateReplyGrace: 200, timeout: 1000 });
    const siblingResult = await sibling;
    assert.equal(siblingResult.success, true);
    await Promise.race([timedAborted.promise, new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))]);
    assert.equal(signals.get("spawn-sibling").aborted, false);
    assert.equal(signals.get("spawn-timeout").aborted, true);
    startup.resolve();
    firstSettlement.resolve();
    await assert.rejects(timed, (error) => error.code === "HARNESS_RPC_TIMEOUT");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally {
    for (const unsubscribe of Object.values(handlers)) unsubscribe?.();
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
  }
});

test("RPC startup rejection reports a confirmed no-child outcome", async () => {
  const events = new EventBus();
  const startup = deferred();
  const manager = {
    spawn() { return "child-startup-failed"; },
    awaitStartup: () => startup.promise,
  };
  const handlers = registerRpcHandlers({ events, pi: {}, getCtx: () => ({ cwd: process.cwd() }), manager });
  try {
    const pending = executeCoordinateTask({ events }, { owner: "research", scope: "lib", verification: "inspect", permission: "read" }, { rpcTimeout: 20, rpcLateReplyGrace: 200, timeout: 1000 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    startup.reject(new Error("private startup details"));
    await assert.rejects(pending, (error) => error.code === "HARNESS_RPC_TIMEOUT" && error.childOutcome === "spawn_rejected");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally {
    for (const unsubscribe of Object.values(handlers)) unsubscribe?.();
  }
});

test("RPC timeout before manager spawn lets the aborted request resolve as no child", async () => {
  const events = new EventBus();
  let childSignal;
  let spawned = false;
  events.on("subagents:rpc:spawn", (request) => {
    childSignal = request.options.signal;
    setTimeout(() => {
      if (childSignal.aborted) events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "cancelled before spawn" });
      else {
        spawned = true;
        events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: "too-late" } });
      }
    }, 50);
  });
  await assert.rejects(executeCoordinateTask({ events }, { owner: "research", scope: "lib", verification: "inspect", permission: "read" }, { rpcTimeout: 20, rpcLateReplyGrace: 200, timeout: 1000 }), (error) => error.childOutcome === "spawn_rejected");
  assert.equal(childSignal.aborted, true);
  assert.equal(spawned, false);
  assert.equal(hasActiveCoordinateTasks(), false);
});

test("Coordinator RPC timeout aborts the exact child and drains its acknowledgment", async () => {
  const events = new EventBus();
  const startup = deferred();
  const settled = deferred();
  const records = new Map();
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  globalThis[managerKey] = { getRecord: (id) => records.get(id) };
  let childSignal;
  const manager = {
    spawn(_pi, _ctx, _type, _prompt, options) {
      childSignal = options.signal;
      records.set("coordinator-late", { promise: settled.promise });
      options.onSpawned("coordinator-late");
      return "coordinator-late";
    },
    awaitStartup: () => startup.promise,
  };
  const handlers = registerRpcHandlers({ events, pi: {}, getCtx: () => ({ cwd: process.cwd() }), manager });
  try {
    const pending = executeCoordinatorTurn({ events }, "bounded brief", { rpcTimeout: 20, rpcLateReplyGrace: 200, timeout: 1000, groupId: "G-coordinator" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    assert.equal(childSignal.aborted, true);
    assert.equal(hasActiveCoordinateTasks(), true);
    startup.resolve();
    settled.resolve();
    await assert.rejects(pending, (error) => error.code === "HARNESS_RPC_TIMEOUT");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally {
    for (const unsubscribe of Object.values(handlers)) unsubscribe?.();
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
  }
});

test("Reviewer RPC timeout aborts the Reviewer and returns blocked verification", async () => {
  const events = new EventBus();
  const reviewerStartup = deferred();
  const reviewerSettled = deferred();
  const records = new Map();
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  globalThis[managerKey] = { getRecord: (id) => records.get(id) };
  let reviewerSignal;
  let resolveReviewerAbort;
  const reviewerAborted = new Promise((resolvePromise) => { resolveReviewerAbort = resolvePromise; });
  const manager = {
    spawn(_pi, _ctx, type, _prompt, options) {
      const id = type === "research" ? "research-complete" : "reviewer-late";
      const settled = type === "research" ? deferred() : reviewerSettled;
      records.set(id, { promise: settled.promise });
      options.onSpawned(id);
      if (type === "reviewer") {
        reviewerSignal = options.signal;
        reviewerSignal.addEventListener("abort", resolveReviewerAbort, { once: true });
      } else queueMicrotask(() => {
        settled.resolve();
        events.emit("subagents:completed", { id, status: "completed", result: "bounded report" });
      });
      return id;
    },
    awaitStartup(id) { return id === "reviewer-late" ? reviewerStartup.promise : Promise.resolve(); },
    consumeResult() { return true; },
  };
  const handlers = registerRpcHandlers({ events, pi: {}, getCtx: () => ({ cwd: process.cwd() }), manager });
  try {
    const pending = executeCoordinateTask({ events }, { owner: "research", task_id: "T-reviewer-timeout", scope: "lib", verification: "inspect", permission: "read", acceptance_criteria: ["The report identifies the source."] }, { rpcTimeout: 20, rpcLateReplyGrace: 200, timeout: 1000 });
    await Promise.race([reviewerAborted, new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))]);
    assert.equal(reviewerSignal.aborted, true);
    assert.equal(hasActiveCoordinateTasks(), true);
    reviewerStartup.resolve();
    reviewerSettled.resolve();
    const result = await pending;
    assert.equal(result.taskResult.execution_status, "execution_complete");
    assert.equal(result.taskResult.verification_status, "blocked");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally {
    for (const unsubscribe of Object.values(handlers)) unsubscribe?.();
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
  }
});

test("terminal timeout aborts only the owned ExecutionUnit and drains its exact child", async () => {
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  try {
    for (const owner of ["worker", "scout", "research"]) {
      const events = new EventBus();
      const id = `timed-${owner}`;
      const child = deferred();
      const record = { status: "running", promise: child.promise };
      records.set(id, record);
      let request;
      events.on("subagents:rpc:spawn", (next) => {
        request = next;
        next.options.onSpawned(id);
        events.emit(`subagents:rpc:spawn:reply:${next.requestId}`, { success: true, data: { id } });
        next.options.signal.addEventListener("abort", () => {
          record.status = "stopped";
          events.emit("subagents:failed", { id, status: "stopped" });
          child.resolve();
        }, { once: true });
      });
      await assert.rejects(executeCoordinateTask({ events }, { owner, task_id: `T-${owner}`, operation_id: "O-timeout", scope: "Inspect timeout.", permission: owner === "worker" ? "write" : "read", verification: "true", ...(owner === "worker" ? {} : { acceptance_criteria: ["The report identifies the requested evidence."] }) }, { timeout: 30, rpcTimeout: 1000 }), (error) => error.code === "HARNESS_CHILD_TERMINAL_TIMEOUT" && error.childSettled === true);
      assert.equal(request.options.signal.aborted, true, `${owner} child signal must reach pi-subagents`);
      assert.equal(hasActiveCoordinateTasks(), false);
      assert.equal(events.listenerCount("subagents:completed"), 0);
      assert.equal(events.listenerCount("subagents:failed"), 0);
      events.emit("subagents:completed", { id, status: "completed", result: "LATE PRIVATE RESULT" });
      assert.equal(hasActiveCoordinateTasks(), false);
    }
  } finally { restoreManager(); }
});

test("timed-out Worker records package-confirmed branch and commit disposition without a TaskResult", async () => {
  const repo = makeRepo("pi-harness-timeout-disposition-");
  const base = head(repo);
  const worktree = mkdtempSync(join(tmpdir(), "pi-harness-partial-worker-"));
  rmSync(worktree, { recursive: true, force: true });
  assert.equal(spawnSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, base]).status, 0);
  writeFileSync(join(worktree, "partial.txt"), "partial Worker output\n");
  spawnSync("git", ["-C", worktree, "add", "partial.txt"]);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "Partial Worker output"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "branch", "pi-agent-partial"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]).status, 0);
  const commitSha = spawnSync("git", ["-C", repo, "rev-parse", "pi-agent-partial"], { encoding: "utf8" }).stdout.trim();
  const events = new EventBus();
  const child = deferred();
  const record = { status: "running", promise: child.promise, worktreeResult: { hasChanges: true, branch: "pi-agent-partial" } };
  const restoreManager = installManagerRecords(new Map([["partial-worker", record]]));
  events.on("subagents:rpc:spawn", (request) => {
    request.options.onSpawned("partial-worker");
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: "partial-worker" } });
    request.options.signal.addEventListener("abort", () => {
      record.status = "stopped";
      events.emit("subagents:failed", { id: "partial-worker", status: "stopped" });
      child.resolve();
    }, { once: true });
  });
  try {
    await assert.rejects(executeCoordinateTask({ events }, { owner: "worker", task_id: "T-partial", operation_id: "O-partial", scope: "Write partial output.", permission: "write", verification: "Run the required gate." }, { cwd: repo, timeout: 30, rpcTimeout: 1000 }), (error) => {
      assert.equal(error.code, "HARNESS_CHILD_TERMINAL_TIMEOUT");
      assert.equal(error.childSettled, true);
      assert.deepEqual(error.child_disposition, { branch_status: "preserved", branch: "pi-agent-partial", commit_sha: commitSha, commit_count: 1, worktree_status: "unknown" });
      assert.equal(Object.hasOwn(error, "taskResult"), false);
      return true;
    });
    assert.equal(head(repo), base, "the partial branch is not integrated into the base branch");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally {
    restoreManager();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a terminal event does not release ownership before the exact package child settles", async () => {
  const events = new EventBus();
  const child = deferred();
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  let returned = false;
  events.on("subagents:rpc:spawn", (request) => {
    const id = "terminal-before-settlement";
    records.set(id, { status: "completed", promise: child.promise });
    request.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => events.emit("subagents:completed", { id, status: "completed", result: "The report is ready." }));
  });
  try {
    const pending = executeCoordinateTask({ events }, { owner: "research", scope: "Inspect.", verification: "inspect", permission: "read" }, { timeout: 1000, rpcTimeout: 1000 }).then((result) => {
      returned = true;
      return result;
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(returned, false, "TaskResult waits for package settlement after the terminal event");
    assert.equal(hasActiveCoordinateTasks(), true, "Harness ownership remains until the package promise settles");
    child.resolve();
    const result = await pending;
    assert.equal(result.taskResult.execution_status, "execution_complete");
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally { restoreManager(); }
});

test("a terminal notification without package settlement times out without promoting a TaskResult", async () => {
  const events = new EventBus();
  const child = deferred();
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  events.on("subagents:rpc:spawn", (request) => {
    const id = "terminal-no-settlement";
    records.set(id, { status: "completed", promise: child.promise });
    request.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => events.emit("subagents:completed", { id, status: "completed", result: "The report is ready." }));
  });
  try {
    await assert.rejects(executeCoordinateTask({ events }, { owner: "research", scope: "Inspect.", verification: "inspect", permission: "read" }, { timeout: 1000, rpcTimeout: 1000 }), (error) => error.code === "HARNESS_CHILD_SETTLEMENT_TIMEOUT" && error.childSettled === false);
    assert.equal(hasActiveCoordinateTasks(), true, "unsettled package ownership remains tracked");
    child.resolve();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(hasActiveCoordinateTasks(), false, "late settlement releases exact ownership");
  } finally { restoreManager(); }
});

test("terminal timeout retains ownership until the exact child settles", async () => {
  const events = new EventBus();
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  const child = deferred();
  const aborted = deferred();
  const id = "slow-cleanup";
  const record = { status: "running", promise: child.promise };
  records.set(id, record);
  let request;
  events.on("subagents:rpc:spawn", (next) => {
    request = next;
    next.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${next.requestId}`, { success: true, data: { id } });
    next.options.signal.addEventListener("abort", () => { record.status = "stopped"; aborted.resolve(); }, { once: true });
  });
  try {
    const pending = executeCoordinateTask({ events }, { owner: "research", scope: "Inspect timeout.", permission: "read", verification: "Inspect report." }, { timeout: 30, rpcTimeout: 1000 });
    await aborted.promise;
    assert.equal(request.options.signal.aborted, true);
    assert.equal(hasActiveCoordinateTasks(), true, "Harness must retain ownership during the bounded drain");
    await assert.rejects(pending, (error) => error.code === "HARNESS_CHILD_TERMINAL_TIMEOUT" && error.childSettled !== true);
    assert.equal(hasActiveCoordinateTasks(), true, "Harness must retain ownership after the drain expires");
    events.emit("subagents:completed", { id, status: "completed", result: "LATE PRIVATE RESULT" });
    assert.equal(hasActiveCoordinateTasks(), true);
    child.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hasActiveCoordinateTasks(), false, "Harness releases ownership only after package settlement");
  } finally { restoreManager(); }
});

test("Coordinator terminal timeout aborts its own signal and drains its child", async () => {
  const events = new EventBus();
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  const child = deferred();
  const id = "timed-coordinator";
  const record = { status: "running", promise: child.promise };
  records.set(id, record);
  let request;
  events.on("subagents:rpc:spawn", (next) => {
    request = next;
    next.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${next.requestId}`, { success: true, data: { id } });
    next.options.signal.addEventListener("abort", () => {
      record.status = "stopped";
      events.emit("subagents:failed", { id, status: "stopped" });
      child.resolve();
    }, { once: true });
  });
  try {
    await assert.rejects(executeCoordinatorTurn({ events }, "Bounded OperationBrief", { timeout: 30, rpcTimeout: 1000 }), (error) => error.code === "HARNESS_CHILD_TERMINAL_TIMEOUT" && error.childSettled === true);
    assert.equal(request.options.signal.aborted, true);
    assert.equal(hasActiveCoordinateTasks(), false);
    assert.equal(events.listenerCount("subagents:completed"), 0);
    assert.equal(events.listenerCount("subagents:failed"), 0);
    events.emit("subagents:completed", { id, status: "completed", result: "late decision" });
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally { restoreManager(); }
});

test("Reviewer terminal timeout drains its own child and blocks verification", async () => {
  const events = new EventBus();
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  const reviewer = deferred();
  const idByType = { research: "report-child", reviewer: "reviewer-child" };
  let reviewerSignal;
  events.on("subagents:rpc:spawn", (request) => {
    const id = idByType[request.type];
    const settled = request.type === "research" ? deferred() : reviewer;
    const record = { status: "running", promise: settled.promise };
    records.set(id, record);
    request.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    if (request.type === "research") queueMicrotask(() => {
      record.status = "completed";
      settled.resolve();
      events.emit("subagents:completed", { id, status: "completed", result: "The report identifies the source." });
    });
    else {
      reviewerSignal = request.options.signal;
      reviewerSignal.addEventListener("abort", () => { record.status = "stopped"; settled.resolve(); }, { once: true });
    }
  });
  try {
    const result = await executeCoordinateTask({ events }, { owner: "research", task_id: "T-review-timeout", scope: "Inspect the source.", permission: "read", verification: "Inspect report.", acceptance_criteria: ["The report identifies the source."] }, { timeout: 1000, reviewerTimeout: 30, rpcTimeout: 1000 });
    assert.equal(reviewerSignal.aborted, true);
    assert.equal(result.taskResult.verification_status, "blocked");
    assert.equal(hasActiveCoordinateTasks(), false);
    assert.equal(events.listenerCount("subagents:completed"), 0);
    assert.equal(events.listenerCount("subagents:failed"), 0);
  } finally { restoreManager(); }
});

test("execution budgets start after RPC acknowledgement and Worker gate has a separate cleanup phase", async () => {
  const records = new Map();
  const restoreManager = installManagerRecords(records);
  try {
    const events = new EventBus();
    const child = deferred();
    const id = "delayed-ack";
    let acknowledgedAt;
    let abortedAt;
    records.set(id, { promise: child.promise });
    events.on("subagents:rpc:spawn", (request) => {
      request.options.signal.addEventListener("abort", () => {
        abortedAt = Date.now();
        child.resolve();
        events.emit("subagents:failed", { id, status: "stopped" });
      }, { once: true });
      setTimeout(() => {
        acknowledgedAt = Date.now();
        request.options.onSpawned(id);
        events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
      }, 60);
    });
    await assert.rejects(executeCoordinateTask({ events }, { owner: "research", scope: "Inspect.", verification: "inspect", permission: "read" }, { timeout: 40, rpcTimeout: 500 }), (error) => error.code === "HARNESS_CHILD_TERMINAL_TIMEOUT");
    assert.ok(abortedAt - acknowledgedAt >= 30, `child timeout began before acknowledgement: ${abortedAt - acknowledgedAt}ms`);
  } finally { restoreManager(); }

  const repo = makeRepo("pi-harness-worker-gate-budget-");
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, repo, "worker-delayed-cleanup");
  try {
    const startedAt = Date.now();
    const result = await executeCoordinateTask({ events }, {
      owner: "worker", scope: "file.txt", verification: "sleep 0.8; test -f file.txt", permission: "write",
    }, { cwd: repo, timeout: 500, rpcTimeout: 1000 });
    assert.equal(result.taskResult.execution_status, "execution_complete");
    assert.equal(result.taskResult.verification_status, "verified");
    assert.ok(Date.now() - startedAt >= 750, "the independent Worker gate must complete beyond the Worker execution budget");
  } finally {
    fakePackage.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("managed Worker receives a bounded terminal budget; other roles retain the default", async () => {
  assert.equal(DEFAULT_TERMINAL_TIMEOUT_MS, 120_000);
  assert.equal(MANAGED_WORKER_TERMINAL_TIMEOUT_MS, 300_000);
  assert.equal(MAX_TERMINAL_TIMEOUT_MS, 300_000);
  assert.equal(managedTaskTimeout("worker"), MANAGED_WORKER_TERMINAL_TIMEOUT_MS);
  for (const role of ["coordinator", "scout", "research", "reviewer", "security-reviewer"]) assert.equal(managedTaskTimeout(role), DEFAULT_TERMINAL_TIMEOUT_MS);
  const source = readFileSync("extensions/pi-harness.ts", "utf8");
  assert.match(source, /timeout: managedTaskTimeout\(task\.owner\), reviewerTimeout: managedTaskTimeout\("reviewer"\)/);
  const task = { owner: "research", scope: "Inspect.", verification: "inspect", permission: "read" };
  for (const timeout of [0, -1, MAX_TERMINAL_TIMEOUT_MS + 1, 1.5, Infinity]) {
    await assert.rejects(executeCoordinateTask({}, task, { timeout }), /terminal budget/);
    await assert.rejects(executeCoordinatorTurn({}, "brief", { timeout }), /terminal budget/);
  }
  await assert.rejects(executeCoordinateTask({}, task, { reviewerTimeout: MAX_TERMINAL_TIMEOUT_MS + 1 }), /terminal budget/);
  for (const rpcTimeout of [0, -1, 60_001, 1.5, Infinity]) {
    await assert.rejects(executeCoordinateTask({}, task, { rpcTimeout }), /RPC timeout/);
    await assert.rejects(executeCoordinatorTurn({}, "brief", { rpcTimeout }), /RPC timeout/);
  }
  assert.equal(hasActiveCoordinateTasks(), false);
});

test("public task validation keeps scout and research read-only", () => {
  assert.throws(() => validateTask({ owner: "worker" }));
  assert.throws(() => validateTask({ owner: "research", scope: "src", verification: "rg x", permission: "write" }));
  assert.equal(validateTask({ owner: "scout", scope: "src", verification: "rg x", permission: "read" }).owner, "scout");
  assert.deepEqual(JSON.parse(readFileSync(".pi/subagents.json", "utf8")), {
    maxConcurrent: 4,
    maxConcurrentForeground: 1,
    fleetView: false,
    worktreeIsolation: true,
  });
  for (const role of ["scout", "research"]) {
    const source = readFileSync(`.pi/agents/${role}.md`, "utf8");
    assert.match(source, /tools: read, grep, find, ls/);
    assert.doesNotMatch(source, /tools:.*\bbash\b/);
  }
});

test("scout and research complete through the package boundary with read-only policies", async () => {
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, process.cwd());
  try {
    for (const owner of ["scout", "research"]) {
      const result = await executeCoordinateTask({ events }, {
        owner,
        scope: "lib",
        verification: "printf evidence",
        permission: "read",
      }, { rpcTimeout: 1000, timeout: 1000 });
      assert.equal(result.success, true);
      assert.equal(result.taskResult.execution_status, "execution_complete");
      assert.equal(result.taskResult.verification_status, "not_verified");
      assert.equal(result.taskResult.evidence_refs.length, 1);
      assert.equal(readEvidence(result.taskResult.evidence_refs[0]).content.toString(), result.result);
      assert.equal(JSON.stringify(promoteTaskResult(result)).includes("read-only complete"), false);
      assert.equal(result.owner, owner);
      assert.match(result.result, /read-only complete/);
      const request = fakePackage.calls.find((entry) => entry?.type === owner);
      assert.equal(request.options.isolation, "off");
      assert.equal(request.options.isBackground, true);
      assert.equal(request.options.model, null);
      assert.ok(request.options.signal instanceof AbortSignal);
      assert.match(request.prompt, /TaskOrder .*\nExecution Status: assigned/);
      assert.match(request.prompt, /ExecutionUnit must inspect and report evidence/);
    }
  } finally {
    fakePackage.restore();
  }
});

test("bounded read-only capture records real truncation metadata", async () => {
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, process.cwd(), "long");
  try {
    const result = await executeCoordinateTask({ events }, { owner: "research", scope: "lib", verification: "inspect", permission: "read" }, { rpcTimeout: 1000, timeout: 1000 });
    assert.equal(result.resultTruncated, true);
    const stored = readEvidence(result.taskResult.evidence_refs[0]);
    assert.equal(stored.metadata.truncated, true);
    assert.equal(stored.metadata.bytes, Buffer.byteLength(result.result));
    assert.equal(stored.content.toString(), result.result);
    assert.equal(JSON.stringify(promoteTaskResult(result)).includes("x".repeat(100)), false);
  } finally { fakePackage.restore(); }
});

test("worker uses package worktree/concurrency options, runs the gate, preserves parent HEAD, and never integrates", async () => {
  const repo = makeRepo("pi-harness-package-worker-");
  mkdirSync(join(repo, "node_modules"));
  const before = head(repo);
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, repo, "worker");
  try {
    const result = await executeCoordinateTask({ events }, {
      owner: "worker",
      scope: "file.txt with a bounded synthetic scope description",
      verification: "grep 'worker-update' file.txt && printf 'verification passed'",
      permission: "write",
      acceptance_criteria: ["The Worker verification command passes."],
    }, { cwd: repo, rpcTimeout: 1000, timeout: 1000 });

    const request = fakePackage.calls.find((entry) => entry?.type === "worker");
    assert.equal(request.options.isBackground, true);
    assert.equal(request.options.isolation, "worktree");
    assert.match(request.options.description, /Scope: file\.txt with a bounded synthetic scope \.\.\.\[truncated after 40 bytes\]/);
    assert.match(request.options.description, /Reason: grep 'worker-update' file\.txt/);
    assert.doesNotMatch(request.options.description, /[\r\n]/u);
    assert.doesNotMatch(request.prompt, /create exactly one atomic commit/);
    assert.equal(result.success, true);
    assert.equal(result.gatePassed, true);
    assert.equal(result.taskResult.execution_status, "execution_complete");
    assert.equal(result.taskResult.verification_status, "verified");
    assert.equal(fakePackage.calls.some((entry) => entry?.type === "reviewer"), false);
    assert.deepEqual(result.taskResult.changed_paths, ["file.txt"]);
    const items = result.taskResult.evidence_refs.map((ref) => readEvidence(ref, repo));
    assert.deepEqual(items.map((item) => item.metadata.kind), ["execution", "gate", "diff"]);
    assert.equal(items[0].content.toString(), result.result);
    assert.equal(items[1].content.toString(), result.gateEvidence);
    assert.equal(items[2].content.toString(), result.diff);
    assert.equal(JSON.stringify(promoteTaskResult(result)).includes("+worker-update"), false);
    assert.equal(result.commitCheck.valid, true);
    assert.equal(result.atomicCommit, true);
    assert.match(result.diff, /\+worker-update/);
    assert.equal(result.integrated, false);
    assert.match(result.integration, /never auto-integrates/);
    assert.equal(head(repo), before);
    assert.equal(existsSync(join(result.worktreePath, "node_modules")), false);
    assert.equal(existsSync(result.worktreePath), false, "package owns worktree cleanup");
  } finally {
    fakePackage.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worker commit metadata may be inline in the package-generated subject", () => {
  assert.equal(validCommitMessage("pi-agent: worker: file.txt · Scope: file.txt · Reason: grep file.txt", ""), true);
  assert.equal(validCommitMessage("Worker update", "Scope: file.txt\nReason: grep file.txt"), true);
  assert.equal(validCommitMessage("pi-agent: worker · Scope: file.txt", ""), false);
  assert.equal(validCommitMessage("pi-agent: worker · Scope: \nReason: grep file.txt", ""), false);
});

test("deterministic Verifier defers semantic criteria and rejects a failed gate", async () => {
  const repo = makeRepo("pi-harness-verifier-");
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, repo, "worker");
  try {
    const semantic = await executeCoordinateTask({ events }, {
      owner: "worker", scope: "file.txt", verification: "grep worker-update file.txt", permission: "write",
      acceptance_criteria: ["The change is readable to a new maintainer."],
    }, { cwd: repo, rpcTimeout: 1000, timeout: 1000 });
    assert.equal(semantic.taskResult.verification_status, "blocked");
    assert.match(semantic.taskResult.verification_summary, /semantic Verifier/);
    spawnSync("git", ["-C", repo, "branch", "-D", "pi-agent-smoke"]);
    const failed = await executeCoordinateTask({ events }, {
      owner: "worker", scope: "file.txt", verification: "false", permission: "write",
    }, { cwd: repo, rpcTimeout: 1000, timeout: 1000 });
    assert.equal(failed.taskResult.execution_status, "execution_complete");
    assert.equal(failed.taskResult.verification_status, "failed");
    assert.equal(failed.taskResult.failure_code, "HARNESS_VERIFIER_FAILED");
    assert.ok(failed.taskResult.evidence_refs.some((ref) => readEvidence(ref, repo).metadata.kind === "gate"));
  } finally { fakePackage.restore(); rmSync(repo, { recursive: true, force: true }); }
});

test("Harness combines passed Worker deterministic and semantic checks", async () => {
  const repo = makeRepo("pi-harness-reviewed-worker-");
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, repo, "worker-reviewed");
  try {
    const result = await executeCoordinateTask({ events }, { owner: "worker", task_id: "T-worker", scope: "file.txt", verification: "grep worker-update file.txt", permission: "write", acceptance_criteria: ["The new code remains understandable."] }, { cwd: repo, rpcTimeout: 1000, timeout: 1000 });
    assert.equal(result.taskResult.verification_status, "verified");
    assert.equal(fakePackage.calls.filter((entry) => entry?.type === "reviewer").length, 1);
    assert.ok(result.taskResult.evidence_refs.some((ref) => readEvidence(ref, repo).metadata.kind === "semantic_review"));
    assert.ok(!JSON.stringify(promoteTaskResult(result)).includes("+worker-update"));
  } finally { fakePackage.restore(); rmSync(repo, { recursive: true, force: true }); }
});

test("Evidence Store failure never gives a fake reference or verified status", async () => {
  const events = new EventBus();
  const fakePackage = packageManagerFor(events, process.cwd());
  const old = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = "relative/unsafe";
  try {
    const result = await executeCoordinateTask({ events }, { owner: "scout", scope: "lib", verification: "inspect", permission: "read" }, { timeout: 1000, rpcTimeout: 1000 });
    assert.equal(result.taskResult.verification_status, "failed");
    assert.equal(result.taskResult.failure_code, "HARNESS_EVIDENCE_FAILED");
    assert.deepEqual(result.taskResult.evidence_refs, []);
    assert.match(result.taskResult.evidence_error, /could not persist/);
  } finally {
    if (old === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR;
    else process.env.PI_HARNESS_EVIDENCE_DIR = old;
    fakePackage.restore();
  }
});

test("goal-scoped cancellation aborts only the package task owned by that goal", async () => {
  const events = new EventBus();
  let request;
  events.on("subagents:rpc:spawn", (payload) => {
    request = payload;
    const id = "agent-cancel";
    events.emit(`subagents:rpc:spawn:reply:${payload.requestId}`, { success: true, data: { id } });
    payload.options.signal.addEventListener("abort", () => {
      events.emit("subagents:failed", { id, status: "stopped", error: "aborted by goal" });
    }, { once: true });
  });

  const pending = executeCoordinateTask({ events }, {
    owner: "research",
    scope: "lib",
    verification: "printf evidence",
    permission: "read",
  }, { groupId: "goal-1", rpcTimeout: 1000, timeout: 1000 });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(cancelCoordinateTasks("other-goal"), 0);
  assert.equal(cancelCoordinateTasks("goal-1"), 1);
  await assert.rejects(pending, error => error.code === "HARNESS_CANCELLED");
  assert.equal(request.options.signal.aborted, true);
  assert.equal(hasActiveCoordinateTasks(), false);
});

test("missing package settlement fails closed; a later exact promise releases retained ownership", async () => {
  const events = new EventBus();
  events.mockSettlement = false;
  const child = deferred();
  const record = { status: "completed" };
  const restoreManager = installManagerRecords(new Map([["missing-promise", record]]));
  let request;
  events.on("subagents:rpc:spawn", req => {
    request = req;
    req.options.onSpawned("missing-promise");
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, {success:true,data:{id:"missing-promise"}});
    queueMicrotask(() => events.emit("subagents:completed", {id:"missing-promise",status:"completed",result:"PRIVATE"}));
  });
  try {
    await assert.rejects(executeCoordinatorTurn({events}, "Inspect."), error => error.code === "HARNESS_CHILD_SETTLEMENT_TIMEOUT");
    assert.equal(request.options.signal.aborted, true);
    assert.equal(hasActiveCoordinateTasks(), true);
    record.promise = child.promise;
    request.options.onSpawned("missing-promise");
    child.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally { child.resolve(); restoreManager(); }
});

test("queued cancellation waits for startup gate and never promotes late completion", async () => {
  const events = new EventBus();
  events.mockSettlement = false;
  const gate = deferred(), child = deferred();
  const record = {status:"queued",startGate:gate.promise};
  const key = Symbol.for("pi-subagents:manager"), previous = globalThis[key];
  globalThis[key] = {getRecord: () => record, awaitStartup: () => Promise.resolve()};
  const parent = new AbortController();
  let request;
  events.on("subagents:rpc:spawn", req => {
    request = req;
    req.options.onQueued("queued-child");
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`, {success:true,data:{id:"queued-child"}});
  });
  try {
    const pending = executeCoordinatorTurn({events}, "Inspect.", {signal:parent.signal});
    const rejection = assert.rejects(pending, error => error.code === "HARNESS_CANCELLED" && error.childSettled === true);
    await new Promise(resolve => setImmediate(resolve));
    parent.abort();
    assert.equal(request.options.signal.aborted, true);
    assert.equal(hasActiveCoordinateTasks(), true);
    record.status = "stopped";
    gate.resolve();
    await rejection;
    events.emit("subagents:completed", {id:"queued-child",status:"completed",result:"LATE PRIVATE"});
    assert.equal(hasActiveCoordinateTasks(), false);
    assert.equal(events.listenerCount("subagents:completed"), 0);
  } finally { child.resolve(); gate.resolve(); if(previous === undefined) delete globalThis[key]; else globalThis[key] = previous; }
});

test("cancellation during spawn ACK retains ownership and cleans the late RPC listener", async () => {
  const events = new EventBus(), child = deferred();
  const restoreManager = installManagerRecords(new Map([["cancel-ack",{status:"stopped",promise:child.promise}]]));
  const parent = new AbortController();
  let request;
  events.on("subagents:rpc:spawn", req => { request = req; req.options.onSpawned("cancel-ack"); });
  try {
    const pending = executeCoordinatorTurn({events}, "Inspect.", {signal:parent.signal,rpcTimeout:1000});
    const rejection = assert.rejects(pending, error => error.code === "HARNESS_CANCELLED" && error.childSettled === true);
    parent.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hasActiveCoordinateTasks(), true);
    child.resolve();
    await rejection;
    assert.equal(events.listenerCount(`subagents:rpc:spawn:reply:${request.requestId}`), 0);
    assert.equal(hasActiveCoordinateTasks(), false);
  } finally { child.resolve(); restoreManager(); }
});

test("pi-subagents real queued child cancels without starting while its sibling owns startup", async () => {
  const repo = makeRepo("pi-harness-queue-real-");
  const events = new EventBus(); events.mockSettlement = false;
  const manager = new AgentManager(() => {}, 1);
  const key = Symbol.for("pi-subagents:manager"), previous = globalThis[key];
  const previousIsolation = isWorktreeIsolationEnabled();
  globalThis[key] = manager;
  setWorktreeIsolationEnabled(true);
  const startup = deferred();
  const pi = {async exec(command, args, options) {
    if(args[0] === "worktree" && args[1] === "add") await startup.promise;
    const result = spawnSync(command, args, {cwd:options.cwd,encoding:"utf8",timeout:options.timeout});
    return {stdout:result.stdout??"",stderr:result.stderr??"",code:result.status??1,killed:false};
  }};
  const ctx = {cwd:repo,getSystemPrompt:()=>{throw Error("No provider request permitted in this test");}};
  const handlers = registerRpcHandlers({events,pi,getCtx:()=>ctx,manager});
  const siblingSignal = new AbortController(), queuedSignal = new AbortController();
  const siblingId = manager.spawn(pi,ctx,"worker","Inspect.",{cwd:repo,isBackground:true,isolation:"worktree",signal:siblingSignal.signal});
  try {
    const pending = executeCoordinatorTurn({events},"Inspect.",{cwd:repo,signal:queuedSignal.signal,rpcTimeout:1000});
    const rejection = assert.rejects(pending,error=>error.code === "HARNESS_CANCELLED" && error.childSettled === true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(manager.queue.length,1);
    const queued = manager.getRecord(manager.queue[0].id);
    assert.equal(queued.status,"queued");
    queuedSignal.abort();
    await rejection;
    assert.equal(queued.status,"stopped");
    assert.equal(queued.promise,undefined,"queued child never runs");
    assert.equal(siblingSignal.signal.aborted,false);
    assert.equal(manager.getRecord(siblingId).status,"running");
    assert.equal(hasActiveCoordinateTasks(),false);
  } finally {
    siblingSignal.abort(); startup.resolve();
    await manager.awaitStartup(siblingId).catch(()=>{});
    for(const unsubscribe of Object.values(handlers)) unsubscribe?.();
    await manager.dispose(); setWorktreeIsolationEnabled(previousIsolation);
    if(previous===undefined) delete globalThis[key]; else globalThis[key]=previous;
    rmSync(repo,{recursive:true,force:true});
  }
});

test("fake-clock terminal deadline aborts only at its exact boundary", async t => {
  const events = new EventBus(), child = deferred();
  const record = {status:"running",promise:child.promise};
  const restoreManager = installManagerRecords(new Map([["clock-child",record]]));
  let signal;
  events.on("subagents:rpc:spawn",req=>{
    signal=req.options.signal; req.options.onSpawned("clock-child");
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`,{success:true,data:{id:"clock-child"}});
    signal.addEventListener("abort",()=>{record.status="stopped";child.resolve();},{once:true});
  });
  t.mock.timers.enable({apis:["setTimeout"]});
  try {
    const pending=executeCoordinatorTurn({events},"Inspect.",{timeout:100,rpcTimeout:1000});
    const rejected=assert.rejects(pending,error=>error.code === "HARNESS_CHILD_TERMINAL_TIMEOUT");
    await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(99); assert.equal(signal.aborted,false);
    t.mock.timers.tick(1); assert.equal(signal.aborted,true);
    await rejected; assert.equal(hasActiveCoordinateTasks(),false);
  } finally {t.mock.timers.reset();child.resolve();restoreManager();}
});

test("trusted verification inherits host env and follows worktree symlinks", async () => {
  const external = mkdtempSync(join(tmpdir(), "pi-harness-gate-host-"));
  const repo = makeRepo("pi-harness-gate-symlink-");
  const envName = `PI_HARNESS_GATE_SENTINEL_${process.pid}`;
  const previous = process.env[envName];
  try {
    const hostFile = join(external, "host-file.txt");
    const commandBin = join(external, "node_modules", ".bin");
    const outsideCommand = join(commandBin, "outside-command");
    writeFileSync(hostFile, "host-file-readable-through-symlink\n");
    mkdirSync(commandBin, { recursive: true });
    writeFileSync(outsideCommand, "#!/bin/sh\nprintf 'outside-command-ran\\n'\n");
    chmodSync(outsideCommand, 0o755);
    symlinkSync(hostFile, join(repo, "host-file"));
    symlinkSync(join(external, "node_modules"), join(repo, "node_modules"), "dir");
    process.env[envName] = "host-environment-visible";

    const result = await runWorkerVerification(repo, {
      verification: `printf '%s\\n' "$${envName}"; cat host-file; outside-command`,
    }, { projectRoot: process.cwd() });

    assert.equal(result.gatePassed, true);
    assert.match(result.gateEvidence, /host-environment-visible/);
    assert.match(result.gateEvidence, /host-file-readable-through-symlink/);
    assert.match(result.gateEvidence, /outside-command-ran/);
    assert.equal(existsSync(join(repo, "node_modules")), true, "the gate preserves a pre-existing worktree dependency symlink");
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    rmSync(repo, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("worker gate removes the project dependency symlink that it creates", async () => {
  const repo = makeRepo("pi-harness-gate-dependency-link-");
  try {
    assert.equal(existsSync(join(process.cwd(), "node_modules")), true);
    const result = await runWorkerVerification(repo, {
      verification: `node -e 'const fs = require("node:fs"); if (!fs.lstatSync("node_modules").isSymbolicLink()) process.exit(12);'`,
    }, { projectRoot: process.cwd() });
    assert.equal(result.gatePassed, true);
    assert.equal(existsSync(join(repo, "node_modules")), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("worker gate kills same-group descendants after the verification shell exits", async () => {
  const repo = makeRepo("pi-harness-gate-early-exit-");
  try {
    const result = await runWorkerVerification(repo, {
      verification: `node -e 'const fs = require("node:fs"); const { spawn } = require("node:child_process"); const child = spawn("sleep", ["30"], { stdio: "ignore" }); child.unref(); fs.writeFileSync("descendant.pid", String(child.pid));'`,
    }, { projectRoot: repo });
    assert.equal(result.gatePassed, true);
    const pid = Number(readFileSync(join(repo, "descendant.pid"), "utf8"));
    assert.ok(pid > 0);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { assert.equal(error.code, "ESRCH"); }
    if (alive) assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /\) Z /);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("verification timeout and parent cancellation terminate shell descendants with bounded output", async () => {
  const repo=makeRepo("pi-harness-gate-cancel-");
  try {
    const timed=await runWorkerVerification(repo,{verification:"sleep 30 & echo $!; wait"},{timeout:40,projectRoot:repo});
    assert.equal(timed.gatePassed,false); assert.equal(timed.failure_code,"HARNESS_GATE_TIMEOUT");
    const pid=Number(timed.gateEvidence.trim());
    assert.ok(pid>0);
    let alive; try { process.kill(pid,0); alive=true; } catch {alive=false;}
    // A killed descendant can briefly remain a zombie until its parent reaps it.
    if(alive) assert.match(readFileSync(`/proc/${pid}/stat`,"utf8"),/\) Z /);
    const controller=new AbortController();
    const pending=runWorkerVerification(repo,{verification:"sleep 30"},{timeout:1000,projectRoot:repo,signal:controller.signal});
    controller.abort();
    const cancelled=await pending;
    assert.equal(cancelled.failure_code,"HARNESS_CANCELLED"); assert.equal(cancelled.gatePassed,false);
    const large=await runWorkerVerification(repo,{verification:`node -e 'process.stdout.write("x".repeat(100000))'`},{projectRoot:repo});
    assert.equal(large.gatePassed,true); assert.equal(large.gateEvidenceTruncated,true);
    assert.ok(Buffer.byteLength(large.gateEvidence)<=8000);
    await assert.rejects(runWorkerVerification(repo,{verification:"true"},{timeout:Infinity}));
  } finally {rmSync(repo,{recursive:true,force:true});}
});

test("fake-clock Reviewer retains its 120s default when execution budget is 300s",async t=>{
  const events=new EventBus(), reviewer=deferred(), records=new Map();
  const restoreManager=installManagerRecords(records);
  let reviewerSignal;
  events.on("subagents:rpc:spawn",req=>{
    const id=req.type;
    records.set(id,{promise:req.type === "research" ? Promise.resolve() : reviewer.promise});
    req.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${req.requestId}`,{success:true,data:{id}});
    if(req.type === "research") queueMicrotask(()=>events.emit("subagents:completed",{id,status:"completed",result:"Selected report."}));
    else {reviewerSignal=req.options.signal;reviewerSignal.addEventListener("abort",reviewer.resolve,{once:true});}
  });
  t.mock.timers.enable({apis:["setTimeout"]});
  try {
    const pending=executeCoordinateTask({events},{owner:"research",scope:"Inspect.",verification:"Inspect report.",permission:"read",acceptance_criteria:["The report is sufficient."]},{timeout:300000});
    while(!reviewerSignal) await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(119999);assert.equal(reviewerSignal.aborted,false);
    t.mock.timers.tick(1);assert.equal(reviewerSignal.aborted,true);
    assert.equal((await pending).taskResult.verification_status,"blocked");
    assert.equal(hasActiveCoordinateTasks(),false);
  } finally {t.mock.timers.reset();reviewer.resolve();restoreManager();}
});


test("executeCoordinateTask records each spawned child against the current Attempt", async () => {
  const repo = makeRepo("pi-child-correlation-");
  const events = new EventBus();
  events.mockSettlement = false;
  const records = new Map(), references = [], callbackErrors = [];
  const restoreManager = installManagerRecords(records);
  let sequence = 0;
  events.on("subagents:rpc:spawn", (request) => {
    const id = `managed-${++sequence}`;
    const child = deferred();
    records.set(id, { status: "running", promise: child.promise, result: "PRIVATE", error: "/tmp/private" });
    request.options.onSpawned(id);
    request.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
    queueMicrotask(() => {
      try {
        assert.deepEqual(references.at(-1), { child_id: id, role: request.type }, "spawn acknowledgement records ownership before settlement");
        assert.deepEqual(coordinatorApi.inspectCoordinateChild(id), { state: "active" });
      } catch (error) { callbackErrors.push(error); }
      const packet = request.type.endsWith("reviewer") ? JSON.parse(request.prompt.slice(request.prompt.indexOf('{"version"'))) : undefined;
      const result = packet ? JSON.stringify({ version: 1, task_id: packet.task_id, status: "verified", summary: "The criterion passed.", criteria: packet.acceptance_criteria.map((criterion) => ({ criterion, status: "passed", finding: "The report supports the criterion.", evidence_refs: [packet.evidence[0].reference] })) }) : "A selected report.";
      records.get(id).status = "completed";
      child.resolve();
      events.emit("subagents:completed", { id, status: "completed", result });
    });
  });
  try {
    await executeCoordinateTask({ events }, { owner: "worker", permission: "write", scope: "Edit file.txt", verification: "true" }, { cwd: repo, onChildStarted: (ref) => references.push(ref) });
    await executeCoordinateTask({ events }, { task_id: "T-review", owner: "research", permission: "read", scope: "Inspect file.txt", verification: "Inspect report.", acceptance_criteria: ["The report is clear.", "The report is safe."], review_profile: { "The report is safe.": "security" } }, { cwd: repo, onChildStarted: (ref) => references.push(ref), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-daybreak-blue-latest" }] } });
    if (callbackErrors.length) throw callbackErrors[0];
    assert.deepEqual(references, [{ child_id: "managed-1", role: "worker" }, { child_id: "managed-2", role: "research" }, { child_id: "managed-3", role: "reviewer" }, { child_id: "managed-4", role: "security-reviewer" }]);
    assert.deepEqual(coordinatorApi.inspectCoordinateChild("managed-1"), { state: "terminal", child_status: "completed", child_disposition: { branch_status: "unknown", worktree_status: "unknown" } });
    records.get("managed-1").child_disposition = { branch_status: "preserved", branch: "pi-agent-selected", worktree_status: "unknown" };
    assert.deepEqual(coordinatorApi.inspectCoordinateChild("managed-1").child_disposition, records.get("managed-1").child_disposition);
    records.get("managed-1").child_disposition.path = "/tmp/private";
    assert.deepEqual(coordinatorApi.inspectCoordinateChild("managed-1"), { state: "terminal", child_status: "completed", child_disposition: { branch_status: "unknown", worktree_status: "unknown" } });
    assert.deepEqual(coordinatorApi.inspectCoordinateChild("missing"), { state: "unavailable" });
  } finally { restoreManager(); rmSync(repo, { recursive: true, force: true }); }
});
