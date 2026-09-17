#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySkills } from "../lib/skills.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = verifySkills(root);
console.log(JSON.stringify({ source: result.lock?.source, commit: result.lock?.commit, ok: result.ok, errors: result.errors }, null, 2));
process.exitCode = result.ok ? 0 : 1;
