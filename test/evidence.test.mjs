import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceRoot, MAX_EVIDENCE_BYTES, readEvidence, storeEvidence } from "../lib/evidence.mjs";
import { getProjectIdentifier } from "../lib/memory.mjs";

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "pi-evidence-test-"));
  const old = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = join(root, "store");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  try { return fn({ root, cwd, store: evidenceRoot() }); }
  finally {
    if (old === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR;
    else process.env.PI_HARNESS_EVIDENCE_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
}

test("local Evidence preserves bytes, integrity metadata and truncation state", () => fixture(({ cwd, store }) => {
  const raw = "child says VERIFIED\n\u0000raw output";
  const item = storeEvidence({ cwd, taskId: "../../T-104", kind: "report", content: raw, truncated: true });
  assert.match(item.reference, /^evidence:\/\/[a-zA-Z0-9_-]+\/[0-9a-f-]{36}$/);
  assert.ok(!item.reference.includes("T-104"));
  assert.equal(item.bytes, Buffer.byteLength(raw));
  assert.equal(item.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.ok(!Number.isNaN(Date.parse(item.created_at)));
  assert.equal(item.truncated, true);
  const found = readEvidence(item.reference, cwd);
  assert.equal(found.content.toString(), raw);
  assert.deepEqual(found.metadata, item);
  assert.equal(lstatSync(store).mode & 0o077, 0);
  const id = item.reference.split("/").at(-1);
  assert.equal(lstatSync(join(store, getProjectIdentifier(cwd), `${id}.bin`)).mode & 0o077, 0);
}));

test("invalid, foreign, escaped and tampered Evidence fails closed", () => fixture(({ cwd, store, root }) => {
  const item = storeEvidence({ cwd, taskId: "T", kind: "report", content: "raw" });
  for (const ref of ["evidence://other/../../secret", "evidence://other/" + item.reference.split("/").at(-1), item.reference + "/../secret", "file:///tmp/private"]) {
    assert.throws(() => readEvidence(ref, cwd));
  }
  const id = item.reference.split("/").at(-1);
  const data = join(store, getProjectIdentifier(cwd), `${id}.bin`);
  writeFileSync(data, "bad");
  assert.throws(() => readEvidence(item.reference, cwd), /integrity/);
  const outside = join(root, "outside");
  writeFileSync(outside, "raw");
  rmSync(data);
  symlinkSync(outside, data);
  assert.throws(() => readEvidence(item.reference, cwd));
}));

test("Evidence size and directory symlinks are rejected", () => fixture(({ cwd, store, root }) => {
  assert.throws(() => storeEvidence({ cwd, taskId: "T", kind: "report", content: "x".repeat(MAX_EVIDENCE_BYTES + 1) }), /size limit/);
  const item = storeEvidence({ cwd, taskId: "T", kind: "report", content: "test" });
  const project = join(store, getProjectIdentifier(cwd));
  renameSync(project, join(root, "old-project"));
  symlinkSync(join(root, "old-project"), project);
  assert.throws(() => readEvidence(item.reference, cwd), /safe directory/);
  assert.throws(() => storeEvidence({ cwd, taskId: "T", kind: "report", content: "test" }), /safe directory/);
}));

test("unsafe existing Evidence directory cannot be used", () => fixture(({ cwd, store }) => {
  mkdirSync(store, { mode: 0o700 });
  chmodSync(store, 0o777);
  assert.throws(() => storeEvidence({ cwd, taskId: "T", kind: "report", content: "test" }), /private/);
}));
