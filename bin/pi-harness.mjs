#!/usr/bin/env node
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySkills } from "../lib/skills.mjs";
import { findReferences, findSymbol } from "../lib/code-intel.mjs";
import { assertSupportedPlatform, platformStatus } from "../lib/platform.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const [command, value] = process.argv.slice(2);

function commandPath(name) {
  if (process.platform !== "linux") return null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function piVersion(piPath) {
  if (!piPath) return { ready: false, version: "unavailable" };
  const pi = spawnSync(piPath, ["--version"], { env: process.env, encoding: "utf8", timeout: 3_000 });
  if (!pi.error && pi.status === 0) return { ready: true, version: `${pi.stdout}${pi.stderr}`.trim() || "unavailable" };
  return { ready: false, version: "unavailable" };
}

function checkToolCallingReadiness(piPath, extensionExists) {
  if (!piPath) return false;
  const input = '{"id":"doc","type":"get_commands"}\n';
  const checkOutput = (output) => {
    for (const line of (output ?? "").split("\n")) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.id === "doc" && parsed.success) {
          const names = parsed.data?.commands?.map((item) => item.name) ?? [];
          return names.includes("plan") && names.includes("goal");
        }
      } catch {}
    }
    return false;
  };
  const run = (args) => spawnSync(piPath, args, { env: process.env, encoding: "utf8", timeout: 15_000, input });
  try {
    if (checkOutput(run(["--mode", "rpc", "--no-session"]).stdout)) return true;
    if (extensionExists && checkOutput(run(["--mode", "rpc", "-e", root, "--no-session"]).stdout)) return true;
  } catch {}
  return false;
}

function probeFilesystem(status) {
  if (!status.supported) return { unix_permissions: false, nofollow: false };
  let directory;
  try {
    directory = mkdtempSync(join(tmpdir(), "pi-harness-doctor-"));
    chmodSync(directory, 0o700);
    const file = join(directory, "private");
    const link = join(directory, "link");
    writeFileSync(file, "probe", { mode: 0o600 });
    symlinkSync(file, link);
    const directoryStat = statSync(directory);
    const fileStat = statSync(file);
    let nofollow = false;
    try {
      const fd = openSync(link, constants.O_RDONLY | constants.O_NOFOLLOW);
      closeSync(fd);
    } catch (error) { nofollow = error.code === "ELOOP"; }
    return {
      unix_permissions: (directoryStat.mode & 0o777) === 0o700 && (fileStat.mode & 0o777) === 0o600 && directoryStat.uid === process.getuid() && fileStat.uid === process.getuid(),
      nofollow,
    };
  } catch {
    return { unix_permissions: false, nofollow: false };
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function probeProcessGroups(status) {
  if (!status.supported || !status.process.process_groups) return false;
  const result = spawnSync(process.execPath, ["-e", "process.kill(-process.pid, 0)"], { detached: true, stdio: "ignore", timeout: 3_000 });
  return !result.error && result.status === 0;
}

function probeGitWorktrees(gitPath, status) {
  if (!status.supported || !gitPath) return false;
  let directory;
  try {
    directory = mkdtempSync(join(tmpdir(), "pi-harness-git-doctor-"));
    const repository = join(directory, "repo");
    const worktree = join(directory, "worktree");
    const run = (args) => spawnSync(gitPath, args, { encoding: "utf8", stdio: "ignore", timeout: 5_000 });
    if (run(["init", "--quiet", repository]).status !== 0) return false;
    if (run(["-C", repository, "-c", "user.name=Pi Harness doctor", "-c", "user.email=doctor@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "doctor"]).status !== 0) return false;
    if (run(["-C", repository, "worktree", "add", "--quiet", "--detach", worktree, "HEAD"]).status !== 0) return false;
    return run(["-C", repository, "worktree", "remove", "--force", worktree]).status === 0;
  } catch {
    return false;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function exactZedEntry() {
  const path = resolve(process.env.HOME ?? "", ".config/zed/settings.json");
  if (!existsSync(path)) return { ready: false, path };
  const text = readFileSync(path, "utf8");
  return { ready: /"pi-harness"\s*:\s*\{[\s\S]*?"command"\s*:\s*"pi-harness-acp"/.test(text), path };
}

function nodeVersionReady(version = process.versions.node) {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}

if (["find-symbol", "references"].includes(command)) {
  if (!value) { console.error(`Usage: pi-harness ${command} <symbol>`); process.exitCode = 2; }
  else {
    try {
      assertSupportedPlatform();
      console.log(JSON.stringify(command === "find-symbol" ? findSymbol(process.cwd(), value) : findReferences(process.cwd(), value), null, 2));
    } catch (error) { console.error(`pi-harness: ${error.message}`); process.exitCode = 1; }
  }
}
else if (command !== "doctor" || (value && value !== "--zed")) {
  console.error("Usage: pi-harness doctor [--zed] | find-symbol <symbol> | references <symbol>");
  process.exitCode = 2;
}
else {
  const basePlatform = platformStatus();
  const filesystem = probeFilesystem(basePlatform);
  const processCapabilities = { ...basePlatform.process, process_groups: probeProcessGroups(basePlatform) };
  const platformMissing = [...basePlatform.missing];
  if (basePlatform.supported && !filesystem.unix_permissions) platformMissing.push("Unix filesystem permission probe");
  if (basePlatform.supported && !filesystem.nofollow) platformMissing.push("O_NOFOLLOW filesystem probe");
  if (basePlatform.supported && !processCapabilities.process_groups) platformMissing.push("Linux process-group probe");
  const platform = {
    ...basePlatform,
    missing: platformMissing,
    supported: basePlatform.supported && filesystem.unix_permissions && filesystem.nofollow && processCapabilities.signals && processCapabilities.process_groups,
  };
  const onLinux = basePlatform.actual === "linux";
  const commands = Object.fromEntries(["sh", "git", "rg", "pi", "npm", "pi-harness-acp"].map((name) => [name === "pi-harness-acp" ? "acp" : name, commandPath(name)]));
  const gitWorktrees = probeGitWorktrees(commands.git, platform);
  const pi = platform.supported ? piVersion(commands.pi) : { ready: false, version: "unavailable" };
  const skills = platform.supported ? verifySkills(root) : { ok: false, errors: [], lock: { skills: {} } };
  const resources = { extension: existsSync(resolve(root, "extensions/pi-harness.ts")), skills: existsSync(resolve(root, "skills/skills.lock.json")) };
  const requiredCommands = ["sh", "git", "rg", "pi", "npm"];
  const commandsReady = requiredCommands.every((name) => commands[name]);
  const toolCalling = platform.supported && pi.ready && checkToolCallingReadiness(commands.pi, resources.extension);
  const zed = value === "--zed" && platform.supported ? { supported: false, ...exactZedEntry() } : { supported: false, ready: false, path: null };
  const failures = [];
  if (!platform.supported) failures.push(`Pi Harness supports Linux CLI only (actual: ${platform.actual}; missing: ${platform.missing.join(", ") || "required Linux safety probe"})`);
  if (!nodeVersionReady()) failures.push(`Node.js >=22.19.0 required; found ${process.version}`);
  if (!commandsReady) failures.push(`Missing required command(s): ${requiredCommands.filter((name) => !commands[name]).join(", ")}`);
  if (platform.supported && pi.version !== "0.87.1") failures.push(`Pi 0.87.1 required; found ${pi.version}`);
  if (!resources.extension || !resources.skills) failures.push("package resources missing");
  if (platform.supported && !skills.ok) failures.push(...skills.errors);
  if (platform.supported && !toolCalling) failures.push("Pi tool-calling extension readiness check failed");
  if (value === "--zed" && platform.supported && !commands.acp) failures.push("experimental pi-harness-acp is not on PATH");
  if (value === "--zed" && platform.supported && !zed.ready) failures.push("experimental Zed agent_servers.pi-harness entry missing");
  if (onLinux && basePlatform.supported && (!filesystem.unix_permissions || !filesystem.nofollow)) failures.push("Linux filesystem safety probe failed");
  if (onLinux && basePlatform.supported && !processCapabilities.process_groups) failures.push("Linux process-group probe failed");
  if (platform.supported && !gitWorktrees) failures.push("Git worktree probe failed");
  console.log(JSON.stringify({
    package: `${pkg.name}@${pkg.version}`,
    supported_surface: "Linux Pi CLI only",
    node: process.version,
    platform,
    commands,
    filesystem,
    process: processCapabilities,
    git_worktrees: gitWorktrees,
    pi,
    resources,
    skills: { count: Object.keys(skills.lock?.skills ?? {}).length, verified: skills.ok },
    provider: "Pi CLI-owned; not inspected",
    toolCalling,
    acp: commands.acp ? "experimental/unsupported" : "unavailable",
    zed,
    failures,
  }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
