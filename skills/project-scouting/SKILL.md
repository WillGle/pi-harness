---
name: project-scouting
description: Reconnaissance doctrine for unfamiliar or changed repositories; obtain bounded structural findings through Pi Harness when useful, not an independent scout workflow.
disable-model-invocation: true
---

# Project reconnaissance

Scout when repository structure is unknown and matters to the task, prior knowledge is stale after significant changes, or known structure is insufficient to locate relevant code. Skip when the request already identifies the few files needed. Before scouting, use trustworthy, current project knowledge already in context; `/learn` is explicit user-saved memory, not an automatically refreshed scout cache. No automatic freshness check or persistent repo-intelligence store exists yet. Do not scout blindly on every prompt.

Ask for stack, layout, entry points, applicable agent instructions, likely files, and Evidence with paths. Keep scope small and request 2–5 target files for focused follow-up. Register reconnaissance TaskOrders, exact task intents, and Operation Acceptance Criteria through `pi_harness_operation`; then call `pi_harness_run_operation`. The Harness Coordinator selects the read-only `scout` or `research` profile. Every read-only TaskOrder needs a specific Acceptance Criterion. The Verifier checks the report against that criterion and promotes only evidence-backed Findings. The Commander receives the bounded OperationReport, not the child report or raw Evidence. The legacy `pi_harness_coordinate` tool is disabled. Scout cannot mutate; do not ask it to generate a report file or edit `.gitignore`.

Use Acceptance Criteria that require the report to state the relevant conclusion, exact technical identifiers, Evidence references, and any uncertainty. The Verifier must distinguish execution completion from verification. Promote only verified Findings to the OperationReport. Do not treat a child lifecycle event as verification. Promote stable structural facts to project intelligence only after verification and only when a Harness-owned replaceable cache exists. Until then, keep task-specific reconnaissance ephemeral; do not use `.scout_report.md`, install a second scout agent, run the former `scout.py` workflow, or treat session compaction as repo intelligence.
