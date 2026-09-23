import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Content(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function verifySourceCommit(lock, sourceRepo) {
  if (!sourceRepo || !existsSync(sourceRepo)) {
    return { verified: false, error: "source repository not found" };
  }
  const rev = spawnSync("git", ["-C", sourceRepo, "rev-parse", "--verify", `${lock.commit}^{commit}`], { encoding: "utf8" });
  if (rev.status !== 0) {
    return { verified: false, error: `source commit ${lock.commit} not found in ${sourceRepo}` };
  }
  for (const [name, entry] of Object.entries(lock.skills ?? {})) {
    if (entry?.local === true) continue; // authored here: packaged hashes, not an upstream snapshot
    const sourceName = typeof entry === "string" ? name : entry?.sourceSkill;
    if (!sourceName || !/^[a-z0-9-]+$/.test(sourceName)) {
      return { verified: false, error: `${name}: invalid source skill` };
    }
    const show = spawnSync("git", ["-C", sourceRepo, "show", `${lock.commit}:${sourceName}/SKILL.md`], { encoding: "utf8" });
    if (show.status !== 0) {
      return { verified: false, error: `${sourceName}: missing in source commit ${lock.commit}` };
    }
    const hash = sha256Content(show.stdout);
    const expected = typeof entry === "string" ? entry : entry.sourceHash;
    if (hash !== expected) {
      return { verified: false, error: `${name}: source commit hash ${hash} does not match lock checksum ${expected}` };
    }
  }
  return { verified: true };
}

export function verifySkills(root, options = {}) {
  const lockPath = resolve(root, "skills/skills.lock.json");
  if (!existsSync(lockPath)) return { ok: false, errors: ["skill lock missing"] };
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const errors = [];
  if (!/^[0-9a-f]{40}$/.test(lock.commit ?? "")) errors.push("skill source commit must be a full SHA");
  if (!lock.source?.includes("skills-central")) errors.push("skill source must identify skills-central");
  if (lock.sourceCommitVerified !== true) errors.push(lock.sourceBlocker ?? "skill source commit has not been verified");
  const names = Object.keys(lock.skills ?? {});
  if (names.length !== 6) errors.push("exactly six curated skills are required");
  for (const name of names) {
    const entry = lock.skills[name];
    if (typeof entry !== "string" && entry?.local !== true && !entry?.sourceSkill) {
      errors.push(`${name}: source skill or local origin required`);
    }
    const files = typeof entry === "string" ? { "SKILL.md": entry } : entry?.files;
    if (!files || !Object.hasOwn(files, "SKILL.md")) {
      errors.push(`${name}: missing SKILL.md checksum`);
      continue;
    }
    for (const [file, checksum] of Object.entries(files)) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split("/").includes("..")) {
        errors.push(`${name}: invalid file path ${file}`);
        continue;
      }
      const path = resolve(root, "skills", name, file);
      if (!existsSync(path)) errors.push(`${name}/${file}: missing`);
      else if (!/^[0-9a-f]{64}$/.test(checksum ?? "")) errors.push(`${name}/${file}: checksum missing`);
      else if (sha256(path) !== checksum) errors.push(`${name}/${file}: checksum mismatch`);
    }
  }

  // Verify against source repository if available or required
  const sourceRepo = options.sourceRepo || process.env.SKILLS_CENTRAL_DIR || resolve(root, "../skills-central");
  if (existsSync(sourceRepo)) {
    const srcCheck = verifySourceCommit(lock, sourceRepo);
    if (!srcCheck.verified) {
      errors.push(`source commit verification failed: ${srcCheck.error}`);
    }
  } else if (options.requireSourceRepo) {
    errors.push("source repository is required for provenance verification but was not found");
  }

  return { ok: errors.length === 0, errors, lock };
}
