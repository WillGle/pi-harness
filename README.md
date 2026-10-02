# Pi Harness

Pi Harness helps Pi run delegated tasks, save progress, handle cancellation, and show what was checked. The main agent chooses the work and reviews the results.

## Install

Requires Linux, Node.js 22.19.0 or newer, Pi 0.87.1 available as `pi`, npm, Git, `sh`, `rg`, and `flock`.

```bash
git clone https://github.com/WillGle/pi-harness.git
cd pi-harness
npm install
npm run bootstrap
npm run doctor
```

Run `pi` in your project directory. Installation keeps your provider, model, and sign-in settings.

## Use

Describe the task normally, or start with:

```text
/goal Fix the login error and run the relevant tests.
```

- `/status` shows progress and context usage.
- `/work list` and `/work resume <id>` reopen unfinished work.
- `/work cancel` stops selected work and keeps its history.
- `/plan on` enables planning without edits; `/plan off` allows edits again.
- `/skill-hub` lists skills and their commands.
- `/learn <note>` saves a project note for future prompts.

Tasks run one at a time. Code changes use a separate Git working directory and branch. The main agent reviews each result before marking the work complete.

The default check, `git diff --check`, checks formatting. Ask for the tests your task needs. Displayed costs are estimates, not bills.

See the [manual](docs/manual.md) for interrupted work and result labels, or the [code guide](docs/target-architecture.md) for module responsibilities.

Linux terminal use is supported. ACP/Zed integration is experimental and installed separately. Verification commands run with your user permissions.

## Development

```bash
npm run build
npm test
npm run verify:skills
```

For full installation and runtime checks, run `npm run test:all`.
