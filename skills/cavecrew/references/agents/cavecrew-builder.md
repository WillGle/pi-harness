# Builder receipt example (not an agent definition)

The Coordinator may dispatch a `worker` profile through `pi_harness_coordinate`. Pi Harness owns the TaskOrder. Pi-subagents owns the child lifecycle, worktree and commit. This file does not register a builder or authorize recursive spawning. The L3 Worker may return a compact execution receipt. The receipt must keep actor, condition, negation, exception and Verification Status explicit. It is not Evidence or a TaskResult.

Example:

```
Changed:
- `lib/state.mjs`
Gate:
- `npm test`: passed in the Worker worktree.
Verification Status:
- not_verified. The Verifier has not checked all Acceptance Criteria.
```
