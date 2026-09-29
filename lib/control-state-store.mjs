import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProjectIdentifier } from "./memory.mjs";

export const CONTROL_STATE_VERSION = 1;
export const MAX_CONTROL_STATE_BYTES = 4_000_000;
const NOFOLLOW = constants.O_NOFOLLOW;
const CONTROL_LOCK = Symbol("pi-harness-control-lock");

function safeDirectory(path, create = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      try { mkdirSync(current, { mode: 0o700 }); } catch (race) { if (race.code !== "EEXIST") throw race; }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Mission control storage path is not a safe directory");
    if (index === components.length - 1 && (stat.mode & 0o077 || stat.uid !== process.getuid())) throw new Error("Mission control storage directory must be private and owned by the current user");
  }
}

function paths(cwd, create = false) {
  const override = process.env.PI_HARNESS_CONTROL_DIR;
  if (override && !parse(override).root) throw new Error("PI_HARNESS_CONTROL_DIR must be absolute");
  const root = resolve(override ?? join(homedir(), ".pi-harness", "control"));
  safeDirectory(root, create);
  const projectId = getProjectIdentifier(cwd);
  const state = join(root, `${projectId}.json`);
  const lock = join(root, `${projectId}.lock`);
  if (create) ensurePrivateFile(lock);
  return { root, projectId, state, lock };
}

function ensurePrivateFile(path) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Mission control lock file must be private and owned by the current user");
  } finally { closeSync(fd); }
}

function readPrivateFile(path) {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONTROL_STATE_BYTES || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Mission control state is unsafe or exceeds its size limit");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function readControlState(cwd = process.cwd()) {
  const override = process.env.PI_HARNESS_CONTROL_DIR;
  if (override && !parse(override).root) throw new Error("PI_HARNESS_CONTROL_DIR must be absolute");
  if (!existsSync(resolve(override ?? join(homedir(), ".pi-harness", "control")))) return undefined;
  const { projectId, state } = paths(cwd);
  if (!existsSync(state)) return undefined;
  const value = JSON.parse(readPrivateFile(state).toString("utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object" || value.version !== CONTROL_STATE_VERSION || value.project_id !== projectId || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) throw new Error("Mission control state has an unsupported or invalid envelope");
  return value;
}

export function acquireControlLease(cwd = process.cwd()) {
  const location = paths(cwd, true);
  const child = spawn("flock", ["--nonblock", "--exclusive", "--no-fork", location.lock, process.execPath, fileURLToPath(import.meta.url), "--pi-harness-hold-control-lease"], { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolveLease, rejectLease) => {
    let ready = false;
    let stdout = "";
    let stderr = "";
    const fail = (error) => {
      if (ready) return;
      ready = true;
      rejectLease(error);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("READY\n")) return;
      ready = true;
      const lease = {
        project_id: location.projectId,
        child,
        [CONTROL_LOCK]: true,
        release() {
          if (lease.released) return Promise.resolve();
          lease.released = true;
          process.removeListener("exit", emergencyRelease);
          if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
          const exited = new Promise((done) => child.once("exit", done));
          child.kill("SIGTERM");
          return exited;
        },
        released: false,
      };
      const emergencyRelease = () => { if (!lease.released && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
      process.once("exit", emergencyRelease);
      resolveLease(lease);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.once("error", (error) => fail(new Error(error.code === "ENOENT" ? "Mission resume requires the Linux flock utility" : `Mission control session lock failed: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (ready) return;
      const detail = stderr.trim();
      fail(new Error(/operation not permitted|permission denied/i.test(detail)
        ? `Mission control session lock failed: ${detail}`
        : `Mission control state is already owned by another Pi Harness session${detail ? ` (${detail})` : ` (lock exit ${code ?? signal})`}`));
    });
  });
}

export function assertControlLease(lease, cwd = process.cwd()) {
  const projectId = getProjectIdentifier(cwd);
  if (!lease || lease[CONTROL_LOCK] !== true || lease.project_id !== projectId || lease.released || lease.child.exitCode !== null || lease.child.signalCode !== null) throw new Error("This Pi session no longer owns Mission control state");
}

export function writeControlState(snapshot, lease, cwd = process.cwd()) {
  const location = paths(cwd, true);
  assertControlLease(lease, cwd);
  const previous = readControlState(cwd);
  const value = { ...snapshot, version: CONTROL_STATE_VERSION, project_id: location.projectId, revision: (previous?.revision ?? 0) + 1, updated_at: new Date().toISOString() };
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_CONTROL_STATE_BYTES) throw new Error("Mission control state exceeds its size limit");

  if (existsSync(location.state)) {
    const stat = lstatSync(location.state);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Mission control state file must be private and owned by the current user");
  }
  const temporary = join(location.root, `.${basename(location.state)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    assertControlLease(lease, cwd);
    renameSync(temporary, location.state);
    const dirFd = openSync(dirname(location.state), constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return value;
}

if (process.argv[2] === "--pi-harness-hold-control-lease") {
  process.stdout.write("READY\n");
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("error", () => process.exit(0));
}
