import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Opt-in only. No project content or Evidence is sent to a live provider.
test("opt-in Pi Daybreak Blue capability", { skip: process.env.PI_HARNESS_LIVE_DAYBREAK === "1" ? false : "Daybreak live access was not requested" }, (t) => {
  const pi = resolve("node_modules/.bin/pi");
  const available = spawnSync(pi, ["--offline", "--list-models", "gpt-daybreak-blue-latest"], { encoding: "utf8", timeout: 15000 });
  if (available.status !== 0 || !available.stdout.includes("gpt-daybreak-blue-latest")) return t.skip("Pi/provider does not expose Daybreak Blue on this machine");
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-daybreak-live-"));
  try {
    const result = spawnSync(pi, ["--offline", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools", "--model", "openai/gpt-daybreak-blue-latest", "-p", "For a toy web API, give one defensive authorization test. Do not use tools."], { cwd, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `Pi could not complete a benign Daybreak prompt: ${result.stderr?.slice(0, 500)}`);
    assert.ok(result.stdout.trim(), "The selected model returned no response");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
