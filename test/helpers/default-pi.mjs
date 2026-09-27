import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, relative, resolve } from "node:path";

function npmInjectedBinDirs(cwd) {
  const directories = new Set();
  for (let current = resolve(cwd); ; current = dirname(current)) {
    directories.add(resolve(current, "node_modules", ".bin"));
    const parent = dirname(current);
    if (parent === current) return directories;
  }
}

// npm run prepends node_modules/.bin at the project and each parent directory.
// Remove those injected entries so integration children use the caller's default PATH.
export function defaultPiEnv(env = process.env, cwd = process.cwd()) {
  const injected = npmInjectedBinDirs(cwd);
  const childEnv = { ...env };
  delete childEnv.PI_BIN;
  childEnv.PATH = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !injected.has(resolve(entry)))
    .join(delimiter);
  return childEnv;
}

function findDefaultPi() {
  const path = defaultPiEnv().PATH;
  for (const directory of path.split(delimiter)) {
    const candidate = resolve(directory || ".", "pi");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {}
  }
  throw new Error("No default pi executable found after excluding npm-injected node_modules/.bin entries");
}

export const DEFAULT_PI_EXECUTABLE = findDefaultPi();

function cliBundleEntry(executable) {
  const realExecutable = realpathSync(executable);
  if (/[\\/]dist[\\/]bundle[\\/]cli\.js$/.test(realExecutable)) return realExecutable;

  const wrapper = readFileSync(realExecutable, "utf8");
  const wrappedPath = wrapper.match(/["']([^"']*\/\.pi-wrapped)["']/)?.[1];
  if (!wrappedPath || !existsSync(wrappedPath)) {
    throw new Error(`Cannot identify Pi bundle from default executable: ${realExecutable}`);
  }
  const wrapped = readFileSync(realpathSync(wrappedPath), "utf8");
  const entry = wrapped.match(/(\/[^\s"']*[\\/]dist[\\/]bundle[\\/]cli\.js)/)?.[1];
  if (!entry || !existsSync(entry)) {
    throw new Error(`Cannot identify Pi bundle from wrapper: ${wrappedPath}`);
  }
  return realpathSync(entry);
}

function bundleFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return bundleFiles(root, path);
    return entry.isFile() ? [path] : [];
  });
}

export function defaultPiFingerprint(executable = DEFAULT_PI_EXECUTABLE) {
  const entry = cliBundleEntry(executable);
  const root = dirname(entry);
  const files = bundleFiles(root).sort();
  const hash = createHash("sha256");
  const source = [];
  for (const file of files) {
    const content = readFileSync(file);
    hash.update(relative(root, file)).update("\0").update(content).update("\0");
    if (/\.(?:c?js|mjs)$/.test(file)) source.push(content.toString("utf8"));
  }
  const combined = source.join("\n");
  const markers = ["drainRefresh", "refreshOperations", "storageOperations"];
  return {
    executable,
    bundle: root,
    sha256: hash.digest("hex"),
    catalogDrainPatched: markers.every((marker) => combined.includes(marker)),
  };
}

const fingerprint = defaultPiFingerprint();
if (!fingerprint.catalogDrainPatched) {
  throw new Error(
    `Default Pi executable ${fingerprint.executable} has an unpatched bundle: ${fingerprint.bundle} sha256=${fingerprint.sha256}`,
  );
}
console.log(`# Default Pi: ${fingerprint.executable}`);
console.log(`# Pi bundle: ${fingerprint.bundle} sha256=${fingerprint.sha256} catalogDrainPatched=true`);
