import { createHash } from "node:crypto";

const PI_TOOL_NAME_MAX = 64;

function slug(value) {
  const result = String(value).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return result || "x";
}

export function createMcpPiToolNames(servers) {
  const used = new Set();
  return servers.flatMap((server, serverIndex) => (server.tools ?? []).map((tool, toolIndex) => {
    const digest = createHash("sha256")
      .update(server.name).update("\0")
      .update(tool.name)
      .digest("hex").slice(0, 12);
    const prefix = `mcp_${slug(server.name).slice(0, 16)}_${slug(tool.name).slice(0, 20)}`;
    const base = `${prefix}_${digest}`.slice(0, PI_TOOL_NAME_MAX);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) {
      const tail = `_${suffix}`;
      name = `${base.slice(0, PI_TOOL_NAME_MAX - tail.length)}${tail}`;
    }
    used.add(name);
    return { serverIndex, toolIndex, name };
  }));
}
