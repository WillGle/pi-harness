import { constants } from "node:fs";
import { release as osRelease } from "node:os";

export function platformStatus({
  platform = process.platform,
  release = osRelease(),
  env = process.env,
  hasGetuid = typeof process.getuid === "function",
  hasUmask = typeof process.umask === "function",
  nofollow = constants.O_NOFOLLOW,
  hasKill = typeof process.kill === "function",
} = {}) {
  const wsl = platform === "linux" && (/microsoft|wsl/i.test(release) || Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
  const linux = platform === "linux" && !wsl;
  const filesystem = {
    unix_permissions: linux && hasGetuid && hasUmask,
    nofollow: Number.isInteger(nofollow) && nofollow !== 0,
  };
  const processCapabilities = {
    signals: hasKill && typeof process.kill === "function",
    process_groups: linux && hasKill,
  };
  const missing = [];
  if (!linux) missing.push(wsl ? "WSL host is unsupported" : "Linux host");
  if (!hasGetuid) missing.push("process.getuid()");
  if (linux && !hasUmask) missing.push("process.umask()");
  if (!filesystem.nofollow) missing.push("O_NOFOLLOW");
  if (!processCapabilities.signals) missing.push("process signals");
  if (!processCapabilities.process_groups) missing.push("Linux process groups");
  return {
    required: "linux",
    actual: wsl ? "wsl" : platform,
    supported: missing.length === 0,
    missing,
    filesystem,
    process: processCapabilities,
  };
}

export function assertSupportedPlatform() {
  const status = platformStatus();
  if (!status.supported) {
    throw new Error(`Pi Harness supports Linux CLI only (actual: ${status.actual}; missing: ${status.missing.join(", ")}).`);
  }
  return status;
}
