---
name: project-scouting
description: Reconnaissance doctrine for unfamiliar or changed repositories; obtain bounded structural findings through Pi Harness when useful, not an independent scout workflow.
disable-model-invocation: true
---

# Project reconnaissance

Scout when repository structure is unknown and matters to the task, prior knowledge is stale after significant changes, or known structure is insufficient to locate relevant code. Skip when the request already identifies the few files needed. Before scouting, use trustworthy, current project knowledge already in context; `/learn` is explicit user-saved memory, not an automatically refreshed scout cache. No automatic freshness check or persistent repo-intelligence store exists yet. Do not scout blindly on every prompt.

Ask for stack, layout, entry points, applicable agent instructions, likely files, and evidence with paths. Keep scope small and request 2–5 target files for focused follow-up. For managed work, call `pi_harness_delegate` with the read-only `scout` or `research` owner and specific acceptance criteria. The Commander reads the bounded report and checks it against the original objective before accepting the Task through `pi_harness_work`. Independent review is optional (`review: true`). Scout cannot mutate; do not ask it to generate a report file or edit `.gitignore`.

Require relevant conclusions, exact technical identifiers, evidence references, and uncertainty. Child termination does not establish correctness. Acceptance records Commander review; it must not claim independent verification unless that check actually ran. Keep task-specific reconnaissance ephemeral; do not create a persistent scout cache or treat session compaction as repository intelligence.
