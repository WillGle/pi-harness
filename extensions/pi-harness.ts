import { contextTelemetry, deterministicContextEdits, installStablePrompt, stablePromptSections } from "../lib/context-economics.mjs";
import { acquireControlLease, assertControlLease, readControlState, writeControlState } from "../lib/control-state-store.mjs";
import { MISSION_ENTRY, attachOperation, createMission, missionIsClosable, missionSituationBoard, validateMissionOwnership } from "../lib/mission.mjs";
import { safeFailureCode } from "../lib/failure-codes.mjs";
import { attemptId, recordAttemptChild, reconcileAttemptLedger, resolveUnknownAttempt, rollbackUnstartedAttempt } from "../lib/attempt-ledger.mjs";
import { assertSupportedPlatform } from "../lib/platform.mjs";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  COMPACT_ENTRY, GOAL_ENTRY, PLAN_ENTRY, READ_ONLY_TOOLS, controlStateSummary, goalState,
  isPlanAllowedTool, parsePlan, planState, restore, transitionGoal,
} from "../lib/state.mjs";
import { appendProjectMemory, clearProjectMemory, loadProjectMemory } from "../lib/memory.mjs";
import { cancelCoordinateTasks, executeCoordinateTask, executeCoordinatorTurn, hasActiveCoordinateTasks, inspectCoordinateChild, managedTaskTimeout, validateTask } from "../lib/coordinator.mjs";
import { COMMANDER_LANGUAGE_POLICY } from "../lib/agent-english.mjs";
import { PROACTIVE_COMPACT_ENTRY, proactiveCompactionPolicy, restoreProactivePolicy, setProactiveThreshold } from "../lib/compaction-policy.mjs";
import { COORDINATOR_ENTRY, canRetryResolvedAttempt, canRetryTaskResult, coordinatorState, operationReport, parallelTaskLimit, runOperation } from "../lib/operation-runner.mjs";
import { promoteTaskResult } from "../lib/communication.mjs";
import { OPERATION_ENTRY, createOperation, terminalizeOperation } from "../lib/operation.mjs";
import { TASK_GRAPH_ENTRY, createTaskGraph, migrateTaskGraph, reconcileTaskGraph, supersedeGraphTask, validateTaskGraph, waiveGraphTask } from "../lib/task-graph.mjs";
import { findReferences, findSymbol } from "../lib/code-intel.mjs";
import { buildStatusViewModel, formatExpandedStatus, formatStatusFooter } from "../lib/status-view-model.mjs";
import { readHashlines, replaceHashlines } from "../lib/precise-edit.mjs";
import { Type } from "typebox";

type Context = { cwd?: string; ui?: { notify?: (message: string, level: "info" | "warning" | "error") => void }; abort?: () => void; isIdle?: () => boolean };
type Pi = Record<string, any>;

const HARNESS_TOOLS = new Set(["pi_harness_start_mission", "pi_harness_goal", "pi_harness_coordinate", "pi_harness_operation", "pi_harness_run_operation", "pi_harness_cancel_operation", "pi_harness_patch"]);
const PACKAGE_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"]);
const MAX_AUTOMATIC_CONTINUATIONS = 25;
const SKILLS = Object.keys(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../skills/skills.lock.json"), "utf8")).skills).join(", ");

class StatusOverlay {
  private offset = 0;
  private tui: any;
  private theme: any;
  private content: string[];
  private done: () => void;
  constructor(tui: any, theme: any, content: string[], done: () => void) {
    this.tui = tui; this.theme = theme; this.content = content; this.done = done;
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q" || matchesKey(data, "ctrl+c")) return this.done();
    const rows = Math.max(1, this.content.length - 16);
    if (matchesKey(data, "down") || matchesKey(data, "pageDown")) this.offset = Math.min(rows, this.offset + (matchesKey(data, "pageDown") ? 12 : 1));
    else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - (matchesKey(data, "pageUp") ? 12 : 1));
    else return;
    this.tui.requestRender();
  }
  invalidate() {}
  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const wrapped = this.content.flatMap((row) => row ? wrapTextWithAnsi(row, innerWidth) : [""]);
    const pageSize = 18;
    const maxOffset = Math.max(0, wrapped.length - pageSize);
    this.offset = Math.min(this.offset, maxOffset);
    const content = wrapped.slice(this.offset, this.offset + pageSize).map((row) => truncateToWidth(row, innerWidth, "…"));
    while (content.length < pageSize) content.push("");
    const border = this.theme.fg("border", "│");
    const top = this.theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const bottom = this.theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
    const title = this.theme.fg("accent", truncateToWidth(" Status · ↑/↓ scroll · Esc close ", innerWidth));
    return [top, border + title + " ".repeat(Math.max(0, innerWidth - visibleWidth(title))) + border, ...content.map((row) => border + row + " ".repeat(Math.max(0, innerWidth - visibleWidth(row))) + border), bottom];
  }
}

export default function harness(pi: Pi): void {
  assertSupportedPlatform();
  const parallelLimit = parallelTaskLimit();
  let plan = planState();
  let goal: ReturnType<typeof goalState> | undefined;
  let operations: Record<string, ReturnType<typeof createOperation>> = {};
  let missions: Record<string, any> = {};
  let attemptLedger: Record<string, any> = {};
  let coordinatorStates: Record<string, ReturnType<typeof coordinatorState>> = {};
  let taskGraphs: Record<string, ReturnType<typeof createTaskGraph>> = {};
  let missionGoals: Record<string, any> = {};
  let selectedMissionId: string | undefined;
  let controlLease: any;
  let controlCwd = process.cwd();
  let sessionTaskGroup = randomUUID();
  const activeOperationRuns = new Map<string, { controller: AbortController; goalGroup?: string }>();
  let sessionEpoch = 0;
  let proactivePolicy = proactiveCompactionPolicy();
  let stablePromptFingerprint: string | undefined;
  let nativeCompactionImminent = false;
  let sessionEnding = false;
  let maintenancePending = false;
  let maintenanceArmed = true;
  let maintenanceEpoch = 0;
  let lastMaintenanceEpoch = -1;
  const activeToolCalls = new Set<string>();
  let savedTools: string[] | undefined;
  let continuationQueued = false;
  let continuationCount = 0;
  let invalidTerminalAttempts = 0;
  let resumedMissionId: string | undefined;
  let controlStateRestored = false;
  let latestContextTelemetry: ReturnType<typeof contextTelemetry> | undefined;
  let latestContextUsage: any;
  let latestRuntimeIdentity: { modelDisplayName?: string; effort?: string } = {};
  let goalGroupId: string | undefined;
  let statusTui: any;
  let statusViewModel = buildStatusViewModel();

  const say = (ctx: Context, message: string, level: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(message, level);
  const statusFingerprint = (model: ReturnType<typeof buildStatusViewModel>) => JSON.stringify([
    formatStatusFooter(model, 140), formatStatusFooter(model, 100), formatStatusFooter(model, 60), formatExpandedStatus(model),
  ]);
  const captureRuntimeIdentity = (ctx: any) => {
    const model = ctx?.model;
    latestRuntimeIdentity = {
      modelDisplayName: typeof model?.name === "string" && model.name.trim() ? model.name : typeof model?.id === "string" ? model.id : undefined,
      effort: typeof ctx?.thinkingLevel === "string" ? ctx.thinkingLevel : undefined,
    };
  };
  const refreshStatusView = (requestRender = true) => {
    const next = buildStatusViewModel({ missions, operations, taskGraphs, attemptLedger, coordinatorStates,
      selectedMissionId, activeOperationId: activeOperationRuns.keys().next().value,
      contextUsage: latestContextUsage, telemetry: latestContextTelemetry, runtime: latestRuntimeIdentity,
      gcPending: maintenancePending, piCompacting: nativeCompactionImminent });
    const changed = statusFingerprint(statusViewModel) !== statusFingerprint(next);
    statusViewModel = next;
    if (changed && requestRender) statusTui?.requestRender();
    return changed;
  };
  const persistControlState = () => {
    if (!controlLease) return;
    attemptLedger = reconcileAttemptLedger(attemptLedger, operations, taskGraphs);
    validateMissionOwnership(missions, operations, taskGraphs, attemptLedger);
    writeControlState({ missions, operations, task_graphs: taskGraphs, attempt_ledger: attemptLedger, mission_goals: missionGoals,
      coordinator_states: coordinatorStates }, controlLease, controlCwd);
  };
  const ensureControlLease = async (cwd = process.cwd()) => {
    const projectCwd = resolve(cwd ?? process.cwd());
    if (resolve(controlCwd) !== projectCwd) throw new Error("Mission control state is scoped to this Pi session's project directory; start a new session before changing projects");
    if (controlLease) {
      assertControlLease(controlLease, projectCwd);
      return;
    }
    controlLease = await acquireControlLease(projectCwd);
    controlCwd = projectCwd;
  };
  const persist = () => {
    if (goal?.mission_id) missionGoals = { ...missionGoals, [goal.mission_id]: goal };
    persistControlState();
    pi.appendEntry?.(PLAN_ENTRY, plan);
    if (goal) pi.appendEntry?.(GOAL_ENTRY, goal);
  };
  // One canonical session entry commits Operation and TaskGraph together.
  const persistScheduler = () => {
    attemptLedger = reconcileAttemptLedger(attemptLedger, operations, taskGraphs);
    validateMissionOwnership(missions, operations, taskGraphs, attemptLedger);
    persistControlState();
    pi.appendEntry?.(TASK_GRAPH_ENTRY, { version: 2, missions, operations, task_graphs: taskGraphs, attempt_ledger: attemptLedger });
    maintenancePending = true;
    refreshStatusView();
  };
  const persistMission = () => {
    if (goal?.mission_id) missionGoals = { ...missionGoals, [goal.mission_id]: goal };
    persistControlState();
    pi.appendEntry?.(MISSION_ENTRY, missions);
    refreshStatusView();
  };
  const missionBoard = () => missionSituationBoard(missions, operations, taskGraphs, attemptLedger);
  const collectContextTelemetry = (entries: any[], usage: any) => contextTelemetry(entries, usage, { missions, operations, taskGraphs, attemptLedger });
  const saveCompactState = (event: Record<string, unknown> = {}) => pi.appendEntry?.(COMPACT_ENTRY, controlStateSummary({
    goal, missionConstraints: selectedMissionId ? missions[selectedMissionId]?.constraints : undefined, plan, decisions: Array.isArray(event.decisions) ? event.decisions : [],
    changedFiles: Array.isArray(event.changedFiles) ? event.changedFiles : [],
    gates: Array.isArray(event.gates) ? event.gates : [], blocker: goal?.blocker,
  }));
  const setPlan = (enabled: boolean, ctx: Context) => {
    if (enabled) {
      savedTools ??= pi.getActiveTools?.() ?? [];
      pi.setActiveTools?.((savedTools.length ? savedTools : [...READ_ONLY_TOOLS]).filter((name: string) => READ_ONLY_TOOLS.has(name)));
    } else if (savedTools) {
      pi.setActiveTools?.(savedTools);
      savedTools = undefined;
    }
    plan = planState(enabled, plan.plan);
    persist();
    say(ctx, `Plan mode ${enabled ? "enabled (read-only)" : "disabled"}.`);
  };
  const cancelGoal = (ctx: Context) => {
    const groupId = goal?.status === "active" ? goalGroupId : undefined;
    for (const run of activeOperationRuns.values()) if (run.goalGroup && run.goalGroup === groupId) run.controller.abort();
    if (goal?.status === "active") {
      const activeMission = selectedMissionId ? missions[selectedMissionId] : undefined;
      goal = transitionGoal(goal, "cancelled");
      if (activeMission) missions = { ...missions, [activeMission.mission_id]: createMission({ ...activeMission, status: "cancelled" }) };
      if (goal.mission_id) missionGoals = { ...missionGoals, [goal.mission_id]: goal };
      maintenancePending = true;
      persistMission(); persistScheduler();
    }
    goalGroupId = undefined;
    continuationQueued = false;
    continuationCount = 0;
    invalidTerminalAttempts = 0;
    const cancelled = cancelCoordinateTasks(groupId);
    ctx.abort?.();
    persist();
    say(ctx, `Goal cancelled; ${cancelled} package-managed task(s) were aborted.`);
  };
  const stopUnboundedGoal = () => {
    if (!goal || goal.status !== "active") return;
    goal = transitionGoal(
      goal,
      "error",
      `Automatic continuation limit reached after ${MAX_AUTOMATIC_CONTINUATIONS} turns.`,
      "The goal did not reach a terminal state within the automatic continuation limit.",
    );
    goalGroupId = undefined;
    continuationQueued = false;
    invalidTerminalAttempts = 0;
    persist();
  };
  const continueGoal = () => {
    if (!goal || goal.status !== "active" || !selectedMissionId || goal.mission_id !== selectedMissionId || continuationQueued || plan.enabled || maintenancePending) return;
    if (continuationCount >= MAX_AUTOMATIC_CONTINUATIONS) return stopUnboundedGoal();
    continuationCount += 1;
    continuationQueued = true;
    const resumed = resumedMissionId === selectedMissionId;
    resumedMissionId = undefined;
    const mission = missions[selectedMissionId];
    const situation = missionSituationBoard({ [selectedMissionId]: mission }, operations, taskGraphs, attemptLedger);
    const existingOperations = mission.operation_ids.map((id: string) => operations[id]);
    const noSafeWork = existingOperations.length > 0 && !missionIsClosable(mission, operations, taskGraphs, attemptLedger)
      && existingOperations.every((operation: any) => operation && (operation.status !== "open" || !operation.planning
        && operation.required_task_ids.some((id: string) => taskGraphs[operation.operation_id]?.nodes[id]?.scheduler_status !== "accepted")
        && operation.required_task_ids.every((id: string) => {
          const node = taskGraphs[operation.operation_id]?.nodes[id];
          const attempt = node && attemptLedger[attemptId(operation.operation_id, id, node.attempts)];
          return !["ready", "running", "result_available"].includes(node?.scheduler_status)
            && !canRetryTaskResult(operation, taskGraphs[operation.operation_id], attemptLedger, id)
            && !canRetryResolvedAttempt(operation, taskGraphs[operation.operation_id], attemptLedger, id)
            && !(attempt?.status === "unknown" && attempt.child_refs?.length && node.scheduler_status === "blocked");
        })));
    const message = [
      "[PI_HARNESS_MISSION_CONTINUE]",
      resumed ? `Mission ${selectedMissionId} was explicitly resumed by ID in this Pi session.` : undefined,
      resumed && controlStateRestored ? "The fresh-session resume requirement is satisfied; do not report it as pending." : undefined,
      `Mission: ${goal.objective}`,
      "Current Mission Situation Board:",
      situation,
      "Use this persisted state. Do not recreate completed Operations or accepted Tasks.",
      "Inspect existing open Operations with pi_harness_operation status first. Resolve exact unknown Attempts only from terminal child evidence, then retry only IDs in retryable_task_ids. Run ready work in its existing Operation.",
      noSafeWork
        ? `No safe TaskOrder remains. Waived work does not satisfy Operation or Mission completion. Routes were not tested by waived work. Preserve the Mission history. Use /mission cancel ${selectedMissionId}, then start a new Mission for the remaining objective.`
        : "Create a task-less planning Operation only when this eligible Mission has no usable existing Operation. Pass the Mission Constraints and call pi_harness_run_operation. Let the Coordinator choose the smallest useful TaskGraph. If only waived or otherwise non-recoverable work remains, state that routes were not tested, preserve the Mission history, cancel this Mission, and start a new Mission.",
      "Continue until you call pi_harness_goal with a terminal state and concrete Evidence.",
    ].filter(Boolean).join("\n");
    pi.sendUserMessage?.(message, { deliverAs: "followUp" });
  };
  const startMission = async (objective: string, constraints: string[] = [], ctx: Context = {}) => {
    if (plan.enabled) throw new Error("Disable plan mode before starting a Mission.");
    if (activeOperationRuns.size) throw new Error("Wait until the active Operation finishes before starting another Mission.");
    if (goal?.status === "active" && selectedMissionId) throw new Error("A Mission is already active. Continue it or cancel it before starting another Mission.");
    const mission_id = `M-${randomUUID()}`;
    const mission = createMission({ mission_id, objective, constraints: [...new Set(constraints)] });
    await ensureControlLease(ctx.cwd);
    goal = { ...goalState(mission.objective), mission_id };
    selectedMissionId = mission_id;
    missionGoals = { ...missionGoals, [mission_id]: goal };
    goalGroupId = randomUUID(); continuationCount = 0; invalidTerminalAttempts = 0; continuationQueued = false;
    resumedMissionId = undefined;
    missions = { ...missions, [mission_id]: mission };
    maintenancePending = true;
    persistMission(); persistScheduler(); persist();
    if (ctx.isIdle?.() !== false) maintenancePending = false;
    refreshStatusView();
    continueGoal();
    return mission;
  };

  pi.on?.("session_start", async (_event: any, ctx: any) => {
    cancelCoordinateTasks(sessionTaskGroup);
    if (goalGroupId) cancelCoordinateTasks(goalGroupId);
    sessionTaskGroup = randomUUID();
    sessionEpoch++;
    statusTui = undefined;
    selectedMissionId = undefined;
    resumedMissionId = undefined;
    controlStateRestored = false;
    goal = undefined;
    stablePromptFingerprint = undefined; nativeCompactionImminent = false; sessionEnding = false;
    maintenancePending = false;
    latestContextTelemetry = undefined;
    latestContextUsage = undefined;
    maintenanceArmed = true;
    maintenanceEpoch = 0;
    lastMaintenanceEpoch = -1;
    activeToolCalls.clear();
    for (const run of activeOperationRuns.values()) run.controller.abort();
    activeOperationRuns.clear(); // Old callbacks are epoch-guarded and cannot clear a new run.
    const previousControlLease = controlLease;
    controlLease = undefined;
    if (previousControlLease) await previousControlLease.release();
    controlCwd = ctx.cwd ?? process.cwd();
    const activeTools = pi.getActiveTools?.() ?? [];
    pi.setActiveTools?.(activeTools.filter((name: string) => !PACKAGE_TOOLS.has(name)));
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    plan = restore(entries, PLAN_ENTRY) ?? plan;
    const restoredGoal = restore(entries, GOAL_ENTRY);
    const controlSnapshot = readControlState(controlCwd);
    controlStateRestored = Boolean(controlSnapshot);
    missionGoals = controlSnapshot?.mission_goals ?? (restoredGoal?.mission_id ? { [restoredGoal.mission_id]: restoredGoal } : {});
    const schedulerSnapshot = restore(entries, TASK_GRAPH_ENTRY);
    operations = controlSnapshot ? controlSnapshot.operations : schedulerSnapshot ? schedulerSnapshot.operations : restore(entries, OPERATION_ENTRY) ?? {};
    const legacyCoordinator = restore(entries, COORDINATOR_ENTRY) ?? {};
    taskGraphs = controlSnapshot ? controlSnapshot.task_graphs : schedulerSnapshot ? schedulerSnapshot.task_graphs : Object.fromEntries(Object.entries(operations).map(([id, operation]) => [id, migrateTaskGraph(operation, legacyCoordinator[id]?.dispatch_counts)]));
    missions = controlSnapshot ? controlSnapshot.missions : schedulerSnapshot?.missions ?? restore(entries, MISSION_ENTRY) ?? {};
    for (const [id, operation] of Object.entries(operations) as [string, any][]) {
      // Legacy Operation state has no trustworthy parent link. Do not create a
      // Mission or infer a child outcome during restore. The session must stop
      // until an authorized, evidence-backed migration supplies ownership.
      if (!operation.mission_id) throw new Error(`Legacy Operation ${id} has no persisted Mission ownership; restore fails closed`);
      if (!taskGraphs[id]) throw new Error("TaskGraph is missing for a restored Operation");
      validateTaskGraph(taskGraphs[id], operations[id]);
      taskGraphs[id] = reconcileTaskGraph(taskGraphs[id], operations[id]);
    }
    if (Object.keys(taskGraphs).some((id) => !Object.hasOwn(operations, id))) throw new Error("TaskGraph has no owning Operation");
    attemptLedger = reconcileAttemptLedger(controlSnapshot?.attempt_ledger ?? schedulerSnapshot?.attempt_ledger ?? {}, operations, taskGraphs);
    validateMissionOwnership(missions, operations, taskGraphs, attemptLedger);
    coordinatorStates = controlSnapshot?.coordinator_states ?? Object.fromEntries(Object.entries(legacyCoordinator).map(([id, state]: [string, any]) => [id, {
      version: 1, operation_id: id, turns: state.turns ?? 0, decisions: (state.decisions ?? []).slice(-7), blocker: state.blocker ?? null,
      ...(state.failure_code ? { failure_code: safeFailureCode(state.failure_code) } : {}),
      ...(["worktree_preflight", "worker_branch_result"].includes(state.failure_stage) ? { failure_stage: state.failure_stage } : {}),
      ...(operations[id]?.required_task_ids?.includes(state.failure_task_id) ? { failure_task_id: state.failure_task_id } : {}),
    }]));
    if (Object.keys(coordinatorStates).length) pi.appendEntry?.(COORDINATOR_ENTRY, coordinatorStates);
    if (Object.keys(missions).length) persistMission();
    if (Object.keys(operations).length) persistScheduler();
    // One restore-time scan seeds the footer. Later refreshes happen only at
    // settlement boundaries, so render() never walks an unbounded session.
    latestContextUsage = ctx.getContextUsage?.();
    latestContextTelemetry = collectContextTelemetry(ctx.sessionManager?.getEntries?.() ?? [], latestContextUsage);
    captureRuntimeIdentity(ctx);
    refreshStatusView(false);
    proactivePolicy = restoreProactivePolicy(restore(entries, PROACTIVE_COMPACT_ENTRY));
    continuationCount = 0;
    invalidTerminalAttempts = 0;
    goalGroupId = undefined;
    if (plan.enabled) setPlan(true, ctx);
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui: any, theme: any) => ({
      invalidate() {},
      render(width: number): string[] {
        const title = theme.bold(theme.fg("accent", "π PI HARNESS")) + theme.fg("warning", " / READY");
        const cwd = theme.fg("dim", `~/${basename(ctx.cwd)}`);
        const gap = " ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(cwd)));
        const skills = wrapTextWithAnsi(`  ${SKILLS}`, Math.max(1, width));
        return [truncateToWidth(title + gap + cwd, width), theme.fg("dim", "Focused coding agent · evidence-backed execution"), "", theme.fg("warning", "[Skills]"), ...skills.map((line: string) => theme.fg("dim", line)), "", theme.fg("warning", "[Extensions]"), theme.fg("dim", "  dist, pi-harness.ts"), ""];
      },
    }));

    ctx.ui.setFooter((tui: any, theme: any) => {
      statusTui = tui;
      return {
        dispose() { if (statusTui === tui) statusTui = undefined; },
        invalidate() {},
        render(width: number): string[] {
          // Render only the cached StatusViewModel. This path reads no session
          // history and performs no lifecycle or telemetry aggregation.
          return formatStatusFooter(statusViewModel, width, theme);
        },
      };
    });
  });
  pi.on?.("tool_call", (event: any, ctx: Context) => {
    if (event.toolName === "pi_harness_goal" && goal?.status === "active") {
      const input = event.input ?? {};
      const invalid = !input.evidence?.trim?.() || (["blocked", "error"].includes(input.status) && !input.blocker?.trim?.());
      if (invalid) {
        invalidTerminalAttempts += 1;
        if (invalidTerminalAttempts >= MAX_AUTOMATIC_CONTINUATIONS) {
          stopUnboundedGoal();
          ctx.abort?.();
          return { block: true, reason: "Goal safety limit reached after repeated invalid terminal calls." };
        }
      }
    }
    if (!plan.enabled) return;
    if (HARNESS_TOOLS.has(event.toolName) || !isPlanAllowedTool(event.toolName, event.input)) {
      return { block: true, reason: event.toolName === "bash" ? "Plan mode rejects this bash syntax." : "Plan mode is read-only. Run /plan off before using this tool." };
    }
  });
  const compactInstructions = `${COMMANDER_LANGUAGE_POLICY}\nUse the pi-harness control state (agent-english-v1). Preserve Mission, plan, Decisions, changed paths, gates, Blocker and separate Execution Status and Verification Status exactly. Do not promote raw Worker transcripts or infer verification from execution completion.`;
  const checkpoint = (event: Record<string, unknown> = {}) => {
    persist();
    pi.appendEntry?.(PROACTIVE_COMPACT_ENTRY, proactivePolicy);
    pi.appendEntry?.(OPERATION_ENTRY, operations);
    persistMission();
    pi.appendEntry?.(COORDINATOR_ENTRY, coordinatorStates);
    persistScheduler();
    saveCompactState(event);
  };
  pi.on?.("session_before_compact", (event: any) => { nativeCompactionImminent = true; refreshStatusView(); checkpoint(event); refreshStatusView(); return { customInstructions: compactInstructions, replaceInstructions: false }; });
  pi.on?.("session_compact", (_event: any, ctx: any) => {
    nativeCompactionImminent = false;
    latestContextUsage = ctx?.getContextUsage?.();
    // Pi owns compaction; the checkpoint does not change Scheduler semantics.
    maintenancePending = false; lastMaintenanceEpoch = maintenanceEpoch; maintenanceArmed = false;
    refreshStatusView();
  });
  pi.on?.("session_compact_failed", (_event: any, ctx: any) => {
    nativeCompactionImminent = false;
    latestContextUsage = ctx?.getContextUsage?.();
    maintenancePending = false; lastMaintenanceEpoch = maintenanceEpoch; maintenanceArmed = false;
    refreshStatusView();
  });
  pi.on?.("model_select", (_event: any, ctx: any) => { captureRuntimeIdentity(ctx); refreshStatusView(); });
  pi.on?.("thinking_level_select", (_event: any, ctx: any) => { captureRuntimeIdentity(ctx); refreshStatusView(); });
  pi.on?.("context", (_event: any, ctx: any) => {
    latestContextUsage = ctx.getContextUsage?.();
    if (proactivePolicy.enabled) {
      const percent = latestContextUsage?.percent;
      if (typeof percent === "number" && Number.isFinite(percent)) {
        if (percent < proactivePolicy.threshold_percent!) {
          if (!maintenanceArmed) { maintenanceEpoch++; maintenanceArmed = true; }
          maintenancePending = false;
        } else if (maintenanceArmed && maintenanceEpoch > lastMaintenanceEpoch) maintenancePending = true;
      }
    }
    refreshStatusView();
  });
  const maintainContext = (event: any, ctx: any) => {
    if (!maintenancePending || activeToolCalls.size || activeOperationRuns.size || hasActiveCoordinateTasks() || event.context?.pendingMessages?.length) return;
    const projected = event.context?.contextEntries ?? [];
    const collected = deterministicContextEdits(projected, { missions, operations, taskGraphs, memory: loadProjectMemory(ctx.cwd ?? process.cwd()), existingEdits: event.entries ?? [] });
    const board = missionBoard();
    const previousBoard = [...projected].reverse().find((entry: any) => entry.sourceEntry?.type === "custom_message" && entry.sourceEntry?.customType === "pi-harness-situation-board");
    const previousContent = previousBoard?.messages?.[0]?.content;
    const previousText = typeof previousContent === "string" ? previousContent : Array.isArray(previousContent) ? previousContent.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") : undefined;
    const boardEntries = !board
      ? previousBoard?.sourceEntry?.id && !previousText?.startsWith("[Superseded Mission Situation Board")
        ? [{ type: "context_edit", targetId: previousBoard.sourceEntry.id, replacement: { content: "[Superseded Mission Situation Board; terminal Mission state is durable.]" } }]
        : []
      : previousBoard?.sourceEntry?.id && previousText !== board
        ? [{ type: "context_edit", targetId: previousBoard.sourceEntry.id, replacement: { content: board } }]
        : previousBoard ? [] : [{ type: "custom_message", customType: "pi-harness-situation-board", content: board, display: false }];
    checkpoint();
    maintenancePending = false; maintenanceArmed = false; lastMaintenanceEpoch = maintenanceEpoch;
    refreshStatusView();
    return { entries: [...event.entries, ...collected.edits, ...boardEntries, { type: "custom", customType: "pi-harness-context-maintenance", data: { version: 1, context_edits: collected.edits.length, situation_board_edits: boardEntries.length, gc_bytes_removed: collected.bytesRemoved, gc_entries_superseded_by_task: collected.gcEntries.task, gc_entries_superseded_by_operation: collected.gcEntries.operation, gc_entries_superseded_by_mission: collected.gcEntries.mission } }] };
  };
  pi.on?.("turn_end", maintainContext);
  pi.on?.("agent_before_settle", maintainContext);
  pi.on?.("agent_settled", (_event: any, ctx: any) => { continuationQueued = false; latestContextUsage = ctx.getContextUsage?.(); latestContextTelemetry = collectContextTelemetry(ctx.sessionManager?.getEntries?.() ?? [], latestContextUsage); pi.appendEntry?.("pi-harness-context-telemetry", latestContextTelemetry); refreshStatusView(); continueGoal(); });
  pi.on?.("tool_execution_start", (event: any) => { activeToolCalls.add(event.toolCallId); });
  pi.on?.("tool_execution_end", (event: any, ctx: any) => { activeToolCalls.delete(event.toolCallId); });
  pi.on?.("before_agent_start", (event: any, ctx: any) => {
    const sections = stablePromptSections({ memory: loadProjectMemory(ctx?.cwd ?? process.cwd()), plan: plan.enabled });
    const result = installStablePrompt(event, sections);
    stablePromptFingerprint = JSON.stringify(sections);
    return result;
  });

  pi.on?.("cache_warming_decision", (_event: any, ctx: any) => {
    const current = JSON.stringify(stablePromptSections({ memory: loadProjectMemory(ctx?.cwd ?? process.cwd()), plan: plan.enabled }));
    if (sessionEnding || maintenancePending || nativeCompactionImminent || current !== stablePromptFingerprint) return { action: "stop" };
    // Provider mechanics, TTL and economics remain entirely Pi-owned.
  });
  pi.on?.("session_shutdown", async () => {
    sessionEnding = true;
    sessionEpoch++;
    cancelCoordinateTasks(sessionTaskGroup);
    if (goalGroupId) cancelCoordinateTasks(goalGroupId);
    for (const run of activeOperationRuns.values()) run.controller.abort();
    activeOperationRuns.clear();
    goalGroupId = undefined;
    continuationQueued = false;
    resumedMissionId = undefined;
    const lease = controlLease;
    controlLease = undefined;
    selectedMissionId = undefined;
    statusTui = undefined;
    if (lease) await lease.release();
  });

  const showExpandedStatus = async (ctx: any) => {
    const content = formatExpandedStatus(statusViewModel).split("\n");
    if (ctx.mode === "tui" && ctx.ui?.custom) {
      await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => new StatusOverlay(tui, theme, content, done), {
        overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: 24 },
      });
    } else say(ctx, content.join("\n"));
  };
  pi.registerCommand?.("status", { description: "Show the current bounded Mission, execution, and Context Economics status", handler: async (_args: string, ctx: any) => showExpandedStatus(ctx) });
  pi.registerCommand?.("harness-context", { description: "Show the current status projection", handler: async (_args: string, ctx: any) => showExpandedStatus(ctx) });
  pi.registerTool?.({
    name: "pi_harness_status", label: "Pi Harness status",
    description: "Return the current bounded status projection. Use this read-only tool when the user asks what is running, what agents are doing, whether work is blocked, or for Context Economics status. It uses the cached StatusViewModel and does not inspect session history or child output.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: formatExpandedStatus(statusViewModel) }], details: undefined }),
  });

  pi.registerCommand?.("harness-compact", { description: "Harness context maintenance: /harness-compact set <50-90>|status|disable (independent of /autocompact)", handler: async (args: string, ctx: Context) => {
    const input = args.trim();
    if (!input || input === "status") return say(ctx, `Harness context maintenance: ${proactivePolicy.enabled ? `enabled at ${proactivePolicy.threshold_percent}%` : "disabled"}${proactivePolicy.threshold_percent === null ? " (no threshold set)" : `; threshold ${proactivePolicy.threshold_percent}%`}.`);
    try {
      if (input === "disable") { proactivePolicy = { ...proactivePolicy, enabled: false }; maintenancePending = false; }
      else if (input.startsWith("set ")) { proactivePolicy = setProactiveThreshold(input.slice(4).trim()); maintenancePending = false; maintenanceArmed = true; maintenanceEpoch++; }
      else throw new Error("Use /harness-compact set <50-90>, status, or disable.");
      refreshStatusView();
      pi.appendEntry?.(PROACTIVE_COMPACT_ENTRY, proactivePolicy);
      say(ctx, `Harness context maintenance ${proactivePolicy.enabled ? `set to ${proactivePolicy.threshold_percent}%` : "disabled"}. Pi-native auto-compaction is unchanged.`);
    } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("plan", { description: "Read-only planning: /plan on|off|status", handler: async (args: string, ctx: Context) => {
    try { const action = parsePlan(args); if (action === "status") say(ctx, `Plan mode: ${plan.enabled ? "on" : "off"}`); else setPlan(action === "on", ctx); } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("mission", { description: "List Missions, resume one, cancel one, or clear a cancelled Mission: /mission list|status|resume <mission-id>|cancel <mission-id>|clear <mission-id>", handler: async (args: string, ctx: Context) => {
    const [action, id, ...extra] = args.trim().split(/\s+/);
    if (!action || action === "list" || action === "status") {
      const all = Object.values(missions).sort((a: any, b: any) => a.mission_id.localeCompare(b.mission_id));
      const shown = all.slice(-32).map((mission: any) => `${mission.mission_id}${mission.mission_id === selectedMissionId ? " [selected]" : ""} · ${mission.status} · ${String(mission.objective).replace(/\s+/g, " ").slice(0, 100)}`);
      const omitted = all.length - shown.length;
      return say(ctx, all.length ? `${shown.join("\n")}${omitted > 0 ? `\n${omitted} older Mission(s) omitted.` : ""}` : "No persisted Missions.");
    }
    if (!["resume", "cancel", "clear"].includes(action) || !id || extra.length) return say(ctx, "Use /mission list, /mission resume <mission-id>, /mission cancel <mission-id>, or /mission clear <mission-id>.", "warning");
    const mission = missions[id];
    if (!mission) return say(ctx, `Unknown Mission ${id}. Use /mission list to inspect persisted Missions.`, "error");
    if (action === "cancel") {
      if (mission.status === "complete") return say(ctx, `Mission ${id} is complete and cannot be cancelled.`, "warning");
      if (mission.status === "cancelled") return say(ctx, `Mission ${id} is already cancelled.`);
      if (selectedMissionId === id && goal?.status === "active") return cancelGoal(ctx);
      try {
        await ensureControlLease(ctx.cwd);
        for (const [operationId, run] of activeOperationRuns) if (operations[operationId]?.mission_id === id) run.controller.abort();
        missions = { ...missions, [id]: createMission({ ...mission, status: "cancelled" }) };
        const previousGoal = missionGoals[id];
        missionGoals = { ...missionGoals, [id]: { ...goalState(mission.objective, "cancelled", Array.isArray(previousGoal?.evidence) ? previousGoal.evidence : []), mission_id: id } };
        if (selectedMissionId === id) {
          if (goalGroupId) cancelCoordinateTasks(goalGroupId);
          goalGroupId = undefined;
          continuationQueued = false;
          continuationCount = 0;
          if (goal?.mission_id === id) goal = missionGoals[id];
        }
        maintenancePending = true;
        persistMission(); persistScheduler(); persist();
        say(ctx, `Mission ${id} cancelled.`);
      } catch (error) { say(ctx, (error as Error).message, "error"); }
      return;
    }
    if (action === "clear") {
      if (mission.status !== "cancelled") return say(ctx, `Cancel Mission ${id} before clearing its TaskOrders.`, "warning");
      if ([...activeOperationRuns.keys()].some((operationId) => operations[operationId]?.mission_id === id)) return say(ctx, `Wait until Mission ${id}'s cancelled Operation run settles before clearing its TaskOrders.`, "warning");
      try {
        await ensureControlLease(ctx.cwd);
        const operationIds = new Set<string>(mission.operation_ids);
        const removedOperations = operationIds.size;
        const removedTasks = [...operationIds].reduce((count, operationId) => count + (operations[operationId]?.required_task_ids?.length ?? 0), 0);
        missions = { ...missions, [id]: createMission({ ...mission, operation_ids: [] }) };
        operations = Object.fromEntries(Object.entries(operations).filter(([operationId]) => !operationIds.has(operationId)));
        taskGraphs = Object.fromEntries(Object.entries(taskGraphs).filter(([operationId]) => !operationIds.has(operationId)));
        coordinatorStates = Object.fromEntries(Object.entries(coordinatorStates).filter(([operationId]) => !operationIds.has(operationId)));
        attemptLedger = Object.fromEntries(Object.entries(attemptLedger).filter(([, attempt]: [string, any]) => attempt?.mission_id !== id));
        persistMission(); persistScheduler(); persist();
        say(ctx, `Cleared ${removedTasks} TaskOrder(s) and ${removedOperations} Operation(s) from cancelled Mission ${id}.`);
      } catch (error) { say(ctx, (error as Error).message, "error"); }
      return;
    }
    if (activeOperationRuns.size || ctx.isIdle?.() === false) return say(ctx, "Wait until the current operation and Pi turn settle before resuming a Mission.", "warning");
    if (mission.status === "complete") return say(ctx, `Mission ${id} is complete and cannot be resumed.`, "warning");
    try {
      await ensureControlLease(ctx.cwd);
      if (goalGroupId) cancelCoordinateTasks(goalGroupId);
      selectedMissionId = id;
      resumedMissionId = id;
      if (mission.status !== "active") missions = { ...missions, [id]: createMission({ ...mission, status: "active" }) };
      const previousGoal = missionGoals[id];
      goal = { ...goalState(mission.objective, "active", Array.isArray(previousGoal?.evidence) ? previousGoal.evidence : []), mission_id: id };
      missionGoals = { ...missionGoals, [id]: goal };
      goalGroupId = randomUUID(); continuationCount = 0; invalidTerminalAttempts = 0; continuationQueued = false;
      maintenancePending = true;
      persistMission(); persistScheduler(); persist();
      if (ctx.isIdle?.() !== false) maintenancePending = false;
      refreshStatusView();
      say(ctx, `Mission ${id} resumed. Its Task and Attempt state is unchanged.`);
      continueGoal();
    } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("goal", { description: "Manage one evidence-backed goal", handler: async (args: string, ctx: Context) => {
    const input = args.trim();
    if (input === "status") return say(ctx, goal && selectedMissionId ? `${goal.status}: ${goal.objective} (${selectedMissionId})` : "No Mission selected. Use /mission list and /mission resume <mission-id>.");
    if (input === "cancel") return selectedMissionId ? cancelGoal(ctx) : say(ctx, "No Mission selected. Use /mission resume <mission-id> before cancelling.", "warning");
    try { const mission = await startMission(input, [], ctx); say(ctx, `Goal active: ${mission.objective}`); }
    catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("skill-hub", { description: "Show the pinned curated-skill boundary", handler: async (_args: string, ctx: Context) => {
    say(ctx, "Curated skills are checksum-pinned. Do not install an additional skill without an explicit user request.");
  }});
  pi.registerCommand?.("learn", { description: "Manage private local project memory: /learn <note> | status | clear", handler: async (args: string, ctx: Context) => {
    const input = args.trim();
    if (!input || input === "status") {
      const memory = loadProjectMemory(ctx.cwd ?? process.cwd());
      return say(ctx, memory ? `[Project Memory]:\n${memory}` : "No memory saved for this project yet. Use /learn <note> to add one.");
    }
    if (input === "clear" || input === "reset") try {
      clearProjectMemory(ctx.cwd ?? process.cwd());
      return say(ctx, "Project memory cleared for this project.");
    } catch (error) { return say(ctx, (error as Error).message, "error"); }
    try {
      const entry = appendProjectMemory(input, ctx.cwd ?? process.cwd());
      say(ctx, `Learned for this project: "${entry.note}"`);
    } catch (error) {
      say(ctx, (error as Error).message, "error");
    }
  }});

  pi.registerTool?.({
    name: "pi_harness_start_mission", label: "Pi Harness start Mission",
    description: "Start a managed Mission from a natural-language objective and optional user Constraints. Use only when managed execution materially improves the result. Harness starts a bounded Commander continuation; the Coordinator owns semantic Task decomposition.",
    parameters: Type.Object({ objective: Type.String(), constraints: Type.Optional(Type.Array(Type.String())) }),
    execute: async (_id: string, input: { objective: string; constraints?: string[] }, _signal?: AbortSignal, _onUpdate?: any, ctx?: Context) => {
      const mission = await startMission(input.objective, input.constraints ?? [], ctx ?? {});
      return { content: [{ type: "text", text: JSON.stringify({ version: 1, mission_id: mission.mission_id, status: mission.status, objective: mission.objective }) }] };
    },
  });
  pi.registerTool?.({
    name: "pi_harness_goal", label: "Pi Harness goal",
    description: "Record the terminal state of the explicitly selected Mission. Evidence is mandatory; blocked and error also require a blocker.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("error")]), evidence: Type.String(), blocker: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { status: "complete" | "blocked" | "error"; evidence: string; blocker?: string }) => {
      if (!selectedMissionId || !controlLease || goal?.mission_id !== selectedMissionId) throw new Error("The Commander must explicitly resume a Mission before recording its terminal state");
      const activeMission = missions[selectedMissionId];
      if (!activeMission || activeMission.status !== "active") throw new Error("The selected Mission is not active");
      if (input.status === "complete" && !missionIsClosable(activeMission, operations, taskGraphs, attemptLedger)) throw new Error("The Mission has unresolved obligations or unmet successful completion requirements");
      goal = transitionGoal(goal, input.status, input.evidence, input.blocker);
      missions = { ...missions, [activeMission.mission_id]: createMission({ ...activeMission, status: goal.status }) };
      missionGoals = { ...missionGoals, [activeMission.mission_id]: goal };
      maintenancePending = true;
      continuationQueued = false; if (goal.status !== "active") goalGroupId = undefined; persistMission(); persistScheduler(); persist();
      return { content: [{ type: "text", text: JSON.stringify({ mission_id: activeMission?.mission_id, status: goal.status, evidence: goal.evidence, blocker: goal.blocker }) }] };
    },
  });
  pi.registerTool?.({
    name: "pi_harness_hashlines", label: "Pi Harness hashlines",
    description: "Read up to 200 lines with line hashes and a block SHA-256. Pass the returned SHA-256 unchanged to pi_harness_patch.",
    parameters: Type.Object({ path: Type.String(), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }) }),
    execute: async (_id: string, input: { path: string; start_line: number; end_line: number }) => ({
      content: [{ type: "text", text: JSON.stringify(readHashlines(process.cwd(), input.path, input.start_line, input.end_line), null, 2) }],
    }),
  });
  pi.registerTool?.({
    name: "pi_harness_patch", label: "Pi Harness precise patch",
    description: "Replace exactly one previously read line block. The patch is rejected if its SHA-256 is stale. replacement contains only the new block, without surrounding lines.",
    parameters: Type.Object({ path: Type.String(), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }), expected_sha256: Type.String(), replacement: Type.String() }),
    execute: async (_id: string, input: { path: string; start_line: number; end_line: number; expected_sha256: string; replacement: string }) => ({
      content: [{ type: "text", text: JSON.stringify(replaceHashlines(process.cwd(), input.path, input.start_line, input.end_line, input.expected_sha256, input.replacement), null, 2) }],
    }),
  });
  pi.registerTool?.({
    name: "pi_harness_find_symbol", label: "Pi Harness find symbol",
    description: "Find symbol declarations with Universal Ctags, or structural ast-grep matches when available. The fallback is explicitly labeled text search.",
    parameters: Type.Object({ symbol: Type.String() }),
    execute: async (_id: string, input: { symbol: string }) => ({
      content: [{ type: "text", text: JSON.stringify(findSymbol(process.cwd(), input.symbol), null, 2) }],
    }),
  });
  pi.registerTool?.({
    name: "pi_harness_references", label: "Pi Harness references",
    description: "Find structural symbol references with ast-grep when available. The fallback is explicitly labeled text search.",
    parameters: Type.Object({ symbol: Type.String() }),
    execute: async (_id: string, input: { symbol: string }) => ({
      content: [{ type: "text", text: JSON.stringify(findReferences(process.cwd(), input.symbol), null, 2) }],
    }),
  });
  pi.registerTool?.({
    name: "pi_harness_operation", label: "Pi Harness Operation handoff",
    description: "Create, resolve an unknown Attempt from exact child terminal evidence, terminalize, or read a bounded Commander-safe Operation summary. For status, pass task_id to inspect one exact blocked TaskOrder when omitted_blocker_count is nonzero. Only the Harness Coordinator may dispatch TaskOrders, accept or reject TaskResults, or accept Operation Acceptance Criteria. Operation completion never completes the Mission.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("status"), Type.Literal("supersede"), Type.Literal("waive"), Type.Literal("remove"), Type.Literal("transfer"), Type.Literal("waive_operation"), Type.Literal("resolve_attempt")]), operation_id: Type.String(), attempt_id: Type.Optional(Type.String({ maxLength: 160 })), objective: Type.Optional(Type.String()), acceptance_criteria: Type.Optional(Type.Array(Type.String())), allowed_policy_ids: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), task_id: Type.Optional(Type.String()), replacement_operation_id: Type.Optional(Type.String()), replacement_task_id: Type.Optional(Type.String()), authority_type: Type.Optional(Type.Union([Type.Literal("commander"), Type.Literal("user")])), reason: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { action: "create" | "status" | "supersede" | "waive" | "remove" | "transfer" | "waive_operation" | "resolve_attempt"; operation_id: string; attempt_id?: string; objective?: string; acceptance_criteria?: string[]; allowed_policy_ids?: string[]; constraints?: string[]; task_id?: string; replacement_operation_id?: string; replacement_task_id?: string; authority_type?: "commander" | "user"; reason?: string }) => {
      const id = input.operation_id;
      const action = input.action as string;
      if (!["create", "status", "supersede", "waive", "remove", "transfer", "waive_operation", "resolve_attempt"].includes(action)) throw new Error("Only the Harness Coordinator may accept or reject a TaskResult or Operation Acceptance Criterion");
      if (activeOperationRuns.has(id)) throw new Error("The Operation is running. The Commander must wait for the bounded OperationReport.");
      if (action === "create") {
        if (Object.hasOwn(operations, id)) throw new Error("Operation ID already exists");
        // Persisted and direct-program legacy callers can still restore a static Operation.
        // The public schema does not expose this compatibility path.
        const legacy = input as any;
        const mission = selectedMissionId ? missions[selectedMissionId] : undefined;
        if (!mission || mission.status !== "active" || !controlLease) throw new Error("Operation creation requires an explicitly selected Mission; use /mission resume <mission-id>");
        const constraints = [...new Set([...(mission.constraints ?? []), ...(input.constraints ?? [])])];
        const operation = legacy.required_task_ids !== undefined
          ? createOperation({ operation_id: id, mission_id: mission.mission_id, objective: input.objective, required_task_ids: legacy.required_task_ids, acceptance_criteria: input.acceptance_criteria, dependencies: legacy.dependencies, constraints, task_intents: legacy.task_intents, task_specs: legacy.task_specs })
          : createOperation({ operation_id: id, mission_id: mission.mission_id, objective: input.objective, acceptance_criteria: input.acceptance_criteria, allowed_policy_ids: input.allowed_policy_ids ?? ["research-read", "scout-read", "worker-write"], constraints, planning: true });
        if (!operation.planning && operation.required_task_ids.some((taskId: string) => Object.values(operations).some((entry: any) => entry.required_task_ids?.includes(taskId)))) throw new Error("A TaskOrder ID already belongs to another Operation");
        const graph = createTaskGraph(operation);
        operations = { ...operations, [id]: operation };
        taskGraphs = { ...taskGraphs, [id]: graph };
        missions = attachOperation(missions, mission.mission_id, id);
        persistMission();
        pi.appendEntry?.(OPERATION_ENTRY, operations);
        persistScheduler();
        return { content: [{ type: "text", text: JSON.stringify(operation.planning
          ? { version: 1, mission_id: mission.mission_id, operation_id: id, status: "open", planning: true, summary: "The Commander registered a planning Operation. The Coordinator must materialize its TaskGraph before dispatch." }
          : { version: 1, mission_id: mission.mission_id, operation_id: id, status: "open", summary: "The Commander registered the legacy Operation. The Commander must start the Harness Coordinator." }) }] };
      }
      const operation = Object.hasOwn(operations, id) ? operations[id] : undefined;
      if (!operation) throw new Error("Unknown Operation");
      validateTaskGraph(taskGraphs[id], operation);
      if (action !== "status" && (!controlLease || selectedMissionId !== operation.mission_id || missions[operation.mission_id]?.status !== "active")) throw new Error("Resume the owning Mission before changing its Operation state");
      if (action === "resolve_attempt") {
        const attempt = input.attempt_id && Object.hasOwn(attemptLedger, input.attempt_id) ? attemptLedger[input.attempt_id] : undefined;
        if (!attempt || attempt.operation_id !== id) throw new Error("resolve_attempt requires the exact owning attempt_id");
        if (attempt.status !== "terminal") {
          if (attempt.status !== "unknown") throw new Error("Only an unknown Attempt can be resolved");
          if (!attempt.child_refs?.length) throw new Error("Unknown Attempt has no persisted child reference");
          const observations = attempt.child_refs.map((ref: any) => ({ child_id: ref.child_id, ...inspectCoordinateChild(ref.child_id), source: "pi-subagents", observed_at: new Date().toISOString() }));
          if (observations.some((observation: any) => observation.state !== "terminal")) throw new Error("Every exact child must be terminal; active or unavailable children remain blocked");
          const resolutions = observations.map(({ state, ...observation }: any) => observation);
          attemptLedger = resolveUnknownAttempt(attemptLedger, input.attempt_id!, resolutions);
          persistScheduler();
        }
      }
      if (["transfer", "waive_operation"].includes(action)) {
        if (!input.authority_type || !input.reason?.trim()) throw new Error("Operation terminal disposition requires authority type and reason");
        const status = action === "transfer" ? "transferred" : "waived";
        operations = { ...operations, [id]: terminalizeOperation(operation, taskGraphs[id], { status, authority_type: input.authority_type, reason: input.reason }) };
        persistScheduler();
        return { content: [{ type: "text", text: JSON.stringify({ version: 1, mission_id: operation.mission_id, operation_id: id, status, situation_board: missionBoard() }) }] };
      }
      if (["supersede", "waive", "remove"].includes(action)) {
        if (operation.planning || !input.task_id || !input.authority_type || !input.reason?.trim()) throw new Error("Task supersession or waiver requires a materialized TaskOrder, authority type, and reason");
        let nextGraph;
        if (action === "supersede") {
          const replacement = input.replacement_operation_id && operations[input.replacement_operation_id];
          if (!replacement || !input.replacement_task_id || replacement.mission_id !== operation.mission_id || !replacement.required_task_ids?.includes(input.replacement_task_id)) throw new Error("Task supersession requires a persisted replacement TaskOrder in the same Mission");
          nextGraph = supersedeGraphTask(taskGraphs[id], operation, input.task_id, { authority_type: input.authority_type, reason: input.reason, replacement_mission_id: operation.mission_id, replacement_operation_id: replacement.operation_id, replacement_task_id: input.replacement_task_id });
        } else nextGraph = waiveGraphTask(taskGraphs[id], operation, input.task_id, { authority_type: input.authority_type, reason: input.reason });
        taskGraphs = { ...taskGraphs, [id]: nextGraph };
        persistScheduler();
        return { content: [{ type: "text", text: JSON.stringify({ version: 1, mission_id: operation.mission_id, operation_id: id, task_id: input.task_id, disposition: action === "supersede" ? "superseded" : "waived", situation_board: missionBoard() }) }] };
      }
      const report = operationReport(operation, coordinatorStates[id] ?? coordinatorState(operation), undefined, undefined, taskGraphs[id], attemptLedger, action === "status" ? input.task_id : undefined);
      const summary = operation.planning ? "The Operation awaits Coordinator plan_tasks materialization. No TaskOrder is available." : operation.status === "complete"
        ? "The Coordinator accepted the Operation. The Commander must evaluate the Mission Definition of Done."
        : "Inspect the bounded recovery status. Resolve exact unknown Attempts, retry only retryable_task_ids, and run ready work in this Operation. Waived work does not satisfy completion.";
      const statusReport = { version: 1, mission_id: operation.mission_id, operation_id: id, status: operation.status, ...(operation.planning ? { planning: true } : {}), summary,
        ...(report.failure_code ? { failure_code: report.failure_code } : {}), ...(report.failure_stage ? { failure_stage: report.failure_stage } : {}),
        ...(report.failure_task_id ? { failure_task_id: report.failure_task_id } : {}), ...(report.failure_codes ? { failure_codes: report.failure_codes } : {}),
        ready_task_ids: report.ready_task_ids, retryable_task_ids: report.retryable_task_ids, accepted_task_ids: report.accepted_task_ids,
        waived_task_ids: report.waived_task_ids, blocked_task_ids: report.blocked_task_ids, blockers: report.scheduler_blockers,
        omitted_blocker_count: report.omitted_blocker_count, blocker_lookup: report.blocker_lookup, situation_board: "" };
      // Reserve the status budget before adding the Board; omitted blockers stay
      // available through an exact lookup instead of disappearing silently.
      while (Buffer.byteLength(JSON.stringify(statusReport)) > 24_000 && statusReport.blockers.length && input.task_id === undefined) {
        statusReport.blockers.pop(); statusReport.omitted_blocker_count++;
      }
      const board = missionBoard(), marker = "\n[Situation Board truncated; remaining obligations stay in durable Mission state.]";
      statusReport.situation_board = board;
      if (Buffer.byteLength(JSON.stringify(statusReport)) > 24_000) {
        let low = 0, high = board.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          statusReport.situation_board = board.slice(0, middle) + marker;
          if (Buffer.byteLength(JSON.stringify(statusReport)) <= 24_000) low = middle;
          else high = middle - 1;
        }
        const end = /[\uD800-\uDBFF]$/.test(board.slice(0, low)) ? low - 1 : low;
        statusReport.situation_board = board.slice(0, end) + marker;
        if (Buffer.byteLength(JSON.stringify(statusReport)) > 24_000) statusReport.situation_board = "";
      }
      if (Buffer.byteLength(JSON.stringify(statusReport)) > 24_000) throw new Error("The bounded Operation status exceeds its limit");
      return { content: [{ type: "text", text: JSON.stringify(statusReport) }] };
    },
  });
  pi.registerTool?.({
    name: "pi_harness_run_operation", label: "Pi Harness run Operation",
    description: "Run a serial Harness-controlled Coordinator loop. To restart a failed TaskOrder listed in Operation status retryable_task_ids, pass retry_task_id. Harness releases an eligible resolved Attempt or rejects its failed TaskResult and makes the exact TaskOrder ready for a new Attempt. Return only a bounded OperationReport to the Commander.",
    parameters: Type.Object({ operation_id: Type.String(), retry_task_id: Type.Optional(Type.String()), model: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { operation_id: string; retry_task_id?: string; model?: string }, signal?: AbortSignal, _onUpdate?: any, ctx?: any) => {
      const runCwd = ctx?.cwd ?? process.cwd();
      const id = input.operation_id;
      const operation = Object.hasOwn(operations, id) ? operations[id] : undefined;
      if (hasActiveCoordinateTasks()) throw new Error("Coordinator dispatch is blocked until the previously managed child settles");
      if (!operation || operation.status !== "open" || !selectedMissionId || operation.mission_id !== selectedMissionId || missions[selectedMissionId]?.status !== "active" || !controlLease || activeOperationRuns.size) throw new Error("An open Operation owned by the selected Mission and an idle serial Scheduler are required");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
      const runId = randomUUID();
      const runEpoch = sessionEpoch;
      activeOperationRuns.set(id, { controller, goalGroup: goal?.status === "active" ? goalGroupId : undefined });
      refreshStatusView();
      const save = (nextOperation: ReturnType<typeof createOperation>, state: ReturnType<typeof coordinatorState>, graph: ReturnType<typeof createTaskGraph>) => {
        if (runEpoch !== sessionEpoch) return;
        validateTaskGraph(graph, nextOperation);
        operations = { ...operations, [id]: nextOperation };
        taskGraphs = { ...taskGraphs, [id]: graph };
        coordinatorStates = { ...coordinatorStates, [id]: state };
        pi.appendEntry?.(OPERATION_ENTRY, operations);
        pi.appendEntry?.(COORDINATOR_ENTRY, coordinatorStates);
        persistScheduler();
      };
      const recordUsage = (usage: any, provenance: Record<string, any> = {}) => {
        if (runEpoch !== sessionEpoch) return;
        const safe: Record<string, any> = {};
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) if (Number.isFinite(usage?.[key]) && usage[key] >= 0) safe[key] = usage[key];
        if (Number.isFinite(usage?.cost?.total) && usage.cost.total >= 0) safe.cost = { total: usage.cost.total };
        const task_id = provenance.task_id;
        const attempt_id = task_id ? Object.values(attemptLedger).find((attempt: any) => attempt.operation_id === id && attempt.task_id === task_id && attempt.ordinal === taskGraphs[id]?.nodes?.[task_id]?.attempts)?.attempt_id : undefined;
        if (Object.keys(safe).length) pi.appendEntry?.("pi-harness-child-usage", { version: 1, mission_id: operation.mission_id, operation_id: id, ...(task_id ? { task_id } : {}), ...(attempt_id ? { attempt_id } : {}), role: provenance.role ?? "coordinator", usage: safe });
      };
      try {
        const report = await runOperation(operation, {
          turn: (prompt: string) => executeCoordinatorTurn(pi, prompt, { cwd: runCwd, onUsage: (usage: any) => recordUsage(usage, { role: "coordinator" }), model: input.model, groupId: runId, signal: controller.signal }),
          dispatch: async (task: any, progress: any) => {
            const claimedAttemptId = attemptId(id, task.task_id, taskGraphs[id].nodes[task.task_id].attempts);
            return promoteTaskResult(await executeCoordinateTask(pi, validateTask(task), { cwd: runCwd, groupId: runId, signal: controller.signal, modelRegistry: ctx?.modelRegistry,
              onChildStarted: (reference: { child_id: string; role: string }) => {
                if (runEpoch !== sessionEpoch) return;
                const nextLedger = recordAttemptChild(attemptLedger, claimedAttemptId, reference);
                if (nextLedger === attemptLedger) return;
                attemptLedger = nextLedger;
                persistScheduler();
              },
              onVerificationStart: progress.onVerificationStart, timeout: managedTaskTimeout(task.owner), reviewerTimeout: managedTaskTimeout("reviewer"), onUsage: (usage: any, provenance: Record<string, any>) => recordUsage(usage, { task_id: task.task_id, ...provenance }) }));
          },
          save,
          getAttemptLedger: () => attemptLedger,
          rollbackAttempt: (attemptId: string) => {
            if (runEpoch !== sessionEpoch) throw new Error("The Operation session changed before the Attempt rollback");
            attemptLedger = rollbackUnstartedAttempt(attemptLedger, attemptId);
            return attemptLedger;
          },
        }, { state: coordinatorStates[id] ?? coordinatorState(operation), graph: taskGraphs[id], mission: operations[id].mission_id ? { mission_id: operations[id].mission_id, objective: missions[operations[id].mission_id]?.objective, ...(missions[operations[id].mission_id]?.constraints?.length ? { constraints: missions[operations[id].mission_id].constraints } : {}) } : goal?.status === "active" ? goal.objective : undefined, cwd: runCwd, onUsage: recordUsage, signal: controller.signal, parallelLimit, retryTaskId: input.retry_task_id, attemptLedger });
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
      } finally {
        signal?.removeEventListener("abort", abort);
        if (activeOperationRuns.get(id)?.controller === controller) { activeOperationRuns.delete(id); refreshStatusView(); }
      }
    },
  });
  pi.registerTool?.({
    name: "pi_harness_cancel_operation", label: "Pi Harness cancel Operation run",
    description: "Abort the active Coordinator or ExecutionUnit of this Operation. The Operation stays open for a later handoff.",
    parameters: Type.Object({ operation_id: Type.String() }),
    execute: async (_id: string, input: { operation_id: string }) => {
      const run = activeOperationRuns.get(input.operation_id);
      if (!run) throw new Error("No active run for this Operation");
      run.controller.abort();
      return { content: [{ type: "text", text: JSON.stringify({ operation_id: input.operation_id, status: "blocked", blocker: "The Commander cancelled the active Operation run." }) }] };
    },
  });
  pi.registerTool?.({
    name: "pi_harness_coordinate", label: "Pi Harness legacy dispatch (disabled)",
    description: "Direct ExecutionUnit dispatch is disabled. Register a TaskOrder in pi_harness_operation and call pi_harness_run_operation; the Harness Coordinator owns dispatch and TaskResult acceptance.",
    parameters: Type.Object({ owner: Type.Union([Type.Literal("scout"), Type.Literal("research"), Type.Literal("worker")]), scope: Type.String(), verification: Type.String(), permission: Type.Union([Type.Literal("read"), Type.Literal("write")]), model: Type.Optional(Type.String()), operation_id: Type.Optional(Type.String()), task_id: Type.Optional(Type.String()), constraints: Type.Optional(Type.Array(Type.String())), acceptance_criteria: Type.Optional(Type.Array(Type.String())), review_evidence: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Literal("diff"), Type.Literal("gate"), Type.Literal("execution"), Type.Literal("report")]))), review_profile: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Literal("default"), Type.Literal("security")]))) }),
    execute: async () => {
      throw new Error("Direct TaskOrder dispatch is disabled because it promotes TaskResult to the Commander. Register an Operation and call pi_harness_run_operation so the Coordinator owns dispatch, verification, and acceptance.");
    },
  });
}
