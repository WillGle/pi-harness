---
name: cavecrew
description: Compact execution/report profile for bounded Pi Harness delegations. Use when the user requests cavecrew or compressed subagent output. Pi Harness retains dispatch and lifecycle ownership.
---

# Cavecrew reporting profile

Cavecrew is not an orchestration runtime. Do not register or spawn named cavecrew agents. Do not use another host's subagent tool, or let a child spawn another child. Pi Harness dispatches only through `pi_harness_coordinate(owner, scope, verification, permission, model?)`. The `scout` and `research` profiles are read-only. The `worker` profile uses the package-managed worktree. The Coordinator chooses whether delegation is necessary.

The files under [references/agents/](references/agents/) are historical reporting examples, not executable agent definitions or lifecycle instructions. Do not copy them to an agent registry. Use a compact receipt only for L3 execution findings when it preserves the actor, condition, Dependency, status, negation, exception, cause, and Verification Status. Do not rewrite raw Evidence. Never treat a receipt as a TaskResult.

The Harness owns the TaskOrder prompt and the versioned TaskResult projection. The Coordinator must use the canonical TaskResult before promoting information to L1 or L0. If a compact receipt omits a condition or status, consult the raw Evidence in the execution context instead of guessing. Caveman may also format explicit human-requested presentation, but never a Mission, Constraint, Decision, TaskOrder, Acceptance Criterion, TaskResult, Verification Status, Blocker, or Dependency.
