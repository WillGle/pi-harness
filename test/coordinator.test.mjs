import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireConcurrencySlot,
  executeWorkerTask,
  getActiveConcurrency,
  getProviderLimit,
  isLocalProvider,
  releaseConcurrencySlot,
  runWorkerChild,
  setProviderLimit,
  startChild,
  validateTask,
  validCommitMessage,
  workerWorktree,
} from "../lib/coordinator.mjs";

test("coordinator requires a bounded task", () => {
  assert.throws(() => validateTask({ owner: "worker" }));
  assert.throws(() => validateTask({ owner: "research", scope: "src", verification: "rg x", permission: "write" }));
  assert.equal(validateTask({ owner: "scout", scope: "src", verification: "rg x", permission: "read" }).owner, "scout");
  assert.equal(validCommitMessage("Fix gate", "Scope: test\nReason: verify"), true);
});

test("concurrency limiter enforces provider limits (remote=4, local=1) and slot release", () => {
  // Remote provider defaults to 4
  assert.equal(isLocalProvider("anthropic"), false);
  assert.equal(getProviderLimit("anthropic"), 4);
  assert.equal(getProviderLimit("openai"), 4);
  assert.equal(getProviderLimit("default"), 4);

  // Local provider defaults to 1
  assert.equal(isLocalProvider("local"), true);
  assert.equal(isLocalProvider("ollama"), true);
  assert.equal(isLocalProvider("llama-server"), true);
  assert.equal(getProviderLimit("local"), 1);
  assert.equal(getProviderLimit("ollama"), 1);

  // Custom configuration override
  setProviderLimit("custom-prov", 2);
  assert.equal(getProviderLimit("custom-prov"), 2);
  assert.equal(getActiveConcurrency("custom-prov"), 0);

  acquireConcurrencySlot("custom-prov");
  assert.equal(getActiveConcurrency("custom-prov"), 1);

  acquireConcurrencySlot("custom-prov");
  assert.equal(getActiveConcurrency("custom-prov"), 2);

  // Exceed limit
  assert.throws(() => acquireConcurrencySlot("custom-prov"), /Concurrency limit reached/);

  releaseConcurrencySlot("custom-prov");
  assert.equal(getActiveConcurrency("custom-prov"), 1);

  releaseConcurrencySlot("custom-prov");
  assert.equal(getActiveConcurrency("custom-prov"), 0);
});

test("startChild uses ls instead of list for Pi scout/research tools", () => {
  const task = { owner: "scout", scope: "src", verification: "echo ok", permission: "read" };
  const mockPi = "echo";
  const child = startChild(task, {
    pi: mockPi,
  });
  assert.ok(child.spawnargs.includes("--tools"));
  const toolIdx = child.spawnargs.indexOf("--tools");
  const toolList = child.spawnargs[toolIdx + 1];
  assert.ok(toolList.includes("ls"), "Pi tools list must include ls");
  assert.equal(toolList.includes("list"), false, "Pi tools list must not use non-existent tool 'list'");
  child.kill();
});

test("executeWorkerTask runs gate, validates atomic commit, returns diff evidence, and does not auto-integrate", () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-harness-worker-repo-"));
  spawnSync("git", ["-C", repo, "init", "-q"]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "file.txt"), "initial\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "Initial commit"]);

  const headBefore = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const task = {
    owner: "worker",
    scope: "file.txt",
    verification: "grep 'updated' file.txt",
    permission: "write",
  };

  const result = executeWorkerTask(repo, task, (worktreePath) => {
    writeFileSync(join(worktreePath, "file.txt"), "updated\n");
    spawnSync("git", ["-C", worktreePath, "add", "file.txt"]);
    spawnSync("git", [
      "-C",
      worktreePath,
      "commit",
      "-m",
      "Update file content\n\nScope: file.txt\nReason: verify coordinator gate",
    ]);
  });

  // Verify gate passed and evidence captured
  assert.equal(result.success, true);
  assert.equal(result.gatePassed, true);
  assert.match(result.gateEvidence, /updated/);

  // Verify atomic commit message
  assert.equal(result.commitCheck.valid, true);
  assert.equal(result.commitCheck.subject, "Update file content");

  // Verify diff captured
  assert.ok(result.diff.includes("+updated"));

  // Verify no auto integration: main repo HEAD unchanged
  const headAfter = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headBefore, headAfter, "Target repo HEAD must not change; auto integration is strictly forbidden");
  assert.equal(result.integrated, false);

  // Cleanup
  result.cleanup();
  assert.equal(
    spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout.includes(
      result.worktreePath
    ),
    false
  );
});

test("executeWorkerTask supports async worker function", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-harness-worker-repo-async-"));
  spawnSync("git", ["-C", repo, "init", "-q"]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "file.txt"), "initial\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "Initial commit"]);

  const task = {
    owner: "worker",
    scope: "file.txt",
    verification: "grep 'async-update' file.txt",
    permission: "write",
  };

  const result = await executeWorkerTask(repo, task, async (worktreePath) => {
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(worktreePath, "file.txt"), "async-update\n");
    spawnSync("git", ["-C", worktreePath, "add", "file.txt"]);
    spawnSync("git", [
      "-C",
      worktreePath,
      "commit",
      "-m",
      "Async worker change\n\nScope: file.txt\nReason: verify async coordinator support",
    ]);
  });

  assert.equal(result.success, true);
  assert.equal(result.gatePassed, true);
  assert.match(result.gateEvidence, /async-update/);
  result.cleanup();
});

test("runWorkerChild sends prompt via RPC and terminates child cleanly without hanging", async () => {
  const mockScript = mkdtempSync(join(tmpdir(), "pi-mock-worker-"));
  const mockBin = join(mockScript, "mock-pi.mjs");
  writeFileSync(
    mockBin,
    `#!/usr/bin/env node
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === "prompt") {
      writeFileSync("worker-output.txt", "worker executed\\n");
      spawnSync("git", ["add", "."]);
      spawnSync("git", ["commit", "-m", "Worker commit\\n\\nScope: mock\\nReason: test runWorkerChild"]);
      console.log(JSON.stringify({ id: msg.id, type: "response", success: true }));
    }
  } catch {}
});
`
  );
  spawnSync("chmod", ["+x", mockBin]);

  const repo = mkdtempSync(join(tmpdir(), "pi-harness-worker-run-"));
  spawnSync("git", ["-C", repo, "init", "-q"]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "initial.txt"), "init\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "Initial commit"]);

  const task = {
    owner: "worker",
    scope: "mock",
    verification: "grep 'worker executed' worker-output.txt",
    permission: "write",
  };

  const result = await executeWorkerTask(repo, task, undefined, {
    pi: mockBin,
    timeout: 5000,
  });

  assert.equal(result.success, true);
  assert.equal(result.gatePassed, true);
  assert.match(result.gateEvidence, /worker executed/);
  assert.equal(result.commitCheck.valid, true);
  assert.equal(result.commitCheck.subject, "Worker commit");
  assert.equal(result.integrated, false);

  result.cleanup();
});
