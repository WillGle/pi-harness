import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { getProjectIdentifier } from "./memory.mjs";

export const MAX_EVIDENCE_BYTES = 32_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const KINDS = new Set(["execution", "gate", "diff", "report"]);

export function evidenceRoot() {
  const override = process.env.PI_HARNESS_EVIDENCE_DIR;
  if (override && !isAbsolute(override)) throw new Error("PI_HARNESS_EVIDENCE_DIR must be absolute");
  return resolve(override ?? join(homedir(), ".pi-harness", "evidence"));
}

// Check every component, including ancestors. Reject symlinks, not just the leaf.
// Newly created storage components are private; the existing store root and
// project directory must be private and owned by this user. No chmod of
// caller-owned paths.
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
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Evidence directory is not a safe directory");
    // Parents above the store can be shared (e.g. /tmp). The store itself
    // and its project directory cannot be group/world accessible.
    if (index === components.length - 1 && (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))) {
      throw new Error("Evidence directory must be private and owned by the current user");
    }
  }
}

function projectDirectory(cwd, create) {
  const root = evidenceRoot();
  safeDirectory(root, create);
  const project = getProjectIdentifier(cwd);
  const path = join(root, project);
  safeDirectory(path, create);
  return { path, project };
}

function readRegular(path, maxBytes) {
  const fd = openSync(path, READ_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error("Evidence file is unsafe or exceeds its size limit");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function storeEvidence({ cwd = process.cwd(), taskId, kind, content, truncated = false }) {
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("Evidence requires task_id");
  if (!KINDS.has(kind)) throw new Error("Invalid Evidence kind");
  if (typeof content !== "string" && !Buffer.isBuffer(content)) throw new Error("Evidence requires raw text or bytes");
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the size limit");
  const { path, project } = projectDirectory(cwd, true);
  const id = randomUUID();
  const reference = `evidence://${project}/${id}`;
  const metadata = { reference, task_id: taskId, kind, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), created_at: new Date().toISOString(), truncated: Boolean(truncated) };
  const dataPath = join(path, `${id}.bin`);
  const metaPath = join(path, `${id}.json`);
  let fd;
  try {
    fd = openSync(dataPath, WRITE_FLAGS, 0o600);
    writeFileSync(fd, bytes);
    closeSync(fd); fd = undefined;
    const metaFd = openSync(metaPath, WRITE_FLAGS, 0o600);
    try { writeFileSync(metaFd, JSON.stringify(metadata)); } finally { closeSync(metaFd); }
    return metadata;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(dataPath); } catch { /* best-effort cleanup */ }
    try { unlinkSync(metaPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function readEvidence(reference, cwd = process.cwd()) {
  if (typeof reference !== "string") throw new Error("Invalid Evidence reference");
  const match = /^evidence:\/\/([a-zA-Z0-9_-]+)\/([0-9a-f-]+)$/.exec(reference);
  if (!match || !ID.test(match[2]) || match[1] !== getProjectIdentifier(cwd)) throw new Error("Invalid or foreign Evidence reference");
  const { path } = projectDirectory(cwd, false);
  const metadata = JSON.parse(readRegular(join(path, `${match[2]}.json`), 4096).toString("utf8"));
  if (metadata.reference !== reference || !KINDS.has(metadata.kind) || typeof metadata.task_id !== "string" || !Number.isInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > MAX_EVIDENCE_BYTES || !/^[0-9a-f]{64}$/.test(metadata.sha256)) throw new Error("Invalid Evidence metadata");
  const content = readRegular(join(path, `${match[2]}.bin`), MAX_EVIDENCE_BYTES);
  if (content.length !== metadata.bytes || createHash("sha256").update(content).digest("hex") !== metadata.sha256) throw new Error("Evidence integrity check failed");
  return { metadata, content };
}
