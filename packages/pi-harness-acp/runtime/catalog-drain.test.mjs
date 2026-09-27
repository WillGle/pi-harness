import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { patchCatalogDrain } from "./pi-0.87.1-catalog-drain.mjs";

async function patchedModule(specifier, file) {
  const url = new URL(specifier.startsWith("/") ? pathToFileURL(specifier) : import.meta.resolve(specifier));
  const source = patchCatalogDrain(file, await readFile(url, "utf8"));
  // Keep runtime dependencies identical; only the tested module is patched.
  const moduleRequire = createRequire(url);
  const resolved = source.replace(/from "([^"]+)"/g, (_, path) => `from "${path.startsWith("node:") ? path : pathToFileURL(moduleRequire.resolve(path)).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("catalog drain awaits physical provider work after public abort", async () => {
  const entry = new URL(import.meta.resolve("@earendil-works/pi-ai"));
  const { createModels } = await patchedModule(new URL("models.js", entry).pathname, "models.js");
  const entered = deferred(), physical = deferred();
  const models = createModels();
  models.setProvider({ id: "fixture", getModels: () => [], auth: {}, refreshModels: async () => { entered.resolve(); await physical.promise; } });
  const controller = new AbortController();
  const refresh = models.refresh({ allowNetwork: false, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await refresh;
  assert.equal(models.refreshOperations.size, 1);
  let drained = false;
  const drain = models.drainRefresh().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  physical.resolve();
  await drain;
  assert.equal(models.refreshOperations.size, 0);
  assert.equal(models.publicationChains.size, 0);
});

test("catalog drain retains physical lock ownership after read facade abort", async () => {
  const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { FileAuthStorageBackend } = await import(new URL("core/auth-storage.js", entry));
  const { FileModelsStore } = await patchedModule(new URL("core/models-store.js", entry).pathname, "models-store.js");
  const original = FileAuthStorageBackend.prototype.withLockAsync;
  const entered = deferred(), physical = deferred();
  FileAuthStorageBackend.prototype.withLockAsync = async () => { entered.resolve(); await physical.promise; return {}; };
  try {
    const store = new FileModelsStore("/tmp/t11-synthetic-catalog-never-created.json");
    const controller = new AbortController();
    const read = store.read("fixture", { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(read);
    assert.equal(store.readState.reload, undefined);
    assert.equal(store.storageOperations.size, 1);
    let drained = false;
    const drain = store.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    physical.resolve();
    await drain;
    assert.equal(store.storageOperations.size, 0);
  } finally {
    FileAuthStorageBackend.prototype.withLockAsync = original;
  }
});
