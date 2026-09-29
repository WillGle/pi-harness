import { afterEach, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tracked = new Set();
let root;
let previous;

beforeEach(() => {
  previous = process.env.PI_HARNESS_CONTROL_DIR;
  root = mkdtempSync(join(tmpdir(), "pi-harness-control-test-"));
  process.env.PI_HARNESS_CONTROL_DIR = root;
});

afterEach(async () => {
  for (const pi of tracked) await pi.shutdown?.();
  tracked.clear();
  if (previous === undefined) delete process.env.PI_HARNESS_CONTROL_DIR;
  else process.env.PI_HARNESS_CONTROL_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

export function trackControlPi(pi) {
  tracked.add(pi);
  return pi;
}
