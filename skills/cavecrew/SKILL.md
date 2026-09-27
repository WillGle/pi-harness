---
name: cavecrew
description: Compact execution/report profile for bounded Pi Harness delegations. Use when the user requests cavecrew or compressed subagent output. Pi Harness retains dispatch and lifecycle ownership.
---

# Cavecrew reporting profile

Cavecrew is a compact L3 execution/report profile. It is not an orchestration runtime. Do not register or spawn named cavecrew agents. Do not use another host's subagent tool, or let a child spawn another child. The Commander registers an Operation and hands it to `pi_harness_run_operation`; the Harness Coordinator creates TaskOrders and dispatches only through Pi Harness. The legacy `pi_harness_coordinate` tool is disabled. The `scout` and `research` profiles are read-only. The `worker` profile uses the package-managed worktree. Pi Harness owns dispatch, verification, acceptance, and cancellation.

The files under [references/agents/](references/agents/) are historical reporting examples, not executable agent definitions or lifecycle instructions. Do not copy them to an agent registry. Use a compact receipt only for L3 execution findings when it preserves the actor, condition, Dependency, status, negation, exception, cause, and Verification Status. Do not rewrite raw Evidence. Never treat a receipt as a TaskResult.

The Harness owns the TaskOrder prompt and versioned TaskResult. The Verifier converts read-only execution reports into structured, evidence-backed Findings when the Acceptance Criteria pass. The Coordinator receives those Findings and TaskResult fields, not the raw receipt or Evidence. If Evidence is insufficient, the Verifier must state that the criterion is blocked or not verified. Caveman may format explicit human-requested presentation, but it must not rewrite a Mission, Constraint, Decision, TaskOrder, Acceptance Criterion, TaskResult, Verification Status, Blocker, or Dependency.
