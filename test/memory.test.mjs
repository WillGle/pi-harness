import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemory,
  clearProjectMemory,
  getMemoryDir,
  getProjectIdentifier,
  getProjectMemoryPath,
  loadProjectMemory,
} from "../lib/memory.mjs";

test("getProjectIdentifier returns stable, collision-free slug based on repo/path", () => {
  const dir1 = mkdtempSync(join(tmpdir(), "proj-a-"));
  const dir2 = mkdtempSync(join(tmpdir(), "proj-b-"));
  try {
    const slug1 = getProjectIdentifier(dir1);
    const slug2 = getProjectIdentifier(dir2);
    assert.notEqual(slug1, slug2);
    assert.equal(getProjectIdentifier(dir1), slug1, "Slug must be deterministic");
    assert.match(slug1, /^proj-a-.+-[a-f0-9]{8}$/);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("project memory persists in private home dir without touching project repo", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "fake-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "fake-repo-"));
  const originalEnv = process.env.PI_HARNESS_MEMORY_DIR;
  process.env.PI_HARNESS_MEMORY_DIR = join(fakeHome, "memory");

  try {
    // 1. Initial state is empty
    assert.equal(loadProjectMemory(projectDir), undefined);

    // 2. Append notes
    appendProjectMemory("Use pnpm instead of npm", projectDir);
    appendProjectMemory("Never commit .env files", projectDir);

    // 3. Load notes
    const memory = loadProjectMemory(projectDir);
    assert.ok(memory);
    assert.match(memory, /Use pnpm instead of npm/);
    assert.match(memory, /Never commit .env files/);

    // 4. Critical Privacy Guarantee: zero memory files in project directory
    assert.equal(existsSync(join(projectDir, ".pi")), false);
    assert.equal(existsSync(join(projectDir, ".wpi")), false);
    assert.equal(existsSync(join(projectDir, "memory.md")), false);

    // 5. Memory file physically exists only in private memory directory
    const memoryPath = getProjectMemoryPath(projectDir);
    assert.ok(existsSync(memoryPath));
    assert.ok(memoryPath.startsWith(fakeHome));

    // 6. Clear memory
    const cleared = clearProjectMemory(projectDir);
    assert.equal(cleared, true);
    assert.equal(loadProjectMemory(projectDir), undefined);
  } finally {
    if (originalEnv) process.env.PI_HARNESS_MEMORY_DIR = originalEnv;
    else delete process.env.PI_HARNESS_MEMORY_DIR;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
