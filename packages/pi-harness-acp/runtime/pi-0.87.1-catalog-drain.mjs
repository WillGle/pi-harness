// Version-specific runtime patch; never apply this to an immutable Nix store.
export function patchCatalogDrain(file, source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`Unexpected Pi 0.87.1 source: ${file}`);
    source = source.replace(before, after);
  };
  if (file === "models.js") {
    replace("    publicationChains = new Map();", "    publicationChains = new Map();\n    refreshOperations = new Set();");
    replace("            try {\n                await raceWithAbortSignal(operation, signal);", "            this.refreshOperations.add(operation);\n            const forget = () => this.refreshOperations.delete(operation);\n            void operation.then(forget, forget);\n            try {\n                await raceWithAbortSignal(operation, signal);");
    replace("    async resolveRefreshCredential(provider, stored, signal) {", "    async drainRefresh() {\n        for (const controller of this.refreshControllers.values()) controller.abort();\n        while (this.refreshOperations.size || this.publicationChains.size) {\n            await Promise.allSettled([...this.refreshOperations, ...this.publicationChains.values()]);\n        }\n        await this.modelsStore.drain?.();\n    }\n    async resolveRefreshCredential(provider, stored, signal) {");
  } else if (file === "models-store.js") {
    replace("    storage;", "    storage;\n    storageOperations = new Set();");
    replace("        this.storage = new FileAuthStorageBackend(this.path);", "        this.storage = new FileAuthStorageBackend(this.path);\n        const withLockAsync = this.storage.withLockAsync.bind(this.storage);\n        this.storage.withLockAsync = (...args) => {\n            const operation = withLockAsync(...args);\n            this.storageOperations.add(operation);\n            const forget = () => this.storageOperations.delete(operation);\n            void operation.then(forget, forget);\n            return operation;\n        };");
    replace("    parse(content) {", "    async drain() {\n        // Aborted read facades may have already cleared readState.reload.\n        while (this.storageOperations.size) await Promise.allSettled([...this.storageOperations]);\n    }\n    parse(content) {");
  } else if (file === "main.js") {
    replace("        void modelRuntime\n            .refresh({ signal: controller.signal })\n            .catch(() => { })\n            .finally(() => clearTimeout(timeout));", "        const refresh = modelRuntime\n            .refresh({ signal: controller.signal })\n            .catch(() => { })\n            .finally(() => clearTimeout(timeout));\n        const dispose = runtime.dispose.bind(runtime);\n        runtime.dispose = async () => {\n            controller.abort();\n            await refresh;\n            // Public refresh aborts early; physical lock operations must drain.\n            await modelRuntime.models.drainRefresh();\n            await dispose();\n        };");
  } else throw new Error(`Unsupported patch target: ${file}`);
  return source;
}
