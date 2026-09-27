const branchPattern = /^pi-agent-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const branchStatuses = new Set(["unknown", "not_reported", "preserved"]);
const childStatuses = new Set(["cancelled", "stopped", "cleanup_failed", "unknown"]);

export function isManagedWorkerBranch(value) {
  return typeof value === "string" && branchPattern.test(value);
}

export function isChildOutcomeStatus(value) {
  return childStatuses.has(value);
}

export function safeChildDisposition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = ["branch_status", "branch", "commit_sha", "commit_count", "worktree_status"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !branchStatuses.has(value.branch_status) || value.worktree_status !== "unknown") return undefined;
  const result = { branch_status: value.branch_status, worktree_status: "unknown" };
  if (value.branch !== undefined) {
    if (value.branch_status !== "preserved" || !isManagedWorkerBranch(value.branch)) return undefined;
    result.branch = value.branch;
  }
  if (value.commit_sha !== undefined) {
    if (value.branch_status !== "preserved" || typeof value.commit_sha !== "string" || !shaPattern.test(value.commit_sha)) return undefined;
    result.commit_sha = value.commit_sha;
  }
  if (value.commit_count !== undefined) {
    if (value.branch_status !== "preserved" || !Number.isSafeInteger(value.commit_count) || value.commit_count < 0 || value.commit_count > 1_000_000) return undefined;
    result.commit_count = value.commit_count;
  }
  if (value.branch_status === "preserved" && !result.branch) return undefined;
  if (value.branch_status !== "preserved" && (value.branch !== undefined || value.commit_sha !== undefined || value.commit_count !== undefined)) return undefined;
  return result;
}

export function isChildDisposition(value) {
  return safeChildDisposition(value) !== undefined;
}
