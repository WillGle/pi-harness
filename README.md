# Pi Harness

Pi-native harness and extension for **Pi 0.85.1**. Provides read-only planning mode (`/plan`), evidence-backed goal tracking (`/goal`), curated skills, a thin coordinator adapter backed by `@tintinweb/pi-subagents@0.19.0`, and an Agent Client Protocol (ACP) compatibility bridge for editors like Zed.

---

## Features

- **Read-Only Planning Mode (`/plan on|off|status`)**: Strips mutating tools (`edit`, `write`), blocks mutating bash syntax (e.g. `sed -i`, redirects, file deletions), and prompts the agent to provide assumptions, steps, and verification gates. Lifecycle tests cover persisted reload, real compaction, real fork/branch independence, and mutation blocking after transitions.
- **Evidence-Backed Goal (`/goal <objective>`)**: Tracks a single active objective requiring concrete verification evidence and blockers for terminal transitions. It does not provide wait, pause/resume, token-budget, or strong no-progress circuit-breaker states.
- **8 Curated Skills**: Checksum-pinned skills (`ask-user`, `architecture-diagram`, `drawio-modeling`, `project-scouting`, `caveman`, `ponytail`, `pi-coordinator`, `skill-hub`). Upstream-derived skills are verified against `skills-central` commit `8cc8358`; `architecture-diagram` pins its upstream source hash plus all packaged resources. Locally authored skills pin all packaged resources: `drawio-modeling` handles ERD, functional decomposition and UML views separately from product architecture; `ask-user` clarifies ambiguous needs/goals in or outside `/plan` without granting permissions or requiring a special UI tool.
- **Package-Backed Coordinator**: Delegates scoped scout/research and isolated worker tasks to `@tintinweb/pi-subagents`; Harness retains role policy, verification, bounded result normalization, and strict non-auto-integration.
- **ACP Stdio Bridge (`pi-harness-acp`)**: Connects Pi with Zed Editor or any ACP client over JSON-RPC stdio, advertises Harness commands, forwards Pi events, persists session mappings, and relays cancellation.
- **Project Memory (`/learn <note>`)**: Retains user-saved rules and lessons in owner-only local files at `~/.pi-harness/memory/<project-hash>.md`, outside the repository. Loaded memory is sent with the prompt to the active model provider.

Other skill directories are ignored by Git and excluded from the package file list. Review the package contents before publishing this checkout.

---

## Clients

Pi Harness is the shared Pi extension and ACP bridge. Clients stay separate:

- **Zed** connects to `pi-harness-acp` as an editor client.
- **WPi** is an independent terminal UI app that also connects to `pi-harness-acp`; see the WPi repository README for its setup.

Each client starts its own ACP process and session. WPi is not packaged inside Pi Harness and does not import Harness source or private state files.

## Ownership

```text
Pi 0.85.1
├── provider, model, authentication, local runtime, session tree, compaction
├── Pi Harness
│   ├── plan, goal, explicit project memory, precise editing
│   ├── code intelligence, skill loading/provenance, bounded web CLI
│   ├── bootstrap, doctor, and compatibility policy
│   └── thin coordinator and ACP compatibility policy adapters
├── @tintinweb/pi-subagents@0.19.0
│   └── child lifecycle, concurrency, worktrees, and cancellation
└── ACP
    └── Pi Harness: ACP bridge and Harness command compatibility
```

---

## Quick Setup (Zero-Config)

### Multi-Device Setup (PC, Laptop, Mini PC)

On any machine with Node.js 22+ and Pi installed:

```bash
# 1. Clone repository
git clone git@github.com:WillGle/pi-harness.git ~/dev/pi-harness
cd ~/dev/pi-harness

# 2. Run automated bootstrap
npm run bootstrap
```

The bootstrap script automatically:

1. Installs the extension and curated skills into Pi via `pi install .`.
2. Installs the `pi-harness-acp` binary globally.
3. Automatically configures Zed Editor (`~/.config/zed/settings.json`) with rollback backup and fingerprint protection.

Use this when Zed integration is wanted too. It is not required to use WPi.

### Pi CLI Only

On a machine without Zed, install only the Pi package:

```bash
npm run bootstrap -- --cli
npm run doctor
```

### WPi Terminal Client

Install the Harness extension and expose the ACP bridge once:

```bash
cd ~/dev/pi-harness
pi install .

cd packages/pi-harness-acp
npm link
```

Then install and expose the separate WPi app:

```bash
cd ~/dev/pi-harness-tui
npm install
npm link
pi-tui
```

`pi-tui` starts WPi and its ACP child process. Do not start `pi-harness-acp` separately for that terminal. If the ACP bridge is not on `PATH` during local development, start WPi with:

```bash
PI_HARNESS_ACP_BIN=~/dev/pi-harness/packages/pi-harness-acp/bin/pi-harness-acp.mjs npm start
```

---

## Verification & Diagnostics

Verify system readiness at any time:

```bash
# Check Pi CLI readiness
npm run doctor

# Also require ACP and Zed readiness
npm run doctor -- --zed

# Run unit tests
npm test

# Verify curated skill checksums against upstream source
npm run verify:skills

# Inspect the exact files included before distributing a package
npm pack --dry-run --json
```

---

## License

MIT
