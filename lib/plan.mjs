export const PLAN_ENTRY = "pi-harness-plan-state";

export const READ_ONLY_TOOLS = new Set(["read", "ls", "find", "grep", "bash", "pi_harness_hashlines", "pi_harness_find_symbol", "pi_harness_references", "pi_harness_status"]);
const SAFE_PROGRAMS = new Set(["cat", "cut", "find", "git", "head", "ls", "pwd", "rg", "sed", "sort", "stat", "tail", "wc"]);
const FORBIDDEN_SHELL = /[;&`$()<>\n\r]|\|\||&&|\$\{|\*|\?/;
const FORBIDDEN_WORDS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-f", "--force", "--output", "-o", "-i", "--in-place"]);
const GIT_READ_COMMANDS = new Set(["branch", "diff", "log", "ls-files", "remote", "rev-parse", "show", "status", "tag"]);

export function planState(enabled = false, plan = []) {
  return { enabled: Boolean(enabled), plan: Array.isArray(plan) ? plan : [], updatedAt: new Date().toISOString() };
}

export function restore(entries, type) {
  return [...(entries ?? [])].reverse().find((entry) => entry?.customType === type)?.data;
}

export function parsePlan(args) {
  const value = String(args ?? "").trim().toLowerCase();
  if (["on", "off", "status"].includes(value)) return value;
  throw new Error("Usage: /plan on|off|status");
}

function safeWords(command) {
  if (!command?.trim() || FORBIDDEN_SHELL.test(command)) return undefined;
  const pipelines = command.trim().split("|");
  if (pipelines.some((part) => !part.trim())) return undefined;
  const words = pipelines.map((part) => part.trim().split(/\s+/));
  if (words.some((segment) => !SAFE_PROGRAMS.has(segment[0]) || segment.some((word) => FORBIDDEN_WORDS.has(word)))) return undefined;
  return words;
}

function safeProgramArgs(program, args) {
  if (program === "git") return GIT_READ_COMMANDS.has(args[0]) && !args.slice(1).some((arg) => arg === "--upload-pack" || arg.startsWith("--exec="));
  if (program === "find") return !args.some((arg) => arg.startsWith("-exec") || arg.startsWith("-delete") || arg.startsWith("-ok"));
  if (program === "sed") return !args.some((arg) => arg.startsWith("-i") || arg.startsWith("--in-place"));
  return ["cat", "head", "ls", "pwd", "rg", "sed", "sort", "stat", "tail", "wc", "cut"].includes(program);
}

/** A deliberately small shell grammar: commands joined only by a simple pipe. */
export function isReadOnlyBash(command) {
  const segments = safeWords(command);
  return Boolean(segments && segments.every(([program, ...args]) => safeProgramArgs(program, args)));
}

export function isPlanAllowedTool(name, input = {}) {
  if (!READ_ONLY_TOOLS.has(name)) return false;
  return name !== "bash" || isReadOnlyBash(String(input.command ?? ""));
}
