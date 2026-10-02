import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

export function getProjectIdentifier(cwd = process.cwd()) {
  const gitRoot = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const rootPath = gitRoot.status === 0 && gitRoot.stdout.trim() ? gitRoot.stdout.trim() : resolve(cwd);
  const base = basename(rootPath).replace(/[^a-zA-Z0-9_-]/g, "_") || "project";
  const hash = createHash("sha256").update(rootPath).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

