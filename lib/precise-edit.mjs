import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_PRECISE_LINES = 200;
export const MAX_PRECISE_BYTES = 200_000;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function projectFile(root, path) {
  if (!path || typeof path !== "string" || isAbsolute(path)) throw new Error("path must be a project-relative file path");
  const realRoot = realpathSync(root);
  const target = realpathSync(resolve(realRoot, path));
  if (relative(realRoot, target).startsWith("..")) throw new Error("path must remain inside the project");
  if (!statSync(target).isFile()) throw new Error("path must name a regular file");
  return target;
}

function sourceLines(source) {
  const lines = [];
  let start = 0;
  for (const match of source.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ text: source.slice(start, match.index), start, end: match.index, newline: match[0] });
    start = match.index + match[0].length;
  }
  if (start < source.length || lines.length === 0) lines.push({ text: source.slice(start), start, end: source.length, newline: "" });
  return lines;
}

function range(lines, startLine, endLine) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error(`line range must be within 1-${lines.length}`);
  if (endLine - startLine + 1 > MAX_PRECISE_LINES) throw new Error(`line range must contain at most ${MAX_PRECISE_LINES} lines`);
  return lines.slice(startLine - 1, endLine);
}

function blockText(source, lines, startLine, endLine) {
  const selected = range(lines, startLine, endLine);
  return source.slice(selected[0].start, selected.at(-1).end);
}

export function readHashlines(root, path, startLine, endLine) {
  const target = projectFile(root, path);
  const source = readFileSync(target, "utf8");
  const lines = sourceLines(source);
  const selected = range(lines, startLine, endLine);
  const block = blockText(source, lines, startLine, endLine);
  if (Buffer.byteLength(block) > MAX_PRECISE_BYTES) throw new Error(`line range must contain at most ${MAX_PRECISE_BYTES} bytes`);
  return {
    path,
    start_line: startLine,
    end_line: endLine,
    sha256: sha256(block),
    lines: selected.map((line, index) => `${startLine + index}#${sha256(line.text).slice(0, 12)} ${line.text}`),
  };
}

export function replaceHashlines(root, path, startLine, endLine, expectedSha256, replacement) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) throw new Error("expected_sha256 must be the 64-character hash from pi_harness_hashlines");
  if (typeof replacement !== "string") throw new Error("replacement must be a string");
  const target = projectFile(root, path);
  const source = readFileSync(target, "utf8");
  const lines = sourceLines(source);
  const selected = range(lines, startLine, endLine);
  const block = blockText(source, lines, startLine, endLine);
  const actualSha256 = sha256(block);
  if (actualSha256 !== expectedSha256) throw new Error("source block changed; run pi_harness_hashlines again before patching");
  const newline = selected.find((line) => line.newline)?.newline ?? "\n";
  const normalizedReplacement = replacement.replace(/\r\n|\n|\r/g, newline);
  const next = `${source.slice(0, selected[0].start)}${normalizedReplacement}${source.slice(selected.at(-1).end)}`;
  const temporary = `${target}.pi-harness-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { encoding: "utf8", mode: statSync(target).mode });
    chmodSync(temporary, statSync(target).mode);
    renameSync(temporary, target);
  } catch (error) {
    throw new Error(`precise patch failed: ${(error).message}`);
  }
  return { path, start_line: startLine, end_line: endLine, previous_sha256: actualSha256, sha256: sha256(normalizedReplacement) };
}
