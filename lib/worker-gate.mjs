import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export const MAX_GATE_EVIDENCE_BYTES = 8_000;
export const MAX_DIFF_BYTES = 20_000;
export const MAX_RESULT_BYTES = 8_000;
export const WORKER_GATE_TIMEOUT_MS = 60_000;

export function truncateText(value, maxBytes) {
  const text = String(value ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  let clipped = text;
  while (Buffer.byteLength(clipped, "utf8") > maxBytes) clipped = clipped.slice(0, -1);
  return { text: `${clipped}\n...[truncated after ${maxBytes} bytes]`, bytes, truncated: true };
}

export function validCommitMessage(subject, body) {
  if (!subject?.trim() || !body?.trim()) return false;
  return /Scope:\s*.+/.test(body) && /Reason:\s*.+/.test(body);
}

function gitShowMessage(cwd, ref) {
  const result = spawnSync("git", ["-C", cwd, "show", "-s", "--format=%B", ref], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  if (result.status !== 0) return { valid: false, error: "Failed to read worker commit message" };
  const lines = result.stdout.trim().split("\n");
  const subject = lines[0];
  const body = lines.slice(1).join("\n").trim();
  return { valid: validCommitMessage(subject, body), subject, body };
}

function ensureWorktreeDependencies(worktreePath, projectRoot) {
  const target = join(worktreePath, "node_modules");
  const source = join(projectRoot, "node_modules");
  if (existsSync(target) || !existsSync(source)) return undefined;
  try {
    symlinkSync(source, target, "junction");
    return target;
  } catch {
    // Verification still runs; a simple command such as grep needs no link.
    return undefined;
  }
}

export async function runWorkerVerification(worktreePath, task, options = {}) {
  const timeout = options.timeout ?? WORKER_GATE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > WORKER_GATE_TIMEOUT_MS) throw new Error("Worker verification must use a positive timeout within the Harness maximum");
  const projectRoot = options.projectRoot ?? process.cwd();
  const dependencyLink = ensureWorktreeDependencies(worktreePath, projectRoot);
  const worktreeBin = join(worktreePath, "node_modules", ".bin");
  const parentBin = join(projectRoot, "node_modules", ".bin");
  try {
    return await new Promise(resolve => {
      let child, timer, killTimer, drainTimer, done = false, stopped = false, failureCode;
      let output = Buffer.alloc(0), truncated = false;
      const grouped = process.platform !== "win32";
      const kill = signal => {
        if (!child?.pid) return;
        try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
      };
      const finish = code => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(drainTimer);
        options.signal?.removeEventListener("abort", abort);
        // Kill same-group descendants even if the shell returned early.
        kill("SIGKILL");
        resolve({ worktreePath, gatePassed: code === 0 && !stopped,
          gateEvidence: output.toString("utf8"), gateEvidenceTruncated: truncated,
          ...(failureCode ? { failure_code: failureCode } : {}) });
      };
      const stop = code => {
        if (done || stopped) return;
        stopped = true; failureCode = code;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 100);
        drainTimer = setTimeout(() => { kill("SIGKILL"); child?.stdout?.destroy(); child?.stderr?.destroy(); finish(null); }, 1500);
      };
      const abort = () => stop("HARNESS_CANCELLED");
      const capture = chunk => {
        const available = MAX_GATE_EVIDENCE_BYTES - output.length;
        if (chunk.length > available) truncated = true;
        if (available > 0) output = Buffer.concat([output, chunk.subarray(0, available)]);
      };
      if (options.signal?.aborted) { failureCode = "HARNESS_CANCELLED"; stopped = true; return finish(null); }
      try {
        child = spawn("sh", ["-c", task.verification], { cwd: worktreePath, detached: grouped,
          stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${worktreeBin}:${parentBin}:${process.env.PATH ?? ""}` } });
      } catch { failureCode = "HARNESS_VERIFIER_FAILED"; return finish(null); }
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", () => { failureCode = "HARNESS_VERIFIER_FAILED"; finish(null); });
      child.once("close", finish);
      timer = setTimeout(() => stop("HARNESS_GATE_TIMEOUT"), timeout);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  } finally {
    if (dependencyLink) { try { unlinkSync(dependencyLink); } catch { /* package cleanup must not commit the temporary link */ } }
  }
}

function branchFromResult(result) {
  const match = String(result ?? "").match(/Changes saved to branch `([^`]+)`/);
  return match?.[1];
}

function commitCount(cwd, baseSha, branch) {
  if (!branch || !baseSha) return 0;
  const result = spawnSync("git", ["-C", cwd, "rev-list", "--count", `${baseSha}..${branch}`], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  return result.status === 0 ? Number(result.stdout.trim()) || 0 : 0;
}

function changedPaths(cwd, baseSha, branch) {
  if (!branch || !baseSha) return [];
  const result = spawnSync("git", ["-C", cwd, "diff", "--name-only", "-z", `${baseSha}...${branch}`], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  return result.status === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

function boundedDiff(cwd, baseSha, branch) {
  if (!branch || !baseSha) return { text: "", bytes: 0, truncated: false };
  const result = spawnSync("git", ["-C", cwd, "diff", `${baseSha}...${branch}`], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  return truncateText(result.stdout ?? "", MAX_DIFF_BYTES);
}

export function normalizeWorkerResult({ repo, task, baseSha, event, record, verification }) {
  const branch = record?.worktreeResult?.branch ?? branchFromResult(event?.result);
  const commitCheck = branch
    ? gitShowMessage(repo, branch)
    : { valid: false, error: "Worker produced no package-managed branch" };
  const commitCountValue = commitCount(repo, baseSha, branch);
  const diff = boundedDiff(repo, baseSha, branch);
  const agentResult = truncateText(event?.result ?? "", MAX_RESULT_BYTES);
  const lifecyclePassed = event?.status === "completed" || event?.status === "steered";
  const success = lifecyclePassed && Boolean(verification?.gatePassed) && commitCheck.valid && commitCountValue === 1;

  return {
    owner: task.owner,
    model: record?.invocation?.modelId ?? null,
    requestedModel: task.model?.trim?.() || null,
    scope: task.scope,
    verification: task.verification,
    success,
    status: event?.status,
    agentId: event?.id,
    worktree: verification?.worktreePath,
    worktreePath: verification?.worktreePath,
    branch,
    gatePassed: verification?.gatePassed ?? false,
    ...(verification?.failure_code ? { failure_code: verification.failure_code } : {}),
    gateEvidence: verification?.gateEvidence ?? "",
    gateEvidenceTruncated: verification?.gateEvidenceTruncated ?? false,
    commitCheck,
    commitCount: commitCountValue,
    atomicCommit: commitCountValue === 1,
    changedPaths: changedPaths(repo, baseSha, branch),
    verificationRan: Boolean(verification),
    diff: diff.text,
    diffBytes: diff.bytes,
    diffTruncated: diff.truncated,
    result: agentResult.text,
    resultTruncated: agentResult.truncated,
    integrated: false,
    integration: "requires explicit user confirmation; worker never auto-integrates",
  };
}
