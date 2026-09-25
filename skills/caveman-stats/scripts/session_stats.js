#!/usr/bin/env node
// caveman-stats — read a Claude Code session log (JSONL) and print real token
// usage plus an estimated caveman savings figure.
//
// Standalone distillation of the caveman plugin's stats hook: the plugin-only
// machinery (flag files, mode-transition log, lifetime history, statusline)
// is dropped; what remains reads only the session transcript.
//
// Usage:
//   node session_stats.js [--session-file <transcript.jsonl>] [--mode <level>]
//
//   --session-file  Path to a session JSONL. Default: most recently modified
//                   *.jsonl under $CLAUDE_CONFIG_DIR/projects (~/.claude/projects).
//   --mode          Caveman level active this session (lite|full|ultra|...).
//                   Only 'full' has benchmark data; other values print usage
//                   with no savings estimate. Default: none (no estimate).

const fs = require('fs');
const path = require('path');
const os = require('os');

// Mean per-task savings measured by the caveman benchmarks (avg 65% across
// 10 tasks). Only 'full' has measured data.
const COMPRESSION = { full: 0.65 };

// Approximate Anthropic public output-token pricing, USD per million.
// Most-specific prefixes first — priceForModel returns the first match.
const MODEL_OUTPUT_PRICE_PER_M = [
  ['claude-opus-4-0', 75.0],
  ['claude-opus-4-1', 75.0],
  ['claude-opus-4-2025', 75.0],
  ['claude-opus-4', 25.0],
  ['claude-sonnet-4', 15.0],
  ['claude-haiku-4', 5.0],
  ['claude-3-5-sonnet', 15.0],
  ['claude-3-5-haiku', 4.0],
  ['claude-3-opus', 75.0],
];

function priceForModel(model) {
  if (!model) return null;
  for (const [prefix, price] of MODEL_OUTPUT_PRICE_PER_M) {
    if (model.startsWith(prefix)) return price;
  }
  return null;
}

function formatUsd(amount) {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

// Most recently modified *.jsonl under <claudeDir>/projects.
function findRecentSession(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  let entries;
  try { entries = fs.readdirSync(projectsDir); } catch { return null; }

  let best = null;
  const stack = entries.map((e) => path.join(projectsDir, e));
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      try {
        for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
      } catch {}
    } else if (p.endsWith('.jsonl') && (!best || st.mtimeMs > best.mtime)) {
      best = { file: p, mtime: st.mtimeMs };
    }
  }
  return best ? best.file : null;
}

// Sum assistant-message usage from a session JSONL. Malformed lines skipped.
function parseSession(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { outputTokens: 0, cacheReadTokens: 0, turns: 0, model: null }; }

  let outputTokens = 0;
  let cacheReadTokens = 0;
  let turns = 0;
  let model = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    outputTokens += usage.output_tokens || 0;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    turns++;
    if (!model && entry.message.model) model = entry.message.model;
  }
  return { outputTokens, cacheReadTokens, turns, model };
}

function formatStats({ outputTokens, cacheReadTokens, turns, mode, model, sessionPath }) {
  const sep = '──────────────────────────────────';
  const shortPath = sessionPath && sessionPath.length > 45
    ? '...' + sessionPath.slice(-45)
    : (sessionPath || '');

  if (turns === 0) {
    return `\nCaveman Stats\n${sep}\nNo conversation yet — stats available after first response.\n${sep}\n`;
  }

  const ratio = COMPRESSION[mode] != null ? COMPRESSION[mode] : null;
  const price = priceForModel(model);

  let savings;
  let footer = '';
  if (ratio !== null) {
    const estNormal = Math.round(outputTokens / (1 - ratio));
    const estSaved = estNormal - outputTokens;
    let usdLine = '';
    if (price !== null) {
      const usd = (estSaved / 1_000_000) * price;
      usdLine = `Est. saved (USD):      ~${formatUsd(usd)}\n`;
      footer = `Savings est. from caveman benchmarks (mean per-task). Pricing for ${model}. Actual varies by task.`;
    } else {
      footer = 'Savings est. from caveman benchmarks (mean per-task). Actual varies by task.';
    }
    // Output tokens only: input + cache tokens dominate agentic sessions and
    // are untouched by caveman — a session-usage % would overstate relief.
    footer += ' Reduction is of output tokens only; input/cache usage is unchanged.';
    savings = (`Est. without caveman:  ${estNormal.toLocaleString()}\n` +
      `Est. tokens saved:     ${estSaved.toLocaleString()} (~${Math.round(ratio * 100)}% of output)\n` +
      usdLine).replace(/\n$/, '');
  } else if (mode) {
    savings = `No savings estimate for '${mode}' mode — only 'full' has benchmark data.`;
  } else {
    savings = 'No caveman mode given (--mode) — usage shown without savings estimate.';
  }

  return `\nCaveman Stats\n${sep}\n` +
    (shortPath ? `Session:  ${shortPath}\n` : '') +
    `Turns:    ${turns}\n${sep}\n` +
    `Output tokens:         ${outputTokens.toLocaleString()}\n` +
    `Cache-read tokens:     ${cacheReadTokens.toLocaleString()}\n${sep}\n` +
    `${savings}\n` +
    (footer ? footer + '\n' : '');
}

function main() {
  const args = process.argv.slice(2);
  const argValue = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  const sessionFileArg = argValue('--session-file');
  const mode = argValue('--mode');

  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sessionFile = sessionFileArg || findRecentSession(claudeDir);

  if (!sessionFile) {
    process.stderr.write('caveman-stats: no Claude Code session found.\n');
    process.exit(1);
  }

  const parsed = parseSession(sessionFile);
  process.stdout.write(formatStats({ ...parsed, mode, sessionPath: sessionFile }));
}

if (require.main === module) main();

module.exports = { parseSession, formatStats, priceForModel, formatUsd, COMPRESSION };
