import { contextTelemetry, deterministicContextEdits, installStablePrompt, stablePromptSections } from "../lib/context-economics.mjs";
import { MISSION_ENTRY, attachOperation, createMission, missionIsClosable, missionSituationBoard, validateMissionOwnership } from "../lib/mission.mjs";
import { reconcileAttemptLedger } from "../lib/attempt-ledger.mjs";
import { assertSupportedPlatform } from "../lib/platform.mjs";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  COMPACT_ENTRY, GOAL_ENTRY, PLAN_ENTRY, READ_ONLY_TOOLS, controlStateSummary, goalState,
  isPlanAllowedTool, parsePlan, planState, restore, transitionGoal,
} from "../lib/state.mjs";
import { appendProjectMemory, clearProjectMemory, loadProjectMemory } from "../lib/memory.mjs";
import { cancelCoordinateTasks, executeCoordinateTask, executeCoordinatorTurn, hasActiveCoordinateTasks, managedTaskTimeout, validateTask } from "../lib/coordinator.mjs";
import { COMMANDER_LANGUAGE_POLICY } from "../lib/agent-english.mjs";
import { PROACTIVE_COMPACT_ENTRY, proactiveCompactionPolicy, restoreProactivePolicy, setProactiveThreshold } from "../lib/compaction-policy.mjs";
import { HEAD_REGISTRY_ENTRY, HEAD_STATE_ENTRY, createHeadRegistry, validateHeadRegistry, validateHeadState } from "../lib/domain-head.mjs";
import { COORDINATOR_ENTRY, coordinatorState, parallelTaskLimit, runOperation } from "../lib/operation-runner.mjs";
import { promoteTaskResult } from "../lib/communication.mjs";
import { OPERATION_ENTRY, createOperation, terminalizeOperation } from "../lib/operation.mjs";
import { TASK_GRAPH_ENTRY, createTaskGraph, migrateTaskGraph, reconcileTaskGraph, supersedeGraphTask, validateTaskGraph, waiveGraphTask } from "../lib/task-graph.mjs";
import { findReferences, findSymbol } from "../lib/code-intel.mjs";
import { readHashlines, replaceHashlines } from "../lib/precise-edit.mjs";
import { Type } from "typebox";

type Context = { cwd?: string; ui?: { notify?: (message: string, level: "info" | "warning" | "error") => void }; abort?: () => void; isIdle?: () => boolean };
type Pi = Record<string, any>;

const HARNESS_TOOLS = new Set(["pi_harness_goal", "pi_harness_coordinate", "pi_harness_operation", "pi_harness_run_operation", "pi_harness_cancel_operation", "pi_harness_patch"]);
const PACKAGE_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"]);
const MAX_AUTOMATIC_CONTINUATIONS = 25;
const SKILLS = Object.keys(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../skills/skills.lock.json"), "utf8")).skills).join(", ");

const fmtTokens = (count: number) => count < 1000 ? `${count}` : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`;

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
  let headRegistries: Record<string, ReturnType<typeof createHeadRegistry>> = {};
  let headStates: Record<string, Record<string, any>> = {};
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
  let latestContextTelemetry: ReturnType<typeof contextTelemetry> | undefined;
  let goalGroupId: string | undefined;

  const say = (ctx: Context, message: string, level: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(message, level);
  const persist = () => {
    pi.appendEntry?.(PLAN_ENTRY, plan);
    if (goal) pi.appendEntry?.(GOAL_ENTRY, goal);
  };
  // One canonical session entry commits Operation and TaskGraph together.
  const persistScheduler = () => {
    attemptLedger = reconcileAttemptLedger(attemptLedger, operations, taskGraphs);
    validateMissionOwnership(missions, operations, taskGraphs, attemptLedger);
    pi.appendEntry?.(TASK_GRAPH_ENTRY, { version: 2, missions, operations, task_graphs: taskGraphs, attempt_ledger: attemptLedger });
    maintenancePending = true;
  };
  const persistMission = () => pi.appendEntry?.(MISSION_ENTRY, missions);
  const missionBoard = () => missionSituationBoard(missions, operations, taskGraphs, attemptLedger);
  const collectContextTelemetry = (entries: any[], usage: any) => contextTelemetry(entries, usage, { missions, operations, taskGraphs, attemptLedger });
  const saveCompactState = (event: Record<string, unknown> = {}) => pi.appendEntry?.(COMPACT_ENTRY, controlStateSummary({
    goal, plan, decisions: Array.isArray(event.decisions) ? event.decisions : [],
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
      const activeMission = Object.values(missions).find((mission: any) => mission.status === "active" && mission.objective === goal?.objective) as any;
      goal = transitionGoal(goal, "cancelled");
      if (activeMission) missions = { ...missions, [activeMission.mission_id]: createMission({ ...activeMission, status: "cancelled" }) };
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
    if (!goal || goal.status !== "active" || continuationQueued || plan.enabled || maintenancePending) return;
    if (continuationCount >= MAX_AUTOMATIC_CONTINUATIONS) return stopUnboundedGoal();
    continuationCount += 1;
    continuationQueued = true;
    pi.sendUserMessage?.(`[PI_HARNESS_MISSION_CONTINUE]\nMission: ${goal.objective}\nContinue until you call pi_harness_goal with a terminal state and concrete evidence.`, { deliverAs: "followUp" });
  };

  pi.on?.("session_start", (_event: any, ctx: any) => {
    cancelCoordinateTasks(sessionTaskGroup);
    if (goalGroupId) cancelCoordinateTasks(goalGroupId);
    sessionTaskGroup = randomUUID();
    sessionEpoch++;
    stablePromptFingerprint = undefined; nativeCompactionImminent = false; sessionEnding = false;
    maintenancePending = false;
    latestContextTelemetry = undefined;
    maintenanceArmed = true;
    maintenanceEpoch = 0;
    lastMaintenanceEpoch = -1;
    activeToolCalls.clear();
    for (const run of activeOperationRuns.values()) run.controller.abort();
    activeOperationRuns.clear(); // Old callbacks are epoch-guarded and cannot clear a new run.
    const activeTools = pi.getActiveTools?.() ?? [];
    pi.setActiveTools?.(activeTools.filter((name: string) => !PACKAGE_TOOLS.has(name)));
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    plan = restore(entries, PLAN_ENTRY) ?? plan;
    goal = restore(entries, GOAL_ENTRY);
    const schedulerSnapshot = restore(entries, TASK_GRAPH_ENTRY);
    operations = schedulerSnapshot ? schedulerSnapshot.operations : restore(entries, OPERATION_ENTRY) ?? {};
    const legacyCoordinator = restore(entries, COORDINATOR_ENTRY) ?? {};
    taskGraphs = schedulerSnapshot ? schedulerSnapshot.task_graphs : Object.fromEntries(Object.entries(operations).map(([id, operation]) => [id, migrateTaskGraph(operation, legacyCoordinator[id]?.dispatch_counts)]));
    missions = schedulerSnapshot?.missions ?? restore(entries, MISSION_ENTRY) ?? {};
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
    attemptLedger = reconcileAttemptLedger(schedulerSnapshot?.attempt_ledger ?? {}, operations, taskGraphs);
    validateMissionOwnership(missions, operations, taskGraphs, attemptLedger);
    coordinatorStates = Object.fromEntries(Object.entries(legacyCoordinator).map(([id, state]: [string, any]) => [id, {
      version: 1, operation_id: id, turns: state.turns ?? 0, decisions: (state.decisions ?? []).slice(-7), blocker: state.blocker ?? null,
      ...(state.consultations_since_progress !== undefined ? { consultations_since_progress: state.consultations_since_progress } : {}),
    }]));
    headRegistries = restore(entries, HEAD_REGISTRY_ENTRY) ?? {};
    headStates = restore(entries, HEAD_STATE_ENTRY) ?? {};
    for (const [id, registry] of Object.entries(headRegistries)) {
      if (!operations[id]) throw new Error("Head Registry has no owning Operation");
      validateHeadRegistry(registry, operations[id]);
      for (const state of Object.values(headStates[id] ?? {})) validateHeadState(state, registry);
    }
    if (Object.keys(headStates).some((id) => !headRegistries[id] || Object.keys(headStates[id]).some((headId) => headId !== headStates[id][headId]?.head_id))) throw new Error("HeadState has no registered Head");
    if (Object.keys(coordinatorStates).length) pi.appendEntry?.(COORDINATOR_ENTRY, coordinatorStates);
    if (Object.keys(missions).length) persistMission();
    if (Object.keys(operations).length) persistScheduler();
    // One restore-time scan seeds the footer. Later refreshes happen only at
    // settlement boundaries, so render() never walks an unbounded session.
    latestContextTelemetry = collectContextTelemetry(ctx.sessionManager?.getEntries?.() ?? [], ctx.getContextUsage?.());
    proactivePolicy = restoreProactivePolicy(restore(entries, PROACTIVE_COMPACT_ENTRY));
    continuationCount = 0;
    invalidTerminalAttempts = 0;
    goalGroupId = goal?.status === "active" ? randomUUID() : undefined;
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

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          // Rendering must be read-only. Telemetry is refreshed at authoritative
          // settlement events, never by scanning the session from render().
          const metrics = latestContextTelemetry ?? contextTelemetry([], ctx.getContextUsage?.(), { missions, operations, taskGraphs, attemptLedger });
          const branch = footerData.getGitBranch();
          const left = theme.fg("dim", `${basename(ctx.cwd)}${branch ? ` / ${branch}` : ""}`);
          const model = `${ctx.model?.id ?? "no-model"} · ${ctx.thinkingLevel ?? "off"}`;
          const right = theme.fg("dim", model);
          const first = truncateToWidth(left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + right, width);

          const usage = ctx.getContextUsage?.();
          const percent = Number.isFinite(usage?.percent) ? usage.percent : null;
          const cells = 12;
          const filled = percent === null ? 0 : Math.max(0, Math.min(cells, Math.round(percent / 100 * cells)));
          const bar = theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(cells - filled));
          const window = usage?.contextWindow ?? ctx.model?.contextWindow;
          const context = usage?.tokens == null ? `? / ${Number.isFinite(window) ? fmtTokens(window) : "?"}` : `${fmtTokens(usage.tokens)} / ${Number.isFinite(window) ? fmtTokens(window) : "?"}`;
          const cache = metrics.cache_hit_ratio === null ? "—" : `${(metrics.cache_hit_ratio * 100).toFixed(1)}%`;
          const tokens = (value: number | null) => value === null ? "?" : fmtTokens(value);
          const money = (value: number | null) => value === null ? "?" : `$${value.toFixed(3)}`;
          const warm = metrics.warming_requests === 0 && metrics.warming_runtime_catalog_cost === null ? "0/—" : `${metrics.warming_requests}/${money(metrics.warming_runtime_catalog_cost)}`;
          const details = `Context ${bar} ${context} · ${percent === null ? "?" : percent.toFixed(1)}%  I/O ↑${tokens(metrics.input_tokens)} ↓${tokens(metrics.output_tokens)} · Cache ${cache} R${tokens(metrics.cache_read_tokens)} W${tokens(metrics.cache_write_tokens)} · Warm ${warm} · Est ${money(metrics.runtime_catalog_cost)}`;
          return [first, truncateToWidth(theme.fg("dim", details), width)];
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
    pi.appendEntry?.(HEAD_REGISTRY_ENTRY, headRegistries);
    pi.appendEntry?.(HEAD_STATE_ENTRY, headStates);
    persistScheduler();
    saveCompactState(event);
  };
  pi.on?.("session_before_compact", (event: any) => { nativeCompactionImminent = true; checkpoint(event); return { customInstructions: compactInstructions, replaceInstructions: false }; });
  pi.on?.("session_compact", () => {
    nativeCompactionImminent = false;
    // Pi owns compaction; the checkpoint does not change Scheduler semantics.
    maintenancePending = false; lastMaintenanceEpoch = maintenanceEpoch; maintenanceArmed = false;
  });
  pi.on?.("session_compact_failed", () => {
    nativeCompactionImminent = false;
    maintenancePending = false; lastMaintenanceEpoch = maintenanceEpoch; maintenanceArmed = false;
  });
  pi.on?.("context", (_event: any, ctx: any) => {
    if (!proactivePolicy.enabled) return;
    const percent = ctx.getContextUsage?.()?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    if (percent < proactivePolicy.threshold_percent!) {
      if (!maintenanceArmed) { maintenanceEpoch++; maintenanceArmed = true; }
      maintenancePending = false;
    } else if (maintenanceArmed && maintenanceEpoch > lastMaintenanceEpoch) maintenancePending = true;
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
    return { entries: [...event.entries, ...collected.edits, ...boardEntries, { type: "custom", customType: "pi-harness-context-maintenance", data: { version: 1, context_edits: collected.edits.length, situation_board_edits: boardEntries.length, gc_bytes_removed: collected.bytesRemoved, gc_entries_superseded_by_task: collected.gcEntries.task, gc_entries_superseded_by_operation: collected.gcEntries.operation, gc_entries_superseded_by_mission: collected.gcEntries.mission } }] };
  };
  pi.on?.("turn_end", maintainContext);
  pi.on?.("agent_before_settle", maintainContext);
  pi.on?.("agent_settled", (_event: any, ctx: any) => { continuationQueued = false; latestContextTelemetry = collectContextTelemetry(ctx.sessionManager?.getEntries?.() ?? [], ctx.getContextUsage?.()); pi.appendEntry?.("pi-harness-context-telemetry", latestContextTelemetry); continueGoal(); });
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
  pi.on?.("session_shutdown", () => { sessionEnding = true; });

  pi.registerCommand?.("harness-context", { description: "Show context/cache/GC usage; missing provider metrics stay unknown", handler: async (_args: string, ctx: any) => {
    latestContextTelemetry = collectContextTelemetry(ctx.sessionManager?.getEntries?.() ?? [], ctx.getContextUsage?.());
    say(ctx, JSON.stringify(latestContextTelemetry));
  }});

  pi.registerCommand?.("harness-compact", { description: "Harness context maintenance: /harness-compact set <50-90>|status|disable (independent of /autocompact)", handler: async (args: string, ctx: Context) => {
    const input = args.trim();
    if (!input || input === "status") return say(ctx, `Harness context maintenance: ${proactivePolicy.enabled ? `enabled at ${proactivePolicy.threshold_percent}%` : "disabled"}${proactivePolicy.threshold_percent === null ? " (no threshold set)" : `; threshold ${proactivePolicy.threshold_percent}%`}.`);
    try {
      if (input === "disable") { proactivePolicy = { ...proactivePolicy, enabled: false }; maintenancePending = false; }
      else if (input.startsWith("set ")) { proactivePolicy = setProactiveThreshold(input.slice(4).trim()); maintenancePending = false; maintenanceArmed = true; maintenanceEpoch++; }
      else throw new Error("Use /harness-compact set <50-90>, status, or disable.");
      pi.appendEntry?.(PROACTIVE_COMPACT_ENTRY, proactivePolicy);
      say(ctx, `Harness context maintenance ${proactivePolicy.enabled ? `set to ${proactivePolicy.threshold_percent}%` : "disabled"}. Pi-native auto-compaction is unchanged.`);
    } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("plan", { description: "Read-only planning: /plan on|off|status", handler: async (args: string, ctx: Context) => {
    try { const action = parsePlan(args); if (action === "status") say(ctx, `Plan mode: ${plan.enabled ? "on" : "off"}`); else setPlan(action === "on", ctx); } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("goal", { description: "Manage one evidence-backed goal", handler: async (args: string, ctx: Context) => {
    const input = args.trim();
    if (input === "status") return say(ctx, goal ? `${goal.status}: ${goal.objective}` : "No goal.");
    if (input === "cancel") return cancelGoal(ctx);
    if (plan.enabled) return say(ctx, "Disable plan mode before starting a goal.", "warning");
    if (goal?.status === "active") return say(ctx, "An active goal already exists; use /goal status or /goal cancel.", "warning");
    try {
      goal = goalState(input); goalGroupId = randomUUID(); continuationCount = 0; invalidTerminalAttempts = 0;
      const mission_id = `M-${randomUUID()}`;
      missions = { ...missions, [mission_id]: createMission({ mission_id, objective: goal.objective }) };
      maintenancePending = true;
      persistMission(); persistScheduler(); persist(); if (ctx.isIdle?.() !== false) maintenancePending = false; say(ctx, `Goal active: ${goal.objective}`); continueGoal();
    } catch (error) { say(ctx, (error as Error).message, "error"); }
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
    name: "pi_harness_goal", label: "Pi Harness goal",
    description: "Record the terminal state of the active goal. Evidence is mandatory; blocked and error also require a blocker.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("error")]), evidence: Type.String(), blocker: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { status: "complete" | "blocked" | "error"; evidence: string; blocker?: string }) => {
      const activeMission = Object.values(missions).find((mission: any) => mission.status === "active" && mission.objective === goal?.objective) as any;
      if (input.status === "complete" && activeMission && !missionIsClosable(activeMission, operations, taskGraphs, attemptLedger)) throw new Error("The Mission has unresolved obligations");
      goal = transitionGoal(goal, input.status, input.evidence, input.blocker);
      if (activeMission) missions = { ...missions, [activeMission.mission_id]: createMission({ ...activeMission, status: goal.status }) };
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
    description: "Create, terminalize, or read a bounded Commander-safe Operation summary. Only the Harness Coordinator may dispatch TaskOrders, accept or reject TaskResults, or accept Operation Acceptance Criteria. Operation completion never completes the Mission.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("status"), Type.Literal("supersede"), Type.Literal("waive"), Type.Literal("transfer"), Type.Literal("waive_operation")]), operation_id: Type.String(), objective: Type.Optional(Type.String()), acceptance_criteria: Type.Optional(Type.Array(Type.String())), allowed_policy_ids: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), task_id: Type.Optional(Type.String()), replacement_operation_id: Type.Optional(Type.String()), replacement_task_id: Type.Optional(Type.String()), authority_type: Type.Optional(Type.Union([Type.Literal("commander"), Type.Literal("user")])), reason: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { action: "create" | "status" | "supersede" | "waive" | "transfer" | "waive_operation"; operation_id: string; objective?: string; acceptance_criteria?: string[]; allowed_policy_ids?: string[]; constraints?: string[]; task_id?: string; replacement_operation_id?: string; replacement_task_id?: string; authority_type?: "commander" | "user"; reason?: string }) => {
      const id = input.operation_id;
      const action = input.action as string;
      if (!["create", "status", "supersede", "waive", "transfer", "waive_operation"].includes(action)) throw new Error("Only the Harness Coordinator may accept or reject a TaskResult or Operation Acceptance Criterion");
      if (activeOperationRuns.has(id)) throw new Error("The Operation is running. The Commander must wait for the bounded OperationReport.");
      if (action === "create") {
        if (Object.hasOwn(operations, id)) throw new Error("Operation ID already exists");
        // Persisted and direct-program legacy callers can still restore a static Operation.
        // The public schema does not expose this compatibility path.
        const legacy = input as any;
        const activeMissions = Object.values(missions).filter((entry: any) => entry.status === "active") as any[];
        if (activeMissions.length !== 1) throw new Error("Operation creation requires one active Mission");
        const mission = activeMissions[0];
        const operation = legacy.required_task_ids !== undefined
          ? createOperation({ operation_id: id, mission_id: mission.mission_id, objective: input.objective, required_task_ids: legacy.required_task_ids, acceptance_criteria: input.acceptance_criteria, dependencies: legacy.dependencies, constraints: input.constraints, task_intents: legacy.task_intents, task_specs: legacy.task_specs })
          : createOperation({ operation_id: id, mission_id: mission.mission_id, objective: input.objective, acceptance_criteria: input.acceptance_criteria, allowed_policy_ids: input.allowed_policy_ids ?? ["research-read", "scout-read", "worker-write"], constraints: input.constraints, planning: true });
        if (!operation.planning && operation.required_task_ids.some((taskId: string) => Object.values(operations).some((entry: any) => entry.required_task_ids?.includes(taskId)))) throw new Error("A TaskOrder ID already belongs to another Operation");
        const graph = createTaskGraph(operation);
        const registry = createHeadRegistry(operation, legacy.required_task_ids !== undefined ? (legacy.heads ?? []) : []);
        headRegistries = { ...headRegistries, [id]: registry };
        pi.appendEntry?.(HEAD_REGISTRY_ENTRY, headRegistries);
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
      if (["transfer", "waive_operation"].includes(action)) {
        if (!input.authority_type || !input.reason?.trim()) throw new Error("Operation terminal disposition requires authority type and reason");
        const status = action === "transfer" ? "transferred" : "waived";
        operations = { ...operations, [id]: terminalizeOperation(operation, taskGraphs[id], { status, authority_type: input.authority_type, reason: input.reason }) };
        persistScheduler();
        return { content: [{ type: "text", text: JSON.stringify({ version: 1, mission_id: operation.mission_id, operation_id: id, status, situation_board: missionBoard() }) }] };
      }
      if (["supersede", "waive"].includes(action)) {
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
      if (operation.planning) return { content: [{ type: "text", text: JSON.stringify({ version: 1, mission_id: operation.mission_id, operation_id: id, status: "open", planning: true, summary: "The Operation awaits Coordinator plan_tasks materialization. No TaskOrder is available.", situation_board: missionBoard() }) }] };
      const blocked_task_ids = operation.required_task_ids.filter((taskId: string) => taskGraphs[id].nodes[taskId].scheduler_status === "blocked");
      const blockers = blocked_task_ids.map((taskId: string) => {
        const { blocked_action, required_condition } = taskGraphs[id].nodes[taskId].blocker;
        return { task_id: taskId, blocked_action, required_condition };
      });
      const summary = operation.status === "complete"
        ? "The Coordinator accepted the Operation. The Commander must evaluate the Mission Definition of Done."
        : "The Operation remains open. The Commander must start or resume the Harness Coordinator.";
      return { content: [{ type: "text", text: JSON.stringify({ version: 1, mission_id: operation.mission_id, operation_id: id, status: operation.status, summary, blocked_task_ids, blockers, situation_board: missionBoard() }) }] };
    },
  });
  pi.registerTool?.({
    name: "pi_harness_run_operation", label: "Pi Harness run Operation",
    description: "Run a serial Harness-controlled Coordinator loop. Return only a bounded OperationReport to the Commander.",
    parameters: Type.Object({ operation_id: Type.String(), model: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { operation_id: string; model?: string }, signal?: AbortSignal, _onUpdate?: any, ctx?: any) => {
      const runCwd = ctx?.cwd ?? process.cwd();
      const id = input.operation_id;
      const operation = Object.hasOwn(operations, id) ? operations[id] : undefined;
      if (!operation || operation.status !== "open" || activeOperationRuns.size) throw new Error("An open Operation and an idle serial Scheduler are required");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
      const runId = randomUUID();
      const runEpoch = sessionEpoch;
      activeOperationRuns.set(id, { controller, goalGroup: goal?.status === "active" ? goalGroupId : undefined });
      const save = (nextOperation: ReturnType<typeof createOperation>, state: ReturnType<typeof coordinatorState>, graph: ReturnType<typeof createTaskGraph>, nextHeads: Record<string, any>) => {
        if (runEpoch !== sessionEpoch) return;
        validateTaskGraph(graph, nextOperation);
        operations = { ...operations, [id]: nextOperation };
        taskGraphs = { ...taskGraphs, [id]: graph };
        coordinatorStates = { ...coordinatorStates, [id]: state };
        headStates = { ...headStates, [id]: nextHeads };
        pi.appendEntry?.(HEAD_STATE_ENTRY, headStates);
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
          headTurn: (prompt: string) => executeCoordinatorTurn(pi, prompt, { cwd: runCwd, onUsage: (usage: any) => recordUsage(usage, { role: "head" }), role: "head", groupId: runId, signal: controller.signal }),
          dispatch: async (task: any, progress: any) => promoteTaskResult(await executeCoordinateTask(pi, validateTask(task), { cwd: runCwd, groupId: runId, signal: controller.signal, modelRegistry: ctx?.modelRegistry,
            onVerificationStart: progress.onVerificationStart, timeout: managedTaskTimeout(task.owner), reviewerTimeout: managedTaskTimeout("reviewer"), onUsage: (usage: any, provenance: Record<string, any>) => recordUsage(usage, { task_id: task.task_id, ...provenance }) })),
          save,
        }, { state: coordinatorStates[id] ?? coordinatorState(operation), graph: taskGraphs[id], registry: headRegistries[id], headStates: headStates[id] ?? {}, mission: operations[id].mission_id ? { mission_id: operations[id].mission_id, objective: missions[operations[id].mission_id]?.objective } : goal?.status === "active" ? goal.objective : undefined, cwd: runCwd, onUsage: recordUsage, signal: controller.signal, parallelLimit });
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
      } finally { signal?.removeEventListener("abort", abort); if (activeOperationRuns.get(id)?.controller === controller) activeOperationRuns.delete(id); }
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
