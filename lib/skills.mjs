import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root, relative = "") {
  return readdirSync(resolve(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(root, file);
    return entry.isFile() || entry.isSymbolicLink() ? [file] : [];
  });
}

export function verifySkills(root) {
  const skillsRoot = resolve(root, "skills");
  const lockPath = resolve(skillsRoot, "skills.lock.json");
  if (!existsSync(lockPath)) return { ok: false, errors: ["skill lock missing"] };
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const errors = [];
  const names = Object.keys(lock.skills ?? {}).sort();
  const directories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of directories) {
    if (!Object.hasOwn(lock.skills ?? {}, name)) errors.push(`${name}: unregistered skill directory`);
  }
  for (const name of names) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push(`${name}: invalid skill name`);
      continue;
    }
    const skillRoot = resolve(skillsRoot, name);
    if (!existsSync(skillRoot)) {
      errors.push(`${name}: missing skill directory`);
      continue;
    }
    const entry = lock.skills[name];
    const files = entry?.files;
    if (!files || typeof files !== "object" || Array.isArray(files) || !Object.hasOwn(files, "SKILL.md")) {
      errors.push(`${name}: missing SKILL.md checksum`);
      continue;
    }

    const expectedFiles = Object.keys(files).sort();
    const actualFiles = listFiles(skillRoot).sort();
    for (const file of actualFiles) {
      if (!Object.hasOwn(files, file)) errors.push(`${name}/${file}: not recorded in lock`);
    }
    for (const file of expectedFiles) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split("/").some((part) => part === "." || part === "..")) {
        errors.push(`${name}: invalid file path ${file}`);
        continue;
      }
      const path = resolve(skillRoot, file);
      if (!path.startsWith(`${skillRoot}/`)) {
        errors.push(`${name}: invalid file path ${file}`);
        continue;
      }
      let stat;
      try { stat = lstatSync(path); } catch {}
      if (!stat?.isFile() || stat.isSymbolicLink()) errors.push(`${name}/${file}: missing or not a regular file`);
      else if (!/^[0-9a-f]{64}$/.test(files[file] ?? "")) errors.push(`${name}/${file}: checksum missing`);
      else if (sha256(path) !== files[file]) errors.push(`${name}/${file}: checksum mismatch`);
    }
  }

  return { ok: errors.length === 0, errors, lock };
}
