import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { patchCatalogDrain } from "./pi-0.87.1-catalog-drain.mjs";

// Run after the upstream monorepo build, before installation. Rebuild the native
// bundle too: patching only dist/*.js would leave the actual CLI unchanged.
const root = resolve(process.argv[2] || ".");
const codingAgent = "packages/coding-agent";
const manifest = JSON.parse(await readFile(resolve(root, codingAgent, "package.json"), "utf8"));
if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "0.87.1") {
  throw new Error("Catalog drain patch requires upstream Pi 0.87.1 build tree");
}
const targets = [
  ["packages/ai/dist/models.js", "models.js"],
  [`${codingAgent}/dist/core/models-store.js`, "models-store.js"],
  [`${codingAgent}/dist/main.js`, "main.js"],
];
// Validate every source anchor before touching any build output.
const changes = await Promise.all(targets.map(async ([path, file]) => {
  const target = resolve(root, path);
  return [target, patchCatalogDrain(file, await readFile(target, "utf8"))];
}));
for (const [path, source] of changes) await writeFile(path, source);
const result = spawnSync(process.execPath, ["scripts/build-coding-agent-bundle.mjs"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) throw new Error("Patched Pi bundle build failed");
