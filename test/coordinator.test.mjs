import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readEvidence } from "../lib/evidence.mjs";
import { promoteTaskResult } from "../lib/communication.mjs";
import {
  cancelCoordinateTasks,
  executeCoordinateTask,
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

  emit(name, payload) {
    for (const handler of [...(this.#handlers.get(name) ?? [])]) handler(payload);
  }
}

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
        if (mode === "worker" || mode === "worker-reviewed") {
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
            "Worker update\n\nScope: file.txt\nReason: package smoke",
          ]);
          await request.options.onBeforeWorktreeCleanup(worktree);
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

test("public task validation keeps scout and research read-only", () => {
  assert.throws(() => validateTask({ owner: "worker" }));
  assert.throws(() => validateTask({ owner: "research", scope: "src", verification: "rg x", permission: "write" }));
  assert.equal(validateTask({ owner: "scout", scope: "src", verification: "rg x", permission: "read" }).owner, "scout");
  assert.deepEqual(JSON.parse(readFileSync(".pi/subagents.json", "utf8")), {
    maxConcurrent: 1,
    maxConcurrentForeground: 1,
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
      scope: "file.txt",
      verification: "grep 'worker-update' file.txt",
      permission: "write",
      acceptance_criteria: ["The Worker verification command passes."],
    }, { cwd: repo, rpcTimeout: 1000, timeout: 1000 });

    const request = fakePackage.calls.find((entry) => entry?.type === "worker");
    assert.equal(request.options.isBackground, true);
    assert.equal(request.options.isolation, "worktree");
    assert.match(request.options.description, /Scope: file\.txt/);
    assert.match(request.options.description, /Reason: grep 'worker-update' file\.txt/);
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
  const result = await pending;
  assert.equal(request.options.signal.aborted, true);
  assert.equal(result.success, false);
  assert.equal(result.status, "stopped");
  assert.equal(result.taskResult.execution_status, "blocked");
  assert.match(result.taskResult.blocker, /cannot continue until/);
  assert.equal(result.taskResult.verification_status, "blocked");
  assert.deepEqual(result.taskResult.evidence_refs, []);
});
