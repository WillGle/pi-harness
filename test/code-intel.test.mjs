import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReferences, findSymbol } from "../lib/code-intel.mjs";

test("findSymbol locates function and class declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "code-intel-test-"));
  const sample = join(root, "sample.js");
  writeFileSync(sample, "function calculateTotal(a, b) {\n  return a + b;\n}\nconst x = calculateTotal(1, 2);\n");

  try {
    const result = findSymbol(root, "calculateTotal");
    assert.equal(result.symbol, "calculateTotal");
    assert.ok(result.matches.length >= 1);
    assert.match(result.matches[0].text, /function calculateTotal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findReferences locates occurrences of an identifier", () => {
  const root = mkdtempSync(join(tmpdir(), "code-intel-test-"));
  const sample = join(root, "sample.js");
  writeFileSync(sample, "function greet() {}\ngreet();\nconsole.log(greet);\n");

  try {
    const result = findReferences(root, "greet");
    assert.equal(result.symbol, "greet");
    assert.ok(result.matches.length >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
