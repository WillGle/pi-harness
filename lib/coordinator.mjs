import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const children = new Set();
const providerLimits = new Map();
const activePerProvider = new Map();

export function isLocalProvider(provider = "") {
  const p = String(provider).toLowerCase();
  return p === "local" || p.startsWith("local/") || p.includes("ollama") || p.includes("llama") || p.includes("vllm");
}

export function getDefaultProviderLimit(provider = "default") {
  return isLocalProvider(provider) ? 1 : 4;
}

export function setProviderLimit(provider, limit) {
  providerLimits.set(provider, Math.max(1, Number(limit) || getDefaultProviderLimit(provider)));
}

export function getProviderLimit(provider = "default") {
  return providerLimits.get(provider) ?? getDefaultProviderLimit(provider);
}

export function acquireConcurrencySlot(provider = "default") {
  const current = activePerProvider.get(provider) ?? 0;
  const limit = getProviderLimit(provider);
  if (current >= limit) {
    throw new Error(`Concurrency limit reached for provider '${provider}' (${current}/${limit})`);
  }
  activePerProvider.set(provider, current + 1);
}

export function releaseConcurrencySlot(provider = "default") {
  const current = activePerProvider.get(provider) ?? 0;
  if (current > 0) {
    activePerProvider.set(provider, current - 1);
  }
}

export function getActiveConcurrency(provider = "default") {
  return activePerProvider.get(provider) ?? 0;
}

export function validateTask(task) {
  for (const key of ["owner", "scope", "verification", "permission"]) if (!task?.[key]?.trim?.()) throw new Error(`Task requires ${key}`);
  if (!["scout", "research", "worker"].includes(task.owner)) throw new Error("Unknown task owner");
  if (!["read", "write"].includes(task.permission)) throw new Error("Task permission must be read or write");
  if (task.owner !== "worker" && task.permission !== "read") throw new Error(`${task.owner} tasks are read-only`);
  return task;
}

export function startChild(task, options = {}) {
  validateTask(task);
  const provider = options.provider ?? "default";
  acquireConcurrencySlot(provider);

  const args = ["--mode", "rpc", "--no-session"];
  if (task.owner !== "worker") args.push("--tools", "read,ls,find,grep,bash");
  const child = spawn(options.pi ?? "pi", args, { stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd });
  children.add(child);

  child.once("exit", () => {
    children.delete(child);
    releaseConcurrencySlot(provider);
  });
  return child;
}

export function terminateChildren() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child already exited
    }
  }
  children.clear();
}

export function runWorkerChild(task, options = {}) {
  const child = startChild(task, options);
  const promptMessage =
    task.prompt ||
    `Worker task:\nScope: ${task.scope}\nVerification: ${task.verification}\nImplement changes within scope, verify with ${task.verification}, and commit atomically.`;
  const promptId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        child.stdin.end();
      } catch {}
      setTimeout(() => {
        try {
          if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
        } catch {}
      }, 1000);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if ((msg.id === promptId && msg.type === "response") || msg.type === "agent_settled") {
            finish();
          }
        } catch {}
      }
    });

    child.once("exit", (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });

    child.once("error", (err) => {
      settled = true;
      reject(err);
    });

    try {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ id: promptId, type: "prompt", message: promptMessage })}\n`);
      } else {
        finish();
      }
    } catch (err) {
      finish();
      reject(err);
    }

    const timeoutMs = options.timeout ?? 60_000;
    const timer = setTimeout(() => {
      if (!settled) {
        finish();
      }
    }, timeoutMs);
    child.once("exit", () => clearTimeout(timer));
  });
}

export function workerWorktree(repo, branch) {
  const targetBranch = branch ?? `pi-worker-${Date.now()}`;
  const worktreePath = mkdtempSync(join(tmpdir(), "pi-worker-worktree-"));
  const add = spawnSync("git", ["-C", repo, "worktree", "add", "-b", targetBranch, worktreePath, "HEAD"], {
    encoding: "utf8",
  });
  if (add.status !== 0) throw new Error(`Failed to create worker worktree: ${add.stderr}`);

  // Symlink node_modules if present in parent repo to support gate tests
  const parentNodeModules = join(repo, "node_modules");
  const worktreeNodeModules = join(worktreePath, "node_modules");
  try {
    spawnSync("ln", ["-s", parentNodeModules, worktreeNodeModules]);
  } catch {}

  return {
    path: worktreePath,
    branch: targetBranch,
    cleanup() {
      try {
        spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktreePath]);
      } catch {}
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function validCommitMessage(subject, body) {
  if (!subject?.trim() || !body?.trim()) return false;
  return /Scope:\s*.+/.test(body) && /Reason:\s*.+/.test(body);
}

export function verifyLastCommit(cwd) {
  const log = spawnSync("git", ["-C", cwd, "log", "-1", "--pretty=%B"], { encoding: "utf8" });
  if (log.status !== 0) return { valid: false, error: "Failed to read commit message" };
  const lines = log.stdout.trim().split("\n");
  const subject = lines[0];
  const body = lines.slice(1).join("\n").trim();
  const valid = validCommitMessage(subject, body);
  return { valid, subject, body };
}

function postWorkerGate(worktree, task, options) {
  // 1. Run gate verification command in worker worktree
  const worktreeBin = join(worktree.path, "node_modules", ".bin");
  const gateRun = spawnSync("sh", ["-c", task.verification], {
    cwd: worktree.path,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${worktreeBin}:${process.env.PATH}`,
    },
    timeout: options.timeout ?? 60_000,
  });
  const gatePassed = gateRun.status === 0;
  const gateEvidence = `${gateRun.stdout ?? ""}\n${gateRun.stderr ?? ""}`.trim();

  // 2. Validate commit message format
  const commitCheck = verifyLastCommit(worktree.path);

  // 3. Extract diff evidence
  const diffRun = spawnSync("git", ["-C", worktree.path, "diff", "HEAD~1...HEAD"], { encoding: "utf8" });
  const diff = diffRun.stdout || spawnSync("git", ["-C", worktree.path, "diff", "HEAD"], { encoding: "utf8" }).stdout;

  // 4. Do not auto-integrate: branch is preserved for user confirmation
  return {
    success: gatePassed && commitCheck.valid,
    gatePassed,
    gateEvidence,
    commitCheck,
    diff,
    branch: worktree.branch,
    worktreePath: worktree.path,
    integrated: false,
    integration: "requires explicit user confirmation; worker never auto-integrates",
    cleanup: worktree.cleanup,
  };
}

export function executeWorkerTask(repo, task, workerFn, options = {}) {
  validateTask(task);
  if (task.owner !== "worker") throw new Error("executeWorkerTask requires worker owner");
  const provider = options.provider ?? "default";
  acquireConcurrencySlot(provider);

  const worktree = workerWorktree(repo, options.branch);
  let isAsync = false;
  try {
    const fn = workerFn ?? ((worktreePath) => runWorkerChild(task, { ...options, cwd: worktreePath }));
    const res = fn(worktree.path);
    if (res && typeof res.then === "function") {
      isAsync = true;
      return res
        .then(() => postWorkerGate(worktree, task, options))
        .finally(() => {
          releaseConcurrencySlot(provider);
        });
    }
    return postWorkerGate(worktree, task, options);
  } finally {
    if (!isAsync) {
      releaseConcurrencySlot(provider);
    }
  }
}
