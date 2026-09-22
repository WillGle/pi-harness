---
name: project-scouting
description: >
  Establishes a token-efficient workspace mental model upon first entry by delegating
  structural discovery to a cheap scout subagent (cheapest/lite model tier) or a
  zero-token local script, instead of reading raw directories and files directly in
  the main thread. The scout returns a compressed report; main thread reads the report
  and targets only 2–5 relevant files instead of the whole workspace.
  Trigger: "scout project", "scouting codebase", "first-time entry", "explore repository",
  "understand this project", "what's in this repo".
---

# Project Scouting

You = coordinator. Scout = cheap throwaway agent or zero-token script. Scout reads the workspace. You read the scout's report. Do not read raw directories or files until the report exists.

## Mandatory: run scout on first entry

Before doing any other work in a new workspace:

1. Check if `.scout_report.md` exists at the workspace root.
2. If missing, generate it — either via a scout on an available low-cost model (or the active model if no suitable override is known) or the local script (zero LLM cost):
   ```bash
   python3 <skill-dir>/scripts/scout.py .
   # or, if python3 unavailable:
   nix run nixpkgs#python3 -- <skill-dir>/scripts/scout.py .
   ```
   `<skill-dir>` is wherever this skill is installed (e.g. `.claude/skills/project-scouting`).
   If the script is absent from an installed copy, inspect the project directly with read-only tools and produce the same compact report. Never guess a model name or call a missing script.
3. **Gitignore the report** — `.scout_report.md` is a regenerable, per-machine
   artifact; it must NOT be committed. If the workspace is a git repo and the
   file isn't already ignored, add it:
   ```bash
   grep -qxF '.scout_report.md' .gitignore 2>/dev/null || echo '.scout_report.md' >> .gitignore
   ```
4. Read `.scout_report.md`. Identify tech stack, entry points, documentation, and directory layout.
5. Pick 2–5 files relevant to the current user request. Read those only. Stop.

## Why this exists (the real win)

Reading a workspace naively — `ls -R`, full README, every config — burns 50–300k tokens on orientation before a single line of productive work. That orientation context also crowds out code. The scout avoids this by doing the orientation in a cheap throwaway model: the cheapest/lite tier (small model variant — not fast/extended-thinking mode, which costs more) on any platform costs a fraction of the flagship model, sits in a different usage bucket on most coordinators, and returns a compressed report instead of raw files. Main context only sees the compressed output, not the raw workspace content. The token cost of orientation drops to near-zero; usage-limit budget is preserved for the actual task.

## When to use what

| Situation | Use |
|---|---|
| Subagent registry available (Claude Code, OpenCode…) | Spawn `scout-subagent` with a model configured in that host's agent registry; otherwise inherit the active model |
| No subagent support, python3/nix available | Run `scripts/scout.py` locally — zero LLM cost, instant |
| `.scout_report.md` already exists and is recent | Read it directly, skip re-generation |
| Workspace changed significantly (files added/moved/deleted) | Re-run scout to overwrite the stale report |
| Task is highly scoped (you already know the 1–2 files needed) | Skip scout, read directly |

## Setup

The subagent definition ships with this skill in [references/agents/scout-subagent.md](references/agents/scout-subagent.md). Copy it once into the host coordinator's agent registry:
- **Claude Code:** `.claude/agents/scout-subagent.md` or `~/.claude/agents/scout-subagent.md`
- **OpenCode:** `.opencode/agent/scout-subagent.md`
- **Other hosts:** their equivalent agent registry directory

On coordinators without an agent registry, skip the subagent and run `scripts/scout.py` directly — see [references/setup.md](references/setup.md) for per-host instructions.

## What NOT to do

- Don't list full directories or read whole files to "get a feel" for the project — that's what the scout is for.
- Don't spawn scout on a workspace you already have a fresh `.scout_report.md` for.
- Don't guess a model name or its cost. Configure a suitable available model in the host, or use the local script.
- Don't read the scout's raw tool calls — only its final compressed report matters. Main thread stays clean.
- Don't skip re-scouting after major structural changes; a stale report will misdirect file targeting.

## Output the scout returns

The scout subagent returns a compact report (not injected raw files). Main thread should expect:

```
# Scout Findings: <project-name>
- **Stack:** <language, framework, build tool>
- **Structure:** <1–2 sentence layout summary>
- **Agent instruction files:** <AGENTS.md / claude.md / codex.md if found>
- **Entry points:** <key files>
- **Target files for task:** <2–5 files to inspect first>
- **Token warning:** <any large dirs or files to avoid>
```

## Resources

- `scripts/scout.py` — local scanner, zero LLM cost, writes `.scout_report.md`.
- [references/agents/scout-subagent.md](references/agents/scout-subagent.md) — subagent definition and output contract.
- [references/setup.md](references/setup.md) — per-host install guide (Claude Code, Codex, plain CLI fallback).
