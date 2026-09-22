#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const migrationDir = join(homedir(), ".pi-harness");
const migrationPath = join(migrationDir, "zed-migration.json");
const zedSettings = join(homedir(), ".config", "zed", "settings.json");
const entry = '"pi-harness": {\n      "type": "custom",\n      "command": "pi-harness-acp",\n      "args": []\n    }';

function sha(text) { return createHash("sha256").update(text).digest("hex"); }
function command(command, args, options = {}) { return spawnSync(command, args, { encoding: "utf8", ...options }); }
function requirePi() {
  const pi = command("pi", ["--version"]); const version = `${pi.stdout}${pi.stderr}`.trim();
  if (pi.status !== 0 || version !== "0.85.1") throw new Error(`Pi 0.85.1 required; found ${version || "unavailable"}`);
}
function matchingBrace(text, open) {
  let depth = 0; let quote = false; let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (!escaped && char === '"') quote = false; escaped = !escaped && char === "\\"; continue; }
    if (char === '"') quote = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  throw new Error("Invalid Zed agent_servers object");
}
function serverRange(text, required = false) {
  const servers = text.match(/"agent_servers"\s*:\s*\{/);
  if (!servers || servers.index === undefined) { if (required) throw new Error("Zed agent_servers object missing"); return undefined; }
  const start = text.indexOf("{", servers.index); const end = matchingBrace(text, start);
  const property = /"pi-harness"\s*:\s*\{/.exec(text.slice(start + 1, end));
  if (!property || property.index === undefined) return { start, end };
  const propertyStart = start + 1 + property.index;
  const objectStart = text.indexOf("{", propertyStart); const objectEnd = matchingBrace(text, objectStart);
  let removeEnd = objectEnd + 1; if (text[removeEnd] === ",") removeEnd += 1;
  return { start, end, propertyStart, objectEnd, removeEnd };
}
function withoutHarness(text) {
  const range = serverRange(text);
  if (!range?.propertyStart) return text;
  return `${text.slice(0, range.propertyStart)}${text.slice(range.removeEnd)}`;
}
function updateZed() {
  if (!existsSync(zedSettings)) throw new Error(`Zed settings not found: ${zedSettings}`);
  const original = readFileSync(zedSettings, "utf8");
  const baseline = sha(withoutHarness(original));
  if (existsSync(migrationPath)) {
    const previous = JSON.parse(readFileSync(migrationPath, "utf8"));
    if (previous.baseline !== baseline) throw new Error("Zed migration fingerprint mismatch; settings were not changed");
  }
  const range = serverRange(original, true);
  const backup = `${zedSettings}.bak-pi-harness-${Date.now()}`;
  writeFileSync(backup, original);
  let updated;
  if (range.propertyStart) updated = `${original.slice(0, range.propertyStart)}${entry},${original.slice(range.removeEnd)}`;
  else updated = `${original.slice(0, range.start + 1)}\n    ${entry},${original.slice(range.start + 1)}`;
  writeFileSync(zedSettings, updated);
  mkdirSync(migrationDir, { recursive: true });
  const temporary = `${migrationPath}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, baseline: sha(withoutHarness(updated)), backup, settings: zedSettings }, null, 2));
  renameSync(temporary, migrationPath);
  return backup;
}

requirePi();
const cliOnly = process.argv[2] === "--cli";
const packageArgs = process.argv.slice(cliOnly ? 3 : 2);
const localAcp = join(root, "packages", "pi-harness-acp");
const defaultPiPkg = existsSync(join(root, "extensions", "pi-harness.ts")) ? root : `${pkg.name}@${pkg.version}`;
const defaultAcpPkg = existsSync(localAcp) ? localAcp : `@will/pi-harness-acp@${pkg.version}`;
const piPkg = process.env.PI_HARNESS_PKG || packageArgs[0] || defaultPiPkg;
const acpPkg = process.env.PI_HARNESS_ACP_PKG || packageArgs[1] || defaultAcpPkg;
const installed = command("pi", ["install", piPkg], { stdio: "inherit" });
if (installed.status !== 0) process.exit(installed.status ?? 1);
if (cliOnly) console.log("Pi Harness installed for Pi CLI.");
else {
  const acp = command("npm", ["install", "--global", acpPkg], { stdio: "inherit" });
  if (acp.status !== 0) process.exit(acp.status ?? 1);
  const backup = updateZed();
  console.log(`Pi Harness installed. Zed backup: ${backup}`);
}
console.log("Provider, model, authentication, aliases, secrets, and environment variables were not changed.");
