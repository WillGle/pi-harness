import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const MAX_MEMORY_BYTES = 8192;
export const MAX_MEMORY_NOTE_BYTES = 1024;

export function getMemoryDir() {
  return process.env.PI_HARNESS_MEMORY_DIR || join(homedir(), ".pi-harness", "memory");
}

export function getProjectIdentifier(cwd = process.cwd()) {
  const gitRoot = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const rootPath = gitRoot.status === 0 && gitRoot.stdout.trim() ? gitRoot.stdout.trim() : resolve(cwd);
  const base = basename(rootPath).replace(/[^a-zA-Z0-9_-]/g, "_") || "project";
  const hash = createHash("sha256").update(rootPath).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function getProjectMemoryPath(cwd = process.cwd()) {
  const slug = getProjectIdentifier(cwd);
  return join(getMemoryDir(), `${slug}.md`);
}

export function loadProjectMemory(cwd = process.cwd(), maxBytes = MAX_MEMORY_BYTES) {
  const filePath = getProjectMemoryPath(cwd);
  if (!existsSync(filePath)) return undefined;
  try {
    const bytes = readFileSync(filePath);
    const start = Math.max(0, bytes.length - maxBytes);
    let offset = start;
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset += 1;
    const content = bytes.subarray(offset).toString("utf8").trim();
    if (!content) return undefined;
    return content;
  } catch {
    return undefined;
  }
}

export function appendProjectMemory(note, cwd = process.cwd()) {
  const cleanNote = String(note ?? "").trim().replace(/\s+/g, " ");
  if (!cleanNote) throw new Error("Memory note cannot be empty");
  if (Buffer.byteLength(cleanNote) > MAX_MEMORY_NOTE_BYTES) throw new Error(`Memory note must be at most ${MAX_MEMORY_NOTE_BYTES} bytes`);
  const filePath = getProjectMemoryPath(cwd);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
  if (existsSync(filePath)) chmodSync(filePath, 0o600);
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- [${timestamp}] ${cleanNote}\n`;
  const lines = existsSync(filePath) ? readFileSync(filePath, "utf8").trimEnd().split("\n") : [];
  lines.push(line.trimEnd());
  while (lines.length > 1 && Buffer.byteLength(`${lines.join("\n")}\n`) > MAX_MEMORY_BYTES) lines.shift();
  writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
  return { filePath, note: cleanNote, timestamp };
}

export function clearProjectMemory(cwd = process.cwd()) {
  const filePath = getProjectMemoryPath(cwd);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      writeFileSync(filePath, "", "utf8");
      return true;
    }
  }
  return false;
}
