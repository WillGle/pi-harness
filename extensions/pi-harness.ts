import {
  COMPACT_ENTRY, GOAL_ENTRY, PLAN_ENTRY, READ_ONLY_TOOLS, cavemanSummary, goalState,
  isPlanAllowedTool, parsePlan, planState, restore, transitionGoal,
} from "../lib/state.mjs";
import { executeWorkerTask, runWorkerChild, startChild, terminateChildren, validateTask, workerWorktree } from "../lib/coordinator.mjs";
import { Type } from "typebox";

type Context = { ui?: { notify?: (message: string, level: "info" | "warning" | "error") => void }; abort?: () => void };
type Pi = Record<string, any>;

const HARNESS_TOOLS = new Set(["pi_harness_goal", "pi_harness_coordinate"]);

export default function harness(pi: Pi): void {
  let plan = planState();
  let goal: ReturnType<typeof goalState> | undefined;
  let savedTools: string[] | undefined;
  let continuationQueued = false;

  const say = (ctx: Context, message: string, level: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(message, level);
  const persist = () => {
    pi.appendEntry?.(PLAN_ENTRY, plan);
    if (goal) pi.appendEntry?.(GOAL_ENTRY, goal);
  };
  const saveCompactState = (event: Record<string, unknown> = {}) => pi.appendEntry?.(COMPACT_ENTRY, cavemanSummary({
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
    if (goal?.status === "active") goal = transitionGoal(goal, "cancelled");
    continuationQueued = false;
    terminateChildren();
    ctx.abort?.();
    persist();
    say(ctx, "Goal cancelled; queued continuation and Pi children were aborted.");
  };
  const continueGoal = () => {
    if (!goal || goal.status !== "active" || continuationQueued || plan.enabled) return;
    continuationQueued = true;
    pi.sendUserMessage?.(`[GOAL ACTIVE] ${goal.objective}\nContinue until you call pi_harness_goal with a terminal state and concrete evidence.`, { deliverAs: "followUp" });
  };

  pi.on?.("session_start", (_event: any, ctx: any) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    plan = restore(entries, PLAN_ENTRY) ?? plan;
    goal = restore(entries, GOAL_ENTRY) ?? goal;
    if (plan.enabled) setPlan(true, ctx);
  });
  pi.on?.("tool_call", (event: any) => {
    if (!plan.enabled) return;
    if (HARNESS_TOOLS.has(event.toolName) || !isPlanAllowedTool(event.toolName, event.input)) {
      return { block: true, reason: event.toolName === "bash" ? "Plan mode rejects this bash syntax." : "Plan mode is read-only. Run /plan off before using this tool." };
    }
  });
  pi.on?.("session_before_compact", (event: any) => { saveCompactState(event); return { customInstructions: "Use the pi-harness compact state (caveman-v1). Preserve goal, plan, decisions, changed files, gates, and blocker exactly.", replaceInstructions: false }; });
  pi.on?.("context", (_event: any, ctx: any) => { if (Number(ctx.getContextUsage?.()?.percent ?? 0) >= 80) { saveCompactState(); ctx.compact?.({ customInstructions: "Use the pi-harness compact state (caveman-v1). Preserve goal, plan, decisions, changed files, gates, and blocker exactly." }); } });
  pi.on?.("agent_settled", () => { continuationQueued = false; continueGoal(); });
  pi.on?.("before_agent_start", () => plan.enabled ? { message: { customType: "pi-harness-plan-context", display: false, content: "[PLAN MODE: READ ONLY]\nGather context. Return assumptions, numbered steps, and verification criteria. Do not edit or delegate workers." } } : undefined);

  pi.registerCommand?.("plan", { description: "Read-only planning: /plan on|off|status", handler: async (args: string, ctx: Context) => {
    try { const action = parsePlan(args); if (action === "status") say(ctx, `Plan mode: ${plan.enabled ? "on" : "off"}`); else setPlan(action === "on", ctx); } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("goal", { description: "Manage one evidence-backed goal", handler: async (args: string, ctx: Context) => {
    const input = args.trim();
    if (input === "status") return say(ctx, goal ? `${goal.status}: ${goal.objective}` : "No goal.");
    if (input === "cancel") return cancelGoal(ctx);
    if (plan.enabled) return say(ctx, "Disable plan mode before starting a goal.", "warning");
    if (goal?.status === "active") return say(ctx, "An active goal already exists; use /goal status or /goal cancel.", "warning");
    try { goal = goalState(input); persist(); say(ctx, `Goal active: ${goal.objective}`); continueGoal(); } catch (error) { say(ctx, (error as Error).message, "error"); }
  }});
  pi.registerCommand?.("skill-hub", { description: "Show the pinned curated-skill boundary", handler: async (_args: string, ctx: Context) => {
    say(ctx, "Curated skills are checksum-pinned. Do not install an additional skill without an explicit user request.");
  }});

  pi.registerTool?.({
    name: "pi_harness_goal", label: "Pi Harness goal",
    description: "Record the terminal state of the active goal. Evidence is mandatory; blocked and error also require a blocker.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("error")]), evidence: Type.String(), blocker: Type.Optional(Type.String()) }),
    execute: async (_id: string, input: { status: "complete" | "blocked" | "error"; evidence: string; blocker?: string }) => {
      goal = transitionGoal(goal, input.status, input.evidence, input.blocker); continuationQueued = false; persist();
      return { content: [{ type: "text", text: JSON.stringify({ status: goal.status, evidence: goal.evidence, blocker: goal.blocker }) }] };
    },
  });
  pi.registerTool?.({
    name: "pi_harness_coordinate", label: "Pi Harness coordinator",
    description: "Start a bounded scout, research, or worker task. Worker changes remain in a temporary worktree and are never integrated automatically.",
    parameters: Type.Object({ owner: Type.Union([Type.Literal("scout"), Type.Literal("research"), Type.Literal("worker")]), scope: Type.String(), verification: Type.String(), permission: Type.Union([Type.Literal("read"), Type.Literal("write")]) }),
    execute: async (_id: string, input: { owner: "scout" | "research" | "worker"; scope: string; verification: string; permission: "read" | "write" }) => {
      const task = validateTask(input);
      if (task.owner === "worker") {
        const result = await executeWorkerTask(process.cwd(), task, (worktreePath: string) => runWorkerChild(task, { cwd: worktreePath }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                owner: task.owner,
                scope: task.scope,
                verification: task.verification,
                worktree: result.worktreePath,
                branch: result.branch,
                success: result.success,
                gatePassed: result.gatePassed,
                commitCheck: result.commitCheck,
                diff: result.diff,
                integration: result.integration,
              }),
            },
          ],
        };
      }
      const child = startChild(task, { cwd: process.cwd() });
      return { content: [{ type: "text", text: JSON.stringify({ owner: task.owner, scope: task.scope, verification: task.verification, integration: "read-only task" }) }] };
    },
  });
}
