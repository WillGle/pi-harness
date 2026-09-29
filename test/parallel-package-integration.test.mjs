import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, cleanupWorktree } from "../node_modules/@tintinweb/pi-subagents/dist/worktree.js";
import { loadSettings, applySettings } from "../node_modules/@tintinweb/pi-subagents/dist/settings.js";
import { AgentManager } from "../node_modules/@tintinweb/pi-subagents/dist/agent-manager.js";
import { executeCoordinateTask } from "../lib/coordinator.mjs";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", args, { cwd });

test("pi-subagents post-abort cleanup preserves partial work on an unintegrated branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-h-abort-worktree-"));
  const pi = { exec: async (_command, args, options) => {
    try { const { stdout, stderr } = await exec("git", args, { cwd: options.cwd }); return { stdout, stderr, code: 0, killed: false }; }
    catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1, killed: false }; }
  } };
  let worktree;
  try {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pi test");
    await git(cwd, "config", "user.email", "pi@example.invalid");
    writeFileSync(join(cwd, "partial.txt"), "base\n");
    await git(cwd, "add", "partial.txt");
    await git(cwd, "commit", "-qm", "base");
    worktree = await createWorktree(pi, cwd, "abort-disposition");
    assert.ok(worktree);
    // AgentManager calls this cleanup after an aborted run. Keep the partial diff as its input.
    writeFileSync(join(worktree.path, "partial.txt"), "partial work before abort\n");
    const disposition = await cleanupWorktree(pi, cwd, worktree, "aborted Worker");
    assert.equal(disposition.hasChanges, true);
    assert.equal(disposition.branch, "pi-agent-abort-disposition");
    assert.equal(readFileSync(join(cwd, "partial.txt"), "utf8"), "base\n", "pi-subagents must not integrate the branch");
    assert.equal((await git(cwd, "show", `${disposition.branch}:partial.txt`)).stdout.trim(), "partial work before abort");
    assert.equal(existsSync(worktree.path), false, "pi-subagents removes the completed worktree");
  } finally {
    if (worktree?.path && existsSync(worktree.path)) await git(cwd, "worktree", "remove", "--force", worktree.path).catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installed pi-subagents applies project capacity and isolates two concurrent Worker worktrees", async () => {
  const settings = loadSettings(process.cwd());
  const manager = new AgentManager(() => {}, 1);
  let fleetView = true;
  applySettings(settings, { setMaxConcurrent: (n) => manager.setMaxConcurrent(n), setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n), setFleetView: (enabled) => { fleetView = enabled; }, setWorktreeIsolation: () => {} });
  assert.equal(manager.getMaxConcurrent(), 4);
  assert.equal(manager.getMaxConcurrentForeground(), 1);
  assert.equal(fleetView, false);
  const cwd = mkdtempSync(join(tmpdir(), "pi-h-worktrees-"));
  const pi = { exec: async (_command, args, options) => {
    try { const { stdout, stderr } = await exec("git", args, { cwd: options.cwd }); return { stdout, stderr, code: 0, killed: false }; }
    catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1, killed: false }; }
  } };
  let worktrees = [];
  try {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pi test");
    await git(cwd, "config", "user.email", "pi@example.invalid");
    writeFileSync(join(cwd, "shared.txt"), "base\n");
    await git(cwd, "add", "shared.txt");
    await git(cwd, "commit", "-qm", "base");
    worktrees = await Promise.all([createWorktree(pi, cwd, "worker-A"), createWorktree(pi, cwd, "worker-B")]);
    assert.ok(worktrees.every(Boolean));
    assert.notEqual(worktrees[0].path, worktrees[1].path);
    assert.ok(worktrees.every((wt) => wt.path !== cwd));
    writeFileSync(join(worktrees[0].path, "shared.txt"), "A\n");
    writeFileSync(join(worktrees[1].path, "shared.txt"), "B\n");
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "base\n");
    const branches = await Promise.all(worktrees.map((wt, index) => cleanupWorktree(pi, cwd, wt, `worker-${index}`)));
    assert.notEqual(branches[0].branch, branches[1].branch);
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "base\n", "the package must not integrate branches");
  } finally {
    for (const wt of worktrees) if (wt?.path) await git(cwd, "worktree", "remove", "--force", wt.path).catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
    manager.dispose();
  }
});

test("package cleanup failure keeps the timed-out Worker's worktree disposition unknown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-h-cleanup-failure-"));
  const makePi = (injectCleanupFailure = false) => ({ exec: async (_command, args, options) => {
    if (injectCleanupFailure && args[0] === "worktree" && ["remove", "prune"].includes(args[1])) return { stdout: "", stderr: "injected cleanup failure", code: 1, killed: false };
    try { const { stdout, stderr } = await exec("git", args, { cwd: options.cwd }); return { stdout, stderr, code: 0, killed: false }; }
    catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1, killed: false }; }
  } });
  const cleanPi = makePi();
  let worktree;
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = globalThis[managerKey];
  try {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pi test");
    await git(cwd, "config", "user.email", "pi@example.invalid");
    writeFileSync(join(cwd, "base.txt"), "base\n");
    await git(cwd, "add", "base.txt");
    await git(cwd, "commit", "-qm", "base");
    worktree = await createWorktree(cleanPi, cwd, "cleanup-failure");
    assert.ok(worktree);

    const worktreeResult = await cleanupWorktree(makePi(true), cwd, worktree, "unchanged Worker");
    assert.deepEqual(worktreeResult, { hasChanges: false });
    assert.equal(existsSync(worktree.path), true, "the injected package cleanup failure leaves the physical worktree present");

    const records = new Map();
    const id = "package-cleanup-failure-child";
    records.set(id, { status: "stopped", promise: Promise.resolve(), worktree, worktreeResult });
    globalThis[managerKey] = { getRecord: (agentId) => records.get(agentId) };
    const listeners = new Map();
    const events = {
      on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
      emit(name, payload) {
        if (name === "subagents:rpc:spawn") {
          payload.options.onSpawned(id);
          this.emit(`${name}:reply:${payload.requestId}`, { success: true, data: { id } });
        }
        for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
      },
    };
    await assert.rejects(executeCoordinateTask({ events }, {
      owner: "worker", task_id: "T-CLEANUP-FAILURE", operation_id: "O-CLEANUP-FAILURE",
      scope: "Run a bounded Worker task.", permission: "write", verification: "true",
    }, { cwd, timeout: 30, rpcTimeout: 1000 }), (error) => {
      assert.equal(error.code, "HARNESS_CHILD_TERMINAL_TIMEOUT");
      assert.deepEqual(error.child_disposition, { branch_status: "not_reported", worktree_status: "unknown" });
      assert.equal(Object.hasOwn(error, "taskResult"), false);
      return true;
    });
  } finally {
    if (previousManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = previousManager;
    if (worktree?.path && existsSync(worktree.path)) await cleanupWorktree(cleanPi, cwd, worktree, "test cleanup").catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});
