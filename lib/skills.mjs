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
  for (const name of Object.keys(lock.skills ?? {})) {
    const show = spawnSync("git", ["-C", sourceRepo, "show", `${lock.commit}:${name}/SKILL.md`], { encoding: "utf8" });
    if (show.status !== 0) {
      return { verified: false, error: `${name}: missing in source commit ${lock.commit}` };
    }
    const hash = sha256Content(show.stdout);
    if (hash !== lock.skills[name]) {
      return { verified: false, error: `${name}: source commit hash ${hash} does not match lock checksum ${lock.skills[name]}` };
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
  if (names.length !== 5) errors.push("exactly five curated skills are required");
  for (const name of names) {
    const path = resolve(root, "skills", name, "SKILL.md");
    if (!existsSync(path)) errors.push(`${name}: missing SKILL.md`);
    else if (!/^[0-9a-f]{64}$/.test(lock.skills[name] ?? "")) errors.push(`${name}: checksum missing`);
    else if (sha256(path) !== lock.skills[name]) errors.push(`${name}: checksum mismatch`);
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
