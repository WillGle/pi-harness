# Pi Harness — TODO và verification report T0–T14

Checkpoint: 2026-09-27. **Master list chưa hoàn tất: 10 PASS, 5 PARTIAL, 0 FAIL.** Numbering T0–T14 bên dưới thay thế numbering 1–11 của tracker cũ.

Chỉ đánh dấu PASS khi mọi DoD có source và test/runtime evidence. Suite pass không thay thế live managed coding, trust-policy hay Phase I proof. Khi HEAD/runtime thay đổi, phải kiểm tra lại evidence. Không tự tích hợp nhánh Worker.

Dependency order:

`T0 → T1 → T2 → T3 → T4 → T10 baseline → T5 → T6 → T7 → T8 → T9 → T10 rerun → T11 → T12 → T13 → T14`

Logs dưới /tmp là bằng chứng của checkpoint, có thể bị dọn khỏi máy; không coi đường dẫn còn tồn tại là bằng chứng đã rerun. Không có commit hoặc push cho checkpoint này.

Canonical numbering is the user's T0–T14 master list. The previous checkpoint's T3/T4/T5/T9/T10/T11 labels describe different tasks and are not carried over as PASS claims.

HEAD before/after: `14041475f37d93473496002f0d0ad85e67651281`.
Initial worktree: 31 modified tracked files and four untracked files (`lib/agent-english.mjs`, `lib/child-disposition.mjs`, `lib/failure-codes.mjs`, `todo.md`). Existing changes were preserved. The authorized closure work also changed the gate, TaskSpec/Operation registration, failure projection, existing regression fixtures, role profile and architecture documentation. Added `lib/task-spec.mjs` and `test/helpers/mock-settlement.mjs`. All pre-existing dirty changes remain preserved; no staging, commit, push, provider or auth configuration mutation.
Installed runtime: Pi `0.87.1`, pi-subagents `0.19.0`, Node `v22.22.2`. Verified with `npm ls @earendil-works/pi-coding-agent @tintinweb/pi-subagents`, `pi --version`, and the runtime compatibility tests.

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
Status: PARTIAL

Inspected:
- Actual Pi SDK, installed pi-subagents manager, Harness tool/command entry, trusted TaskSpecs, package worktree/gate/Evidence/Coordinator acceptance.
Findings:
- Real baseline and Phase I rerun both complete; no manual TaskResult injection, Scheduler mutation or Worker merge. Commander is driven through actual Pi command/tool boundary, not an independent live Commander reasoning turn. Full live failure-mode matrix is not yet demonstrated.
- First disposable proof exposed process.cwd instead of session cwd: package created branch pi-agent-9db90ac4-c827-429 (commit bb3cca2 prefix) in main repo, without merging or modifying its working tree. Branch is preserved, not silently removed. Fixed runCwd=ctx.cwd fallback across managed callbacks/Evidence paths.
Changes:
- Session-cwd fix and portable genuine coding proof; actual /goal creates active Mission. User-authorized isolated Luna override resolves earlier gpt-5.5 reservation blocker without changing active config. Full advertised output reserved because Codex adapter does not enforce requested maxTokens.
Verification:
- baseline command: node --experimental-strip-types /tmp/pi-managed-live-proof.mjs; result: exit0, /tmp/pi-managed-live-proof-baseline-final.log; sandbox /tmp/pi-managed-proof-oiDvLd; Worker branch pi-agent-7f1177b8-92e1-464.
- rerun command: same portable benchmark command in T9; result: exit0; sandbox /tmp/pi-managed-proof-YOdPck, branch pi-agent-b609797a-56eb-48e; proof.json.
- tests: controlled parallel sibling timeout/success, restart/switch, cancel/late result, dependencies/retry exhaustion, semantic review/security fail-closed, plus real package worktree/Pi RPC integration all PASS.
- runtime evidence: live Coordinator dispatch/acceptance, real Worker add.mjs/add.test.mjs, node --test gate,3 persisted Evidence refs, verified accepted T-LIVE, transitions running→verifying→result_available→accepted, bounded complete OperationReport. Parent retains one initial commit; Worker branch separate. Mission remains active after Operation completion.
DoD:
- [x] At least one real managed coding Operation completes with accepted TaskResult and deterministic Evidence.
- [x] Live Coordinator acceptance and bounded OperationReport; no raw child output to Commander.
- [x] No direct merge/result injection/Scheduler mutation; execution != verification != acceptance.
- [x] Operation != Mission; pre-Phase baseline and post-Phase rerun.
- [x] Stale-session/parallel/dependency/reviewer failure regressions pass.
- [ ] Full live managed restart/switch/parallel-timeout/cancel/reviewer matrix and autonomous live Commander turn.
Remaining blocker: broader runtime scenario proof; baseline gate for Phase I is satisfied, overall T10 is not PASS.
Commit: none.

## Task: T11 — ACP / Pi RPC Lifecycle Closure
Status: PARTIAL

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
- Added7 core lifecycle regressions and4 controlled wire-level bridge regressions. ACP smoke prompts use /plan status (no model call); controlled peer has no model/credentials. UPSTREAM.md documents the legacy custom acceptance contract and runtime limitation.
- Phase I, managed-operation code, Worker budgets and Context Economics unchanged. T14 section/status untouched. No commit/push.

Verification:
- Original serialized reproducer: node --test --test-concurrency=1 test/acp-acceptance.test.mjs test/pi-rpc-integration.test.mjs;5/7 PASS,2 direct initial /plan timeouts; /tmp/t11-original-repro.log.
- Core regressions: node --test test/acp-rpc-lifecycle.test.mjs;7/7 PASS, no skips. Controlled bridge regressions all4 PASS, including real child PID disappearance, in /tmp/t11-new-regressions.log and repeated full runs.
- Initial fixed historical7/7 PASS: /tmp/t11-second-fix-repro.log. This is not accepted as stability proof.
- Expanded serialized repeats: /tmp/t11-serialized-repeat-2.log and -3.log each9/11 PASS,2 ACP readiness failures; direct goal/compaction suites pass there. Earlier expanded run /tmp/t11-new-regressions.log16/18 PASS (includes7 core tests).
- npm run test:integration repeated3 times: /tmp/t11-integration-repeat-1.log, -2.log, -3.log EACH27/31 PASS,4 readiness failures, zero skips. Failing cases: ACP lifecycle/reconnect, ACP forwarding, direct plan and direct goal. Initial-command failures now have typed PI_RPC_NOT_READY and bounded child cleanup, not undefined success; startup is still NOT stable.
- npm run build PASS; npm run test159/159 PASS, zero skips (/tmp/t11-unit.log). Final focused wire-level4/4 PASS (/tmp/t11-wire-final.log), core7/7 PASS (/tmp/t11-core-final.log). Bridge/helper syntax checks and git diff --check PASS. Protected extensions/lib source unchanged; T14 section verified byte-identical against HEAD. No active test ACP/Pi RPC process remained after all runs settled.
- Protocol: official v1/SDK1.5 prompt response is terminal with stopReason, cancel is notification; v2 separates prompt acceptance/idle state. Current bridge uses its pre-existing legacy custom accepted:true response and agent_settled notification. No numeric-version/terminal-response migration is claimed or invented. References: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx and /v2/overview.mdx; https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html.

DoD / acceptance:
- [x] Installed startup and deterministic native probe deep-traced; timestamps and actual pre-RPC blocker demonstrated.
- [x] Delayed startup cannot advertise readiness; fresh reconnect uses same barrier; identity verified.
- [x] Readiness deadline typed failure + cleanup; pending exit rejection; RPC timeout/late-reply/timer-map regressions.
- [x] Cancel during startup/outstanding prompt; short independent abort budget; bounded TERM/KILL fallback; controlled child PID absent after settle.
- [x] Pi acceptance != terminal completion; current client/protocol contract inspected and unchanged.
- [x] Repeated historical/full integration executed; failures retained rather than hidden by a green rerun.
- [ ] Serialized reproducer repeatedly green with zero initial-command timeout.
- [ ] Full integration repeatedly green; real ACP forwarding stable across cold restarts.
- [ ] Runtime catalog refresh drained before shutdown; no stranded catalog lock remains.
- [ ] Full official ACP conformance/live Zed-client proof (not claimed by this scoped patch).

Runtime patch checkpoint (2026-09-28):
- User authorized the narrow Pi catalog lifecycle patch. packages/pi-harness-acp/runtime/pi-0.87.1-catalog-drain.mjs tracks raw provider operations/publication chains and physical FileModelsStore lock promises; RPC disposal aborts its background controller and drains these before native dispose. Merely awaiting public refresh is insufficient because raceWithAbortSignal returns before physical lock acquisition settles. Existing deadlines, refresh cancellation behavior, providers/models and Harness policies unchanged.
- Permanent regression command: node packages/pi-harness-acp/runtime/catalog-drain.test.mjs;2/2 PASS. Tests prove public provider/read abort can finish while physical work remains, drain stays pending until that work ends, and tracked sets then empty. Tests use synthetic storage/provider, no credentials or paid token requests.
- Disposable actual Pi0.87.1 source runtime /tmp/t11-runtime-VM3xax, same installed Node24.20.0 and dependencies: historical serialized reproducer3 consecutive11/11 PASS, zero skips (/tmp/t11-drained-serialized-1.log through -3.log).
- Full integration with explicit disposable runtime selection3 consecutive31/31 PASS, zero skips (/tmp/t11-drained-full-1.log through -3.log). Command: npm run test:integration --script-shell=/tmp/t11-patched-script-shell. All command and readiness deadlines unchanged. Native goal/compaction and ACP forwarding/reconnect pass.
- A preceding npm run test:integration still27/31 because npm prepends node_modules/.bin/pi (unpatched local Pi0.87.1), overriding the disposable PATH prefix. That failure is retained in /tmp/t11-drained-integration-1.log; it is NOT evidence against the patched runtime and NOT hidden as a default-runtime success.
- Version/source-guarded apply-catalog-drain.mjs provided for an upstream monorepo build tree; it patches compiled modules and invokes the upstream bundle rebuild. This packaging hook has NOT yet been exercised in a canonical Nix/upstream build. No immutable Nix store, system links, installed npm dependency, credentials or real catalog lock were modified/deleted. Runtime README distinguishes candidate validation from deployment.
- T11 remains PARTIAL: repeated stability demonstrated only with the disposable patched runtime, not the default installed paths. T14 unchanged; no release claim or commit.

Remaining blocker:
- Deploy and verify the version-gated catalog patch through the canonical Pi build/package owner, rebuild the actual bundle, then repeat default-path regressions. Both Nix Pi and npm-installed Pi remain unpatched; build hook not yet exercised. Do not raise deadlines, force offline mode or delete shared locks. Official ACP conformance/live Zed remains outside this scoped legacy-contract change.
Commit: none; HEAD35dc2ad803c0d8c8f9438f0a507997fadf72134e.

## Task: T12 — Security / Verification Trust Boundary Audit
Status: PARTIAL

Inspected: `lib/worker-gate.mjs:runWorkerVerification`, all role profiles, exact security route/model registry check and deterministic precedence.
Findings: `sh -c task.verification` inherits host environment/filesystem permissions and may link parent node_modules. Before T3 closure, Coordinator-authored verification text could grant host shell execution. T3 now resolves only Commander/user-registered trusted TaskSpecs; mismatched Coordinator verification text is rejected. Git worktree is not an OS sandbox. Reviewer profiles omit mutation tools; security profile has tools none/extensions false/skills false. Exact security model availability and invocation are checked and unavailable model blocks.
Changes: T3 selected and enforced registered trusted TaskSpecs. Host environment and dependency symlinks remain explicitly trusted, not sandboxed.
Verification:
- Tests: security availability fails closed; security pass cannot override general failure; deterministic failed gate does not become verified; review packet selection and truncation/integrity rejection.
- Command/result: baseline suite PASS; no live Daybreak call.
- Runtime evidence: no explicit Daybreak validation was run; no credentials were inspected by the audit.
DoD:
- [x] Current shell authority identified; no OS sandbox asserted.
- [x] Reviewer read-only/security zero-tool/exact model fail-closed and deterministic precedence tested.
- [x] Registered trusted TaskSpec policy documented and enforced; Coordinator cannot replace verification/permission/review fields.
- [ ] Host/env/symlink/descendant-command attack coverage under selected policy.
Remaining blocker: complete the wider host/env/symlink/descendant threat audit; no outstanding trust-policy choice. T3 contract tests and real descendant cancellation pass, but these do not establish OS isolation.
Commit: none.

## Task: T13 — Documentation / Doctrine Consistency
Status: PARTIAL

Inspected: README, target architecture, future-work, coordinator doctrine, profiles, package versions/budget statements.
Findings: Domain Heads stale statement has been corrected in pre-existing dirty work; README now distinguishes the implemented native stable prompt/GC/telemetry from unfinished release closure. The architecture was updated to GC-first/native compaction ownership. Broad safe compaction/cancellation claims need qualification until live/missing-settlement/ACP gates close. README remains landing-level.
Changes: architecture ownership/GC/cache/telemetry paragraphs and README implementation-versus-release distinction updated.
Verification:
- Tests: skills lock verification and Domain Head lifecycle; stale-claim source search.
- Command/result: baseline unit skills tests and doctor skills verification PASS (22 skills).
- Runtime evidence: package versions confirmed; no Phase I shipping claim.
DoD:
- [x] No stale unimplemented Domain Head statement; current version and managed timer claims inspected.
- [x] Phase I implementation claims supported by native/live evidence; no completed-release claim; README/deep architecture roles preserved.
- [ ] All ownership/trust/compaction claims reflect closed runtime contracts and explicit PARTIAL/PLANNED distinctions.
Remaining blocker: finish implementation before doctrine/release claims are updated.
Commit: none.

## Task: T14 — Release / Regression Closure
Status: PARTIAL

Inspected: package scripts, worktree state, remotes, install/RPC/ACP/Zed probes and conditional security live test.
Findings: required suites/doctor have evidence, but worktree is dirty; live managed coding and Phase I benchmark now exist, but broader live scenario/release closure remains. `origin` targets `WillGle/pi-setup.git`; separate `pi-harness` remote targets `WillGle/pi-harness.git`. Push cannot be assumed to target the intended repository. No CI check-run evidence was obtained.
Changes: focused T1 correction and seven regression cases only.
Verification:
- Command/result: baseline `npm run test:all` PASS (includes build/test/integration); doctor PASS; final all-suite rerun recorded separately; diff whitespace check PASS.
- Tests/runtime: disposable exact package tarball/bootstrap doctor, real Pi RPC, ACP bridge and configuration smoke. Zed GUI and Daybreak live security are unproven. Suites include prompt smoke requests; aggregate provider spend was not measured, so these are not a cost-benchmark result.
DoD:
- [x] Exact runtime versions verified; baseline build/unit/integration/all/doctor pass.
- [x] Package install/RPC/ACP configuration smoke demonstrated; session/parallel controlled regressions pass.
- [ ] Clean working tree and reviewed focused commits.
- [x] Real managed coding Operation before/after Phase I.
- [ ] Live Zed and full managed runtime scenario matrix.
- [x] Context economics live benchmark under the USD1 ceiling.
- [ ] Full remaining task DoD.
- [ ] Commit/push to verified intended remote and synchronized final HEAD.
Remaining blocker: T1–T13 gaps; existing uncommitted changes require attribution before release commit. Nothing pushed.
Commit: none; HEAD remains `14041475f37d93473496002f0d0ad85e67651281`.

## Final validation addendum

After the focused T1 correction and seven added repository regressions, `npm run test:all` exited 0 outside sandbox: build PASS, unit 145/145 PASS, integration 20/20 PASS, zero failures/cancellations/skips. `npm run verify:skills` PASS (22); `git diff --check` PASS. Full output: `/tmp/pi-harness-master-final-all.log`. The worktree still has the original dirty/untracked files; no commit or push was made. A passing suite does not close missing live, trust, or Phase I DoD items.

## Các nghĩa vụ còn mở từ tracker cũ

- [ ] **Historical timeout investigation:** các lượt cũ từng có Pi RPC /goal, compaction và ACP session/command timeout; các lượt gần nhất pass chưa xác định nguyên nhân gốc. T0 PASS chỉ kết luận baseline audit hoàn tất, không đóng investigation này. Evidence lịch sử nằm trong Git/work-session logs và các log cũ /tmp/pi-harness-current-test-repeat.log, /tmp/pi-harness-current-integration.log, /tmp/pi-harness-current-all.log, /tmp/pi-harness-final-all.log nếu còn tồn tại.
- [ ] **Live failure-mode disposition:** G1 cũ tương ứng T10 live proof. Cần package-backed cleanup-failure injection và post-restart runtime proof. Package worktreeResult có thể không phân biệt cleanup failure với no changes; giữ worktree disposition unknown khi chưa có evidence.
- [ ] **Worker resource enforcement ngoài wall-clock:** package hỗ trợ maxTurns/usage callbacks nhưng Harness chưa enforce Worker turn/token/tool-call/file-scope budgets. Gắn follow-up này với T2/T3/T12; phân biệt enforced với advisory và không chọn coding cap trước T10 baseline. Prompt file scope không phải OS sandbox.
- [ ] **Legacy migration:** thử Operation chỉ có task_intents, persisted failure codes, Head và parallel compatibility khi đăng ký complete TaskSpec hoặc thay trust policy. Không nâng Coordinator-authored shell text thành trusted command chỉ bằng migration.

## Điều kiện đóng tracker

- [ ] T0–T14 đạt đầy đủ DoD; T10 được chứng minh cả trước và sau Phase I.
- [ ] Ownership, exact-child cancellation, late-event isolation và bounded outcome được chứng minh ở mọi boundary; unknown continuation dùng fresh Task ID.
- [ ] Integration và Mission completion vẫn là quyết định riêng của Commander; không suy ra từ Worker completion hoặc Operation completion.
- [ ] Live benchmark tuân thủ USD 1 ceiling, không fabricate provider cost và không đọc/in/copy credentials.
- [ ] Working tree sạch sau khi phân loại/preserve thay đổi có sẵn; commits/push dùng đúng remote, không suy CI PASS từ push.

## Authorized closure validation checkpoint

T1–T4 closure: npm run test:all PASS (155 unit + 20 integration, zero skips); npm run doctor PASS; npm run verify:skills PASS (22); git diff --check PASS. Log: /tmp/harness-t1-t4-release-check.log. HEAD unchanged. No commit or push. T10 stopped at credentials-safe zero-request preflight; T5–T9 not started by design. The earlier 138/145-test checkpoints above are historical, not the current suite counts.

## Phase I implementation checkpoint — 2026-09-27

T1–T4 retained PASS; T5–T9 now PASS on source, regression and native/live evidence above. T10 baseline and Phase I rerun complete, but overall T10 remains PARTIAL. Current full-suite log /tmp/pi-harness-phase-i-final-all.log: build PASS,159 unit +20 integration PASS, zero skips. Final footer/docs follow-up verification is recorded in /tmp/pi-harness-phase-i-release-all.log. HEAD unchanged; no commit or push. Earlier zero-request/pre-Phase statements are historical snapshots, not current blockers. Token ledger upper bound is catalog-derived, not provider billing; USD1 remains the authorized ceiling.

### Final rerun variance (do not erase failures)

/tmp/pi-harness-phase-i-release-all.log: build and159/159 unit PASS, integration17/20 with3 timeouts: ACP command forwarding (15s), Pi RPC goal and compaction/restore (/plan on,10s). All report live child/no events/empty stderr. The immediately preceding full run passed159+20. Focused serialized reproduction is recorded in /tmp/pi-harness-final-timeout-repro.log; repeat success alone does not explain the original failure. These recurring ACP/RPC startup/lifecycle timeouts keep T11/T14 and the historical investigation open. doctor and verify:skills passed after final source changes.

Focused serialized timeout reproduction exited1:5/7 PASS,2/7 FAIL. ACP command forwarding passed in isolation; both Pi RPC initial /plan on timeouts reproduced with no child events. Root cause is still unproven; increasing timeouts or claiming the earlier green run closed this is not justified. The final canonical gate is therefore NOT green (integration17/20 on the last full run), despite the independently passing Phase I functional and live benchmark proofs. Build, doctor,22-skill verification and whitespace checks pass.
