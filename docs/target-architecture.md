# Code guide

The main Pi agent chooses tasks, reviews results, and decides when work is complete. Harness runs the tasks and records their outcomes.

## Files

| File in `lib/` | Responsibility |
| --- | --- |
| `work.mjs` | Work records, task states, attempts, and acceptance |
| `executor.mjs` | Start agents, wait for them, handle cancellation and review |
| `worker-gate.mjs` | Run code checks and inspect the returned branch |
| `communication.mjs`, `task-spec.mjs` | Task instructions and result format |
| `verifier.mjs`, `semantic-verifier.mjs` | Check results and review selected evidence |
| `control-state-store.mjs`, `evidence.mjs` | Save work and supporting records |
| `process-owner.mjs`, `child-disposition.mjs` | Track interrupted execution and returned changes |
| `plan.mjs` | Planning mode and allowed commands |
| `context-economics.mjs`, `status-view-model.mjs` | Prompt content, usage figures, and status display |
| `memory.mjs`, `skills.mjs` | Saved project notes and skill checks |
| `project.mjs`, `text.mjs` | Shared project IDs and text size limits |
| `code-intel.mjs`, `precise-edit.mjs` | Find code and check edits against previously read content |
| `platform.mjs`, `failure-codes.mjs`, `agent-english.mjs` | Host requirements, error codes, and agent instructions |

`extensions/pi-harness.ts` connects these files to Pi commands, tools, and session events. `bin/` contains command-line entry points; `scripts/` contains installation and skill checks. The experimental ACP bridge stays in `pi-harness-acp/`.

## Rules to preserve

- Keep the original objective and constraints. Run delegated tasks one at a time, with at most two attempts each.
- Allow one Pi session to write work at a time. Session history keeps copies of that work.
- An interrupted running task becomes unknown. Confirm execution ended before allowing a retry.
- Keep execution, verification, and main-agent acceptance separate. Require saved evidence for acceptance.
- Return Worker branches without merging them. Require one commit only when explicitly requested.
- Keep missing usage figures unknown. Leave model settings, prompt caching, and conversation shortening to Pi.
- Preserve old records. Keep `operation_id` in saved results for compatibility.

The previous design is retained at `docs/designs/legacy-control-plane.md` in the repository.
