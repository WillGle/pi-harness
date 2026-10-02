import { randomUUID } from "node:crypto";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { acquireControlLease, assertControlLease, readControlState, writeControlState } from "../lib/control-state-store.mjs";
import { acceptWorkTask, addWorkTask, claimWorkTask, createWork, failWorkTask, finishWork, recordWorkChild, recordWorkResult, restoreWorks, updateWorkTask, validateWorks, workSituation, WORK_ENTRY } from "../lib/work.mjs";
import { cancelTasks, executeTask, hasActiveTasks, inspectChild, managedTaskTimeout } from "../lib/executor.mjs";
import { contextTelemetry, installStablePrompt, stablePromptSections } from "../lib/context-economics.mjs";
import { PLAN_ENTRY, READ_ONLY_TOOLS, isPlanAllowedTool, parsePlan, planState, restore } from "../lib/plan.mjs";
import { appendProjectMemory, clearProjectMemory, loadProjectMemory } from "../lib/memory.mjs";
import { findReferences, findSymbol } from "../lib/code-intel.mjs";
import { readHashlines, replaceHashlines } from "../lib/precise-edit.mjs";
import { buildStatusViewModel, formatExpandedStatus, formatStatusFooter } from "../lib/status-view-model.mjs";
import { readEvidence } from "../lib/evidence.mjs";
import { safeFailureCode } from "../lib/failure-codes.mjs";
import { assertSupportedPlatform } from "../lib/platform.mjs";
import { inspectProcessOwner } from "../lib/process-owner.mjs";

type Pi = Record<string, any>;
type Context = Record<string, any>;
const PACKAGE_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"]);
const MAX_CONTINUATIONS = 25;

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
  let works: Record<string, any> = {}, selectedId: string | undefined;
  let plan = planState(), lease: any, cwd = process.cwd(), epoch = 0, legacyState = false;
  let savedTools: string[] | undefined, continuations = 0, continuationQueued = false;
  let contextUsage: any, telemetry: any, runtime: any = {}, statusTui: any;
  let piCompacting = false;
  let status = buildStatusViewModel();
  const runs = new Map<string, { controller: AbortController; group: string }>();
  const say = (ctx: Context, text: string) => ctx.ui?.notify?.(text, "info");
  const selected = () => selectedId ? works[selectedId] : undefined;
  const refresh = () => {
    const next = buildStatusViewModel({ works, selectedWorkId: selectedId, contextUsage, telemetry, runtime, piCompacting });
    const changed = JSON.stringify(next) !== JSON.stringify(status); status = next;
    if (changed) statusTui?.requestRender();
  };
  const capture = (ctx: Context) => {
    contextUsage = ctx.getContextUsage?.();
    runtime = { modelDisplayName: ctx.model?.name ?? ctx.model?.id, effort: ctx.thinkingLevel }; refresh();
  };
  const save = () => {
    validateWorks(works);
    if (lease) writeControlState({ works }, lease, cwd);
    pi.appendEntry?.(WORK_ENTRY, works); pi.appendEntry?.(PLAN_ENTRY, plan); refresh();
  };
  const own = async (ctx: Context) => {
    if ((ctx.cwd ?? cwd) !== cwd) throw new Error("Start a new Pi session before changing the project directory");
    if (legacyState) throw new Error("Saved Mission/Operation state is preserved read-only. Resolve or archive it using the prior Harness before starting managed work.");
    if (lease) assertControlLease(lease, cwd);
    else {
      lease = await acquireControlLease(cwd);
      const latest = readControlState(cwd);
      if (latest && !Object.hasOwn(latest, "works")) { legacyState = true; throw new Error("Legacy state is preserved read-only; use the prior Harness to resolve or archive it."); }
      if (latest) works = restoreWorks(latest.works);
    }
  };
  const active = () => {
    const work = selected();
    if (!work || work.status !== "active" || !lease) throw new Error("Start work or explicitly resume its ID before changing it");
    assertControlLease(lease, cwd); return work;
  };
  const continueWork = () => {
    const work = selected();
    if (!work || work.status !== "active" || plan.enabled || continuationQueued || runs.size) return;
    if (continuations >= MAX_CONTINUATIONS) {
      works = { ...works, [work.work_id]: finishWork(work, "blocked", "The automatic continuation allowance was exhausted.", "Resume this work explicitly to continue.") };
      save(); return;
    }
    continuations++; continuationQueued = true;
    pi.sendUserMessage?.("[PI_HARNESS_WORK_CONTINUE]\n" + workSituation(work) + "\nYou are the Commander. Continue against the original objective. Delegate only when useful. Review results before accepting them. Complete or report blocked work with concrete Evidence.", { deliverAs: "followUp" });
  };
  const start = async (objective: string, constraints: string[], ctx: Context) => {
    if (plan.enabled || runs.size || hasActiveTasks() || selected()?.status === "active") throw new Error("Finish or cancel active work and disable plan mode before starting new work");
    await own(ctx); const work = createWork(objective, constraints);
    selectedId = work.work_id; works = { ...works, [selectedId]: work }; continuations = 0; continuationQueued = false;
    save(); continueWork(); return work;
  };
  const cancel = () => {
    const selectedWork = selected();
    if (!selectedWork || !lease || !["active", "blocked", "error"].includes(selectedWork.status)) throw new Error("Select unfinished work before cancelling it");
    assertControlLease(lease, cwd); const work = { ...selectedWork, status: "active" };
    for (const run of runs.values()) run.controller.abort();
    works = { ...works, [work.work_id]: finishWork(work, "cancelled", "The Commander cancelled this work.") }; continuationQueued = false; save();
  };
  const setPlan = (enabled: boolean, ctx: Context) => {
    if (enabled) {
      savedTools ??= pi.getActiveTools?.() ?? [];
      pi.setActiveTools?.((savedTools.length ? savedTools : [...READ_ONLY_TOOLS]).filter((name: string) => READ_ONLY_TOOLS.has(name)));
    } else if (savedTools) { pi.setActiveTools?.(savedTools); savedTools = undefined; }
    plan = planState(enabled, plan.plan); save(); say(ctx, "Plan mode " + (enabled ? "enabled (read-only)." : "disabled."));
  };
  const result = (value: any) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const view = (work: any, taskId?: string) => {
    if (!work) return { legacy_state: legacyState, summary: "No work selected. Use /work list or start new work." };
    if (taskId && !Object.hasOwn(work.tasks, taskId)) throw new Error("Unknown Task");
    const value: any = { work_id: work.work_id, objective: work.objective, constraints: work.constraints, status: work.status, blocker: work.blocker ?? null,
      tasks: Object.values(work.tasks).map((task: any) => ({ task_id: task.task_id, scope: task.assignment.scope, status: task.status, attempts: task.attempts.length })), omitted_tasks: 0 };
    if (taskId) value.task = work.tasks[taskId];
    while (Buffer.byteLength(JSON.stringify(value)) > 24_000 && value.tasks.length) { value.tasks.pop(); value.omitted_tasks++; }
    if (Buffer.byteLength(JSON.stringify(value)) > 24_000) throw new Error("Work detail exceeds the bounded status limit");
    return value;
  };
  pi.on?.("session_start", async (_event: any, ctx: Context) => {
    epoch++; for (const run of runs.values()) { run.controller.abort(); cancelTasks(run.group); } runs.clear();
    selectedId = undefined; continuationQueued = false; continuations = 0; statusTui = undefined; piCompacting = false;
    const previousLease = lease; lease = undefined; if (previousLease) await previousLease.release();
    cwd = ctx.cwd ?? process.cwd();
    const entries = ctx.sessionManager?.getEntries?.() ?? [], snapshot = readControlState(cwd);
    legacyState = (!!snapshot && !Object.hasOwn(snapshot, "works")) || (!snapshot && entries.some((entry: any) => ["pi-harness-mission-state", "pi-harness-task-graph-state", "pi-harness-operation-state"].includes(entry.customType)));
    works = restoreWorks(snapshot?.works ?? restore(entries, WORK_ENTRY) ?? {}); plan = restore(entries, PLAN_ENTRY) ?? planState();
    pi.setActiveTools?.((savedTools ?? pi.getActiveTools?.() ?? []).filter((name: string) => !PACKAGE_TOOLS.has(name))); savedTools = undefined;
    if (plan.enabled) setPlan(true, ctx);
    telemetry = contextTelemetry(entries, undefined); capture(ctx);
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui: any, theme: any) => ({ invalidate() {}, render(width: number) { return [truncateToWidth(theme.bold("π PI HARNESS") + " · Commander and workers", width)]; } }));
    ctx.ui.setFooter((tui: any, theme: any) => {
      statusTui = tui; return { dispose() { if (statusTui === tui) statusTui = undefined; }, invalidate() {}, render(width: number) { return formatStatusFooter(status, width, theme); } };
    });
  });
  pi.on?.("tool_call", (event: any) => {
    if (plan.enabled && !isPlanAllowedTool(event.toolName, event.input)) return { block: true, reason: "Plan mode is read-only. Run /plan off before changing or delegating work." };
  });
  pi.on?.("before_agent_start", (event: any, ctx: Context) => installStablePrompt(event, stablePromptSections({ memory: loadProjectMemory(ctx.cwd ?? cwd), plan: plan.enabled, work: selected() ? workSituation(selected()) : undefined })));
  pi.on?.("session_before_compact", () => { piCompacting = true; save(); return { customInstructions: "Preserve the original objective, constraints, pending Tasks, unknown outcomes, and checks actually run. Worker termination is not work completion." }; });
  for (const event of ["session_compact", "session_compact_failed"]) pi.on?.(event, () => { piCompacting = false; refresh(); });
  pi.on?.("context", (_event: any, ctx: Context) => capture(ctx));
  pi.on?.("model_select", (_event: any, ctx: Context) => capture(ctx));
  pi.on?.("thinking_level_select", (_event: any, ctx: Context) => capture(ctx));
  pi.on?.("agent_settled", (_event: any, ctx: Context) => { continuationQueued = false; telemetry = contextTelemetry(ctx.sessionManager?.getEntries?.() ?? [], ctx.getContextUsage?.()); capture(ctx); continueWork(); });
  pi.on?.("session_shutdown", async () => {
    epoch++; for (const run of runs.values()) { run.controller.abort(); cancelTasks(run.group); } runs.clear();
    if (lease) await lease.release(); lease = undefined;
  });
  const showStatus = async (ctx: Context) => {
    if (ctx.ui?.custom) return ctx.ui.custom((tui: any, theme: any, _keys: any, done: any) => new StatusOverlay(tui, theme, formatExpandedStatus(status).split("\n"), done));
    say(ctx, formatExpandedStatus(status));
  };
  pi.registerCommand?.("status", { description: "Show work and worker progress", handler: async (_args: string, ctx: Context) => showStatus(ctx) });
  pi.registerCommand?.("harness-context", { description: "Show work and context usage", handler: async (_args: string, ctx: Context) => showStatus(ctx) });
  pi.registerCommand?.("plan", { description: "Read-only planning: /plan on|off|status", handler: async (args: string, ctx: Context) => {
    const action = parsePlan(args); if (action === "status") return say(ctx, "Plan mode: " + (plan.enabled ? "on" : "off")); setPlan(action === "on", ctx);
  }});
  pi.registerCommand?.("goal", { description: "Start work from an objective, show status, or cancel", handler: async (args: string, ctx: Context) => {
    if (args.trim() === "status") return say(ctx, workSituation(selected()));
    if (args.trim() === "cancel") { cancel(); return say(ctx, "Work cancelled."); } await start(args.trim(), [], ctx);
  }});
  pi.registerCommand?.("work", { description: "Saved work: /work list|resume <id>|cancel", handler: async (args: string, ctx: Context) => {
    const [action, id, extra] = args.trim().split(/\s+/);
    if (action === "list") return say(ctx, legacyState ? "Legacy state is preserved read-only; inspect it with the prior Harness." : Object.values(works).map((work: any) => work.work_id + ": " + work.status + " — " + work.objective).join("\n") || "No saved work.");
    if (action === "cancel") { cancel(); return say(ctx, "Work cancelled."); }
    if (action !== "resume" || !id || extra || !Object.hasOwn(works, id) || ["complete", "cancelled"].includes(works[id].status)) throw new Error("Use /work list and resume one exact unfinished work ID");
    if (runs.size || hasActiveTasks()) throw new Error("Wait for the managed child to settle before resuming work");
    await own(ctx);
    if (!works[id] || ["complete", "cancelled"].includes(works[id].status)) throw new Error("Saved work was closed before this session acquired ownership");
    selectedId = id; works = { ...works, [id]: { ...works[id], status: "active" } }; continuations = 0; continuationQueued = false; save(); continueWork();
  }});
  pi.registerCommand?.("skill-hub", { description: "List available skills and invocation commands", handler: async (_args: string, ctx: Context) => {
    const skills = (pi.getCommands?.() ?? []).filter((command: any) => command.source === "skill");
    say(ctx, ["Skills are optional and explicitly invoked.", ...skills.map((skill: any) => `/${skill.name} — ${skill.description ?? ""}`)].join("\n"));
  } });
  pi.registerCommand?.("learn", { description: "Private project memory: /learn <note>|status|clear", handler: async (args: string, ctx: Context) => {
    const input = args.trim(); if (!input || input === "status") return say(ctx, loadProjectMemory(ctx.cwd ?? cwd) ?? "No memory saved for this project.");
    if (["clear", "reset"].includes(input)) { clearProjectMemory(ctx.cwd ?? cwd); return say(ctx, "Project memory cleared."); }
    say(ctx, "Learned: " + appendProjectMemory(input, ctx.cwd ?? cwd).note);
  }});
  pi.registerTool?.({ name: "pi_harness_status", label: "Pi Harness status", description: "Read cached work, worker and context status", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: formatExpandedStatus(status) }] }) });
  pi.registerTool?.({ name: "pi_harness_start_work", label: "Start work", description: "Keep the original objective and constraints for work that benefits from delegation. Small work can be done directly.",
    parameters: Type.Object({ objective: Type.String({ maxLength: 8_000 }), constraints: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 })) }),
    execute: async (_id: string, input: any, _signal: any, _update: any, ctx: Context = {}) => result(view(await start(input.objective, input.constraints ?? [], ctx))) });
  pi.registerTool?.({ name: "pi_harness_delegate", label: "Delegate work", description: "Delegate one Task directly, with scope and criteria tied to the original objective. Choose a Worker check; independent review is optional. No Coordinator or full plan is required.",
    parameters: Type.Object({ scope: Type.String({ maxLength: 500 }), owner: Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("research")]),
      verification: Type.Optional(Type.String({ maxLength: 500 })), acceptance_criteria: Type.Array(Type.String({ maxLength: 500 }), { minItems: 1, maxItems: 32 }),
      dependencies: Type.Optional(Type.Array(Type.String())), review: Type.Optional(Type.Boolean()), retry_task_id: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: any, signal?: AbortSignal, _update?: any, ctx: Context = {}) => {
      if (plan.enabled) throw new Error("Disable plan mode before delegating work");
      let work = active();
      if (runs.size || hasActiveTasks() || Object.values(work.tasks).some((task: any) => task.status === "unknown")) throw new Error("Resolve or wait for the prior child outcome before dispatching work");
      let taskId = input.retry_task_id;
      if (!taskId) {
        const added = addWorkTask(work, { owner: input.owner, scope: input.scope, permission: input.owner === "worker" ? "write" : "read",
          verification: input.verification ?? (input.owner === "worker" ? "git diff --check" : "The Commander reviews the report against the Task criteria."), acceptance_criteria: input.acceptance_criteria }, input.dependencies ?? [], input.review ?? false);
        work = added.work; taskId = added.task_id;
      }
      work = claimWorkTask(work, taskId); works = { ...works, [work.work_id]: work }; save();
      const controller = new AbortController(), group = randomUUID(), runEpoch = epoch, abort = () => controller.abort();
      if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
      runs.set(taskId, { controller, group }); refresh();
      const commit = (next: any) => { if (runEpoch !== epoch) throw new Error("Task session changed; its outcome remains unknown"); works = { ...works, [work.work_id]: next }; save(); };
      try {
        const task = work.tasks[taskId];
        const record = await executeTask(pi, { ...task.assignment, task_id: taskId, operation_id: work.work_id,
          constraints: [...work.constraints, "Original user objective: " + work.objective] }, { cwd, groupId: group, signal: controller.signal, modelRegistry: ctx.modelRegistry,
          timeout: managedTaskTimeout(task.assignment.owner), review: task.review,
          onChildStarted: (reference: any) => commit(recordWorkChild(works[work.work_id], taskId, reference)),
          onUsage: (usage: any, provenance: any) => { if (runEpoch === epoch) pi.appendEntry?.("pi-harness-child-usage", { work_id: work.work_id, task_id: taskId, role: provenance.role, usage }); } });
        if (controller.signal.aborted) throw Object.assign(new Error("Task was cancelled"), { code: "HARNESS_CANCELLED", childSettled: true });
        const receipt = { ...record.taskResult, ...(typeof record.result === "string" ? { report: record.result.slice(0, 8_000) } : {}) };
        commit(recordWorkResult(works[work.work_id], taskId, receipt)); return result(view(works[work.work_id], taskId));
      } catch (error: any) {
        if (runEpoch !== epoch) throw new Error("Task session changed; inspect the saved unknown outcome before retrying");
        const children = works[work.work_id].tasks[taskId].attempts.at(-1).children;
        const settled = (error.childSettled === true || error.childOutcome === "spawn_rejected")
          && children.every((child: any) => inspectChild(child.child_id).state === "terminal");
        commit(failWorkTask(works[work.work_id], taskId, { notStarted: error.childOutcome === "not_started", settled, failure_code: safeFailureCode(error.code), child_disposition: error.child_disposition }));
        return result(view(works[work.work_id], taskId));
      } finally { signal?.removeEventListener("abort", abort); if (runs.get(taskId)?.controller === controller) runs.delete(taskId); refresh(); }
    } });
  pi.registerTool?.({ name: "pi_harness_work", label: "Review work", description: "Inspect a Task, accept or reject a result with concrete Commander review, resolve unknown children using exact terminal observations, or cancel work.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("accept"), Type.Literal("reject"), Type.Literal("resolve"), Type.Literal("cancel")]), task_id: Type.Optional(Type.String()), evidence: Type.Optional(Type.String({ maxLength: 1_000 })) }),
    execute: async (_id: string, input: any) => {
      if (input.action === "status") return result(view(selected(), input.task_id));
      if (plan.enabled) throw new Error("Disable plan mode before changing work");
      if (input.action === "cancel") { cancel(); return result(view(selected())); }
      let work = active();
      if (runs.size) throw new Error("Wait for execution before reviewing work");
      const task = work.tasks[input.task_id]; if (!task) throw new Error("Unknown Task");
      if (input.action === "accept") {
        for (const ref of task.attempts.at(-1)?.result?.evidence_refs ?? []) {
          const item = readEvidence(ref, cwd); if (item.metadata.task_id !== task.task_id || item.metadata.operation_id !== work.work_id) throw new Error("Evidence belongs to another Task");
        }
        work = acceptWorkTask(work, task.task_id, input.evidence);
      } else if (input.action === "reject") {
        if (task.status !== "result_available" || typeof input.evidence !== "string" || !input.evidence.trim()) throw new Error("Rejection needs an available result and concrete Commander review");
        work = updateWorkTask(work, task.task_id, { status: "failed", rejection: input.evidence, attempts: [...task.attempts.slice(0, -1), { ...task.attempts.at(-1), status: "failed" }] });
      } else if (input.action === "resolve") {
        const attempt = task.attempts.at(-1); if (task.status !== "unknown") throw new Error("Resolution requires an unknown Task");
        const owner = inspectProcessOwner(attempt.owner);
        const observations = attempt.children.map((child: any) => {
          const observed = inspectChild(child.child_id);
          return { ...child, ...(observed.state === "unavailable" ? owner : observed) };
        });
        if (!observations.length) observations.push(owner);
        if (observations.some((observation: any) => observation.state !== "terminal")) throw new Error("Active or unavailable children remain unknown");
        work = updateWorkTask(work, task.task_id, { status: "failed", attempts: [...task.attempts.slice(0, -1), { ...attempt, status: "failed", resolutions: observations }] });
      } else throw new Error("Unknown work action");
      works = { ...works, [work.work_id]: work }; save(); return result(view(work, input.task_id));
    } });
  pi.registerTool?.({ name: "pi_harness_goal", label: "Complete work", description: "Record completion or a blocker after checking the original objective. Every delegated Task must be accepted before completion. Evidence is mandatory.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("error")]), evidence: Type.String({ maxLength: 2_000 }), blocker: Type.Optional(Type.String({ maxLength: 1_000 })) }),
    execute: async (_id: string, input: any) => { if (plan.enabled || runs.size || hasActiveTasks()) throw new Error("Wait for execution to settle before completing work"); const work = active(); works = { ...works, [work.work_id]: finishWork(work, input.status, input.evidence, input.blocker) }; save(); return result(view(selected())); } });
  pi.registerTool?.({ name: "pi_harness_hashlines", label: "Pi Harness hashlines", description: "Read a bounded block with hashes for precise editing", parameters: Type.Object({ path: Type.String(), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }) }), execute: async (_id: string, input: any) => result(readHashlines(cwd, input.path, input.start_line, input.end_line)) });
  pi.registerTool?.({ name: "pi_harness_patch", label: "Pi Harness precise patch", description: "Replace a previously read block only if its SHA-256 matches", parameters: Type.Object({ path: Type.String(), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }), expected_sha256: Type.String(), replacement: Type.String() }), execute: async (_id: string, input: any) => { if (plan.enabled) throw new Error("Plan mode is read-only"); return result(replaceHashlines(cwd, input.path, input.start_line, input.end_line, input.expected_sha256, input.replacement)); } });
  pi.registerTool?.({ name: "pi_harness_find_symbol", label: "Pi Harness find symbol", description: "Find symbol declarations with a labeled text fallback", parameters: Type.Object({ symbol: Type.String() }), execute: async (_id: string, input: any) => result(findSymbol(cwd, input.symbol)) });
  pi.registerTool?.({ name: "pi_harness_references", label: "Pi Harness references", description: "Find references with a labeled text fallback", parameters: Type.Object({ symbol: Type.String() }), execute: async (_id: string, input: any) => result(findReferences(cwd, input.symbol)) });
}
