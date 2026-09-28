# #42 — Mission Accountability, Structured Execution, and Context Retention

Status: draft design. This document does not describe shipped behavior.

## Problem

The current Harness has persistent Operation and TaskGraph state, Evidence, TaskResult promotion, complete OperationReport GC, Pi-native compaction, and cache/token telemetry.

It does not yet make Mission ownership the authoritative source for context retention. It also does not persist an Attempt Ledger, Mission ownership for every Operation, or explicit `superseded` and `waived` dispositions.

Context pressure must not decide whether an unresolved obligation is important. The Harness must decide this from lifecycle state.

## Normative invariant

> Every Attempt belongs to exactly one Task. Every Task belongs to exactly one Operation. Every Operation belongs to exactly one Mission.
>
> A child process may terminate, but its obligation does not disappear.
>
> A parent cannot complete while it owns an unresolved obligation.
>
> Harness lifecycle state is the authoritative source for both execution accounting and context-retention decisions.
>
> Unresolved obligations must remain represented in bounded model context. Raw execution may be removed from active context after durable Evidence and a promoted authoritative representation exist.
>
> Context pressure, compaction, cache optimization, or token-cost policy must never silently discard or downgrade an unresolved obligation.
>
> Promotion through `Evidence → TaskResult → OperationReport → Mission closure` defines the corresponding deterministic GC boundary.
>
> Pi owns provider caching and actual compaction. Harness owns semantic context retention, supersession, and maintenance scheduling.

`Mission`, `Operation`, `TaskOrder`, `TaskResult`, `ExecutionUnit`, `Evidence`, `Artifact`, `Blocker`, `Acceptance Criterion`, `Execution Status`, and `Verification Status` retain their current canonical meanings. A Task is the persistent obligation represented by one TaskOrder identity in the TaskGraph.

## Decisions

### 1. Mission state owns the hierarchy

The current active goal becomes the Mission lifecycle surface. `/goal` remains a compatibility command. Its persisted representation becomes `MissionState`.

A Mission has a stable `mission_id`. A Mission owns its `operation_ids`. Every persisted Operation has exactly one immutable `mission_id`. Every TaskGraph already has exactly one `operation_id`. Every Attempt Ledger record has exactly one `task_id` and `operation_id`.

The public `pi_harness_operation create` action requires one active Mission. Harness binds the new Operation to that Mission. The Commander does not supply a free-form Mission ID at this tool boundary.

Harness must persist the Mission update and the new Operation in one scheduler snapshot. Harness must reject an Operation that has no owning Mission. Harness must reject a duplicate ownership link.

A Mission may own multiple Operations. An Operation may not move to a different Mission.

### 2. Attempts are durable accounting records

Harness adds a private persisted `AttemptLedger`. The ledger is not prompt history.

Harness creates an Attempt record in the same durable transition that changes a Task from `ready` to `running`. This occurs before the ExecutionUnit spawn. A spawn failure, timeout, cancellation, session interruption, or child terminal event updates this record. It does not delete the record.

An Attempt record contains bounded control data only:

```json
{
  "version": 1,
  "attempt_id": "A-O-1-T-1-01",
  "mission_id": "M-1",
  "operation_id": "O-1",
  "task_id": "T-1",
  "ordinal": 1,
  "status": "running",
  "failure_code": "HARNESS_CHILD_TERMINAL_TIMEOUT",
  "evidence_refs": ["evidence://project/opaque-id"],
  "updated_at": "2026-09-29T00:00:00.000Z"
}
```

The final schema must use a small allowlist of attempt statuses and failure codes. It must not store raw child output, a transcript, a worktree path, or an unbounded error string.

An Attempt can become terminal while its Task remains unresolved. For example, a timeout creates a terminal Attempt and a blocked Task. The Task retains a bounded Blocker and the latest Attempt identity.

### 3. Task disposition is separate from Scheduler Status

The current Scheduler Status remains `pending`, `ready`, `running`, `result_available`, `accepted`, `blocked`, or `exhausted`.

The following Task states remain unresolved and protected from semantic GC:

```text
pending
ready
running
result_available
blocked
exhausted
```

`accepted` is a resolved Task disposition. A Task can also have an explicit resolved disposition of `superseded` or `waived`.

A supersession record requires all of these fields:

```text
old Mission, Operation, and Task identity
replacement Mission, Operation, and Task identity
reason
authority
timestamp
```

The replacement Task must belong to the same Mission. Harness must persist the replacement lineage before it marks the old Task `superseded`. The replacement Task can remain unresolved. In that case, the Mission remains non-closable.

A waiver record requires a Commander or user authority, a reason, and a timestamp. Harness must not infer a waiver from cancellation, token pressure, failed execution, or an absent child.

`superseded` and `waived` close the old Task obligation. They do not claim successful execution or verification. They must remain visible as a bounded disposition in the owning Operation and Mission.

### 4. Parent closure follows unresolved obligations

An Operation is not complete while it owns a Task in an unresolved state. The existing `complete` meaning remains unchanged: all required TaskResults and Operation Acceptance Criteria are accepted.

If a Task is superseded or waived, the old Operation needs an explicit terminal disposition that is not `complete`. The final schema should use `transferred` for a superseded Operation and `waived` for an Operation whose remaining Tasks are waived. These statuses preserve the meaning of `complete`.

A Mission is closable only if every owned Operation has a terminal disposition and no owned Task remains unresolved. Mission closure also requires the existing explicit Commander decision and Mission Definition of Done evaluation. Task acceptance alone never closes a Mission.

Mission cancellation is an explicit terminal Mission disposition. It must preserve unresolved Task and Attempt accounting. It must not silently convert those Tasks to accepted, superseded, or waived.

### 5. The Mission Situation Board is a projection

Harness state is the source of truth. The model receives one bounded, replaceable Mission Situation Board in the growing prompt tail.

The Situation Board contains current authority information only:

```text
Mission M-1
Closable: false

O-1: complete
  accepted: T-1, T-2
O-2: open
  running: T-3
  blocked: T-4 — required condition: Commander replans
  ready: T-5

Unresolved obligations: 3
```

The board includes Task intent, Dependencies, Acceptance Criteria, current Attempt identity, latest authoritative state, and Blockers only when they are necessary to continue an unresolved Task. It uses bounded IDs and summaries. It contains no raw Evidence, transcript, stdout, diff, child process handle, or full Attempt history.

Harness renders the board from the scheduler snapshot. Harness replaces the prior board by a native `ContextEdit` or an equivalent one-entry projection. Harness must not append a turn-by-turn state history.

The board is not a stable prompt section. The stable prefix continues to contain only stable contract, user-saved memory, and plan policy. The #42 invariant belongs in `pi_harness_contract`. Current Mission state belongs in the replaceable tail.

### 6. Promotion defines representation lifetime

Promotion is both an authority transition and a context-lifetime transition.

| Lower representation | Required durable higher representation | Allowed active-context action |
|---|---|---|
| Raw ExecutionUnit output | Evidence plus bounded Attempt state or TaskResult | Remove raw output from model context. Keep Evidence outside model context. |
| Task execution state | Accepted TaskResult summary in Operation state | Replace task-level transient status messages. |
| Accepted TaskResult summaries | Complete or terminal OperationReport | Replace accepted Task history and intermediate scheduler messages. |
| Terminal OperationReports | Mission closure summary | Replace terminal Operation history after Mission closure. |

A failed child can have no TaskResult. In that case, Harness may remove raw execution only after durable Evidence, when available, and a bounded authoritative Attempt/Task Blocker state exist.

### 7. Deterministic GC has an explicit eligibility rule

Harness may GC a known Harness context entry only if all conditions are true:

```text
The represented obligation has a terminal disposition.
A durable authoritative replacement exists.
The replacement preserves the required lineage and disposition.
The entry is not the current user turn.
The entry is not required by active tool-call structure.
The entry is not the current Mission Situation Board.
```

Harness must protect entries for all unresolved Task states. Harness must preserve unknown content. Harness must preserve raw session history. ContextEdit changes only the future model projection.

Examples:

- `T-4 running`: retain the bounded Task representation.
- `T-4 result_available`: retain the TaskResult for the Coordinator.
- `T-4 accepted`: replace old Task status messages only after Operation state contains the accepted TaskResult summary.
- `O-1 complete`: replace accepted Task summaries and intermediate managed-operation messages only after the complete OperationReport is present.
- `O-1/T-7 superseded by O-2/T-1`: replace old failure detail only after the persisted lineage exists. Retain the bounded old disposition and the unresolved replacement Task on the Situation Board.
- Context at 92%: retain unresolved state. Remove only eligible lower-level representations. Pi may compact after Harness maintenance. Pi must not decide semantic eligibility.

GC code must derive its decision from the restored Mission, Operation, TaskGraph, Attempt Ledger, and promoted-report state. It must not use model judgment, token count, message importance scoring, or cache economics as a semantic input.

### 8. Maintenance scheduling and Pi ownership remain separate

A promotion or disposition transition creates a semantic maintenance trigger. Examples are TaskResult acceptance, Operation terminalization, Mission closure, persisted supersession, and persisted waiver.

Harness sets `maintenancePending` for these transitions. Harness still waits for the current safe boundary. Active tool calls, active managed Operations, active child pipelines, and pending messages continue to block ContextEdit maintenance.

Before Pi warms a cache, Harness stops warming only when a semantic maintenance transition, pending GC, prefix change, native compaction, or shutdown makes the existing projection stale. Harness sends no synthetic prompt, timer, or keepalive.

Pi retains ownership of provider cache mechanics, cache TTL, reserve policy, and actual compaction.

### 9. Telemetry measures semantic context economics

Harness extends local telemetry with bounded structural counters:

```text
mission_obligations_total
mission_obligations_open
mission_obligations_terminal
tasks_running
tasks_result_available
tasks_blocked
attempts_started
attempts_terminal
attempts_unknown
promotions_task_to_operation
promotions_operation_to_mission
gc_entries_superseded_by_task
gc_entries_superseded_by_operation
gc_entries_superseded_by_mission
```

These counters are Harness metrics. They are not provider billing metrics. Missing provider token or cost values remain `null`.

## Persistent schema and migration

Implementation adds a versioned scheduler snapshot that contains Mission state, Operations, TaskGraphs, Attempt Ledger, and terminal-report metadata. Harness validates referential integrity before it restores the snapshot.

The migration must fail closed. Legacy state can continue to restore only through an explicit migration path:

1. If an active legacy goal exists, create one deterministic migrated Mission and attach legacy Operations to it.
2. If a legacy Operation has no active goal, restore it as an unowned legacy record that cannot run, complete, or receive GC. Harness reports a Blocker that requires the Commander to attach it to a new Mission or explicitly waive it.
3. Create synthetic historical Attempt records only when existing persisted TaskGraph state proves a bounded attempt count. Mark uncertain historical attempts `unknown`; do not fabricate child outcomes or Evidence.
4. Write the new canonical snapshot only after all ownership references validate.

The implementation must define the deterministic migrated Mission ID before code changes begin. It must not derive that ID from a timestamp or a model response.

## Implementation order

1. Add MissionState, immutable ownership fields, and snapshot validation. Add migration tests before public tool changes.
2. Add Attempt Ledger creation, update, restore reconciliation, and bounded failure provenance.
3. Add explicit Task and Operation terminal dispositions for accepted, superseded, and waived states. Add Commander-authorized supersession and waiver APIs.
4. Require an active Mission for public Operation creation. Update `operationBrief`, `operationReport`, status projection, and cancellation/closure checks.
5. Render and replace the bounded Mission Situation Board. Add the #42 invariant to the stable communication contract.
6. Generalize `deterministicContextEdits()` to use persisted disposition and promotion lineage. Keep the existing complete-OperationReport rule as one case.
7. Add semantic maintenance triggers, cache-warming suppression, and structural telemetry.
8. Update architecture and user documentation only after code and tests prove the new behavior.

## Acceptance criteria for implementation

1. Harness rejects a persisted or new Attempt without exactly one existing Task, Operation, and Mission lineage.
2. Harness rejects an Operation without exactly one existing Mission lineage.
3. Harness persists a claimed Attempt before it starts an ExecutionUnit.
4. A child terminal event leaves a durable Attempt and a bounded unresolved Task state until an explicit disposition resolves it.
5. Harness cannot complete an Operation or Mission while it owns an unresolved Task.
6. Harness cannot mark a Task superseded until it persists valid same-Mission replacement lineage.
7. Harness cannot mark a Task waived without explicit authority and reason.
8. The Situation Board keeps every unresolved Task represented in bounded context and does not contain raw execution.
9. Deterministic GC never removes an unresolved Task representation because of context pressure, compaction, cache warming, or token cost.
10. Deterministic GC removes eligible lower-level Harness entries only after the required promoted representation exists.
11. ContextEdit preserves raw session history and current tool-call structure.
12. Pi-native compaction and provider caching remain Pi-owned.
13. Telemetry counts obligations, Attempts, promotions, and GC class without inventing provider values.
14. Restore, session switch, cancellation, parallel waves, and legacy migration fail closed and preserve ownership accounting.

## Non-goals

This issue does not add automatic Mission acceptance, model-selected GC, dynamic TaskGraph expansion, raw Evidence retrieval in Commander context, provider cache control, custom Pi compaction, or a separate progress-tracking module.

The lifecycle pipeline and information pipeline are one control-plane system:

```text
execution lifecycle
  -> authoritative promotion and disposition
  -> deterministic GC eligibility
  -> smaller model context
```
