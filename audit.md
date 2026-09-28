# Pi Harness — Audit Addendum

## Scope and evidence

The source findings below were reported against `main` at `2042b1a`. This session did not independently re-audit that source snapshot. Implementation work used checkout `main` at `4e9f270`, which includes one later ACP MCP commit, plus uncommitted working-tree changes.

Linux verification ran in the local NixOS environment with Node.js `v22.22.2` and Pi `0.87.1`. The active Pi runtime is the project-patched Nix build. The Ubuntu workflow has not run remotely in this session. A separate Ubuntu 24.04 Docker run with Node.js `v22.19.0` and npm-installed stock Pi `0.87.1` passed the workflow-equivalent steps on the NixOS host kernel.
## #40 — Linux CLI Platform Boundary

**Status: PARTIAL — fail-closed enforcement is implemented; Ubuntu userspace and stock Pi passed locally; remote CI and a generic Linux host remain unverified.**

### Requirement

> Pi Harness supports Linux CLI only. The supported user-facing execution surface is the Pi CLI on Linux. Harness does not claim support for macOS, Windows, WSL, ACP clients, GUI clients, or other operating environments unless the user explicitly adds that scope and the environment receives separate runtime verification.
>
> Unsupported operating systems must fail closed before Harness execution, state mutation, Worker dispatch, or Evidence creation. Linux support depends on Linux/POSIX process, signal, filesystem permission, symlink, shell, and Git worktree semantics. A missing safety primitive must not silently reduce protection.

### Baseline findings reported against `main` at `2042b1a`

- The implementation was Linux/POSIX-oriented, but it did not enforce a Linux-only support boundary.
- The package metadata did not declare Linux as the supported OS. Bootstrap installed ACP by default and modified Zed settings.
- The extension load path, Worker dispatch, and Evidence creation lacked a shared early platform/capability guard.
- `doctor` did not report the required and actual platforms. It did not fully check `git`, `rg`, filesystem safety capabilities, or process-group support.
- Evidence handling could silently weaken protection when `O_NOFOLLOW` or UID checks were unavailable.
- The reported minimum prerequisites were Linux, Node.js `>=22.19.0`, the project-pinned Pi runtime, Git, POSIX `sh`, ripgrep, and npm for bootstrap/install. Universal Ctags and ast-grep could remain optional when fallbacks worked.
- Strong Linux runtime evidence was reported for NixOS with a patched Pi 0.87.1. Generic Linux with stock Pi 0.87.1 and Ubuntu LTS CI were unverified.

### Changes made in this session

- Root and ACP package metadata now declare `os: ["linux"]`.
- The package loads `extensions/platform-guard.mjs` before `pi-subagents` and the Harness extension. Harness execution and direct Worker, Operation, Evidence, memory, and precise-edit mutation paths also check platform support.
- Platform checks reject macOS, Windows, WSL, and missing Linux safety capabilities. Evidence no longer falls back when required no-follow or UID checks are unavailable.
- Bootstrap now installs the Linux Pi CLI by default. ACP/Zed setup requires the explicit `--experimental-zed` option. README and architecture documentation state the unsupported-surface boundary.
- `doctor` reports the required and actual platform, runtime prerequisites, filesystem permissions, no-follow behavior, process signals, process groups, Git worktree support, Pi readiness, and package resources. It does not run prerequisite probes on unsupported hosts.
- `.github/workflows/linux.yml` now defines Ubuntu 24.04 x86_64 CI with Node.js 22.19.0, build, test, runtime, doctor, and skills checks.

### Verification evidence from this session

- `npm run test:all` passed. It included build, 173 unit tests, 2 runtime tests, and 43 integration tests.
- `npm run verify:skills` passed: 22 skills verified.
- `npm run doctor` passed locally. It reported Linux, Node.js `v22.22.2`, Pi `0.87.1`, required commands, filesystem permissions, `O_NOFOLLOW`, process groups, disposable Git worktree support, and tool-calling readiness.
- The disposable bootstrap test passed. Linux CLI is the default, and experimental Zed setup preserves settings fingerprints.
- `npm pack --workspace=@will/pi-harness-acp --dry-run --json` confirmed that the ACP platform guard is included in the packed package.
- Platform tests passed for simulated macOS, Windows, and WSL. They verify that bootstrap, extension registration, doctor probes, Evidence, memory, precise edits, and Worker verification fail before protected execution or filesystem mutation. These are host-simulation tests, not physical runs on macOS, Windows, or WSL.
- The NixOS run used the project-patched Pi runtime. A separate Ubuntu 24.04 Docker userspace run used Node.js `v22.19.0` and npm-installed stock Pi `0.87.1`. `npm ci`, `npm run build`, `npm test` (173/173), `npm run test:runtime` (2/2), `npm run doctor`, and `npm run verify:skills` passed. The Docker bind mount ran as root, so the test set `/work` as a Git safe directory. This is local workflow-equivalent Evidence, not a remote CI result or a generic Linux host run.
- An extra `npm run test:all` attempt entered `test:integration`, which requires a separately installed patched default Pi outside `node_modules/.bin`. That extra suite could not find the required executable in the stock-Pi container. The Ubuntu workflow does not run `test:integration`.

### Closure criteria

1. **Implemented:** Declare Linux support and make Linux Pi CLI the default product path. Mark ACP/editor integrations experimental and unsupported.
2. **Implemented:** Reject unsupported hosts and missing safety capabilities before bootstrap mutation, Harness registration, Worker dispatch, Evidence creation, and protected state mutation.
3. **Implemented:** Extend `doctor` to report platform, prerequisites, filesystem safety, signal and process-group support, Git worktree support, and Pi readiness.
4. **Pending:** Run the Ubuntu 24.04 x86_64 workflow remotely. Keep the NixOS and local Ubuntu-container results as separate environments.
5. **Partially verified:** Ubuntu 24.04 userspace with stock Pi passed in Docker on a NixOS host. A generic Linux host has not been separately tested.
6. **Partially verified:** Host-simulation tests prove fail-closed behavior. Do not claim real macOS, Windows, or WSL runtime verification.

## #41 — Linux CLI TUI Stability During Managed Subagent Execution

**Status: FAIL — release blocker. Root cause: open.**

### Requirement

During managed subagent execution, progress updates must not corrupt, duplicate, replay, or destabilize the parent CLI transcript. Subagent activity must remain observable without destructive high-frequency full-screen redraws. A healthy Worker process is not sufficient if the supported Linux CLI becomes unusable while that Worker runs.

### User-reported result

The user reported a reproduced CLI presentation failure during managed subagent activity:

- Repeated `Working` separators appeared.
- The same Worker status row replayed many times, including a truncated activity row.
- Transcript presentation became noisy and usability degraded.
- The report does not show that Worker execution or orchestration results were corrupted.

**Presentation correctness failed. Runtime correctness is not shown to have failed.**

### Investigation evidence from this session

The investigation used disposable workspaces and a local fake provider. It used no model credentials and made no network calls.

- A disposable 120x30 tmux session used Pi `0.87.1`, the actual `pi-subagents` extension, the Harness extension/footer, a 60-row synthetic transcript, a local fake provider, and one real `worker` subagent spawned through `subagents:rpc:spawn` with `isBackground: true`. The worker used `isolation: "off"` and made no project edits. Pi's `PI_TUI_DEBUG_REDRAW=1` log showed one initial `fullRender` during the four-second capture. The screen showed one Agents block, one Worker row, and one activity row. The reported replay symptom did not reproduce.
- This Worker used the real `pi-subagents` child path. It did not use a Harness `TaskOrder`, Coordinator, or Operation Runner. The result does not verify the complete managed Harness path.
- A separate renderer probe changed a synthetic 45-row widget every 80 ms on a 120x30 terminal. Pi logged 15 `fullRender` calls in two seconds. The logged reason was `firstChanged < viewportTop`. This proves that a changing off-screen component can cause repeated full renders. It does not prove that the production `pi-subagents` widget caused the user-reported symptom.
- The bounded production AgentWidget did not cause a redraw storm in the tested one-Worker scenario. This narrows one hypothesis. It does not identify the exact trigger.
- This session did not complete the FleetView on/off matrix, one/two/four real Harness Workers, foreground Agent comparison, high-volume tool start/end scenarios, or keyboard responsiveness checks. The user-reported duplicate `Working` separators remain unreproduced in this isolated test.
- No production TUI code was changed. The Harness footer was present in the real Worker test. The investigation did not add sleeps or suppress progress.

### Causal status

The user-reported failure remains a release blocker. The exact Harness trigger is not proven. Candidate paths include the `pi-subagents` widget, FleetView, Pi's foreground `Working` and tool-result rendering, and interactions with Harness header/footer rows. The tested background AgentWidget alone did not reproduce the issue. Treat the footer as a possible amplifier, not a proven cause. Do not attribute the failure to a specific upstream issue without a matching reproducer.

### Required regression and remaining investigation

Continue the isolated Linux investigation. Trace managed Harness Worker events through the Coordinator, `pi-subagents`, UI components, and Pi's render request and redraw decision. Compare:

- Widget on/off.
- FleetView on/off.
- Harness header/footer present/absent.
- One, two, and four parallel Harness Workers.
- A transcript longer than the viewport and a small terminal such as `120x30`.
- High-volume Worker text streaming and tool start/end updates.
- Foreground Agent and background Worker rendering.

Use Pi TUI redraw instrumentation when the tested build supports it. Verify that full redraw frequency does not grow in proportion to token deltas or spinner ticks during steady-state streaming.

Pass criteria:

- No duplicated or replayed transcript history.
- No stale repeated `Working` blocks or unexpected scrollback clearing.
- No screen-jump storm or terminal flicker that prevents use.
- Keyboard input remains responsive, including Ctrl/Esc agent management.
- The final Worker status appears once in a stable form.

Do not disable all progress, add arbitrary sleeps, remove the Harness footer, or patch Pi core before the causal layer is identified. Keep ownership clear: `pi-subagents` owns child presentation, Pi owns the TUI renderer, and Harness owns which managed child UI it exposes.

## Release relationship

`#40` defines the supported Linux CLI boundary. `#41` requires that boundary to remain usable during managed execution. Both requirements must pass before release. `#41` remains a release blocker, not a cosmetic issue. Keep #41 isolated from the committed #19 TaskGraph-planning change until separate review and integration, to avoid mixing orchestration changes with TUI diagnosis.
