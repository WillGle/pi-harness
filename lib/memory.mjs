import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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

export function loadProjectMemory(cwd = process.cwd(), maxBytes = 8192) {
  const filePath = getProjectMemoryPath(cwd);
  if (!existsSync(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, "utf8").trim();
    if (!content) return undefined;
    if (Buffer.byteLength(content) > maxBytes) {
      return content.slice(-maxBytes);
    }
    return content;
  } catch {
    return undefined;
  }
}

export function appendProjectMemory(note, cwd = process.cwd()) {
  const cleanNote = String(note ?? "").trim();
  if (!cleanNote) throw new Error("Memory note cannot be empty");
  const filePath = getProjectMemoryPath(cwd);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- [${timestamp}] ${cleanNote}\n`;
  appendFileSync(filePath, line, "utf8");
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
