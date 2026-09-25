import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, cleanupWorktree } from "../node_modules/@tintinweb/pi-subagents/dist/worktree.js";
import { loadSettings, applySettings } from "../node_modules/@tintinweb/pi-subagents/dist/settings.js";
import { AgentManager } from "../node_modules/@tintinweb/pi-subagents/dist/agent-manager.js";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", args, { cwd });

test("installed pi-subagents applies project capacity and isolates two concurrent Worker worktrees", async () => {
  const settings = loadSettings(process.cwd());
  const manager = new AgentManager(() => {}, 1);
  applySettings(settings, { setMaxConcurrent: (n) => manager.setMaxConcurrent(n), setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n), setWorktreeIsolation: () => {} });
  assert.equal(manager.getMaxConcurrent(), 4);
  assert.equal(manager.getMaxConcurrentForeground(), 1);
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
