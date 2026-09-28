import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultPiEnv } from "./helpers/default-pi.mjs";

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

  const baseEnv = defaultPiEnv();
  const npmCacheResult = spawnSync("npm", ["config", "get", "cache"], { cwd: resolve("."), env: baseEnv, encoding: "utf8" });
  assert.equal(npmCacheResult.status, 0, `npm cache lookup failed: ${npmCacheResult.stderr}`);
  const npmCache = npmCacheResult.stdout.trim();
  const env = {
    ...baseEnv,
    HOME: fakeHome,
    PATH: `${join(npmGlobalPrefix, "bin")}:${baseEnv.PATH}`,
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

    // Pack the ACP workspace and verify its runtime MCP extension ships in the tarball.
    const acpPackResult = spawnSync("npm", ["pack", "--workspace", "packages/pi-harness-acp", "--pack-destination", sandboxDir], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(acpPackResult.status, 0, `ACP npm pack failed: ${acpPackResult.stderr}`);
    const acpTarballName = acpPackResult.stdout.trim().split("\n").pop().trim();
    const acpTarballPath = join(sandboxDir, acpTarballName);
    const acpUnpackDir = join(sandboxDir, "acp-unpacked");
    mkdirSync(acpUnpackDir, { recursive: true });
    const acpUnpackResult = spawnSync("tar", ["-xzf", acpTarballPath, "-C", acpUnpackDir], { encoding: "utf8" });
    assert.equal(acpUnpackResult.status, 0, `ACP tar unpack failed: ${acpUnpackResult.stderr}`);
    const acpPackageDir = join(acpUnpackDir, "package");
    assert.ok(existsSync(join(acpPackageDir, "extensions", "mcp-tools.mjs")), "ACP tarball must include its MCP extension");
    const acpPackageJson = JSON.parse(readFileSync(join(acpPackageDir, "package.json"), "utf8"));
    assert.equal(acpPackageJson.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
    assert.equal(acpPackageJson.dependencies["cross-spawn"], "7.0.6");
    assert.equal(acpPackageJson.dependencies.typebox, "1.3.7");

    const acpInstallDir = join(sandboxDir, "acp-install");
    mkdirSync(acpInstallDir, { recursive: true });
    const acpInstall = spawnSync("npm", ["install", "--offline", "--prefix", acpInstallDir, acpTarballPath], {
      cwd: sandboxDir,
      env: { ...env, npm_config_offline: "true", npm_config_cache: npmCache },
      encoding: "utf8",
    });
    assert.equal(acpInstall.status, 0, `offline ACP install failed: ${acpInstall.stdout} ${acpInstall.stderr}`);
    const installedExtension = join(acpInstallDir, "node_modules", "@will", "pi-harness-acp", "extensions", "mcp-tools.mjs");
    assert.ok(existsSync(installedExtension), "offline install must include the MCP extension");
    const acpVersion = spawnSync(join(acpInstallDir, "node_modules", ".bin", "pi-harness-acp"), ["--version"], {
      cwd: sandboxDir,
      env,
      encoding: "utf8",
    });
    assert.equal(acpVersion.status, 0, `installed ACP executable failed: ${acpVersion.stderr}`);
    assert.equal(acpVersion.stdout.trim(), "1.0.0");

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
