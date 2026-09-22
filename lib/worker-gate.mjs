import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const MAX_GATE_EVIDENCE_BYTES = 8_000;
export const MAX_DIFF_BYTES = 20_000;
export const MAX_RESULT_BYTES = 8_000;

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
  const result = spawnSync("git", ["-C", cwd, "show", "-s", "--format=%B", ref], { encoding: "utf8" });
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

export function runWorkerVerification(worktreePath, task, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dependencyLink = ensureWorktreeDependencies(worktreePath, projectRoot);
  const worktreeBin = join(worktreePath, "node_modules", ".bin");
  const parentBin = join(projectRoot, "node_modules", ".bin");
  let gateRun;
  try {
    gateRun = spawnSync("sh", ["-c", task.verification], {
      cwd: worktreePath,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${worktreeBin}:${parentBin}:${process.env.PATH ?? ""}`,
      },
      timeout: options.timeout ?? 60_000,
    });
  } finally {
    if (dependencyLink) {
      try { unlinkSync(dependencyLink); } catch { /* package cleanup must not commit the temporary link */ }
    }
  }
  const evidence = truncateText(`${gateRun.stdout ?? ""}\n${gateRun.stderr ?? ""}`.trim(), MAX_GATE_EVIDENCE_BYTES);
  return {
    worktreePath,
    gatePassed: gateRun.status === 0,
    gateEvidence: evidence.text,
    gateEvidenceTruncated: evidence.truncated,
  };
}

function branchFromResult(result) {
  const match = String(result ?? "").match(/Changes saved to branch `([^`]+)`/);
  return match?.[1];
}

function commitCount(cwd, baseSha, branch) {
  if (!branch || !baseSha) return 0;
  const result = spawnSync("git", ["-C", cwd, "rev-list", "--count", `${baseSha}..${branch}`], { encoding: "utf8" });
  return result.status === 0 ? Number(result.stdout.trim()) || 0 : 0;
}

function boundedDiff(cwd, baseSha, branch) {
  if (!branch || !baseSha) return { text: "", bytes: 0, truncated: false };
  const result = spawnSync("git", ["-C", cwd, "diff", `${baseSha}...${branch}`], { encoding: "utf8" });
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
    gateEvidence: verification?.gateEvidence ?? "",
    gateEvidenceTruncated: verification?.gateEvidenceTruncated ?? false,
    commitCheck,
    commitCount: commitCountValue,
    atomicCommit: commitCountValue === 1,
    diff: diff.text,
    diffBytes: diff.bytes,
    diffTruncated: diff.truncated,
    result: agentResult.text,
    resultTruncated: agentResult.truncated,
    integrated: false,
    integration: "requires explicit user confirmation; worker never auto-integrates",
  };
}
