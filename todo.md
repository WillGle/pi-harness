# Pi Harness — TODO và verification report T0–T14

Checkpoint: 2026-09-28. **Current status: 14 PASS, 1 PARTIAL, 0 FAIL. T14 remains open for final release closure.** Numbering T0–T14 below replaces numbering 1–11 from the old tracker.

Chỉ đánh dấu PASS khi mọi DoD có source và test/runtime evidence. Suite pass không thay thế live managed coding, trust-policy hay Phase I proof. Khi HEAD/runtime thay đổi, phải kiểm tra lại evidence. Không tự tích hợp nhánh Worker.

Dependency order:

`T0 → T1 → T2 → T3 → T4 → T10 baseline → T5 → T6 → T7 → T8 → T9 → T10 rerun → T11 → T12 → T13 → T14`

Logs dưới /tmp là bằng chứng của checkpoint, có thể bị dọn khỏi máy; không coi đường dẫn còn tồn tại là bằng chứng đã rerun. The original audit checkpoint had no commit or push. Current release commit and push status is recorded in T14.

Canonical numbering is the user's T0–T14 master list. The previous checkpoint's T3/T4/T5/T9/T10/T11 labels describe different tasks and are not carried over as PASS claims.

Original T1 closure baseline: `14041475f37d93473496002f0d0ad85e67651281`. Current release series is based on `caa7735` and has four focused local commits. Push to `pi-harness/main` is pending explicit approval.
At the original closure start, the worktree had 31 modified tracked files and four untracked files (`lib/agent-english.mjs`, `lib/child-disposition.mjs`, `lib/failure-codes.mjs`, `todo.md`). That work added `lib/task-spec.mjs` and `test/helpers/mock-settlement.mjs` and preserved the existing changes. The later T11–T13 closure changes are recorded below.
Repository tests run under Node `v22.22.2` with pi-subagents `0.19.0`. The active Nix Pi `0.87.1` uses Node `v24.20.0`. Runtime versions were checked with `npm ls @earendil-works/pi-coding-agent @tintinweb/pi-subagents`, `pi --version`, and runtime compatibility tests.

Evidence logs:
- `/tmp/pi-harness-master-baseline.log`: sandbox run stopped at unit suite, 19/21 test files passed; code-intel/web failed.
- `/tmp/pi-harness-master-baseline-unsandboxed.log`: same `npm run test:all` outside sandbox passed build, 138/138 unit and 20/20 integration, zero skips.
- `/tmp/pi-harness-master-t1.log`: `node --test test/coordinator.test.mjs`, 31/31 PASS, zero skips after this turn's fix.
- `/tmp/pi-harness-master-final-all.log`: final full-suite output; see final validation addendum for observed result.
- `npm run doctor` outside sandbox: Pi ready, toolCalling true, 22 skills verified, failures `[]`. Sandbox doctor reported `sandbox-blocked`; this was an environment limitation.

Root-cause report was communicated before source changes: spawn ACK rejection after `onSpawned` could bypass drain and remove active ownership; the missing-settlement fallback was subsequently removed in the ownership closure below. That initial checkpoint preceded implementation. Live managed coding now completes both before and after Phase I, and the live context benchmark is recorded below. No credential contents were read, copied or printed; Pi used normal authentication internally.

## Lifecycle trace — original audit snapshot (before closure)

Managed Operation: `extensions/pi-harness.ts:416` registers `pi_harness_run_operation`; callbacks at 442–446 call `executeCoordinatorTurn` and `executeCoordinateTask` with explicit managed budgets. `lib/operation-runner.mjs:123` constructs a bounded brief, validates a decision, atomically claims ready Task IDs, persists, and dispatches a wave. `lib/coordinator.mjs:426` creates a TaskOrder, emits package spawn RPC, captures exact package child settlement, and waits for terminal execution. Worker gate runs in `onBeforeWorktreeCleanup`; execution/diff/gate Evidence persists through `storeEvidence`; `taskResult` calls `verifyTaskOrder`, then selected semantic/security review if required. Runner records the matching TaskResult and graph transition; only later `accept_task`/`accept_criterion` decisions accept results and criteria. `operationReport` returns the bounded Commander report. Mission completion remains separate in goal state.

Cancellation/timeout: group or parent signal aborts owned controller; terminal timeout settles waiter before abort, so synchronous package events cannot replace timeout. RPC timeout retains a bounded late-reply listener and reconciles startup. This turn adds reconciliation for other failures after a child ID exists. Retained ownership is released when its exact package promise settles.
Session restart/switch: `session_start` cancels old groups, increments `sessionEpoch`, restores canonical Scheduler snapshots, reconciles unresolved running nodes to blocked; persistence callbacks reject old epochs. Existing tests exercise fake session switching and real Pi command/session behavior, not a live coding restart.
Parallel wave: `claimTasks` validates all IDs/capacity/dependencies before dispatch; `Promise.allSettled` preserves sibling outcomes. Package capacity is four, Harness default two (configurable one through four).
Compaction: context usage marks maintenance pending at 70%; current `agent_settled` handler waits for idle/no active tool/Operation/child, checkpoints, then calls `ctx.compact`. Pi 0.87.1 `AgentSession.compact()` starts with `await this.abort()` (`dist/core/agent-session.js:1865`). This remains the pre-Phase-I architecture.
ACP: one local map entry holds a Pi process and RPC pending map; RPC timeout removes pending and resolves undefined after 30 seconds. Prompt ACK is not terminal completion; Pi RPC sends acceptance after preflight and later emits `agent_settled`. Current bridge returns custom ACK and does not wait for settled. Load reads persisted Pi session identity; cancel sends abort then TERM/KILL. Cross-process duplicate-session protection is absent.

## Task: T0 — Deep Baseline Audit
Status: PASS

Inspected:
- `extensions/pi-harness.ts`; all 13 named lib modules; role profiles and `.pi/subagents.json`; ACP bridge/content/package; named lifecycle test families; package scripts; README/architecture/coordinator doctrine; installed package spawn and Pi boundary/compaction/RPC implementations.
Findings:
- Shipped: managed runner, TaskGraph, bounded parallel waves, Evidence store, deterministic/selected semantic verification, Domain Heads, exact security routing, restore/epoch guards, explicit project memory.
- Partial: lifecycle ownership, typed Task registration, safe failure projection, ACP request lifecycle, verification trust policy and live E2E proof.
- Unimplemented: stable prompt boundary, deterministic ContextEdit GC, GC-before-native-compaction, warming suppression and reproducible context economics benchmark.
- Root inconsistencies: missing settlement passes through; failed ACK skipped drain; old manual compaction remains; Coordinator authors gate shell text; ACP ACK is not completion; Zed smoke does not launch Zed.
Changes:
- None before root-cause report; subsequent T1 fix is recorded separately.
Verification:
- Commands/results: runtime version probes confirmed exact versions; baseline `npm run test:all` PASS outside sandbox, 138+20 with zero skips; `npm run doctor` PASS outside sandbox; `git diff --check` PASS.
- Tests: Pi exact compatibility targets; package startup/worktree and terminal ownership; managed runner/session/parallel suites; ACP lifecycle and packaged Zed smoke.
- Runtime evidence: real installed Pi RPC process and package worktree probes within integration tests; no live managed coding claim.
DoD:
- [x] HEAD and git status recorded.
- [x] Package/runtime versions verified.
- [x] `npm run test:all` executed and environment difference recorded.
- [x] Architecture/runtime inconsistencies listed.
- [x] Shipped/partial/planned separated.
- [x] Root-cause report preceded source changes.
Remaining blocker: none for audit; implementation tasks remain open.
Commit: none.

## Task: T1 — Child Lifecycle Ownership Closure
Status: PASS

Inspected:
- lib/coordinator.mjs: requestRpc, terminalWaiter, createSpawnAttempt, requireChildSettlement, reconcileSpawnFailure, reconcileChildTermination, retainUntilSettled.
- Installed pi-subagents 0.19.0 startup, onQueued/onSpawned callbacks, startGate, awaitStartup, abort and package promise settlement.
Findings:
- The package can own a queued/running child before RPC ACK. Missing settlement is not proof of termination.
Changes:
- Capture queued identity/startup and exact child promises; abort during handshake; bounded late-ACK reconciliation; fail closed and retain ownership when settlement is unknown.
- A repeated same-child callback can attach its later settlement promise. No sibling-wide abort. Remove RPC/terminal/signal listeners once settled.
- Fake buses now model package settlement promises; they no longer rely on the removed unsafe fallback.
Verification:
- command: npm run test:all; result: build PASS, 155 unit + 20 integration PASS, zero skips; final log /tmp/harness-t1-t4-release-check.log.
- tests: missing package settlement fails closed; queued cancellation waits for startup gate; cancellation during spawn ACK; seven role ACK-failure regressions; late-result byte-equivalent session snapshots; sibling timeout isolation.
- runtime evidence: pi-subagents real queued child cancels without starting while its sibling owns startup; installed package worktree cleanup and real Pi RPC integration tests.
DoD:
- [x] RPC timeout and pre-ACK startup inspected; ownership covers spawn, acknowledgement, wait, cancellation and cleanup.
- [x] Spawn timeout cannot abandon an owned running child; unknown settlement retains ownership until exact proof.
- [x] Exact Worker, Scout, Research, Coordinator, Domain Head, Reviewer and Security Reviewer cancellation paths covered.
- [x] Sibling survives timeout; listener cleanup and activeTasks release after confirmed settlement covered.
- [x] Late completed/failed events ignored; old session cannot mutate new Operation/TaskGraph.
- [x] Regression coverage includes queued and actual installed-package ownership boundaries.
Remaining blocker: none for these ownership invariants. Unknown package cleanup disposition remains explicitly unknown, not fabricated.
Commit: none.

## Task: T2 — Managed Execution Budget Policy
Status: PASS

Inspected: coordinator terminal/RPC/settlement budgets, worker-gate subprocess behavior, installed package cleanup callback ordering.
Findings:
- Execution time and verification time are separate phases. Gate can begin before spawn ACK; ACK must not restart the paused execution timer.
Changes:
- Async cancellable verification shell with bounded output; TERM process group then KILL after 100ms; bounded drain at 1500ms. Unix process-group cleanup is not an OS sandbox.
- Independent default Reviewer budget of 120s, not inherited from Worker 300s. Gate-in-flight guard prevents execution timer rearming.
- Git verification/disposition subprocesses have 5s SIGKILL deadlines and bounded buffers.
Verification:
- command: npm run test:all; result: 155 unit + 20 integration PASS, build PASS, zero skips.
- tests: fake-clock terminal deadline exact boundary; fake-clock Reviewer 120s default with 300s execution; execution budgets start after RPC acknowledgement; gate outlasts Worker execution timer; shell descendant timeout/cancellation and bounded output; Infinity rejected; actual queued-child cancellation; blocked Task ID cannot be reclaimed.
- runtime evidence: real shell sleep descendants terminated; real installed package queued child stopped without running.
DoD:
- [x] Lifecycle budgets documented in target-architecture.md: RPC 15s/max60s, late ACK grace35s, default execution120s/Worker300s/max300s, gate60s, cleanup/drain5s, Git probes5s.
- [x] Worker and independent Reviewer bounded; no Infinity; no unbounded subprocess timeout setting.
- [x] Verification can outlast execution timer without being killed by that timer; parent cancellation still reaches gate.
- [x] RPC and execution budgets separate; timeout abort, cleanup/drain and queue cancellation tested.
- [x] Unknown outcomes blocked; continuation requires fresh Task ID.
Remaining blocker: none for wall-clock lifecycle policy. Turn/token/tool-call/file-scope quotas remain separate follow-up, not claimed implemented. Phase budgets are sequential, not a claimed 300s whole-pipeline limit.
Commit: none.

## Task: T3 — Coordinator Contract Robustness
Status: PASS

Inspected: lib/task-spec.mjs, createOperation, parseCoordinatorDecision, runOperation, pi_harness_operation schema and coordinator profile.
Findings: Coordinator-authored mechanical fields, especially verification shell text, cannot confer execution authority.
Changes:
- Central validateTask and trusted TaskSpec registration validates owner/permission/verification/criteria/review selection. Commander/user registration grants command trust.
- Coordinator chooses task_id or bounded task_ids; Harness resolves registered spec, exact intent, constraints, lineage and Scheduler truth.
- Legacy full packets must match registered mechanical fields exactly. Legacy Operations without specs cannot dispatch; no auto-trusting old shell commands.
- Retained bounded one-repair path within persisted 12-turn budget.
Verification:
- command: npm run test:all; result: build + 155 unit + 20 integration PASS.
- tests: trusted TaskSpec resolves ID-only dispatch and rejects mechanical substitution; malformed or unauthorized CoordinatorDecision; bounded decision repair; dependency/foreign/oversized packet rejection; atomic batch validation; restore/retry budget; registered Worker through actual extension tool boundary.
- runtime evidence: exact Pi runtime/tool discovery; Coordinator/Worker model-backed proof still belongs to T10 and is not inferred from fixtures.
DoD:
- [x] Mechanical validation centralized; owner/permission enums enforced in code, not only prose.
- [x] Unregistered IDs, dependency bypass, foreign Operation and oversized packets rejected.
- [x] Malformed JSON fails closed with one bounded repair; second invalid response blocks.
- [x] Mechanical mistakes require no new prompt patch: ID-only dispatch resolves the trusted schema.
- [x] Coordinator cannot spawn directly or complete Mission.
Remaining blocker: none for the contract. Callers creating runnable Operations must now register task_specs; historical accepted results are retained without gaining new execution authority.
Commit: none.

## Task: T4 — Failure Taxonomy & Bounded Observability
Status: PASS

Inspected: lib/failure-codes.mjs; gate normalization; semantic review; TaskResult; TaskGraph restoration; OperationReport.
Findings: Missing/failed gate and Reviewer error provenance previously collapsed into generic verification failure; persistence exceptions could escape the bounded report.
Changes:
- Stable allowlisted RPC/spawn/terminal/settlement/cancel/lineage/worktree/Evidence/gate/semantic/security/Scheduler/decision/session-interruption classes.
- Preserve gate and review codes into TaskResult; security unavailability and exact-model mismatch fail closed distinctly. Restart marks interrupted running nodes explicitly.
- Persistence failures return a bounded code without raw exception text; failure reporting does not spawn when claim/turn persistence fails.
- Commander findings contain registered verified criteria, not model-authored finding bytes or raw Evidence references.
Verification:
- command: npm run test:all; result: build + 155 unit + 20 integration PASS.
- tests: failure projection across transport, execution, persistence and restore; Commander findings omit model-authored execution bytes and Evidence references; role timeout/review/Evidence-store failures; session reconciliation; bounded large reports.
- runtime evidence: real gate timeout; actual package startup/worktree probes. Injected failures verify stable codes and private stdout/stderr/path absence without treating injection as a live coding flow.
DoD:
- [x] Stable taxonomy exists; timeout, spawn, lineage, Evidence and verification failures distinguishable.
- [x] RPC/terminal/gate/Reviewer/cancel/session/persistence failure projections covered.
- [x] OperationReport remains bounded, exposes task_id/failure_code/blocked action/required condition.
- [x] Raw error strings, child stdout/stderr, worktree paths and raw Evidence are absent in regression projections.
Remaining blocker: none for the projection boundary. Unknown codes map to HARNESS_UNKNOWN rather than accepting arbitrary error text.
Commit: none.

## Task: T5 — Stable Prompt Boundary
Status: PASS

Inspected:
- lib/context-economics.mjs: stablePromptSections/installStablePrompt; extension before_agent_start; installed Pi 0.87.1 native prompt runner.
Findings:
- Stable sections are Harness-owned bytes. Only explicit saved project memory enters the memory section; Worker output is never promoted. Forced upstream system prompts use an idempotent fallback block.
Changes:
- Removed repeated pi-harness-context conversation injection. Native systemPromptOptions.sections installs/removes exact contract, memory and plan keys; /learn uses session cwd.
Verification:
- command: npm run test:all; result: build PASS, 159 unit + 20 integration PASS, zero skips (/tmp/pi-harness-phase-i-final-all.log).
- tests: real Pi prompt runner keeps sections byte-stable and learn/plan invalidate only intentionally; Phase I uses Pi-native stable sections instead of accumulating context messages.
- runtime evidence: actual Pi ExtensionRunner prompt generation verifies repeated bytes/no duplicate message, XML-escaped memory, plan invalidation and forced-prompt idempotence; live managed rerun also succeeds.
DoD:
- [x] Repeated contract entries removed; supported native stable prompt boundary used.
- [x] Unchanged prefix byte-stable; /learn and plan intentionally invalidate relevant sections.
- [x] Worker raw context excluded; compatibility tests exercise actual behavior.
Remaining blocker: none.
Commit: none.

## Task: T6 — Deterministic Context GC
Status: PASS

Inspected:
- lib/context-economics.mjs: deterministicContextEdits; extension maintainContext/turn_end/agent_before_settle; native SessionManager ContextEdit projection.
Findings:
- Conservative GC recognizes exact legacy contracts and accepted execution/status superseded by a later complete OperationReport. Unknown, unresolved, pending/running/unaccepted/current-turn entries remain. No model decides garbage.
Changes:
- Native context_edit drafts at safe boundaries, maximum64 per pass. ToolResult replacements retain call structure. Raw history stays intact; maintenance stores only counts/bytes.
Verification:
- command: npm run test:all; result: 159+20 PASS, zero skips.
- tests: native ContextEdit GC shrinks future context, retains raw history and protects active/unaccepted state; 92.5% long active turn waits for safe boundary; active tool structure prevents GC until an explicit safe boundary; real Pi RPC ContextEdit after completed hashline tool.
- runtime evidence: real Pi session projection and RPC preserve raw history, reduce future messages, and leave Operation/TaskGraph byte-equivalent. Live benchmark removes12 historical contracts: context38842→14998 bytes, input7279→2776 tokens.
DoD:
- [x] Deterministic supersession rules and ContextEditEntry implemented.
- [x] No active-tool edits; current/unaccepted/active state and tool structure preserved.
- [x] Raw history retained; future model context measurably smaller.
- [x] 92.5% safe-boundary regression; Mission/Operation/Scheduler semantics unchanged.
Remaining blocker: none; unrecognized historical content is intentionally retained, not guessed away.
Commit: none.

## Task: T7 — GC Before Compaction / Pi-native Ownership
Status: PASS

Inspected:
- extension context/maintainContext/session_before_compact/session_compact hooks; installed native reserve and compact semantics; lib/compaction-policy.mjs.
Findings:
- Native manual compact aborts the session; Harness no longer calls it. 70% is soft maintenance, not an emergency threshold. Pi remains the final reserve/window owner.
Changes:
- Removed proactive ctx.compact path. Safe turn_end/agent_before_settle GC checkpoints control state; high-water rearm requires lower usage. Compatibility command /harness-compact configures maintenance only.
Verification:
- command: npm run test:all; result: 159+20 PASS; real Pi lifecycle focused suite6/6 PASS (/tmp/harness-phase-i-runtime.log).
- tests: 70% is a configurable soft GC trigger; GC does not loop at the same high-water mark; active direct TaskOrder and semantic Reviewer are never aborted; context maintenance waits until both parallel Task pipelines settle; native compaction satisfies pending request without a second Harness compaction.
- runtime evidence: real Pi RPC native reserve/compaction plus native ContextEdit flow; native checkpoint tests retain Mission/TaskGraph; live benchmark compaction_count0 (not a paid emergency-pressure claim).
DoD:
- [x] Old manual path and abort semantics reviewed; unsafe Harness call removed.
- [x] GC-first maintenance; Pi native reserve final safety mechanism.
- [x] State checkpoint survives native compaction; graph unchanged.
- [x] No active Worker/Reviewer abort or repeated high-water loop.
Remaining blocker: none; lossy native compaction still belongs to Pi.
Commit: none.

## Task: T8 — Pi-native Cache Warming Coordination
Status: PASS

Inspected:
- extension cache_warming_decision, prefix fingerprint and maintenance/native-compaction/shutdown flags; Pi0.87.1 native warming API semantics.
Findings:
- Pi owns mechanics, provider behavior and economics. Harness only returns action:stop when imminent prefix/context changes or session shutdown make warming wasteful.
Changes:
- Suppression handler; no model ping, empty prompt, keepalive timer or credential inspection/modification.
Verification:
- command: npm run test:all; result: 159+20 PASS.
- tests: Pi-owned warming stops only for prefix changes, pending GC, native compaction or shutdown; real Pi stable prompt invalidation and runtime API-shape tests.
- runtime evidence: installed native decision contract used; paid proof explicitly disables warming to bound spend, so it is not a claim of paid provider warming savings.
DoD:
- [x] Mechanics remain Pi-owned; no synthetic keepalive.
- [x] Maintenance/prefix-change suppression and intentional invalidation tested.
- [x] No provider credential inspection/modification.
Remaining blocker: none for policy coordination; provider-specific warming benefit is not asserted.
Commit: none.

## Task: T9 — Context / Cache / Cost Telemetry
Status: PASS

Inspected:
- lib/context-economics.mjs: contextTelemetry; extension /harness-context/footer/child-usage; scripts/managed-coding-proof.mjs.
Findings:
- Runtime availability is explicit. Provider-reported dollar cost and exact GC token count remain null when not supplied. Catalog cost/estimated context are labeled; zero reported cache read/write is not missing data.
Changes:
- Token/cache/warming/edit/compaction/GC-byte telemetry; bounded numeric child usage only, epoch guard; footer no longer fabricates zero missing cost. Portable isolated proof/benchmark runner with shared full-window/full-output reservation guard and zero retries.
Verification:
- command: node --experimental-strip-types scripts/managed-coding-proof.mjs openai-codex/gpt-6-luna /tmp/pi-harness-live-token-budget.json --benchmark; result: exit0 (/tmp/pi-managed-phase-i-proof-final.log).
- tests: telemetry records runtime metrics without inventing provider cost or missing token counts; complete correctness suite159+20 PASS.
- runtime evidence: /tmp/pi-managed-proof-YOdPck/benchmark.json. Same request with12 historical contracts: input7279→2776 (-61.9%); output5→5; cacheRead0→0/cacheWrite0→0; context bytes38842→14998; GC candidate content22584 bytes removed;12 edits;0 compactions. Different byte measures are labeled, not converted to invented token removals.
- budget: all isolated attempts share ledger;32 actual requests; conservative catalog-rate token upper bound USD0.017393, reserved0, ceilingUSD1. Provider-reported cost:null. No active model/provider/auth setting changed; Luna override was explicitly authorized. Benchmark has warming off, therefore no paid warming-cost comparison.
DoD:
- [x] Reproducible workload; before/after real input/cache metrics recorded.
- [x] GC reduction/edit/compaction counts and correctness recorded.
- [x] Provider cost recorded only when genuine; unavailable remains null.
- [x] Shared USD1 guard; no invented provider bill or credential copying.
Remaining blocker: none for requested benchmark; this workload does not establish savings for every provider.
Commit: none.

## Task: T10 — Managed Operation End-to-End Proof
Status: PASS

Inspected:
- Actual Pi SDK, installed pi-subagents manager, Harness tools, trusted TaskSpecs, package worktree/gate/Evidence/Coordinator acceptance, and the full failure-mode test matrix.
Findings:
- The baseline and Phase I rerun pass. The live Commander now starts an Operation through an autonomous Pi SDK prompt. It does not inject a TaskResult, mutate the Scheduler, or merge a Worker branch.
- The first autonomous attempt used an incomplete TaskSpec prompt and ended blocked after 21 requests. The failed attempt remains in `/tmp/t10-live-autonomous-commander.log`. The exact TaskSpec rerun passed.
- A live semantic Reviewer attempt returned `HARNESS_SEMANTIC_REVIEW_FAILED`. The Harness blocked the Operation and accepted no TaskResult. The failure stayed fail-closed.
- The installed pi-subagents package can report `hasChanges: false` while an injected worktree removal and prune failure leave the physical worktree present. Harness disposition remains `worktree_status: unknown`.
Changes:
- Added `--autonomous` to `scripts/managed-coding-proof.mjs`. The runner records only the bounded OperationReport and safe proof summary. It uses the isolated Luna model override and the shared USD 1 guard. It does not change active provider, model, or authentication settings.
- Added package-backed cleanup-failure coverage in `test/parallel-package-integration.test.mjs`.
- Added a real Pi RPC restart test that restores an open Operation and its TaskGraph in `test/pi-plan-lifecycle.test.mjs`.
Verification:
- Autonomous live command: `node --experimental-strip-types scripts/managed-coding-proof.mjs openai-codex/gpt-6-luna /tmp/pi-harness-live-token-budget.json --autonomous`; PASS. Operation `O-LIVE-AUTONOMOUS` completed. Task `T-LIVE-AUTONOMOUS` was verified and accepted. Mission remained active. Parent worktree stayed clean. Evidence: `/tmp/t10-live-autonomous-commander-final.log` and `/tmp/pi-managed-proof-fCG7hD/proof.json`.
- Live Reviewer failure probe: `/tmp/t10-live-autonomous-commander-reviewer.log`; Operation stayed blocked with `HARNESS_SEMANTIC_REVIEW_FAILED`. The OperationReport had no accepted Task IDs.
- `npm run build && npm run test`: build PASS; 159/159 unit tests PASS; zero skips (`/tmp/t10-unit-after-matrix.log`).
- Normal `npm run test:integration`: 33/33 PASS; zero skips (`/tmp/t10-integration-after-matrix.log`). This includes the package cleanup-failure injection and real Pi RPC restart proof. Controlled tests cover switch, parallel timeout, cancellation, retry, and semantic/security Reviewer failures.
- Shared live budget: limit USD 1; catalog-derived upper bound USD 0.04815775; reserved USD 0; 84 requests; provider-reported cost remains null. No credentials were read or printed.
DoD:
- [x] A real managed coding Operation completed with an accepted, verified TaskResult and deterministic Evidence.
- [x] A live autonomous Commander turn registered and ran the Operation. The bounded OperationReport reached the Commander.
- [x] No direct merge, TaskResult injection, or Scheduler mutation occurred.
- [x] Operation completion did not complete the Mission. Baseline and Phase I rerun evidence remain valid.
- [x] Restart, switch, parallel timeout, cancellation, retry, and Reviewer failure paths pass in the package-backed/runtime test matrix. Cleanup failure keeps worktree disposition unknown.
- [x] The live USD 1 guard passed. Provider-reported cost remains null.
Remaining blocker: none for T10. Failure rows use controlled injection. The autonomous live proof covers a successful Worker Operation; the live semantic Reviewer probe covers fail-closed behavior.
Commit: `8816ef2`.

## Task: T11 — ACP / Pi RPC Lifecycle Closure
Status: PASS

The previous scoped closure covered the catalog-drain runtime patch, ACP v1 lifecycle, and one Zed 0.229.0 GUI prompt. The Commander reopened T11 on 2026-09-28 to implement mandatory ACP v1 stdio MCP support. The stdio MCP implementation and its requested lifecycle proof now pass. The full official ACP conformance suite was not found and is not claimed. The readiness, legacy cancellation, and pre-v1 protocol records below are historical.

Historical pre-v1 bridge checkpoint:

Inspected:
- HEAD35dc2ad803c0d8c8f9438f0a507997fadf72134e; initially clean worktree.
- Actual /run/current-system/sw/bin/pi resolves to Nix Pi0.87.1, Node24.20.0, bundled cli-runtime/chunk-OJP47DM6.js. Local test runner is Node22.22.2. Inspected installed plain dist sources and actual bundle, not just the local SDK.
- Pi main:createAgentSessionServices→ModelRuntime.create/refresh→resource loading→runRpcMode→bindExtensions→attachJsonlLineReader. Native get_state/get_commands/prompt preflight and AgentSession.prompt; FileModelsStore.readLatest; FileAuthStorageBackend.acquireLockAsync; installed proper-lockfile acquisition/exit registry.
- ACP spawnPi/ensureSession/rpcToPi/cancel/shutdown, persisted identity, both direct and bridge test helpers; official ACP v1/v2 and SDK1.5.0 contract.

Findings — demonstrated root cause:
- This is NOT demonstrated loss of an early /plan packet. Normal early packets succeed after buffering: /tmp/pi-startup-race.log shows write11.356ms, RPC-reader attachment1868.489ms, correlated native get_state response1884.417ms and early prompt reply1884.565ms. First stdout alone is not a readiness signal: bindExtensions can emit UI events before the input reader is attached.
- Failed native child1774295: spawn1790526795477, first write1790526795478, no response at+7002ms, exit+10022ms. A get_state-first experiment also fails2/4: the failing commands were withheld entirely; native readiness itself never arrived (/tmp/t11-readiness-experiment.log, /tmp/pi-ready-experiment.jsonl). Disabling compile cache does not fix it.
- Failed child1790724 pending stacks are FileModelsStore.readLatest→FileAuthStorageBackend.acquireLockAsync before RPC startup (/tmp/pi-async-1790724.json). The backend class name does not imply credential access: FileModelsStore uses that backend for models-store.json. Only stack locations and catalog-lock metadata were inspected, not credentials.
- Controlled native TERM comparison: child1809908 received TERM1790527186171 while lock absent; exited1790527186216 with a newly stranded catalog lock, mtime1790527186171.7056. Next children1810096/1810881 inherited that same lock and timed out after10s without RPC output (/tmp/pi-close-experiment.jsonl; /tmp/t11-native-close-metadata.log). Native backend's stale threshold is30s; this is shared catalog-lock startup blocking, not command latency.
- Exact installed-library gap reproduced on synthetic catalog /tmp/pi-lock-gap-Nz7fUF: lock directory exists, tracked registry count0, child TERM exits, lock remains, next acquisition ELOCKED. /tmp/t11-lock-gap-proof.log, command node /tmp/pi-lock-gap-proof.mjs exit0. proper-lockfile creates directory and awaits mtime precision probing before registering the lock; exit cleanup only removes registered locks. No real runtime lock was deleted or modified.
- Abort acknowledgement plus EOF/native shutdown helps (controlled4/4 and initial fixed real7/7), but later reruns still strand locks. Pi0.87.1 main starts background catalog refresh with a private controller; AgentSessionRuntime.dispose does not abort/await it, and no native RPC exposes its drain. A readiness barrier cannot repair that runtime shutdown gap.

Changes:
- packages/pi-harness-acp/lib/pi-rpc.mjs:createPiRpc/PiRpcError owns bounded readiness, exact pending requests, exit/error rejection, late-response suppression, listener/timer cleanup, cancellation and termination. Readiness is a correlated native get_state response, not sleep or stdout activity.
- Bridge new and fresh restore/reconnect await the same readiness promise; starting sessions are not persisted as usable. Identity checked against requested/restored Pi ID; stale exited-session callbacks cannot publish readiness or delete replacement sessions.
- Existing normal30s RPC deadline unchanged. Timeouts reject PI_RPC_TIMEOUT, never resolve undefined; bridge drains/stops its owned child on RPC timeout/write failure. Child exit rejects every pending promise immediately; failures expose bounded codes, not raw child errors.
- Cancel bypasses pending readiness; independent500ms abort acknowledgement, then EOF/native dispose, bounded1500ms exit wait, TERM1500ms, KILL1500ms. A success response requires observed exit; cleanup failure is typed, not asserted terminated.
- Direct integration helper uses the same readiness/ownership invariant; its10s command deadline begins after readiness. ACP observer remains15s. No deadlines were increased, no startup sleeps/pings/provider changes were added.
- Reconnect test now always closes its second bridge, including assertion failure. One bridge orphaned by the pre-fix fixture was identified as owned PID1821776 and stopped explicitly; its Pi child had already exited. No unrelated process was stopped.
- Historical pre-v1 checkpoint: added7 core lifecycle regressions and4 controlled wire-level bridge regressions. The controlled peer has no model or credentials. The current ACP v1 contract and limits are recorded below.
- Phase I, managed-operation code, Worker budgets and Context Economics were unchanged at this historical checkpoint. T14 was not edited at that checkpoint. No commit or push occurred then.

Verification:
- Original serialized reproducer: node --test --test-concurrency=1 test/acp-acceptance.test.mjs test/pi-rpc-integration.test.mjs;5/7 PASS,2 direct initial /plan timeouts; /tmp/t11-original-repro.log.
- Core regressions: node --test test/acp-rpc-lifecycle.test.mjs;7/7 PASS, no skips. Controlled bridge regressions all4 PASS, including real child PID disappearance, in /tmp/t11-new-regressions.log and repeated full runs.
- Initial fixed historical7/7 PASS: /tmp/t11-second-fix-repro.log. This is not accepted as stability proof.
- Expanded serialized repeats: /tmp/t11-serialized-repeat-2.log and -3.log each9/11 PASS,2 ACP readiness failures; direct goal/compaction suites pass there. Earlier expanded run /tmp/t11-new-regressions.log16/18 PASS (includes7 core tests).
- npm run test:integration repeated3 times: /tmp/t11-integration-repeat-1.log, -2.log, -3.log EACH27/31 PASS,4 readiness failures, zero skips. Failing cases: ACP lifecycle/reconnect, ACP forwarding, direct plan and direct goal. Initial-command failures now have typed PI_RPC_NOT_READY and bounded child cleanup, not undefined success; startup is still NOT stable.
- npm run build PASS; npm run test159/159 PASS, zero skips (/tmp/t11-unit.log). Final focused wire-level4/4 PASS (/tmp/t11-wire-final.log), core7/7 PASS (/tmp/t11-core-final.log). Bridge/helper syntax checks and git diff --check PASS. Protected extensions/lib source unchanged; T14 section verified byte-identical against HEAD. No active test ACP/Pi RPC process remained after all runs settled.
- Historical pre-v1 protocol note: the bridge then used a custom `accepted: true` response and `agent_settled` notification. The current ACP v1 implementation below supersedes that contract. ACP v1 returns a terminal `stopReason`; cancel is a notification. References: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx and /v2/overview.mdx; https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html.

DoD / acceptance:
- [x] Installed startup and deterministic native probe deep-traced; timestamps and actual pre-RPC blocker demonstrated.
- [x] Delayed startup cannot advertise readiness; fresh reconnect uses same barrier; identity verified.
- [x] Readiness deadline typed failure + cleanup; pending exit rejection; RPC timeout/late-reply/timer-map regressions.
- [x] Cancel during startup/outstanding prompt; short independent abort budget; bounded TERM/KILL fallback; controlled child PID absent after settle.
- [x] ACP v1 prompt completion waits for Pi settlement for normal prompts; registered Harness commands use their completion notification. Cancel returns `stopReason: cancelled`.
- [x] Repeated historical/full integration executed; failures retained rather than hidden by a green rerun.
- [x] Serialized reproducer repeatedly green with zero initial-command timeout after canonical package deployment.
- [x] Full integration repeatedly green; real ACP forwarding stable across cold restarts.
- [x] Runtime catalog refresh drained before shutdown; catalog-drain markers verified in the installed bundle.
- [x] ACP v1 lifecycle/subprocess tests and Zed GUI prompt integration passed. The full official ACP conformance suite was not run and is not claimed.

Runtime patch checkpoint (2026-09-28):
- User authorized the narrow Pi catalog lifecycle patch. packages/pi-harness-acp/runtime/pi-0.87.1-catalog-drain.mjs tracks raw provider operations/publication chains and physical FileModelsStore lock promises; RPC disposal aborts its background controller and drains these before native dispose. Merely awaiting public refresh is insufficient because raceWithAbortSignal returns before physical lock acquisition settles. Existing deadlines, refresh cancellation behavior, providers/models and Harness policies unchanged.
- Permanent regression command: node packages/pi-harness-acp/runtime/catalog-drain.test.mjs;2/2 PASS. Tests prove public provider/read abort can finish while physical work remains, drain stays pending until that work ends, and tracked sets then empty. Tests use synthetic storage/provider, no credentials or paid token requests.
- Disposable actual Pi0.87.1 source runtime /tmp/t11-runtime-VM3xax, same installed Node24.20.0 and dependencies: historical serialized reproducer3 consecutive11/11 PASS, zero skips (/tmp/t11-drained-serialized-1.log through -3.log).
- Full integration with explicit disposable runtime selection3 consecutive31/31 PASS, zero skips (/tmp/t11-drained-full-1.log through -3.log). Command: npm run test:integration --script-shell=/tmp/t11-patched-script-shell. All command and readiness deadlines unchanged. Native goal/compaction and ACP forwarding/reconnect pass.
- A preceding npm run test:integration still27/31 because npm prepends node_modules/.bin/pi (unpatched local Pi0.87.1), overriding the disposable PATH prefix. That failure is retained in /tmp/t11-drained-integration-1.log; it is NOT evidence against the patched runtime and NOT hidden as a default-runtime success.
- Canonical Nix package owner: `/etc/nixos/hosts/think14gryzen/system/packages.nix` now extends `pkgsUnstable.pi-coding-agent` with a `postBuild` call to the version/source-guarded patcher from pinned Pi Harness commit `be0f4524cadf2839db4f9dbbada453ee8c025a92`. `nix flake check --no-build --no-write-lock-file /etc/nixos` PASS. The Pi 0.87.1 derivation build PASS; it ran the normal build, applied the patch, rebuilt the coding-agent bundle, and packaged `/nix/store/g1hn6gr52qwpmh1w1cvfsa2qrx1j428r-pi-coding-agent-0.87.1`. Patched symbols exist in bundled chunks; aggregate bundle fingerprint is `bfc4efa014e5d74637ab627973bc352deb1424cbc7215df2021212ef612ba817` across56 files. The full NixOS build PASS at `/nix/store/jn2h1pc3xyn9zdy4wfcf4n8d7kad1fpf-nixos-system-think14gryzen-25.11.20260630.b6018f8`.
- `test/helpers/default-pi.mjs` removes npm-injected ancestor `node_modules/.bin` entries only from Pi child environments. It ignores inherited `PI_BIN`, resolves the shell's default Pi, logs the bundle fingerprint, and fails unless all catalog-drain markers exist in the executable bundle.
- `npm run build && npm run test && npm run test:runtime` PASS: build,159/159 unit tests,2/2 runtime tests; zero skips.
- System activation was initially blocked because sudo required a terminal. The user later activated the build. `/run/current-system/sw/bin/pi` now resolves to `/nix/store/g1hn6gr52qwpmh1w1cvfsa2qrx1j428r-pi-coding-agent-0.87.1/bin/pi`; `pi --version` returns `0.87.1`. The previous system generation remains available for rollback. The pre-existing `/etc/nixos/flake.lock` change was preserved.
- Normal `npm run test:integration` passed three consecutive runs:31/31 each, zero skips (`/tmp/t11-canonical-integration-1.log` through `-3.log`). Each test log identifies the default Pi package and patched bundle fingerprint. No `PI_BIN`, shell override, or caller PATH override was used.
- Historical serialized reproducer `node --test --test-concurrency=1 test/acp-acceptance.test.mjs test/pi-rpc-integration.test.mjs` passed three consecutive runs:11/11 each, zero skips (`/tmp/t11-canonical-serialized-1.log` through `-3.log`).
- `npm run test:all` PASS: build,159/159 unit tests,2/2 runtime tests,31/31 integration tests; zero skips (`/tmp/t11-canonical-all.log`).
- Installed default bundle fingerprint: `bfc4efa014e5d74637ab627973bc352deb1424cbc7215df2021212ef612ba817` across56 files. The test helper confirms `drainRefresh`, `refreshOperations`, and `storageOperations` markers in that bundle.
- The drain has no internal deadline. A provider or storage operation that never settles can hold native disposal indefinitely. ACP EOF grace, TERM and KILL still bound bridge shutdown. Forced KILL cannot guarantee graceful lock release; README documents this limitation.
- Historical checkpoint: T11 was PASS for the scoped runtime and ACP v1 integration. The Commander later reopened T11 for mandatory stdio MCP support. Zed 0.229.0 GUI displayed the expected prompt response. Full official ACP conformance remains unverified and is not claimed.

### Previous ACP v1 closure checkpoint — before stdio MCP

- The bridge uses `@agentclientprotocol/sdk` 1.5.0 and stable ACP v1. It implements initialize, new/resume/close, text/image prompts, text/thought/tool updates, prompt cancellation, and four Harness commands. This historical checkpoint rejected MCP server configurations. It did not advertise `loadSession` or model selection. Session ownership remains process-local; persisted sessions are not locked across ACP processes.
- Pi 0.87.1 `message_update` has `assistantMessageEvent` without an assistant `message` envelope. The bridge now maps that event. The first live Zed prompt exposed this defect: Pi completed the prompt, but Zed displayed no response. The fixture now matches Pi's event shape.
- Zed 0.229.0 GUI test with the registered `pi-harness` agent passed. Zed displayed the exact response `ACP GUI check passed.`. Screenshot: `/tmp/t11-zed-ws2-result.png`. The two recorded GUI prompt turns have Pi catalog estimates totaling USD0.031849. Provider-reported cost is unknown. These turns are separate from T10's live budget ledger.
- `npm run test:all` passed: build,162/162 unit tests,2/2 runtime tests,34/34 integration tests; zero skips. Log: `/tmp/pi-harness-t10-t14-final-test-all.log`. Normal `npm run test:integration` passed34/34; zero skips. Log: `/tmp/pi-harness-t10-t14-final-integration.log`. No `PI_BIN`, PATH override, or `--script-shell` override was used.
- The default Pi bundle fingerprint is `bfc4efa014e5d74637ab627973bc352deb1424cbc7215df2021212ef612ba817`; the default-runtime test confirms catalog-drain markers. The active default executable resolves to `/nix/store/g1hn6gr52qwpmh1w1cvfsa2qrx1j428r-pi-coding-agent-0.87.1/bin/pi`.
- An isolated offline install of the packed ACP package passed. NPM installed SDK1.5.0 and peer zod4.6.5; the packaged executable returned version1.0.0.
- `npm run doctor` passed with failures `[]`. `npm run verify:skills` passed with22 verified skills. Final `git diff --check` and targeted stale-claim search passed.
- The catalog drain has no internal deadline. A provider or storage operation that never settles can hold native disposal indefinitely. Forced KILL cannot guarantee graceful lock release.
- No full official ACP conformance suite or live Daybreak security call was run. Do not claim either result.

Remaining blocker:
- No blocker remains for the requested T11 stdio MCP scope. T14 release closure remains open. No full ACP conformance claim is made. Do not raise deadlines, force offline mode, or delete shared locks.

### Reopened T11 acceptance — ACP v1 stdio MCP

Status: PASS

The bridge supports stdio MCP through a Pi extension. `session/new` and `session/resume` complete initialize and full tool discovery before readiness. Pi receives deterministic tool names. Resume reconnects the complete requested MCP server set. The bridge sanitizes MCP errors, ignores stderr, and cleans server processes on close and shutdown. POSIX process-group cleanup is tested; detached descendants remain outside the guarantee. MCP commands run with host permissions and are not sandboxed. HTTP/SSE remain unsupported. `session/load` and model selection remain unadvertised.

Verification:
- `node --test test/acp-mcp-integration.test.mjs`: 9/9 PASS, zero skips. Tests cover SDK 1.5.0 initialize/new/prompt/close/resume, real local Pi tool calls, multiple-server name collisions and stable names, handshake and malformed-response failures, child exit during a turn, cancellation with connection reuse, child/descendant cleanup, output/stderr secrecy, empty-list behavior, and unsupported transports.
- Normal `npm run test:integration`: 43/43 PASS, zero skips. No `PI_BIN`, PATH, or `--script-shell` override.
- `npm run test:all`: build PASS;162/162 unit tests,2/2 runtime tests,43/43 integration tests PASS; zero skips.
- `npm run doctor`, `npm run verify:skills`, `git diff --check`, packed ACP extension/dependency checks, and an isolated offline ACP tarball install passed.
- Tests use the local MCP fixture and a local Pi test provider. No external model call or provider cost occurred.

The official ACP repository had no conformance suite. Full ACP conformance remains unverified and is not claimed.
Historical checkpoint baseline: no commit at HEAD35dc2ad803c0d8c8f9438f0a507997fadf72134e.

## Task: T12 — Security / Verification Trust Boundary Audit
Status: PASS

Inspected: `lib/worker-gate.mjs:runWorkerVerification`, all role profiles, exact security route/model registry check and deterministic precedence.
Findings: `sh -c task.verification` inherits host environment/filesystem permissions and may link parent node_modules. Before T3 closure, Coordinator-authored verification text could grant host shell execution. T3 now resolves only Commander/user-registered trusted TaskSpecs; mismatched Coordinator verification text is rejected. Git worktree is not an OS sandbox. Reviewer profiles omit mutation tools; security profile has tools none/extensions false/skills false. Exact security model availability and invocation are checked and unavailable model blocks.
Changes: T3 enforces registered trusted TaskSpecs. Tests prove that verification inherits host environment, follows file/dependency symlinks, runs an outside command through a symlink, removes a dependency symlink it creates, and terminates same-group descendants. This is trusted host execution, not a sandbox.
Verification:
- Tests: security availability fails closed; security pass cannot override general failure; deterministic failed gate does not become verified; review packet selection and truncation/integrity rejection.
- Command/result: `npm run test:all` passed after these tests; the focused four-test T12 run also passed.
- Runtime evidence: no live Daybreak call was run. The tests use local fixtures and no credentials.
DoD:
- [x] Current shell authority identified; no OS sandbox asserted.
- [x] Reviewer read-only/security zero-tool/exact model fail-closed and deterministic precedence tested.
- [x] Registered trusted TaskSpec policy documented and enforced; Coordinator cannot replace verification/permission/review fields.
- [x] Host environment, file and dependency symlink, outside-command, created-link cleanup, and descendant termination coverage passed under the selected policy.
Remaining blocker: none for the documented trusted-TaskSpec boundary. No OS isolation is claimed. No live Daybreak call was run.
Commit: `30aa28a`.

## Task: T13 — Documentation / Doctrine Consistency
Status: PASS

Inspected: README, target architecture, future-work, coordinator doctrine, profiles, package versions/budget statements.
Findings: Domain Head, compaction, telemetry, trusted TaskSpec, host-permission, and ACP claims match the current implementation. The README distinguishes implemented features from unfinished scope. The ACP docs state the tested v1 surface and do not claim full official conformance.
Changes: updated `README.md`, `target-architecture.md`, `packages/pi-harness-acp/UPSTREAM.md`, and the runtime README with current ownership, trust, ACP v1, Zed evidence, and catalog-drain limits.
Verification:
- Tests: `npm run verify:skills` passed with22 verified skills. `npm run doctor` passed. The targeted current-document search found no stale ACP/T11 claim. Rerun `git diff --check` after the final documentation edit.
- Runtime evidence: package versions and default Pi bundle fingerprint are recorded in T11. No full ACP conformance or broader Phase I shipping claim is made.
DoD:
- [x] No stale unimplemented Domain Head statement; current version and managed timer claims inspected.
- [x] Phase I implementation claims supported by native/live evidence; no completed-release claim; README/deep architecture roles preserved.
- [x] Ownership, trust, compaction, catalog-drain, and ACP claims reflect tested runtime contracts and explicit limitations.
Remaining blocker: none for T13. Full ACP conformance remains unverified and is not claimed.
Commit: documentation/tracker commit in the four-commit release series.

## Task: T14 — Release / Regression Closure
Status: PARTIAL

Inspected: package scripts, worktree state, remotes, install/RPC/ACP/Zed probes and conditional security live test.
Findings: T0–T13 criteria now have recorded evidence. Three focused commits cover ACP v1, managed proof, and trust-boundary tests. The fourth commit contains documentation and this tracker update. `origin` targets `WillGle/pi-setup.git`; `pi-harness` targets `WillGle/pi-harness.git` and is the current upstream. The `/etc/nixos` worktree has separate commits and an uncommitted `flake.lock`; it is not part of this release push. No CI check-run evidence was obtained.
Changes: T10 autonomous proof guard, ACP v1 bridge and tests, T12 trust-boundary tests, stdio MCP support, current documentation, and this tracker update.
Verification:
- Command/result: current `npm run test:all` passed (build,162 unit,2 runtime,43 integration; zero skips); normal `npm run test:integration` passed43/43; doctor, skill verification, and the final whitespace check passed.
- Tests/runtime: disposable root-package/bootstrap doctor, isolated offline ACP package install, real Pi RPC, ACP lifecycle/subprocess tests, patched default-runtime checks, and Zed 0.229.0 GUI prompt integration passed. No live Daybreak security call or official ACP conformance suite was run. T10's separate live budget evidence remains USD1 ceiling; provider-reported cost is unknown.
DoD:
- [x] Exact runtime versions verified; baseline build/unit/integration/all/doctor pass.
- [x] Package install/RPC/ACP configuration smoke demonstrated; session/parallel controlled regressions pass.
- [ ] Clean working tree and reviewed focused commits.
- [x] Real managed coding Operation before/after Phase I.
- [x] Live Zed 0.229.0 prompt integration passed. Other failure modes use controlled tests; no broader all-live scenario matrix is claimed.
- [x] Context economics live benchmark under the USD1 ceiling.
- [x] T0–T13 scoped Acceptance Criteria have recorded evidence.
- [x] Push the four reviewed commits to `pi-harness/main` and confirm synchronized HEAD.
Remaining blocker: the worktree contains uncommitted T11 stdio MCP implementation, package, test, and documentation changes. T14 release review and commit remain open. These changes were not pushed.
Commits: `6a9b402`, `8816ef2`, `30aa28a`, and the documentation/tracker commit in this release series. Base: `caa7735`.

## Historical validation addendum — original T1 closure

After the focused T1 correction and seven added repository regressions, `npm run test:all` exited 0 outside sandbox: build PASS, unit 145/145 PASS, integration 20/20 PASS, zero failures/cancellations/skips. `npm run verify:skills` PASS (22); `git diff --check` PASS. Full output: `/tmp/pi-harness-master-final-all.log`. This is historical evidence. Current validation is recorded in the T11 closure and T14 below.

## Open items from the historical tracker

- [x] **Historical startup timeout investigation:** the 2026-09-27 Pi 0.87.1 startup timeout cohort was traced to a catalog-refresh/physical-lock drain gap. The runtime patch and default-bundle fingerprint close this cohort. Do not assign this cause to failures outside the recorded cohort.
- [x] **Live failure-mode disposition:** T10 includes package-backed cleanup-failure injection and a post-restart Operation/TaskGraph proof. Unknown worktree disposition stays unknown when cleanup evidence is missing.
- [ ] **Worker resource enforcement beyond wall-clock:** the package supports `maxTurns`/usage callbacks, but Harness does not enforce Worker turn/token/tool-call/file-scope budgets. Keep this as follow-up work. Prompt file scope is not an OS sandbox.
- [ ] **Legacy migration:** test Operations with only `task_intents`, persisted failure codes and parallel compatibility when a complete TaskSpec is registered or the trust policy changes. Do not promote Coordinator-authored shell text into trusted commands.

## Master tracker closure conditions

- [ ] T0–T14 reach their full Definition of Done; T10 has proof before and after Phase I.
- [ ] Ownership, exact-child cancellation, late-event isolation, and bounded outcomes have evidence at each required boundary. Unknown continuation uses a fresh Task ID.
- [x] Commander retains separate decisions for integration and Mission completion. Worker or Operation completion does not imply either decision.
- [x] The live benchmark stayed under the USD1 ceiling. The report did not fabricate provider cost or read, print, or copy credentials.
- [ ] The root worktree is clean. The T11 stdio MCP changes remain uncommitted. The four prior reviewed commits target `pi-harness/main` and are pushed. Push does not imply CI PASS; no CI check-run evidence is available.

## Authorized closure validation checkpoint

T1–T4 closure: npm run test:all PASS (155 unit + 20 integration, zero skips); npm run doctor PASS; npm run verify:skills PASS (22); git diff --check PASS. Log: /tmp/harness-t1-t4-release-check.log. HEAD unchanged. No commit or push. T10 stopped at credentials-safe zero-request preflight; T5–T9 not started by design. The earlier 138/145-test checkpoints above are historical, not the current suite counts.

## Phase I implementation checkpoint — 2026-09-27

T1–T4 retained PASS; T5–T9 now PASS on source, regression and native/live evidence above. T10 baseline and Phase I rerun complete, but overall T10 remains PARTIAL. Current full-suite log /tmp/pi-harness-phase-i-final-all.log: build PASS,159 unit +20 integration PASS, zero skips. Final footer/docs follow-up verification is recorded in /tmp/pi-harness-phase-i-release-all.log. HEAD unchanged; no commit or push. Earlier zero-request/pre-Phase statements are historical snapshots, not current blockers. Token ledger upper bound is catalog-derived, not provider billing; USD1 remains the authorized ceiling.

### Historical final rerun variance — before catalog-drain fix

At this 2026-09-27 checkpoint, `/tmp/pi-harness-phase-i-release-all.log` showed build and159/159 unit PASS, with integration17/20 and3 timeouts: ACP command forwarding (15s), Pi RPC goal, and compaction/restore (`/plan on`,10s). The immediately preceding full run passed159+20. The focused reproduction in `/tmp/pi-harness-final-timeout-repro.log` showed5/7 PASS and2/7 FAIL. The root cause was not proven at that checkpoint. The canonical gate was NOT green then. T11 later traced the startup timeout cohort to the catalog-drain gap, patched the canonical Pi package, and recorded repeated green default-runtime runs above. Do not delete this historical failure evidence.

## Requested follow-up — Coordinator action cleanup and live Context Economics (2026-06-12)
Status: PASS

- Removed the Coordinator `report` action from the prompt, parser, planning checks, and architecture documentation. Planning Operations now accept only `plan_tasks` or `block`. Existing fixtures use explicit `block` decisions. Regression confirms the removed action fails parsing and is absent from the action prompt.
- Targeted tests: operation runner, parallel Operation and parallel Review tests passed 49/49.
- Full gate: `npm run test:all` passed build, 198 unit tests, 2 runtime tests and 43 integration tests. No tests were skipped.
- Live provider benchmark: `openai-codex/gpt-6-luna`, current managed Pi/Harness architecture, native compaction enabled, cache warming disabled. Workload: one verified managed Operation plus 12 prior blocked OperationReports and one later complete OperationReport; same provider prompt before and after deterministic ContextEdit GC.
- Provider usage: input tokens 32,447→3,128; cache read 0→0; cache write 0→0; cache-hit ratio 0→0. These zero values were returned by the provider. Runtime catalog cost: USD0.0032472→USD0.0003153. Provider-reported cost remains null.
- Context: 187,095→22,191 bytes; 12 ContextEdits; total ContextEdit count 0→12; compaction count 0→0. The Mission stayed active. The Operation completed with a verified, accepted TaskResult.
- The shared USD1 reservation ledger recorded 20 requests across two live qualification runs and a catalog-derived upper bound of USD0.025302. No credential was read, printed or changed. Cache warming was disabled, so no warming-cost comparison is claimed.
- Evidence: `/tmp/pi-managed-proof-L5xRFB/benchmark.json`; full log: `/tmp/pi-harness-context-live-20260612-final.log`; final test log: `/tmp/pi-harness-requested-final-all.log`.

## Natural-language execution policy implementation — 2026-06-12
Status: PASS

- Added Commander policy for natural-language objectives, DIRECT EXECUTION versus MANAGED MISSION selection, optional `mission:` and `direct:` hints, strategic questions, explicit resume selection, and automatic deterministic Context Economics.
- Added `pi_harness_start_mission`. It accepts only a natural-language objective and optional Constraints. It creates a new Mission without selecting persisted Missions. Mission Constraints persist on the Situation Board, enter each Operation, and remain in compaction state.
- The managed Mission continuation directs the Commander to create a task-less planning Operation. The Coordinator prompt and profile require the smallest useful TaskGraph and prohibit artificial Task splits.
- Updated README and target architecture. The target architecture no longer lists the removed Coordinator `report` action.
- Regression tests cover natural-language Mission start, Constraint propagation, persisted Mission non-selection, compaction retention, and minimal Task decomposition.
- Verification: targeted tests passed 43/43; `npm run test:all` passed build, 201 unit tests, 2 runtime tests, and 43 integration tests. No tests were skipped.
- Full test log: `/tmp/pi-harness-natural-language-final-all.log`.
