import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import { sha256, verifySkills } from "../lib/skills.mjs";

test("checked-in skills are self-contained and every packaged file matches the lock", () => {
  const root = resolve(".");
  const result = verifySkills(root);
  assert.equal(result.ok, true, `verifySkills failed: ${result.errors.join(", ")}`);
  assert.equal(result.errors.length, 0);
  const names = Object.keys(result.lock.skills).sort();
  const directories = readdirSync(resolve(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(names, directories);
  assert.equal(Object.hasOwn(result.lock, "source"), false);
  assert.equal(Object.hasOwn(result.lock, "commit"), false);
  for (const [name, entry] of Object.entries(result.lock.skills)) {
    assert.ok(entry.files["SKILL.md"], `${name} must lock SKILL.md`);
    for (const [file, checksum] of Object.entries(entry.files)) {
      assert.equal(sha256(resolve(root, "skills", name, file)), checksum);
    }
  }

  const isolated = mkdtempSync(resolve(tmpdir(), "pi-skills-isolated-"));
  try {
    cpSync(resolve(root, "skills"), resolve(isolated, "skills"), { recursive: true });
    assert.equal(verifySkills(isolated).ok, true, "verification must not need another checkout");
    writeFileSync(resolve(isolated, "skills", "caveman", "unlocked.txt"), "extra");
    const extra = verifySkills(isolated);
    assert.equal(extra.ok, false);
    assert.match(extra.errors.join(" "), /unlocked\.txt: not recorded in lock/);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("Pi exposes only contextual skills to model selection and keeps policy modes explicit-only", () => {
  const root = resolve(".");
  const { skills } = loadSkills({
    cwd: root,
    agentDir: resolve(root, ".missing-agent"),
    skillPaths: [resolve(root, "skills")],
    includeDefaults: false,
  });
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const explicitOnly = skills.filter((skill) => skill.disableModelInvocation).map((skill) => skill.name).sort();
  assert.deepEqual(explicitOnly, ["caveman", "ponytail", "security"]);
  const promptSkills = formatSkillsForPrompt(skills);
  for (const name of explicitOnly) {
    assert.ok(byName.has(name), `${name} must remain registered for explicit invocation`);
    assert.doesNotMatch(promptSkills, new RegExp(`<name>${name}</name>`));
  }
  assert.doesNotMatch(promptSkills, /ACTIVE EVERY RESPONSE|The ladder is a reflex/);
  for (const name of ["ask-user", "pi-coordinator", "project-scouting", "requirement-check"]) {
    assert.match(promptSkills, new RegExp(`<name>${name}</name>`));
  }
  assert.match(byName.get("pi-coordinator").description, /multi-part work/);
  assert.match(readFileSync(byName.get("security").filePath, "utf8"), /trust boundaries/i);
  assert.match(byName.get("requirement-check").description, /medium\/high-impact/);

  const caveman = readFileSync("skills/caveman/SKILL.md", "utf8");
  assert.match(caveman, /presentation only/i);
  assert.match(caveman, /Never skip or alter work/);
  const ponytail = readFileSync("skills/ponytail/SKILL.md", "utf8");
  assert.match(ponytail, /disable-model-invocation: true/);
  assert.match(ponytail, /YAGNI only to additions outside it/);
  assert.match(ponytail, /preserve the requested capability and any specified architecture/i);
});

test("scouting has one packaged execution path and doctrine describes the supported TaskOrder subset", () => {
  const scouting = readFileSync("skills/project-scouting/SKILL.md", "utf8");
  const coordinator = readFileSync("skills/pi-coordinator/SKILL.md", "utf8");
  assert.match(scouting, /pi_harness_coordinate/);
  assert.doesNotMatch(scouting, /scripts\/scout\.py|\.scout_report\.md.*exists/);
  assert.match(coordinator, /current `pi_harness_coordinate` API accepts/);
  const cavecrew = readFileSync("skills/cavecrew/SKILL.md", "utf8");
  assert.match(cavecrew, /Do not register or spawn named cavecrew agents/);
  assert.match(cavecrew, /Never treat a receipt as a TaskResult/);
  assert.match(readFileSync("skills/caveman/SKILL.md", "utf8"), /Never format or rewrite a Mission/);
  assert.match(coordinator, /Do not interpret it as Definition of Done/);
  const lock = JSON.parse(readFileSync("skills/skills.lock.json", "utf8"));
  assert.equal(Object.hasOwn(lock.skills, "skill-hub"), false);
});

test("a modified packaged diagram reference fails verification", () => {
  const root = resolve(".");
  const temp = mkdtempSync(resolve(tmpdir(), "pi-skills-"));
  try {
    cpSync(resolve(root, "skills"), resolve(temp, "skills"), { recursive: true });
    for (const [skill, file] of [["architecture-diagram", "readability.md"], ["ask-user", "SKILL.md"], ["drawio-modeling", "use-case.md"]]) {
      const ref = resolve(temp, "skills", skill, ...(file === "SKILL.md" ? [file] : ["references", file]));
      writeFileSync(ref, readFileSync(ref, "utf8") + "\nchanged\n");
    }
    const result = verifySkills(temp);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /architecture-diagram\/references\/readability.md: checksum mismatch/);
    assert.match(result.errors.join(" "), /ask-user\/SKILL.md: checksum mismatch/);
    assert.match(result.errors.join(" "), /drawio-modeling\/references\/use-case.md: checksum mismatch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
