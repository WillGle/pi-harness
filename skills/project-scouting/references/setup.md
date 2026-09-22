# Setup Guide

Deploy the project-scouting skill and subagent into various agent coordinators using the instructions below.

## Model Selection (all platforms)

Choose a model available in the host that can handle a small, read-only scouting task. Configure its exact ID in the host's agent definition or spawn call. Check the host's current model list and pricing or usage limits before calling it low cost; names and costs change. If no suitable override is configured, inherit the active model or use `scripts/scout.py` locally.

Alternatively, skip the subagent entirely and run `scripts/scout.py` locally — zero LLM cost, works on any platform.



Claude Code supports local skills and custom subagent definitions.

1. **Install Skill:**
   Copy the `project-scouting` directory into the Claude Code configuration directory:
   - **Per-repository (Recommended):** `.claude/skills/project-scouting/`
   - **Globally:** `~/.claude/skills/project-scouting/`

   Command example:
   ```bash
   mkdir -p .claude/skills
   cp -r ~/dev/skills-central/project-scouting .claude/skills/
   ```

2. **Register Subagent:**
   Copy the subagent definition file to Claude Code's agent registry:
   ```bash
   mkdir -p ~/.claude/agents
   cp ~/dev/skills-central/project-scouting/references/agents/scout-subagent.md ~/.claude/agents/scout-subagent.md
   ```

3. **Verify Installation:**
   Start the Claude Code CLI and trigger the skill:
   ```bash
   claude
   > scout project
   ```

## Codex Integration

Codex utilizes a pluggable skill registry.

1. **Install Skill:**
   Place the `project-scouting` folder inside the local `skills/` directory:
   ```bash
   cp -r ~/dev/skills-central/project-scouting skills/
   ```

2. **Register Subagent:**
   Codex automatically indexes markdown files under `skills/*/references/agents/*.md`. Ensure the subagent is discovered.

## Non-Subagent / Simple LLM CLI Setup

If the agent coordinator does not support spawning custom subagents, the main coordinator agent must execute the local scout script directly upon entering the workspace:

```bash
# Execute local scouter using Nix Python environment
nix run nixpkgs#python3 -- project-scouting/scripts/scout.py .

# Or using standard python3 if available locally
python3 project-scouting/scripts/scout.py .
```

After execution, the agent should read the newly created `.scout_report.md` in the workspace root instead of listing directory contents or reading entire source files.
