# Pi Harness Architecture

## Scope

Pi Harness is a Pi package for Pi `0.85.1`; it does not replace Pi, select a provider/model, create a separate GUI, or train a model. Provider, model, and authentication remain machine-local Pi choices.

## Package layout

```text
pi-harness/
├── extensions/pi-harness.ts       # Harness commands and tools
├── lib/state.mjs                  # persisted-state and safety contracts
├── lib/coordinator.mjs            # thin pi-subagents translation and ownership adapter
├── lib/worker-gate.mjs            # Harness-specific verification and result policy
├── lib/memory.mjs                 # explicit /learn project memory
├── lib/precise-edit.mjs           # bounded hashline editing
├── lib/code-intel.mjs             # bounded code intelligence
├── bin/pi-harness*.mjs            # doctor and bounded web CLI
├── skills/                        # curated, locked Pi skills
└── packages/pi-harness-acp/       # ACP stdio bridge
```

`package.json` declares Pi extensions, skills, executable commands, and the pinned `@tintinweb/pi-subagents@0.19.0` dependency. It has no project prompt resource. `.pi/subagents.json` sets serial-safe package limits and explicit worktree isolation. `scripts/bootstrap.mjs` checks Node/Pi and installs this package through `pi install`; it must not modify Pi provider, model, or authentication settings.

## Session behavior

The extension persists `pi-harness-plan-state` and `pi-harness-goal-state` custom session entries. The newest entry restores state when Pi reloads the session.

- `/plan on` removes `edit` and `write` from active tools. In plan mode, bash is limited to classified read-only commands and the agent receives a planning prompt requiring assumptions, numbered steps, and verification criteria.
- `/plan off` restores tools captured before plan mode. `/plan status` reports state.
- `/goal <objective>` creates one active goal only when plan mode is off. `/goal status` reports it; `/goal cancel` records cancellation. Terminal completion/blocking must carry evidence.

The current implementation persists and enforces these command contracts. The lifecycle tests prove persisted reload, real compaction, real fork/branch independence, and mutation blocking after lifecycle transitions. The goal intentionally does not own wait state, pause/resume, token budgets, or a strong no-progress circuit breaker.

## Coordination boundary

Every delegated task needs an owner, scope, verification command, and permission. `@tintinweb/pi-subagents` owns child sessions, tool restrictions, queues, concurrency, cancellation, and worktrees. Harness agent definitions keep scouts/researchers read-only and workers write-capable. Harness runs the worker gate and commit policy, captures bounded evidence, links goal cancellation, and leaves branch integration as a separate, explicit user-confirmed action. No worker may edit the coordinator worktree.

## Skills and provenance

`skills/skills.lock.json` records the required `skills-central` commit and curated skill identifiers. Skills are local Pi resources; no `SKILLS_CENTRAL_ROOT`, Python runtime, or Codex CLI is required. Additional skills may only be installed at user request after source and checksum verification.

## ACP and external presentation

The intended ownership is upstream `pi-acp@0.0.33` for generic ACP v1 initialize/session lifecycle, Pi RPC streaming, persistence/history, cancellation, UI handling, and errors. Pi Harness owns only the `/plan`, `/goal`, `/learn`, and `/skill-hub` command projection, plus optional legacy `get_commands`, `session/inspect`, and `session/command` compatibility where an existing client requires it.

The cleanup wave defers this migration as one explicit final task. The inspected upstream package advertises Pi commands with extension commands disabled and does not expose a command-projection hook, so the current `packages/pi-harness-acp` bridge remains temporarily in place. The final wave must replace its duplicated generic ACP implementation with an upstream-backed thin adapter; it must not add a second generic ACP stack.

TUI-specific status is optional; ACP clients receive textual command/status data. The package has no browser or screen-reader claim. Zed registration and end-to-end ACP forwarding require their dedicated smoke tests before release.

## Native feature boundaries

- Provider, model, authentication, local model servers, session tree, and compaction remain Pi-owned.
- Memory writes occur only through explicit `/learn`; storage is bounded and private, with no autonomous write tool.
- Precise editing is `pi_harness_hashlines` plus `pi_harness_patch` under the small SHA/range contract.
- Web is a lightweight CLI using Brave or DuckDuckGo search, direct public HTTP(S), and bounded Jina fallback after private/local validation, with 10-second timeouts and a 1 MB body cap.
- Skills are loaded from the curated local set and verified against the locked upstream checksum.

## Security boundaries

- Web lookup receives only a task query or URL, with timeout and response-size cap.
- No credentials, provider configuration, or workspace contents are sent by doctor or the web CLI.
- Bootstrap contains no secret and creates no shell alias or wrapper.
