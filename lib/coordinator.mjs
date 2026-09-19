import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  normalizeWorkerResult,
  runWorkerVerification,
  truncateText,
} from "./worker-gate.mjs";

const RPC_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 120_000;
const activeTasks = new Map();

export function validateTask(task) {
  for (const key of ["owner", "scope", "verification", "permission"]) {
    if (!task?.[key]?.trim?.()) throw new Error(`Task requires ${key}`);
  }
  if (!["scout", "research", "worker"].includes(task.owner)) throw new Error("Unknown task owner");
  if (!["read", "write"].includes(task.permission)) throw new Error("Task permission must be read or write");
  if (task.owner !== "worker" && task.permission !== "read") throw new Error(`${task.owner} tasks are read-only`);
  return task;
}

function taskPrompt(task) {
  if (task.prompt?.trim?.()) return task.prompt;
  if (task.owner === "worker") {
    return [
      "Worker task:",
      `Scope: ${task.scope}`,
      `Verification: ${task.verification}`,
      "Work only in the assigned isolated worktree.",
      "Implement the scoped change and run the verification command.",
      "Leave the changes uncommitted; the package creates exactly one atomic commit with the required policy metadata.",
      "Do not merge or integrate the worker branch.",
    ].join("\n");
  }
  return [
    `${task.owner} task:`,
    `Scope: ${task.scope}`,
    `Evidence command: ${task.verification}`,
    "Inspect and report concise evidence only. Do not mutate the project.",
  ].join("\n");
}

function getEvents(pi) {
  if (!pi?.events?.on || !pi?.events?.emit) throw new Error("Pi subagent event bus is unavailable");
  return pi.events;
}

function requestRpc(pi, channel, payload, timeout = RPC_TIMEOUT_MS) {
  const events = getEvents(pi);
  const requestId = crypto.randomUUID();
  const replyChannel = `${channel}:reply:${requestId}`;

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const unsubscribe = events.on(replyChannel, (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (reply?.success === false) rejectPromise(new Error(reply.error || "Pi subagent request failed"));
      else resolvePromise(reply?.data);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      rejectPromise(new Error(`Timed out waiting for ${channel}`));
    }, timeout);

    try {
      events.emit(channel, { requestId, ...payload });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      rejectPromise(error);
    }
  });
}

function consumeResult(events, agentId) {
  try {
    // This is deliberately fire-and-forget. The selected package handles the
    // consume call synchronously inside its in-process RPC handler.
    events.emit("subagents:rpc:consume", { requestId: crypto.randomUUID(), agentId });
  } catch {
    // A missing package handler should not hide the worker result.
  }
}

function terminalWaiter(pi, timeout = TASK_TIMEOUT_MS) {
  const events = getEvents(pi);
  const terminalEvents = new Map();
  let expectedId;
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  let unsubscribeCompleted;
  let unsubscribeFailed;
  let timer;

  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  const finish = (value, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribeCompleted?.();
    unsubscribeFailed?.();
    if (error) rejectPromise(error);
    else {
      consumeResult(events, expectedId);
      resolvePromise(value);
    }
  };
  const handle = (event) => {
    if (!event?.id) return;
    terminalEvents.set(event.id, event);
    if (event.id === expectedId) finish(event);
  };
  unsubscribeCompleted = events.on("subagents:completed", handle);
  unsubscribeFailed = events.on("subagents:failed", handle);
  timer = setTimeout(() => finish(undefined, new Error(`Timed out waiting for subagent ${expectedId ?? "start"}`)), timeout);

  return {
    promise,
    setExpectedId(id) {
      expectedId = id;
      const existing = terminalEvents.get(id);
      if (existing) finish(existing);
    },
    cancel(error) {
      finish(undefined, error);
    },
  };
}

function managerRecord(agentId) {
  return globalThis[Symbol.for("pi-subagents:manager")]?.getRecord?.(agentId);
}

function baseSha(repo) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Failed to read repository HEAD: ${result.stderr?.trim() || "git rev-parse failed"}`);
  return result.stdout.trim();
}

function terminalSuccess(event) {
  return event?.status === "completed" || event?.status === "steered";
}

export function cancelCoordinateTasks(groupId) {
  if (!groupId) return 0;
  let cancelled = 0;
  for (const task of activeTasks.values()) {
    if (task.groupId !== groupId) continue;
    task.controller.abort();
    cancelled += 1;
  }
  return cancelled;
}

export async function executeCoordinateTask(pi, input, options = {}) {
  const task = validateTask(input);
  const repo = resolve(options.cwd ?? process.cwd());
  const base = task.owner === "worker" ? baseSha(repo) : undefined;
  const controller = new AbortController();
  const localTaskId = crypto.randomUUID();
  const active = { controller, groupId: options.groupId, agentId: undefined };
  activeTasks.set(localTaskId, active);
  const parentSignal = options.signal;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });

  let verification;
  const terminal = terminalWaiter(pi, options.timeout ?? TASK_TIMEOUT_MS);
  try {
    const spawnData = await requestRpc(pi, "subagents:rpc:spawn", {
      type: task.owner,
      prompt: taskPrompt(task),
      options: {
        description: task.owner === "worker"
          ? `${task.owner}: ${truncateText(task.scope, 40).text}\n\nScope: ${truncateText(task.scope, 40).text}\nReason: ${truncateText(task.verification, 40).text}`
          : `${task.owner}: ${truncateText(task.scope, 80).text}`,
        cwd: repo,
        model: task.model?.trim?.() || null,
        isBackground: true,
        isolation: task.owner === "worker" ? "worktree" : "off",
        signal: controller.signal,
        ...(task.owner === "worker"
          ? {
              onBeforeWorktreeCleanup: async (worktreePath) => {
                verification = runWorkerVerification(worktreePath, task, { projectRoot: repo });
              },
            }
          : {}),
      },
    }, options.rpcTimeout ?? RPC_TIMEOUT_MS);
    const agentId = spawnData?.id;
    if (!agentId) throw new Error("Pi subagent spawn returned no agent id");
    active.agentId = agentId;
    terminal.setExpectedId(agentId);
    const event = await terminal.promise;
    const record = managerRecord(agentId);

    if (task.owner === "worker") {
      return normalizeWorkerResult({
        repo,
        task,
        baseSha: base,
        event,
        record,
        verification,
      });
    }

    const agentResult = truncateText(event?.result ?? "", 8_000);
    return {
      owner: task.owner,
      model: task.model?.trim?.() || "Pi active model/default",
      scope: task.scope,
      verification: task.verification,
      success: terminalSuccess(event),
      status: event?.status,
      agentId,
      result: agentResult.text,
      resultTruncated: agentResult.truncated,
      integration: "read-only task",
    };
  } catch (error) {
    terminal.cancel(error);
    throw error;
  } finally {
    parentSignal?.removeEventListener?.("abort", abortFromParent);
    activeTasks.delete(localTaskId);
  }
}
