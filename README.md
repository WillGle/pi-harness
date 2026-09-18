# Pi Harness

Pi-native harness and extension for **Pi 0.85.1**. Provides read-only planning mode (`/plan`), evidence-backed goal tracking (`/goal`), curated skills, a bounded coordinator with isolated git worktrees, and an Agent Client Protocol (ACP) bridge for editors like Zed.

---

## Features

- **Read-Only Planning Mode (`/plan on|off|status`)**: Strips mutating tools (`edit`, `write`), blocks mutating bash syntax (e.g. `sed -i`, redirects, file deletions), and prompts the agent to provide assumptions, steps, and verification gates.
- **Evidence-Backed Goal (`/goal <objective>`)**: Tracks a single active objective requiring concrete verification evidence and blockers for terminal transitions. Survives session compaction, restore, and fork via native session entries.
- **5 Curated Skills**: Checksum-pinned skills (`project-scouting`, `caveman`, `ponytail`, `pi-coordinator`, `skill-hub`) verified directly against upstream commit `skills-central@c9dd3e4`.
- **Bounded Coordinator**: Spawns scoped scout/researcher child processes and worker tasks isolated in temporary git worktrees with strict non-auto-integration guarantees.
- **ACP Stdio Bridge (`pi-harness-acp`)**: Connects Pi with Zed Editor or any ACP client over JSON-RPC stdio. Advertises extension commands (`/plan`, `/goal`), forwards streaming events, and ensures clean subprocess lifecycle management (cross-restart session reconnect is experimental).
- **Project Memory (`/learn <note>`)**: Retains user-saved rules and lessons in owner-only local files at `~/.pi-harness/memory/<project-hash>.md`, outside the repository. Loaded memory is sent with the prompt to the active model provider.

---

## Clients

Pi Harness is the shared Pi extension and ACP bridge. Clients stay separate:

- **Zed** connects to `pi-harness-acp` as an editor client.
- **WPi** is an independent terminal UI app that also connects to `pi-harness-acp`; see the WPi repository README for its setup.

Each client starts its own ACP process and session. WPi is not packaged inside Pi Harness and does not import Harness source or private state files.

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
# Run health diagnostic
npm run doctor

# Run unit tests
npm test

# Verify curated skill checksums against upstream source
npm run verify:skills
```

---

## License

MIT
