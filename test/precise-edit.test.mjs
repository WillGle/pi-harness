import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHashlines, replaceHashlines } from "../lib/precise-edit.mjs";

test("hashlines reading and patching replaces exact lines with stale check", () => {
  const root = mkdtempSync(join(tmpdir(), "precise-edit-test-"));
  const filePath = "sample.txt";
  const fullPath = join(root, filePath);
  writeFileSync(fullPath, "line 1\nline 2\nline 3\nline 4\nline 5\n");

  try {
    // 1. Read hashlines for lines 2-4
    const read = readHashlines(root, filePath, 2, 4);
    assert.equal(read.start_line, 2);
    assert.equal(read.end_line, 4);
    assert.equal(read.lines.length, 3);
    assert.match(read.lines[0], /^2#[a-f0-9]{12} line 2$/);
    assert.match(read.lines[1], /^3#[a-f0-9]{12} line 3$/);
    assert.match(read.lines[2], /^4#[a-f0-9]{12} line 4$/);
    assert.match(read.sha256, /^[a-f0-9]{64}$/);

    // 2. Reject patch with wrong sha256 (stale check)
    assert.throws(
      () => replaceHashlines(root, filePath, 2, 4, "a".repeat(64), "updated line"),
      /source block changed/
    );

    // 3. Patch lines 2-4 with new content
    const patch = replaceHashlines(root, filePath, 2, 4, read.sha256, "new line 2\nnew line 3\nnew line 4");
    assert.equal(patch.start_line, 2);
    assert.equal(patch.end_line, 4);

    // 4. Verify file content after patch
    const updatedContent = readFileSync(fullPath, "utf8");
    assert.equal(updatedContent, "line 1\nnew line 2\nnew line 3\nnew line 4\nline 5\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
