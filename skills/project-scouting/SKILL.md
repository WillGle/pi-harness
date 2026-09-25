---
name: project-scouting
description: Reconnaissance doctrine for unfamiliar or changed repositories; obtain bounded structural findings through Pi Harness when useful, not an independent scout workflow.
---

# Project reconnaissance

Scout when repository structure is unknown and matters to the task, prior knowledge is stale after significant changes, or known structure is insufficient to locate relevant code. Skip when the request already identifies the few files needed. Before scouting, use trustworthy, current project knowledge already in context; `/learn` is explicit user-saved memory, not an automatically refreshed scout cache. No automatic freshness check or persistent repo-intelligence store exists yet. Do not scout blindly on every prompt.

Ask for stack, layout, entry points, applicable agent instructions, likely files for this task, and evidence with paths. Keep scope small and request 2–5 target files for focused follow-up. Use the Harness `pi_harness_coordinate` read-only `scout` profile (`permission: read`, `scope` stating the question and reporting limit, `verification` naming the evidence to collect). The tool currently requires a verification string for read-only tasks but does **not** execute it as a gate. Research is another read-only profile for a narrower question. Scout cannot mutate; do not ask it to generate a report file or edit `.gitignore`. The coordinator/main agent should receive only concise findings and read the few targeted files it actually needs, not raw discovery output.

Useful finding shape: task/question, structural conclusion, relevant paths, evidence references, freshness/unknowns, suggested next files. Read-only `success` currently means child lifecycle completion, not independent verification of claims; check decisive findings before relying on them. Promote stable structural facts to project intelligence only after verification and only when a Harness-owned replaceable cache exists. Until then, keep task-specific reconnaissance ephemeral; do not use `.scout_report.md`, install a second scout agent, run the former `scout.py` workflow, or treat session compaction as repo intelligence.
