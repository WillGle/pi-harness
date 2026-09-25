---
name: caveman-help
description: >
  Quick-reference card for all caveman modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /caveman-help,
  "caveman help", "what caveman commands", "how do I use caveman".
---

# Caveman Help

Display this reference card when invoked. One-shot — do NOT change mode, write flag files, or persist anything. Output in caveman style.

## Modes

| Mode | Trigger | What change |
|------|---------|-------------|
| **Lite** | `/skill:caveman lite` in Pi | Drop filler. Keep sentence structure. |
| **Full** | `/skill:caveman` in Pi | Drop articles, filler, pleasantries, hedging. Fragments OK. Default. |
| **Ultra** | `/skill:caveman ultra` in Pi | Extreme compression. Bare fragments. Tables over prose. |
| **Wenyan-Lite** | `/skill:caveman wenyan-lite` in Pi | Classical Chinese style, light compression. |
| **Wenyan-Full** | `/skill:caveman wenyan` in Pi | Full 文言文. Maximum classical terseness. |
| **Wenyan-Ultra** | `/skill:caveman wenyan-ultra` in Pi | Extreme. Ancient scholar on a budget. |

This mode is explicit-only in Pi; invoke it with `/skill:caveman [level]`. Invoke helper skills with `/skill:<skill-name>`. Other hosts may provide aliases such as `/caveman`.

Mode sticks until changed or session end.

## Skills

| Skill | Trigger | What it do |
|-------|---------|-----------|
| **caveman-commit** | `/caveman-commit` | Terse commit messages. Conventional Commits. ≤50 char subject. |
| **caveman-review** | `/caveman-review` | One-line PR comments: `L42: bug: user null. Add guard.` |
| **caveman-compress** | `/caveman-compress <file>` | Compress .md files to caveman prose. Saves ~46% input tokens. |
| **caveman-help** | `/caveman-help` | This card. |

## Deactivate

Say "stop caveman" or "normal mode". Resume with `/skill:caveman` in Pi or the host alias.

## Language

Keep user's language by default. User write Portuguese → reply Portuguese caveman. Compress the style, not the language. Technical terms, code, commands, commit types, and exact error strings stay verbatim unless user ask for translation.

## Default Mode

Default mode = `full`. Explicitly activate with `/skill:caveman` in Pi; switch with `/skill:caveman <level>`. Other hosts may offer aliases.

## More

Full docs: https://github.com/JuliusBrussee/caveman
