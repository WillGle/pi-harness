import { release } from "node:os";

export function assertLinuxCliSupported() {
  const wsl = process.platform === "linux" && (
    /microsoft|wsl/i.test(release())
    || Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
  if (process.platform !== "linux" || wsl) {
    throw new Error(`Pi Harness supports Linux CLI only outside WSL (actual: ${wsl ? "wsl" : process.platform}).`);
  }
}
