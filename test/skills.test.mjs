import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { sha256, verifySkills, verifySourceCommit } from "../lib/skills.mjs";

test("every checked-in curated skill matches its recorded checksum and verified lock passes", () => {
  const root = resolve(".");
  const result = verifySkills(root, { requireSourceRepo: true });
  assert.equal(result.ok, true, `verifySkills failed: ${result.errors.join(", ")}`);
  assert.equal(result.errors.length, 0);
  for (const [name, checksum] of Object.entries(result.lock.skills)) {
    assert.equal(sha256(resolve(root, "skills", name, "SKILL.md")), checksum);
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
