# Pi Harness

Pi-native harness and extension for **Pi 0.85.1**. Provides read-only planning mode (`/plan`), evidence-backed goal tracking (`/goal`), curated skills, a bounded coordinator with isolated git worktrees, and an Agent Client Protocol (ACP) bridge for editors like Zed.

---

## Features

- **Read-Only Planning Mode (`/plan on|off|status`)**: Strips mutating tools (`edit`, `write`), blocks mutating bash syntax (e.g. `sed -i`, redirects, file deletions), and prompts the agent to provide assumptions, steps, and verification gates.
- **Evidence-Backed Goal (`/goal <objective>`)**: Tracks a single active objective requiring concrete verification evidence and blockers for terminal transitions. Survives session compaction, restore, and fork via native session entries.
- **5 Curated Skills**: Checksum-pinned skills (`project-scouting`, `caveman`, `ponytail`, `pi-coordinator`, `skill-hub`) verified directly against upstream commit `skills-central@c9dd3e4`.
- **Bounded Coordinator**: Spawns scoped scout/researcher child processes and worker tasks isolated in temporary git worktrees with strict non-auto-integration guarantees.
- **ACP Stdio Bridge (`pi-harness-acp`)**: Connects Pi with Zed Editor or any ACP client over JSON-RPC stdio. Advertises extension commands (`/plan`, `/goal`), forwards streaming events, and ensures clean subprocess lifecycle management (cross-restart session reconnect is experimental).

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
