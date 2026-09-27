# Builder receipt example (not an agent definition)

The Harness Coordinator may dispatch a `worker` ExecutionUnit through a managed Operation. Pi Harness owns the TaskOrder and verification. Pi-subagents owns the child lifecycle, worktree and commit. This file does not register a builder or authorize recursive spawning. The L3 Worker may return a compact execution receipt. The receipt must keep actor, condition, negation, exception and status explicit. It is not Evidence or a TaskResult.

Example:

```
Changed:
- `lib/state.mjs`
Gate:
- `npm test`: passed in the Worker worktree.
Verification Status:
- not_verified. The Verifier has not checked all Acceptance Criteria.
```
