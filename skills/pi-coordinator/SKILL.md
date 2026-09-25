---
name: pi-coordinator
description: Plan bounded Pi Harness tasks while keeping child execution context out of strategic reasoning.
---

# Coordinator doctrine

Keep mission reasoning separate from execution. Main Pi holds objective, constraints, decisions, Definition of Done (DoD), and status. The coordinator (currently a responsibility of main Pi, not a separately spawned agent) holds the operation plan, dependencies, blockers, and concise task outcomes. Optional domain heads may propose task orders when complexity warrants them; they have no spawn/cancel/worktree authority. Do not create recursive child fanout.

## Order before dispatch

For each delegation, write a small **TaskOrder**: objective and bounded scope; only relevant context and constraints; role and required capabilities; permission; acceptance criteria; deliverables; verification command or evidence question; reporting limit. Add dependencies/ID when multiple tasks need tracking. The current `pi_harness_coordinate` API only accepts `owner`, `scope`, `verification`, `permission`, and optional `model`: put missing order details into `scope` concisely, rather than claiming the API enforces them. `owner` is currently `scout` or `research` (read-only), or `worker` (write-capable); these are role profiles, not distinct orchestration layers. Choose a model only when its availability is known; Pi owns model selection.

Dispatch via `pi_harness_coordinate`; Harness applies policy and delegates child lifecycle, concurrency, isolation and cancellation to `pi-subagents`. Agents propose work; they do not spawn children themselves. In `/plan on`, do not dispatch. Read-only profiles cannot mutate; write workers use isolated worktrees. The package creates the atomic worker commit with policy metadata. Never merge or integrate automatically; obtain explicit user confirmation before integration.

## Close the loop

Separate execution from acceptance. A child reporting completion is not DoD. For workers, Harness runs the named deterministic gate in the worktree and checks the package branch and single commit. Inspect gate status and branch before considering acceptance; run any additional build/test/lint or independent review needed for the stated criteria. Read-only child results are findings, not independently verified facts. Use a semantic reviewer only when deterministic checks cannot decide an acceptance criterion. Retry, replan, or escalate blockers; report only accepted conclusions upward.

Promote **TaskResult**, not transcripts: task ID (if tracked), status (execution complete, verified, failed or blocked), concise conclusion, changed files when known, verification status, evidence/artifact pointers when available, and unexpected findings. Keep raw files, logs, commands, retries and diffs in disposable execution context; inspect them only to resolve an escalation. The current tool response still includes bounded raw worker diff/gate output and read-only prose, has no durable evidence references, and exposes `success` as a combined lifecycle/gate/commit check rather than full task acceptance. Do not interpret `success` as DoD or claim automatic context isolation of that response. Summarize before further promotion; do not copy raw payloads into plans, memory, or compaction state.

Goal cancellation flows through Harness to active package tasks. Integration and final goal completion remain explicit, evidence-backed decisions of main Pi; child results alone do not close a goal.
