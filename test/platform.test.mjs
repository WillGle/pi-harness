import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platformStatus, assertSupportedPlatform } from "../lib/platform.mjs";

const root = resolve(".");

function runNode(source, env = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("Linux platform contract requires Linux and all lifecycle safety primitives", () => {
  const status = platformStatus();
  assert.equal(status.required, "linux");
  assert.equal(status.actual, "linux");
  assert.equal(status.supported, true);
  assert.equal(status.filesystem.unix_permissions, true);
  assert.equal(status.filesystem.nofollow, true);
  assert.equal(status.process.signals, true);
  assert.equal(status.process.process_groups, true);
  assert.equal(assertSupportedPlatform().supported, true);

  const mac = platformStatus({ platform: "darwin", hasGetuid: true, nofollow: 1, hasKill: true });
  assert.equal(mac.supported, false);
  assert.ok(mac.missing.includes("Linux host"));
  assert.equal(mac.process.process_groups, false);

  const wsl = platformStatus({ platform: "linux", release: "5.15.90.1-microsoft-standard-WSL2", env: {}, hasGetuid: true, nofollow: 1, hasKill: true });
  assert.equal(wsl.actual, "wsl");
  assert.equal(wsl.supported, false);
  assert.ok(wsl.missing.includes("WSL host is unsupported"));

  const wslEnvironment = platformStatus({ platform: "linux", release: "5.15.90", env: { WSL_DISTRO_NAME: "Ubuntu" }, hasGetuid: true, nofollow: 1, hasKill: true });
  assert.equal(wslEnvironment.actual, "wsl");
  assert.equal(wslEnvironment.supported, false);

  const missingUid = platformStatus({ platform: "linux", hasGetuid: false, nofollow: 1, hasKill: true });
  assert.equal(missingUid.supported, false);
  assert.ok(missingUid.missing.includes("process.getuid()"));

  const missingUmask = platformStatus({ platform: "linux", hasGetuid: true, hasUmask: false, nofollow: 1, hasKill: true });
  assert.equal(missingUmask.supported, false);
  assert.ok(missingUmask.missing.includes("process.umask()"));

  const missingNoFollow = platformStatus({ platform: "linux", hasGetuid: true, nofollow: 0, hasKill: true });
  assert.equal(missingNoFollow.supported, false);
  assert.ok(missingNoFollow.missing.includes("O_NOFOLLOW"));
});

test("root and ancillary ACP packages declare Linux-only installation", () => {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
  const acpPackage = JSON.parse(readFileSync("packages/pi-harness-acp/package.json", "utf8"));
  assert.deepEqual(rootPackage.os, ["linux"]);
  assert.deepEqual(acpPackage.os, ["linux"]);
});

test("bootstrap rejects an unsupported platform before invoking Pi or mutating settings", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-unsupported-bootstrap-"));
  try {
    const result = runNode(`
      Object.defineProperty(process, "platform", { value: "darwin" });
      await import("./scripts/bootstrap.mjs");
    `, { HOME: home, PATH: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports Linux CLI only/);
    assert.doesNotMatch(result.stderr, /Pi 0\.87\.1 required/);
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("doctor reports unsupported hosts without executing prerequisites", () => {
  const result = runNode(`
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.argv = [process.execPath, "pi-harness", "doctor"];
    await import("./bin/pi-harness.mjs");
  `, { PATH: "" });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.platform.required, "linux");
  assert.deepEqual(report.platform.actual, "darwin");
  assert.equal(report.platform.supported, false);
  assert.equal(report.commands.sh, null);
  assert.equal(report.filesystem.nofollow, false);
  assert.equal(report.git_worktrees, false);
  assert.ok(report.failures.some((failure) => /supports Linux CLI only/.test(failure)));
});

test("WSL rejects Harness bootstrap and doctor execution", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-wsl-bootstrap-"));
  try {
    const bootstrap = runNode(`
      Object.defineProperty(process, "platform", { value: "linux" });
      await import("./scripts/bootstrap.mjs");
    `, { HOME: home, PATH: "", WSL_DISTRO_NAME: "Ubuntu" });
    assert.notEqual(bootstrap.status, 0);
    assert.match(bootstrap.stderr, /actual: wsl/);
    assert.deepEqual(readdirSync(home), []);

    const binDirectory = join(home, "bin");
    const piProbePath = join(home, "pi-invoked");
    mkdirSync(binDirectory);
    const piPath = join(binDirectory, "pi");
    writeFileSync(piPath, `#!/bin/sh\ntouch ${piProbePath}\necho 0.87.1\n`);
    chmodSync(piPath, 0o755);

    const doctor = runNode(`
      Object.defineProperty(process, "platform", { value: "linux" });
      process.argv = [process.execPath, "pi-harness", "doctor"];
      await import("./bin/pi-harness.mjs");
    `, { PATH: binDirectory, WSL_DISTRO_NAME: "Ubuntu" });
    assert.equal(doctor.status, 1, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.platform.actual, "wsl");
    assert.equal(report.platform.supported, false);
    assert.equal(report.pi.ready, false);
    assert.equal(existsSync(piProbePath), false);

    const acp = runNode(`
      Object.defineProperty(process, "platform", { value: "linux" });
      const { assertLinuxCliSupported } = await import("./packages/pi-harness-acp/lib/platform.mjs");
      try { assertLinuxCliSupported(); }
      catch (error) { console.log(error.message); }
    `, { WSL_DISTRO_NAME: "Ubuntu" });
    assert.equal(acp.status, 0, acp.stderr);
    assert.match(acp.stdout, /actual: wsl/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("direct web CLI rejects unsupported hosts before network access", () => {
  const scriptPath = resolve(root, "bin/pi-harness-web.mjs");
  const result = runNode(`
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.argv = [process.execPath, ${JSON.stringify(scriptPath)}, "search", "must not run"];
    await import("./bin/pi-harness-web.mjs");
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supports Linux CLI only/);
  assert.doesNotMatch(result.stderr, /fetch|network/i);
});

test("extension guard rejects unsupported hosts before Harness registration", () => {
  const result = runNode(`
    Object.defineProperty(process, "platform", { value: "win32" });
    await import("./extensions/platform-guard.mjs");
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supports Linux CLI only/);
});

test("Evidence, memory, precise edits, and Worker verification fail before filesystem mutation on unsupported hosts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-platform-gate-"));
  const evidenceDirectory = join(directory, "evidence");
  const projectRoot = join(directory, "project");
  const worktree = join(directory, "worktree");
  mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
  mkdirSync(worktree);
  const editTarget = join(projectRoot, "file.txt");
  writeFileSync(editTarget, "before\n");
  try {
    const evidence = runNode(`
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { storeEvidence } = await import("./lib/evidence.mjs");
      try { storeEvidence({ taskId: "task", kind: "report", content: "evidence" }); }
      catch (error) { console.log(error.message); }
    `, { PI_HARNESS_EVIDENCE_DIR: evidenceDirectory });
    assert.equal(evidence.status, 0, evidence.stderr);
    assert.match(evidence.stdout, /supports Linux CLI only/);
    assert.equal(existsSync(evidenceDirectory), false);

    const memoryDirectory = join(directory, "memory");
    const memory = runNode(`
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { appendProjectMemory } = await import("./lib/memory.mjs");
      try { appendProjectMemory("must not write"); }
      catch (error) { console.log(error.message); }
    `, { PI_HARNESS_MEMORY_DIR: memoryDirectory });
    assert.equal(memory.status, 0, memory.stderr);
    assert.match(memory.stdout, /supports Linux CLI only/);
    assert.equal(existsSync(memoryDirectory), false);

    const preciseEdit = runNode(`
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { replaceHashlines } = await import("./lib/precise-edit.mjs");
      try { replaceHashlines(${JSON.stringify(projectRoot)}, "file.txt", 1, 1, ${JSON.stringify("a".repeat(64))}, "after"); }
      catch (error) { console.log(error.message); }
    `);
    assert.equal(preciseEdit.status, 0, preciseEdit.stderr);
    assert.match(preciseEdit.stdout, /supports Linux CLI only/);
    assert.equal(readFileSync(editTarget, "utf8"), "before\n");

    const verification = runNode(`
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { runWorkerVerification } = await import("./lib/worker-gate.mjs");
      try { await runWorkerVerification(${JSON.stringify(worktree)}, { verification: "true" }, { projectRoot: ${JSON.stringify(projectRoot)} }); }
      catch (error) { console.log(error.message); }
    `);
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /supports Linux CLI only/);
    assert.equal(existsSync(join(worktree, "node_modules")), false);

    const dispatch = runNode(`
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { executeTask } = await import("./lib/executor.mjs");
      const pi = { events: { emit() { console.log("DISPATCHED"); } } };
      try { await executeTask(pi, { owner: "worker", scope: "must not dispatch", permission: "read", verification: "true" }); }
      catch (error) { console.log(error.message); }
    `);
    assert.equal(dispatch.status, 0, dispatch.stderr);
    assert.match(dispatch.stdout, /supports Linux CLI only/);
    assert.doesNotMatch(dispatch.stdout, /DISPATCHED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
