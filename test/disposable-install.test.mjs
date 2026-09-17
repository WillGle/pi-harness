import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("disposable install: exact tarball pack, bootstrap.mjs execution, unpacked package doctor, and Zed fingerprint protection", () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), "pi-disposable-install-"));
  const fakeHome = join(sandboxDir, "home");
  const npmGlobalPrefix = join(fakeHome, ".npm-global");
  const zedConfigDir = join(fakeHome, ".config", "zed");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(npmGlobalPrefix, { recursive: true });
  mkdirSync(zedConfigDir, { recursive: true });

  const zedSettingsPath = join(zedConfigDir, "settings.json");
  const initialZedSettings = JSON.stringify(
    {
      agent_servers: {},
      theme: "One Dark",
      buffer_font_size: 14,
    },
    null,
    2
  );
  writeFileSync(zedSettingsPath, initialZedSettings);

  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${join(npmGlobalPrefix, "bin")}:${process.env.PATH}`,
    npm_config_prefix: npmGlobalPrefix,
  };

  try {
    // 1. Pack exact package from repository root
    const rootDir = resolve(".");
    const packResult = spawnSync("npm", ["pack", "--pack-destination", sandboxDir], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(packResult.status, 0, `npm pack failed: ${packResult.stderr}`);
    const tarballName = packResult.stdout.trim().split("\n").pop().trim();
    const tarballPath = join(sandboxDir, tarballName);

    // 2. Unpack exact package tarball
    const unpackDir = join(sandboxDir, "unpacked");
    mkdirSync(unpackDir, { recursive: true });
    const unpackResult = spawnSync("tar", ["-xzf", tarballPath, "-C", unpackDir], { encoding: "utf8" });
    assert.equal(unpackResult.status, 0, `tar unpack failed: ${unpackResult.stderr}`);
    const packageDir = join(unpackDir, "package");
    assert.ok(existsSync(packageDir), "Unpacked package directory must exist");

    // 3. Execute scripts/bootstrap.mjs directly in disposable sandbox
    const bootstrapScript = resolve("scripts/bootstrap.mjs");
    const acpPkgDir = resolve("packages/pi-harness-acp");
    const bootstrapRun = spawnSync("node", [bootstrapScript], {
      cwd: sandboxDir,
      env: {
        ...env,
        PI_HARNESS_PKG: packageDir,
        PI_HARNESS_ACP_PKG: acpPkgDir,
      },
      encoding: "utf8",
    });
    assert.equal(bootstrapRun.status, 0, `scripts/bootstrap.mjs failed: ${bootstrapRun.stdout} ${bootstrapRun.stderr}`);

    // Verify pi-harness-acp is executable on PATH
    const acpWhich = spawnSync("sh", ["-c", "command -v pi-harness-acp"], { env, encoding: "utf8" });
    assert.equal(acpWhich.status, 0, "pi-harness-acp must be executable on PATH");
    assert.ok(acpWhich.stdout.includes(npmGlobalPrefix));

    // Verify Zed settings updated with pi-harness entry
    const updatedZed = readFileSync(zedSettingsPath, "utf8");
    assert.ok(updatedZed.includes('"command": "pi-harness-acp"'));

    // Verify migration fingerprint file exists
    const zedMigrationDir = join(fakeHome, ".pi-harness");
    const zedMigrationPath = join(zedMigrationDir, "zed-migration.json");
    assert.ok(existsSync(zedMigrationPath));
    const migration = JSON.parse(readFileSync(zedMigrationPath, "utf8"));
    assert.ok(migration.baseline);
    assert.ok(existsSync(migration.backup));

    // 4. Verify fingerprint mismatch detection prevents corrupt overwrites
    // Tamper with Zed settings without updating migration baseline
    writeFileSync(zedSettingsPath, '{\n  "agent_servers": { "foreign": {} }\n}');
    const tamperingRun = spawnSync("node", [bootstrapScript], {
      cwd: sandboxDir,
      env: {
        ...env,
        PI_HARNESS_PKG: packageDir,
        PI_HARNESS_ACP_PKG: acpPkgDir,
      },
      encoding: "utf8",
    });
    assert.equal(tamperingRun.status, 1, "tampered Zed settings must cause bootstrap to fail");
    assert.match(tamperingRun.stderr, /Zed migration fingerprint mismatch/);

    // Restore valid Zed settings with pi-harness entry for doctor verification
    writeFileSync(zedSettingsPath, updatedZed);

    // 5. Run pi-harness doctor against the UNPACKED PACKAGE (not checkout)
    const unpackedDoctorBin = join(packageDir, "bin", "pi-harness.mjs");
    const doctorRun = spawnSync("node", [unpackedDoctorBin, "doctor"], {
      cwd: sandboxDir,
      env,
      encoding: "utf8",
    });

    assert.equal(doctorRun.status, 0, `unpacked package doctor failed: ${doctorRun.stdout} ${doctorRun.stderr}`);
    const doctorJson = JSON.parse(doctorRun.stdout);
    assert.equal(doctorJson.failures.length, 0);
    assert.equal(doctorJson.pi.ready, true);
    assert.equal(doctorJson.toolCalling, true);
    assert.equal(doctorJson.skills.verified, true);
    assert.equal(doctorJson.acp, "available");
    assert.equal(doctorJson.zed.ready, true);
  } finally {
    try {
      rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  }
});
