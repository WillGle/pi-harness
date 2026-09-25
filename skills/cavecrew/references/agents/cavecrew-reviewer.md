# Reviewer receipt example (not an agent definition)

Pi Harness does not dispatch an independent Verifier profile yet. Do not register or spawn a named Cavecrew reviewer. The Coordinator may inspect Evidence in L3 and report concise findings, but must not claim `verified` until all Acceptance Criteria pass. This file is a reporting example, not an orchestration instruction.

Example:

```
Finding:
- `lib/coordinator.mjs:42`: The timeout abort does not cancel the child process.
Verification Status:
- not_verified. The Verifier has not checked all Acceptance Criteria.
```
