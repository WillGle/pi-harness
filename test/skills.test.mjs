import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sha256, verifySkills, verifySourceCommit } from "../lib/skills.mjs";

test("every checked-in curated skill matches its recorded checksum and verified lock passes", () => {
  const root = resolve(".");
  const result = verifySkills(root, { requireSourceRepo: true });
  assert.equal(result.ok, true, `verifySkills failed: ${result.errors.join(", ")}`);
  assert.equal(result.errors.length, 0);
  for (const [name, entry] of Object.entries(result.lock.skills)) {
    const files = typeof entry === "string" ? { "SKILL.md": entry } : entry.files;
    for (const [file, checksum] of Object.entries(files)) {
      assert.equal(sha256(resolve(root, "skills", name, file)), checksum);
    }
  }
  assert.equal(result.lock.sourceCommitVerified, true);

  // Test source commit verification directly
  const sourceRepo = resolve(root, "../skills-central");
  const srcCheck = verifySourceCommit(result.lock, sourceRepo);
  assert.equal(srcCheck.verified, true);

  // Mismatched commit hash fails source verification
  const badLock = { ...result.lock, commit: "0000000000000000000000000000000000000000" };
  const badCheck = verifySourceCommit(badLock, sourceRepo);
  assert.equal(badCheck.verified, false);
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
    const result = verifySkills(temp, { sourceRepo: resolve(root, "../skills-central") });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /architecture-diagram\/references\/readability.md: checksum mismatch/);
    assert.match(result.errors.join(" "), /ask-user\/SKILL.md: checksum mismatch/);
    assert.match(result.errors.join(" "), /drawio-modeling\/references\/use-case.md: checksum mismatch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
