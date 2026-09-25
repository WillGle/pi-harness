---
name: caveman-stats
description: >
  Show real token usage and estimated caveman savings for the current session.
  Reads directly from the coordinator's session transcript (JSONL) — no AI
  estimation of the counts. Trigger: /caveman-stats, "caveman stats",
  "token stats", "how many tokens saved".
allowed-tools: [Bash]
---

Report real session token usage. Numbers come from the session transcript, never from guessing.

## Process

1. Run the bundled script from the directory containing this SKILL.md:

   ```bash
   node scripts/session_stats.js --session-file <transcript_path> --mode <level>
   ```

   - `--session-file`: the current session's JSONL transcript if known; omit to auto-pick the most recently modified transcript under `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`). Any coordinator can pass its own transcript here as long as it is JSONL with `{type: "assistant", message: {usage, model}}` rows — the contract is the format, not the host.
   - `--mode`: the caveman level active this session (`full`, `lite`, `ultra`, ...), if any. Only `full` has benchmark data (65% mean output reduction); other levels print usage without a savings estimate. Omit when caveman is not active.

2. Show the script output to the user verbatim. Do not recompute or "improve" the numbers.

## Honesty rules

- Savings apply to OUTPUT tokens only. Input and cache tokens dominate agentic sessions and are unchanged — never present the estimate as a share of session usage, budget, or plan limits.
- If the script errors (no session found, unreadable file), report the error as-is. Never fabricate counts.
