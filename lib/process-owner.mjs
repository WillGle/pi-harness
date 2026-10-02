import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

const OWNER_ENV = "PI_HARNESS_PROCESS_OWNER";
const token = randomUUID();

function identity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], started: fields[19] };
}

export function processOwner() {
  // Subagents run in this Pi process; its shell descendants inherit the tag.
  process.env[OWNER_ENV] = token;
  return { pid: process.pid, started: identity(process.pid).started, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), token };
}

export function inspectProcessOwner(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || !/^\d+$/.test(owner.started ?? "")
    || !/^[a-f0-9-]{36}$/.test(owner.boot ?? "") || !/^[a-f0-9-]{36}$/.test(owner.token ?? "")) return { state: "unavailable" };
  try {
    if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== owner.boot) return { state: "terminal", reason: "host_restarted" };
    try {
      const current = identity(owner.pid);
      if (current.started === owner.started && !["Z", "X"].includes(current.state)) return { state: "active" };
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        if (Number(pid) === process.pid || statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
        const current = identity(pid);
        // Older processes cannot be descendants of this owner. Their protected
        // environments must not prevent recovery of a later, exited Pi process.
        if (["Z", "X"].includes(current.state) || BigInt(current.started) < BigInt(owner.started)) continue;
        if (readFileSync(`/proc/${pid}/environ`).toString().split("\0").includes(`${OWNER_ENV}=${owner.token}`)) return { state: "active" };
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    }
    return { state: "terminal", reason: "owner_and_tagged_processes_exited" };
  } catch { return { state: "unavailable" }; }
}
