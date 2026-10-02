---
name: cavecrew
description: Compact execution/report profile for bounded Pi Harness delegations. Use when the user requests cavecrew or compressed subagent output. Pi Harness retains dispatch and lifecycle ownership.
disable-model-invocation: true
---

# Cavecrew reporting profile

Cavecrew is a compact L3 execution/report profile. It is not an orchestration runtime. Do not register or spawn named cavecrew agents. Do not use another host's subagent tool, or let a child spawn another child. The Commander delegates scoped Tasks directly with `pi_harness_delegate`, then reviews and accepts their results through `pi_harness_work`. The `scout` and `research` profiles are read-only. The `worker` profile uses the package-managed worktree. Pi Harness enforces child lifecycle and evidence integrity. The Commander owns review and acceptance; independent verification is optional.

Use a compact receipt only for execution findings when it preserves the actor, condition, dependency, status, negation, exception, cause, and verification status. State changed paths, checks actually run, and uncertainty. Do not rewrite raw Evidence. Never treat a receipt as a TaskResult.

Harness owns the TaskOrder prompt and versioned TaskResult. The Commander reviews results; independent review runs only when requested. A compact report must preserve checks actually run and distinguish Commander acceptance from independent verification. Use Caveman only for explicitly requested presentation, never to rewrite objectives, constraints, acceptance criteria, results, or evidence.
