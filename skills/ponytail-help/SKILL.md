---
name: ponytail-help
description: >
  Quick-reference card for all ponytail modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /ponytail-help,
  "ponytail help", "what ponytail commands", "how do I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | `/skill:ponytail lite` in Pi | Build what's asked, name the lazier alternative in one line. |
| **Full** | `/skill:ponytail` in Pi | Simplest implementation that preserves the full TaskOrder. Default. |
| **Ultra** | `/skill:ponytail ultra` in Pi | Remove extras outside TaskOrder first; preserve required work. |

Ponytail is explicit-only in Pi; invoke with `/skill:ponytail [level]`. Other hosts may provide aliases.
Level sticks until changed or session end.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/skill:ponytail` in Pi | Minimal implementation that preserves requested capability and architecture. |
| **ponytail-review** | `/ponytail-review` | Over-engineering review: `L42: yagni: factory, one product. Inline.` |
| **ponytail-audit** | `/ponytail-audit` | Whole-repo over-engineering audit: ranked list of what to delete. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `ponytail:` shortcut comments into a tracked ledger. |
| **ponytail-gain** | `/ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/ponytail-help` | This card. |

In Pi, invoke each skill as `/skill:<skill-name>`. Codex uses `@ponytail`, `@ponytail-review`, and `@ponytail-help`; Claude Code
and OpenCode use the slash-command forms above (OpenCode ships all six as
slash commands).

## Deactivate

Say "stop ponytail" or "normal mode". Resume with `/skill:ponytail` in Pi; other hosts may provide aliases.

## Default Mode

Default mode = `full`. Explicitly activate with `/skill:ponytail` in Pi; switch with `/skill:ponytail <level>`. Other hosts may provide aliases.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
