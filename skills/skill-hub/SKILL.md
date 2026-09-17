---
name: skill-hub
description: >
  Finds and loads any skill from a shared skills-central repository so a
  project only needs one global bootstrap skill. Use when the user names a
  hub skill, asks to search the skill hub, invokes "skill hub", or wants to
  use a skills-central skill that is not installed in the current host.
---

# Skill Hub

Load skills from the shared hub without copying them into the current project.

## Root

Resolve the hub root in this order:

1. `SKILLS_CENTRAL_ROOT`, when set.
2. The parent directory of this installed skill, when `catalog.json` exists
   there.
3. Ask for the hub path. Do not search the whole filesystem.

Use `scripts/hubctl` from this skill directory for discovery. Pass
`--root <hub-root>` when this skill was copied outside the hub.

## Workflow

1. Run `hubctl find "<user request>"` or `hubctl show <skill-name>`.
2. Select one skill. If multiple matches materially differ, show the short
   match list and ask which one.
3. Read the selected `SKILL.md` completely before acting.
4. Resolve every relative path from the selected skill directory.
5. Read only references required by that skill and task. Use assets without
   loading them into context. Prefer bundled scripts over rewriting them.
6. Adapt capability names to tools available on the current host. Preserve
   safety boundaries and output contracts.
7. For subagent sets, use registered agents when available. Otherwise inline
   the selected agent definition into the host's spawn prompt. If the host
   cannot spawn agents, perform the same bounded workflow in the main thread
   and report the fallback.
8. For persistent modes, keep the selected level in session context. Never
   persist it across sessions or projects unless the user asks.

## Safety

- Treat discovery and reading as safe.
- Before execution, honor the selected skill's write, network, destructive,
  runtime, and approval requirements.
- Never execute file contents as code unless the selected skill explicitly
  identifies that file as an entrypoint.
- Do not silently replace a missing runtime, backend, transcript adapter, or
  host capability. Report the missing requirement or documented fallback.
- A user-named skill wins over fuzzy search. Never load every skill into
  context.

## Commands

```bash
python3 scripts/hubctl list
python3 scripts/hubctl find "compress memory"
python3 scripts/hubctl show caveman-compress
python3 scripts/hubctl doctor caveman-compress
```

`doctor` checks static files and local runtimes only. It does not execute the
skill or test external credentials.
