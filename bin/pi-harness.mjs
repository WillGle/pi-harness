#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySkills } from "../lib/skills.mjs";
import { findReferences, findSymbol } from "../lib/code-intel.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const [command, value] = process.argv.slice(2);
const commandPath = (name) => { const found = spawnSync("sh", ["-c", `command -v ${name}`], { env: process.env, encoding: "utf8" }); return found.status === 0 ? found.stdout.trim() : undefined; };
const piVersion = () => {
  const pi = spawnSync("sh", ["-c", "pi --version"], { env: process.env, encoding: "utf8", timeout: 3_000 });
  if (!pi.error && pi.status === 0) return { ready: true, version: `${pi.stdout}${pi.stderr}`.trim() || "unavailable" };
  if (pi.error?.code === "EPERM" && commandPath("pi")) {
    try { const installed = JSON.parse(readFileSync(resolve(dirname(realpathSync(commandPath("pi"))), "../..", "package.json"), "utf8")); return { ready: false, version: installed.version, execution: "sandbox-blocked" }; } catch {}
  }
  return { ready: false, version: "unavailable" };
};
function exactZedEntry() {
  const path = resolve(process.env.HOME ?? "", ".config/zed/settings.json");
  if (!existsSync(path)) return { ready: false, path };
  const text = readFileSync(path, "utf8");
  return { ready: /"pi-harness"\s*:\s*\{[\s\S]*?"command"\s*:\s*"pi-harness-acp"/.test(text), path };
}
function checkToolCallingReadiness(piReady, extensionExists) {
  if (!piReady) return false;
  const checkOutput = (output) => {
    if (!output) return false;
    for (const line of output.split("\n")) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.id === "doc" && parsed.success) {
          const names = parsed.data?.commands?.map((c) => c.name) ?? [];
          return names.includes("plan") && names.includes("goal");
        }
      } catch {}
    }
    return false;
  };

  try {
    // 1. Try default Pi RPC (package installed via pi install)
    let rpc = spawnSync("sh", ["-c", `printf '{"id":"doc","type":"get_commands"}\\n' | pi --mode rpc --no-session`], {
      env: process.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (checkOutput(rpc.stdout)) return true;

    // 2. Fallback to -e "${root}" for development / source checkout
    if (extensionExists) {
      rpc = spawnSync("sh", ["-c", `printf '{"id":"doc","type":"get_commands"}\\n' | pi --mode rpc -e "${root}" --no-session`], {
        env: process.env,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (checkOutput(rpc.stdout)) return true;
    }
  } catch {}
  return false;
}
if (["find-symbol", "references"].includes(command)) {
  if (!value) { console.error(`Usage: pi-harness ${command} <symbol>`); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(command === "find-symbol" ? findSymbol(process.cwd(), value) : findReferences(process.cwd(), value), null, 2)); }
    catch (error) { console.error(`pi-harness: ${error.message}`); process.exitCode = 1; }
  }
}
else if (command !== "doctor" || (value && value !== "--zed")) { console.error("Usage: pi-harness doctor [--zed] | find-symbol <symbol> | references <symbol>"); process.exitCode = 2; }
else {
  const pi = piVersion(); const skills = verifySkills(root); const zed = exactZedEntry();
  const resources = { extension: existsSync(resolve(root, "extensions/pi-harness.ts")), skills: existsSync(resolve(root, "skills/skills.lock.json")) };
  const toolCalling = checkToolCallingReadiness(pi.ready, resources.extension);
  const failures = [];
  if (pi.version !== "0.87.1") failures.push(`Pi 0.87.1 required; found ${pi.version}`);
  if (!resources.extension || !resources.skills) failures.push("package resources missing");
  if (!skills.ok) failures.push(...skills.errors);
  if (!toolCalling) failures.push("Pi tool-calling extension readiness check failed");
  if (value === "--zed" && !commandPath("pi-harness-acp")) failures.push("pi-harness-acp is not on PATH");
  if (value === "--zed" && !zed.ready) failures.push("exact Zed agent_servers.pi-harness entry missing");
  console.log(JSON.stringify({
    package: `${pkg.name}@${pkg.version}`, node: process.version, pi,
    resources, commands: { pi: commandPath("pi"), acp: commandPath("pi-harness-acp") },
    skills: { count: Object.keys(skills.lock?.skills ?? {}).length, verified: skills.ok },
    provider: "Pi/Zed-owned; not inspected", toolCalling,
    acp: commandPath("pi-harness-acp") ? "available" : "unavailable", zed, failures,
  }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
