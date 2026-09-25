# Pi Harness

Pi-native harness and extension for **Pi 0.85.1**. Provides read-only planning mode (`/plan`), evidence-backed goal tracking (`/goal`), curated skills, a thin coordinator adapter backed by `@tintinweb/pi-subagents@0.19.0`, and an Agent Client Protocol (ACP) compatibility bridge for editors like Zed.

---

## Features

- **Read-Only Planning Mode (`/plan on|off|status`)**: Strips mutating tools (`edit`, `write`), blocks mutating bash syntax (e.g. `sed -i`, redirects, file deletions), and prompts the agent to provide assumptions, steps, and verification gates. Lifecycle tests cover persisted reload, real compaction, real fork/branch independence, and mutation blocking after transitions.
- **Evidence-Backed Goal (`/goal <objective>`)**: Tracks a single active objective requiring concrete verification evidence and blockers for terminal transitions. It does not provide wait, pause/resume, token-budget, or strong no-progress circuit-breaker states.
- **Safe proactive compaction (`/harness-compact set <50-90>|status|disable`)**: Enabled by default at **70% of the active model's context window**. A whole-number threshold from 50% to 90% can override the default and is stored in the Pi session; `disable` is also persisted. Crossing it only queues a request; Harness waits for an idle `agent_settled` boundary with no active tools, TaskOrders, or Reviewer before calling Pi's compaction API. Goal continuation waits for compaction success or failure. After either outcome, Harness will not retry until usage first drops below the threshold. This is separate from Pi's `/autocompact`, which remains enabled and handles mid-run/emergency compaction. Session switches reset pending work but restore the saved threshold.
- **Skills**: Pi Harness owns the skills checked into `skills/`. `skills/skills.lock.json` records SHA-256 checksums for every packaged skill file; verification is self-contained and does not require another repository, source commit, or upstream checkout. Public promotions become canonical here; adapted skills follow current Pi Harness behavior. The skill set includes reusable workflows for clarification, requirement checks, architecture/formal draw.io models, atomic commits, delegation, repository scouting, writing/review, and caveman/ponytail modes.
- **Package-Backed Coordinator**: Delegates scoped scout/research and isolated worker tasks to `@tintinweb/pi-subagents`; Harness retains role policy, worker gate/commit checks and strict non-auto-integration. Current tool results include bounded child text, gate output and diff; `success` is not full task acceptance. See `target-architecture.md` for the context-isolated TaskOrder/TaskResult design and remaining code delta.
- **ACP Stdio Bridge (`pi-harness-acp`)**: Connects Pi with Zed Editor or any ACP client over JSON-RPC stdio, advertises Harness commands, forwards Pi events, persists session mappings, relays cancellation, and passes pasted/dragged images plus text-file resources to Pi.
- **Project Memory (`/learn <note>`)**: Retains user-saved rules and lessons in owner-only local files at `~/.pi-harness/memory/<project-hash>.md`, outside the repository. Loaded memory is sent with the prompt to the active model provider.

Other skill directories are ignored by Git and excluded from the package file list. Review the package contents before publishing this checkout.

---

## Clients

Pi Harness is the shared Pi extension and ACP bridge. Clients stay separate:

- **Zed** connects to `pi-harness-acp` as an editor client.
- **WPi** is an independent terminal UI app that also connects to `pi-harness-acp`; see the WPi repository README for its setup.

Each client starts its own ACP process and session. WPi is not packaged inside Pi Harness and does not import Harness source or private state files.

In Pi's native terminal, use `Ctrl+V` (`Alt+V` on Windows/WSL) for clipboard images or text, drag images from the file manager into a supported terminal, and type `@` to attach text/code files. ACP clients can send standard text, image, embedded-resource, and local `resource_link` content blocks; the bridge forwards images and includes text-file contents in the Pi prompt.

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

# Verify locally canonical skill package checksums
npm run verify:skills

# Inspect the exact files included before distributing a package
npm pack --dry-run --json
```

---

## License

MIT
