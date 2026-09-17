import { spawnSync } from "node:child_process";

export const MAX_CODE_INTEL_RESULTS = 100;
const MAX_OUTPUT_BYTES = 1_000_000;

function executable(candidates, marker) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 3_000 });
    if (!result.error && marker.test(`${result.stdout}\n${result.stderr}`)) return candidate;
  }
  return undefined;
}

function validateSymbol(symbol) {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol ?? "")) throw new Error("symbol must be one identifier");
  return symbol;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error) throw new Error(`${command} unavailable: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) throw new Error(`${command} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

function ripgrep(root, symbol, declarationOnly = false) {
  const pattern = declarationOnly
    ? `\\b(?:function|class|interface|type|const|let|var|def|func|struct|trait|enum)\\s+${symbol}\\b`
    : `\\b${symbol}\\b`;
  const output = run("rg", ["--json", "--color", "never", "-e", pattern, root], root);
  const matches = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type !== "match") continue;
    matches.push({ path: event.data.path.text, line: event.data.line_number, column: event.data.submatches[0]?.start + 1, text: event.data.lines.text.trimEnd() });
    if (matches.length === MAX_CODE_INTEL_RESULTS) break;
  }
  return { provider: "ripgrep (text fallback)", symbol, matches, truncated: matches.length === MAX_CODE_INTEL_RESULTS };
}

function astGrep(root, symbol) {
  const command = executable(["ast-grep", "sg"], /ast-grep/i);
  if (!command) return undefined;
  const output = run(command, ["run", "--pattern", symbol, "--json=compact", root], root);
  const raw = JSON.parse(output || "[]");
  const matches = (Array.isArray(raw) ? raw : []).slice(0, MAX_CODE_INTEL_RESULTS).map((match) => ({
    path: match.file,
    line: match.range?.start?.line + 1,
    column: match.range?.start?.column + 1,
    text: match.text ?? match.lines,
  }));
  return { provider: `ast-grep (${command})`, symbol, matches, truncated: raw.length > matches.length };
}

function ctags(root, symbol) {
  const command = executable(["ctags"], /universal ctags/i);
  if (!command) return undefined;
  const output = run(command, ["--output-format=json", "--fields=+n", "-R", "-f", "-", root], root);
  const matches = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const tag = JSON.parse(line);
    if (tag._type !== "tag" || tag.name !== symbol) continue;
    matches.push({ path: tag.path, line: tag.line, kind: tag.kind, scope: tag.scope, language: tag.language });
    if (matches.length === MAX_CODE_INTEL_RESULTS) break;
  }
  return { provider: "Universal Ctags", symbol, matches, truncated: matches.length === MAX_CODE_INTEL_RESULTS };
}

export function findSymbol(root, symbol) {
  symbol = validateSymbol(symbol);
  return ctags(root, symbol) ?? astGrep(root, symbol) ?? ripgrep(root, symbol, true);
}

export function findReferences(root, symbol) {
  symbol = validateSymbol(symbol);
  return astGrep(root, symbol) ?? ripgrep(root, symbol);
}
