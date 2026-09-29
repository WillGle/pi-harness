import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { statSync } from "node:fs";
import { acquireControlLease, readControlState, writeControlState } from "../lib/control-state-store.mjs";
import "./helpers/control-state-isolation.mjs";

test("durable Mission control snapshots are private, atomic, and locked to one writable session", async () => {
  const lease = await acquireControlLease(process.cwd());
  try {
    await assert.rejects(acquireControlLease(process.cwd()), /already owned/);
    const initial = writeControlState({ missions: { "M-1": { mission_id: "M-1", status: "active" } }, operations: {}, task_graphs: {}, attempt_ledger: {} }, lease, process.cwd());
    assert.equal(initial.revision, 1);
    assert.equal(readControlState(process.cwd()).missions["M-1"].status, "active");
    const statePath = `${process.env.PI_HARNESS_CONTROL_DIR}/${initial.project_id}.json`;
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  } finally { await lease.release(); }

  const resumedLease = await acquireControlLease(process.cwd());
  try {
    const next = writeControlState({ missions: { "M-1": { mission_id: "M-1", status: "active" } }, operations: {}, task_graphs: {}, attempt_ledger: {} }, resumedLease, process.cwd());
    assert.equal(next.revision, 2);
  } finally { await resumedLease.release(); }
});

test("an abruptly ended Pi process releases its durable Mission lock", async () => {
  const moduleUrl = new URL("../lib/control-state-store.mjs", import.meta.url).href;
  const source = `import { acquireControlLease } from ${JSON.stringify(moduleUrl)}; await acquireControlLease(process.cwd()); process.stdout.write("READY\\n"); setInterval(() => {}, 60_000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("READY\n")) resolve(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => { if (!output.includes("READY\n")) reject(new Error(`lock child exited before ready: ${code ?? signal}`)); });
  });
  await ready;
  child.kill("SIGKILL");
  await once(child, "exit");
  const resumedLease = await acquireControlLease(process.cwd());
  await resumedLease.release();
});
