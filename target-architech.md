# Pi Harness Architecture

## Scope

Pi Harness is a Pi package for Pi `0.85.1`; it does not replace Pi, select a provider/model, create a separate GUI, or train a model. Provider, model, and authentication remain machine-local Pi choices.

## Package layout

```text
pi-harness/
├── extensions/pi-harness.ts       # /plan and /goal Pi extension
├── lib/state.mjs                  # persisted-state and safety contracts
├── lib/coordinator.mjs            # scoped child/worktree helpers
├── bin/pi-harness*.mjs            # doctor and bounded web CLI
├── skills/                        # curated, locked Pi skills
└── packages/pi-harness-acp/       # ACP stdio bridge
```

`package.json` declares Pi extensions, skills, prompts, and executable commands. `scripts/bootstrap.mjs` checks Node/Pi and installs this package through `pi install`; it must not modify Pi provider, model, or authentication settings.

## Session behavior

The extension persists `pi-harness-plan-state` and `pi-harness-goal-state` custom session entries. The newest entry restores state when Pi reloads the session.

- `/plan on` removes `edit` and `write` from active tools. In plan mode, bash is limited to classified read-only commands and the agent receives a planning prompt requiring assumptions, numbered steps, and verification criteria.
- `/plan off` restores tools captured before plan mode. `/plan status` reports state.
- `/goal <objective>` creates one active goal only when plan mode is off. `/goal status` reports it; `/goal cancel` records cancellation. Terminal completion/blocking must carry evidence.

The current implementation persists and enforces these command contracts. It does not yet prove automatic multi-turn goal completion, compaction restore, fork restore, or ACP reconnect behavior.

## Coordination boundary

Every delegated task needs an owner, scope, verification command, and permission. Scouts/researchers are read-only Pi children. Workers require a temporary git worktree and branch; integration into a target worktree remains a separate, explicit user-confirmed action. No worker may edit the coordinator worktree.

## Skills and provenance

`skills/skills.lock.json` records the required `skills-central` commit and curated skill identifiers. Skills are local Pi resources; no `SKILLS_CENTRAL_ROOT`, Python runtime, or Codex CLI is required. Additional skills may only be installed at user request after source and checksum verification.

## ACP and external presentation

`pi-harness-acp` exposes ACP over stdio and advertises the extension command contract. TUI-specific status is optional; ACP clients receive textual command/status data. The package has no browser or screen-reader claim. Zed registration and end-to-end ACP forwarding require their dedicated smoke tests before release.

## Security boundaries

- Web lookup receives only a task query or URL, with timeout and response-size cap.
- No credentials, provider configuration, or workspace contents are sent by doctor or the web CLI.
- Bootstrap contains no secret and creates no shell alias or wrapper.
