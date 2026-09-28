import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertSupportedPlatform } from "./platform.mjs";
import { taskOrder, formatTaskOrder, taskResult } from "./communication.mjs";
import { storeEvidence } from "./evidence.mjs";
import { reviewTask } from "./semantic-verifier.mjs";
import { semanticCriteria } from "./verifier.mjs";
import { isManagedWorkerBranch, safeChildDisposition } from "./child-disposition.mjs";
import {
  normalizeWorkerResult,
  runWorkerVerification,
  truncateText,
} from "./worker-gate.mjs";

const RPC_TIMEOUT_MS = 15_000;
const MAX_RPC_TIMEOUT_MS = 60_000;
// pi-subagents 0.19.0 can spend up to 30s creating a Worker worktree before
// its spawn RPC replies. Keep the late-reply listener beyond that startup bound.
const RPC_LATE_REPLY_GRACE_MS = 35_000;
const CHILD_ABORT_DRAIN_TIMEOUT_MS = 5_000;
const CHILD_CLEANUP_TIMEOUT_MS = 5_000;
export const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000;
export const MANAGED_WORKER_TERMINAL_TIMEOUT_MS = 300_000;
export const MAX_TERMINAL_TIMEOUT_MS = 300_000;
const activeTasks = new Map();

export function managedTaskTimeout(owner) {
  return owner === "worker" ? MANAGED_WORKER_TERMINAL_TIMEOUT_MS : DEFAULT_TERMINAL_TIMEOUT_MS;
}

function terminalBudget(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TERMINAL_TIMEOUT_MS) throw new Error("The child terminal budget must be a positive integer within the Harness maximum");
  return timeout;
}

function lateReplyBudget(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("The RPC late-reply grace must be a positive integer within the Harness maximum");
  return timeout;
}

function rpcBudget(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_RPC_TIMEOUT_MS) throw new Error("The RPC timeout must be a positive integer within the Harness maximum");
  return timeout;
}

export function securityReviewModel() {
  const model = process.env.PI_HARNESS_SECURITY_REVIEW_MODEL ?? "openai/gpt-daybreak-blue-latest";
  if (!/^[-\w.]+\/[-\w.]+$/.test(model) || model.length > 160) throw new Error("The configured security-reviewer model must be a bounded provider/model identifier.");
  return model;
}

export { validateTask } from "./task-spec.mjs";
import { validateTask } from "./task-spec.mjs";

function getEvents(pi) {
  if (!pi?.events?.on || !pi?.events?.emit) throw new Error("Pi subagent event bus is unavailable");
  return pi.events;
}

function requestRpc(pi, channel, payload, timeout = RPC_TIMEOUT_MS, lateReplyGrace = 0) {
  timeout = rpcBudget(timeout);
  const events = getEvents(pi);
  const requestId = crypto.randomUUID();
  const replyChannel = `${channel}:reply:${requestId}`;
  const signal = payload.options?.signal;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false, emitted = false, timer, lateReplyTimer, lateReplyResolve;
    const closeLateReply = () => {
      clearTimeout(lateReplyTimer);
      unsubscribe?.();
      lateReplyResolve?.(undefined);
      lateReplyResolve = undefined;
    };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = Object.assign(new Error("The child spawn handshake did not complete"), { code });
      if (emitted && lateReplyGrace > 0) {
        error.lateReply = new Promise(resolve => { lateReplyResolve = resolve; });
        error.closeLateReply = closeLateReply;
        lateReplyTimer = setTimeout(closeLateReply, lateReplyGrace);
      } else {
        unsubscribe?.();
        error.childOutcome = "spawn_rejected";
      }
      rejectPromise(error);
    };
    const abort = () => fail("HARNESS_CANCELLED");
    const unsubscribe = events.on(replyChannel, reply => {
      if (settled) {
        if (!lateReplyResolve) return;
        const resolve = lateReplyResolve;
        lateReplyResolve = undefined;
        clearTimeout(lateReplyTimer);
        unsubscribe?.();
        resolve(reply);
        return;
      }
      settled = true;
      cleanup();
      unsubscribe?.();
      if (reply?.success === false) rejectPromise(Object.assign(new Error("The child spawn failed"), { childOutcome: "spawn_rejected", code: "HARNESS_CHILD_SPAWN_FAILED" }));
      else resolvePromise(reply?.data);
    });
    timer = setTimeout(() => fail("HARNESS_RPC_TIMEOUT"), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    try { emitted = true; events.emit(channel, { requestId, ...payload }); }
    catch {
      if (settled) return;
      settled = true;
      cleanup(); unsubscribe?.();
      rejectPromise(Object.assign(new Error("The child spawn request failed"), { code: "HARNESS_CHILD_SPAWN_FAILED" }));
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

function terminalWaiter(pi, timeout = DEFAULT_TERMINAL_TIMEOUT_MS, controller) {
  terminalBudget(timeout);
  const events = getEvents(pi);
  const terminalEvents = new Map();
  let expectedId;
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  let unsubscribeCompleted;
  let unsubscribeFailed;
  let timer;
  let timerActive = false;

  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  // Spawn can fail before the caller awaits this promise; observe cancellation then.
  void promise.catch(() => {});
  const finish = (value, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    timer = undefined;
    timerActive = false;
    unsubscribeCompleted?.();
    unsubscribeFailed?.();
    controller.signal.removeEventListener("abort", onAbort);
    if (error) rejectPromise(error);
    else {
      consumeResult(events, expectedId);
      resolvePromise(value);
    }
  };
  const onAbort = () => finish(undefined, Object.assign(new Error("The child was cancelled"), { code: "HARNESS_CANCELLED" }));
  const handle = (event) => {
    if (!event?.id) return;
    terminalEvents.set(event.id, event);
    if (event.id === expectedId) finish(event);
  };
  unsubscribeCompleted = events.on("subagents:completed", handle);
  unsubscribeFailed = events.on("subagents:failed", handle);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const start = (budget) => {
    if (settled || timerActive) return;
    timerActive = true;
    timer = setTimeout(() => {
      // Settle before aborting: pi-subagents may emit a synchronous stopped
      // event, which must not replace the timeout outcome.
      finish(undefined, Object.assign(new Error(`Timed out waiting for subagent ${expectedId ?? "start"}`), { code: "HARNESS_CHILD_TERMINAL_TIMEOUT" }));
      controller.abort();
    }, terminalBudget(budget));
  };

  return {
    promise,
    start(budget = timeout) {
      start(budget);
    },
    pause() {
      if (!timerActive || settled) return;
      clearTimeout(timer);
      timer = undefined;
      timerActive = false;
    },
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

function createSpawnAttempt(active, activeTaskId) {
  let resolveSpawned;
  const spawned = new Promise((resolvePromise) => { resolveSpawned = resolvePromise; });
  const attempt = { active, activeTaskId, id: undefined, spawned, resolveSpawned, settlement: undefined };
  attempt.onSpawned = (id) => {
    if (attempt.id && attempt.id !== id) throw Object.assign(new Error("The spawn acknowledgement changed child identity"), { code: "HARNESS_LINEAGE_MISMATCH" });
    attempt.id = id;
    active.agentId = id;
    const child = managerRecord(id);
    if (!attempt.settlement && child?.promise && typeof child.promise.then === "function") {
      attempt.settlement = Promise.resolve(child.promise).then(() => true, () => true);
      if (active.keepOwnership) retainUntilSettled(attempt);
    }
    resolveSpawned(id);
  };
  attempt.onQueued = (id) => {
    attempt.onSpawned(id);
    const manager = globalThis[Symbol.for("pi-subagents:manager")];
    const record = manager?.getRecord?.(id);
    if (!attempt.settlement && record?.startGate && manager?.awaitStartup) {
      attempt.settlement = record.startGate.then(async () => {
        await manager.awaitStartup(id);
        const child = manager.getRecord(id);
        if (child?.promise) { await child.promise; return true; }
        return ["stopped", "aborted", "error"].includes(child?.status);
      }).catch(() => true);
      if (active.keepOwnership) retainUntilSettled(attempt);
    }
  };
  return attempt;
}

function retainUntilSettled(attempt) {
  if (attempt.monitorInstalled || !attempt.settlement) return;
  attempt.monitorInstalled = true;
  void attempt.settlement.then((confirmed) => {
    if (!confirmed) return;
    const { active, activeTaskId } = attempt;
    active.childSettled = true;
    if (activeTasks.get(activeTaskId) === active) activeTasks.delete(activeTaskId);
  });
}

function retainOwnership(attempt) {
  attempt.active.keepOwnership = true;
  retainUntilSettled(attempt);
}

function waitForChildSettlement(attempt, timeout) {
  if (!attempt.settlement) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeout);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    attempt.settlement.then((confirmed) => finish(confirmed === true));
  });
}

async function reconcileSpawnFailure(error, attempt) {
  if (!attempt) return;
  const lateReply = error?.lateReply;
  if (!lateReply) {
    if (attempt.id && !attempt.settlement) retainOwnership(attempt);
    return;
  }

  const outcome = await Promise.race([
    lateReply.then((reply) => ({ type: "reply", reply })),
    attempt.spawned.then((id) => ({ type: "spawned", id })),
  ]);
  if (outcome.type === "reply" && outcome.reply?.success === false && !attempt.id) {
    error.childOutcome = "spawn_rejected";
    return;
  }
  if (outcome.type === "reply" && outcome.reply?.success && outcome.reply.data?.id) attempt.onSpawned(outcome.reply.data.id);
  if (!attempt.id) {
    retainOwnership(attempt);
    return;
  }
  error.closeLateReply?.();
  if (!attempt.settlement || !await waitForChildSettlement(attempt, CHILD_ABORT_DRAIN_TIMEOUT_MS)) {
    retainOwnership(attempt);
    return;
  }
  error.childSettled = true;
  const status = managerRecord(attempt.id)?.status;
  if (["completed", "steered", "error", "stopped", "aborted"].includes(status)) error.childStatus = status;
}

async function reconcileChildTermination(error, attempt) {
  if (!attempt) return;
  // A failed spawn acknowledgement can still refer to an existing child.
  if (attempt.id) delete error.childOutcome;
  if (!attempt.id || !attempt.settlement || !await waitForChildSettlement(attempt, CHILD_ABORT_DRAIN_TIMEOUT_MS)) {
    retainOwnership(attempt);
    return;
  }
  error.childSettled = true;
  const status = managerRecord(attempt.id)?.status;
  if (["completed", "steered", "error", "stopped", "aborted"].includes(status)) error.childStatus = status;
}

async function requireChildSettlement(attempt) {
  if (await waitForChildSettlement(attempt, CHILD_ABORT_DRAIN_TIMEOUT_MS)) return;
  retainOwnership(attempt);
  const error = Object.assign(new Error("pi-subagents did not settle the acknowledged ExecutionUnit within the bounded drain"), { code: "HARNESS_CHILD_SETTLEMENT_TIMEOUT", childSettled: false });
  const status = managerRecord(attempt.id)?.status;
  if (["completed", "steered", "error", "stopped", "aborted"].includes(status)) error.childStatus = status;
  throw error;
}

function workerChildDisposition(repo, base, record) {
  const worktreeResult = record?.worktreeResult;
  if (!worktreeResult) return safeChildDisposition({ branch_status: "unknown", worktree_status: "unknown" });
  const branch = worktreeResult.branch;
  if (worktreeResult.hasChanges !== true || !isManagedWorkerBranch(branch)) return safeChildDisposition({ branch_status: "not_reported", worktree_status: "unknown" });
  const disposition = { branch_status: "preserved", branch, worktree_status: "unknown" };
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "--verify", `${branch}^{commit}`], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  const sha = commit.status === 0 ? commit.stdout.trim() : "";
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    disposition.commit_sha = sha;
    const count = spawnSync("git", ["-C", repo, "rev-list", "--count", `${base}..${branch}`], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
    const value = Number(count.stdout?.trim());
    if (count.status === 0 && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) disposition.commit_count = value;
  }
  return safeChildDisposition(disposition);
}

function baseSha(repo) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  if (result.status !== 0) throw Object.assign(new Error(`Failed to read repository HEAD: ${result.stderr?.trim() || "git rev-parse failed"}`), { code: "HARNESS_WORKTREE_FAILED" });
  return result.stdout.trim();
}

function persistExecutionEvidence(repo, order, result) {
  const evidenceRefs = [];
  const items = order.role === "worker" ? [
    ["execution", result.result, result.resultTruncated],
    ...(result.verificationRan ? [["gate", result.gateEvidence, result.gateEvidenceTruncated]] : []),
    ...(result.diff ? [["diff", result.diff, result.diffTruncated]] : []),
  ] : [["report", result.result, result.resultTruncated]];
  try {
    for (const [kind, content, truncated] of items) {
      // An empty gate is still Evidence that the command ran. No item is
      // invented when a child produced no report or diff.
      if (!content && kind !== "gate") continue;
      evidenceRefs.push(storeEvidence({ cwd: repo, taskId: order.task_id, operationId: order.operation_id, kind, content, truncated }).reference);
    }
    return { evidenceRefs };
  } catch {
    // No fabricated reference. Preserve already persisted references, but
    // never accept the TaskResult if one required write failed.
    return { evidenceRefs, evidenceError: true };
  }
}

function terminalSuccess(event) {
  return event?.status === "completed" || event?.status === "steered";
}

export function hasActiveCoordinateTasks() { return activeTasks.size > 0; }

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

// One disposable Coordinator turn. RPC spawn strips resumeSessionFile in
// pi-subagents 0.19.0; Harness passes bounded state rather than a transcript.
export async function executeCoordinatorTurn(pi, prompt, options = {}) {
  assertSupportedPlatform();
  const timeout = terminalBudget(options.timeout ?? DEFAULT_TERMINAL_TIMEOUT_MS);
  const rpcTimeout = rpcBudget(options.rpcTimeout ?? RPC_TIMEOUT_MS);
  const lateReplyGrace = lateReplyBudget(options.rpcLateReplyGrace ?? RPC_LATE_REPLY_GRACE_MS);
  const role = options.role === "head" ? "head" : "coordinator";
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const active = { controller, groupId: options.groupId, agentId: undefined };
  activeTasks.set(id, active);
  const attempt = createSpawnAttempt(active, id);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener?.("abort", abort, { once: true });
  const waiter = terminalWaiter(pi, timeout, controller);
  try {
    if (controller.signal.aborted) throw new Error("The Coordinator turn was cancelled.");
    const spawnData = await requestRpc(pi, "subagents:rpc:spawn", {
      type: role, prompt,
      options: { description: `${role}: bounded Operation turn`, cwd: resolve(options.cwd ?? process.cwd()),
        model: options.model?.trim?.() || null, isBackground: true, isolation: "off", signal: controller.signal,
        onSpawned: attempt.onSpawned, onQueued: attempt.onQueued },
    }, rpcTimeout, lateReplyGrace);
    if (!spawnData?.id) throw new Error("Pi subagent spawn returned no Coordinator id");
    attempt.onSpawned(spawnData.id);
    waiter.setExpectedId(spawnData.id);
    waiter.start();
    const event = await waiter.promise;
    await requireChildSettlement(attempt);
    if (controller.signal.aborted) throw Object.assign(new Error("The Coordinator turn was cancelled."), { code: "HARNESS_CANCELLED" });
    if (event.usage) options.onUsage?.(event.usage);
    if (!terminalSuccess(event)) throw Object.assign(new Error("The Coordinator turn did not complete."), { code: "HARNESS_CHILD_FAILED" });
    return event.result ?? "";
  } catch (error) {
    waiter.cancel(error);
    controller.abort();
    if (error?.lateReply) await reconcileSpawnFailure(error, attempt);
    else if (attempt.id) await reconcileChildTermination(error, attempt);
    throw error;
  } finally {
    options.signal?.removeEventListener?.("abort", abort);
    if (!active.keepOwnership) activeTasks.delete(id);
  }
}

export async function executeCoordinateTask(pi, input, options = {}) {
  assertSupportedPlatform();
  const timeout = terminalBudget(options.timeout ?? DEFAULT_TERMINAL_TIMEOUT_MS);
  const reviewerTimeout = terminalBudget(options.reviewerTimeout ?? DEFAULT_TERMINAL_TIMEOUT_MS);
  const rpcTimeout = rpcBudget(options.rpcTimeout ?? RPC_TIMEOUT_MS);
  const lateReplyGrace = lateReplyBudget(options.rpcLateReplyGrace ?? RPC_LATE_REPLY_GRACE_MS);
  const task = validateTask(input);
  const order = taskOrder(task);
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
  let verificationInFlight = false;
  const terminal = terminalWaiter(pi, timeout, controller);
  const spawnAttempt = createSpawnAttempt(active, localTaskId);
  const finishTask = async (result) => {
    const persisted = persistExecutionEvidence(repo, order, result);
    options.onVerificationStart?.();
    const preliminary = taskResult(order, result, persisted);
    if (preliminary.verification_status !== "not_verified" || !semanticCriteria(order).length) return { ...result, taskResult: preliminary };
    const reviews = [];
    for (const profile of ["default", "security"]) {
      const criteria = semanticCriteria(order).filter((criterion) => (Object.hasOwn(order.review_profile ?? {}, criterion) ? order.review_profile[criterion] : "default") === profile);
      if (!criteria.length) continue;
      if (controller.signal.aborted) {
        reviews.push({ verifier: profile === "security" ? "security" : "semantic", status: "blocked", summary: "The Verifier was cancelled.", evidence_refs: [], criteria: criteria.map((criterion) => ({ criterion, status: "not_checked", finding: "The Verifier was cancelled.", evidence_refs: [] })) });
        continue;
      }
      const selectedOrder = { ...order, acceptance_criteria: criteria };
      const verifier = profile === "security" ? "security" : "semantic";
      reviews.push(await reviewTask(selectedOrder, preliminary, repo, async (prompt) => {
        if (controller.signal.aborted) throw new Error("The semantic Verifier was cancelled.");
        const waiter = terminalWaiter(pi, reviewerTimeout, controller);
        const reviewerAttempt = createSpawnAttempt(active, localTaskId);
        try {
          const model = profile === "security" ? securityReviewModel() : task.model?.trim?.() || null;
          if (profile === "security" && !options.modelRegistry?.getAvailable?.().some((item) => `${item.provider}/${item.id}` === model)) throw Object.assign(new Error("The configured security-reviewer model is unavailable or mismatched."), { code: "HARNESS_SECURITY_REVIEW_UNAVAILABLE" });
          const spawnData = await requestRpc(pi, "subagents:rpc:spawn", {
            type: profile === "security" ? "security-reviewer" : "reviewer", prompt,
            options: { description: `${profile === "security" ? "security-reviewer" : "reviewer"}: ${order.task_id}`, cwd: repo, model,
              isBackground: true, isolation: "off", signal: controller.signal, onSpawned: reviewerAttempt.onSpawned, onQueued: reviewerAttempt.onQueued },
          }, rpcTimeout, lateReplyGrace);
          if (!spawnData?.id) throw new Error("Pi subagent spawn returned no reviewer id");
          reviewerAttempt.onSpawned(spawnData.id);
          waiter.setExpectedId(spawnData.id);
          waiter.start();
          const event = await waiter.promise;
          await requireChildSettlement(reviewerAttempt);
          if (controller.signal.aborted) throw new Error("The semantic Verifier was cancelled.");
          if (event.usage) options.onUsage?.(event.usage, { role: profile === "security" ? "security-reviewer" : "reviewer" });
          if (profile === "security" && managerRecord(spawnData.id)?.invocation?.modelId !== model) throw Object.assign(new Error("The configured security-reviewer model is unavailable or mismatched."), { code: "HARNESS_SECURITY_REVIEW_UNAVAILABLE" });
          return event;
        } catch (error) {
          waiter.cancel(error);
          if (reviewerAttempt.id || error?.code === "HARNESS_RPC_TIMEOUT" || error?.childOutcome === "spawn_rejected") controller.abort();
          if (error?.lateReply) await reconcileSpawnFailure(error, reviewerAttempt);
          else if (reviewerAttempt.id) await reconcileChildTermination(error, reviewerAttempt);
          throw error;
        }
      }, verifier));
    }
    const byCriterion = new Map(reviews.flatMap((review) => review.criteria.map((item) => [item.criterion, { ...item, verifier: review.verifier }])));
    const criteria = semanticCriteria(order).map((criterion) => byCriterion.get(criterion));
    const status = reviews.some((review) => review.status === "failed") ? "failed" : reviews.some((review) => review.status !== "verified") ? "blocked" : "verified";
    const semanticVerification = { version: 1, task_id: order.task_id, verifier: "semantic", status, criteria,
      ...(reviews.find(review => review.failure_code)?.failure_code ? { failure_code: reviews.find(review => review.failure_code).failure_code } : {}),
      summary: status === "verified" ? "All selected Acceptance Criteria passed." : status === "failed" ? "A selected Acceptance Criterion failed." : reviews.find((review) => review.status === "blocked")?.summary,
      evidence_refs: [...new Set(reviews.flatMap((review) => review.evidence_refs))] };
    const evidenceRefs = [...new Set([...persisted.evidenceRefs, ...semanticVerification.evidence_refs])];
    return { ...result, taskResult: taskResult(order, result, { ...persisted, evidenceRefs, semanticVerification }) };
  };
  try {
    const spawnData = await requestRpc(pi, "subagents:rpc:spawn", {
      type: task.owner,
      prompt: formatTaskOrder(order),
      options: {
        description: task.owner === "worker"
          ? `${task.owner}: ${truncateText(task.scope, 40).text}\n\nScope: ${truncateText(task.scope, 40).text}\nReason: ${truncateText(task.verification, 40).text}`
          : `${task.owner}: ${truncateText(task.scope, 80).text}`,
        cwd: repo,
        model: task.model?.trim?.() || null,
        isBackground: true,
        isolation: task.owner === "worker" ? "worktree" : "off",
        signal: controller.signal,
        onSpawned: spawnAttempt.onSpawned,
        onQueued: spawnAttempt.onQueued,
        ...(task.owner === "worker"
          ? {
              onBeforeWorktreeCleanup: async (worktreePath) => {
                verificationInFlight = true;
                terminal.pause();
                try {
                  if (!controller.signal.aborted) verification = await runWorkerVerification(worktreePath, task, { projectRoot: repo, signal: controller.signal });
                } finally {
                  verificationInFlight = false;
                  terminal.start(CHILD_CLEANUP_TIMEOUT_MS);
                }
              },
            }
          : {}),
      },
    }, rpcTimeout, lateReplyGrace);
    const agentId = spawnData?.id;
    if (!agentId) throw new Error("Pi subagent spawn returned no agent id");
    spawnAttempt.onSpawned(agentId);
    terminal.setExpectedId(agentId);
    if (!verificationInFlight) terminal.start();
    const event = await terminal.promise;
    await requireChildSettlement(spawnAttempt);
    if (!controller.signal.aborted && event.usage) options.onUsage?.(event.usage, { role: task.owner });
    if (controller.signal.aborted) throw Object.assign(new Error("The ExecutionUnit was cancelled"), { code: "HARNESS_CANCELLED" });
    const record = managerRecord(agentId);

    if (task.owner === "worker") {
      const result = normalizeWorkerResult({ repo, task, baseSha: base, event, record, verification });
      return await finishTask(result);
    }

    const agentResult = truncateText(event?.result ?? "", 8_000);
    const result = {
      owner: task.owner,
      model: record?.invocation?.modelId ?? null,
      requestedModel: task.model?.trim?.() || null,
      scope: task.scope,
      verification: task.verification,
      success: terminalSuccess(event),
      status: event?.status,
      agentId,
      result: agentResult.text,
      resultTruncated: agentResult.truncated,
      integration: "read-only task",
    };
    return await finishTask(result);
  } catch (error) {
    terminal.cancel(error);
    controller.abort();
    if (error?.lateReply) await reconcileSpawnFailure(error, spawnAttempt);
    else if (spawnAttempt.id) await reconcileChildTermination(error, spawnAttempt);
    if (task.owner === "worker" && spawnAttempt.id && ["HARNESS_RPC_TIMEOUT", "HARNESS_CHILD_TERMINAL_TIMEOUT", "HARNESS_CHILD_SETTLEMENT_TIMEOUT"].includes(error?.code)) {
      error.child_disposition = workerChildDisposition(repo, base, managerRecord(spawnAttempt.id));
    }
    throw error;
  } finally {
    parentSignal?.removeEventListener?.("abort", abortFromParent);
    if (!active.keepOwnership) activeTasks.delete(localTaskId);
  }
}
