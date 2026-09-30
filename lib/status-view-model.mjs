import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MAX_TASK_ROWS = 16;
const MAX_BLOCKERS = 8;
const NEAR_LIMIT_PERCENT = 85;
const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const plainText = (value, maximum = 160) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
const truncatePlain = (value, width, ellipsis = "…") => truncateToWidth(value, width, ellipsis).replace(/\u001b\[[0-9;]*m/g, "");
const compactLabel = (value, maximum = 30) => {
  const text = plainText(value, 500).replace(/[.!?].*$/, "").trim();
  if (!text) return "—";
  const words = text.split(/\s+/).slice(0, 6).join(" ");
  return truncatePlain(words, maximum, "…");
};
const formatTokens = (value) => {
  const number = finite(value);
  if (number === null) return "—";
  if (number < 1_000) return String(Math.round(number));
  if (number < 1_000_000) return `${(number / 1_000).toFixed(number < 10_000 ? 1 : 0)}k`;
  return `${(number / 1_000_000).toFixed(1)}M`;
};
const percentage = (value) => finite(value) === null ? null : Math.max(0, Math.min(100, value));
const taskRole = (operation, id) => operation?.task_specs?.[id]?.owner ?? "agent";

function chooseOperation(mission, operations, activeOperationId) {
  const ids = mission?.operation_ids ?? [];
  if (activeOperationId && ids.includes(activeOperationId) && operations[activeOperationId]) return operations[activeOperationId];
  for (const id of [...ids].reverse()) {
    const operation = operations[id];
    if (operation?.status === "open" && !operation.planning) return operation;
  }
  for (const id of [...ids].reverse()) if (operations[id]) return operations[id];
  return undefined;
}

function taskStatus(node, result) {
  const status = node?.scheduler_status;
  if (["blocked", "exhausted"].includes(status) || ["failed", "blocked"].includes(result?.verification_status)) return "blocked";
  if (status === "accepted") return "accepted";
  if (status === "running") return node.verification_status === "verifying" ? "verifying" : "running";
  if (status === "result_available") return result?.verification_status === "verified" ? "awaiting acceptance" : "review pending";
  if (["ready", "pending"].includes(status)) return "pending";
  if (["superseded", "waived"].includes(status)) return "resolved";
  return "unknown";
}

function makeTaskRows(operation, graph) {
  if (!operation || operation.planning || !graph?.nodes) return [];
  return (operation.required_task_ids ?? []).map((id) => {
    const node = graph.nodes[id];
    const result = operation.task_results?.[id];
    return {
      id,
      role: node?.verification_status === "verifying" ? "verifier" : taskRole(operation, id),
      intent: plainText(operation.task_intents?.[id], 500) || "Registered work",
      status: taskStatus(node, result),
    };
  });
}

export function buildStatusViewModel({
  missions = {}, operations = {}, taskGraphs = {}, attemptLedger = {}, selectedMissionId,
  activeOperationId, coordinatorStates = {}, contextUsage, telemetry, gcPending = false, piCompacting = false, runtime = {},
} = {}) {
  const mission = missions[selectedMissionId] ?? Object.values(missions).find((item) => item?.status === "active") ?? Object.values(missions).at(-1);
  const operation = chooseOperation(mission, operations, activeOperationId);
  const graph = operation ? taskGraphs[operation.operation_id] : undefined;
  const allTasks = makeTaskRows(operation, graph);
  const counts = { accepted: 0, running: 0, pending: 0, blocked: 0, workers: 0, verifiers: 0 };
  for (const task of allTasks) {
    if (task.status === "accepted") counts.accepted++;
    else if (["running", "verifying"].includes(task.status)) counts.running++;
    else if (task.status === "pending" || task.status === "awaiting acceptance" || task.status === "review pending") counts.pending++;
    else if (task.status === "blocked") counts.blocked++;
    if (task.status === "running" && task.role === "worker") counts.workers++;
    if (task.status === "verifying") counts.verifiers++;
  }
  const blockers = allTasks.filter((task) => task.status === "blocked").slice(0, MAX_BLOCKERS).map((task) => ({
    taskId: task.id,
    label: compactLabel(task.intent, 72),
  }));
  const ledgerForOperation = Object.values(attemptLedger).filter((entry) => entry?.operation_id === operation?.operation_id);
  const unknownAttempts = ledgerForOperation.some((entry) => entry?.status === "unknown");
  const coordinatorBlocked = !!coordinatorStates[operation?.operation_id]?.blocker;
  const blockedByCoordinator = operation?.status === "open" && !activeOperationId && (coordinatorBlocked || (unknownAttempts && counts.blocked === 0));
  const tokens = finite(contextUsage?.tokens);
  const contextWindow = finite(contextUsage?.contextWindow) ?? finite(telemetry?.context_window);
  const reportedPercent = percentage(contextUsage?.percent);
  const contextPercent = reportedPercent ?? (tokens !== null && contextWindow > 0 ? percentage(tokens / contextWindow * 100) : null);
  const gcBytes = finite(telemetry?.gc_bytes_removed);
  const gcEntries = (finite(telemetry?.gc_entries_superseded_by_task) ?? 0)
    + (finite(telemetry?.gc_entries_superseded_by_operation) ?? 0)
    + (finite(telemetry?.gc_entries_superseded_by_mission) ?? 0);
  const ecoState = piCompacting ? "Pi compacting"
    : gcPending ? "GC pending"
      : contextPercent !== null && contextPercent >= NEAR_LIMIT_PERCENT ? "near limit"
        : gcBytes > 0 || gcEntries > 0 ? "GC✓" : "clean";
  const warmingRequests = Number.isSafeInteger(telemetry?.warming_requests) && telemetry.warming_requests >= 0 ? telemetry.warming_requests : null;
  const cacheHitRatio = finite(telemetry?.cache_hit_ratio);
  const active = !!activeOperationId && activeOperationId === operation?.operation_id;
  const commanderState = active ? "coordinating"
    : counts.blocked > 0 || blockedByCoordinator ? "blocked"
      : operation?.status === "complete" ? "complete" : "idle";
  const activeTasks = allTasks.filter((task) => ["running", "verifying"].includes(task.status)).slice(0, MAX_TASK_ROWS);
  const omittedTasks = Math.max(0, allTasks.length - MAX_TASK_ROWS);
  const omittedBlockers = Math.max(0, allTasks.filter((task) => task.status === "blocked").length - blockers.length);
  const workerIds = allTasks.filter((task) => task.status === "running" && task.role === "worker").map((task) => task.id);
  const verifierIds = allTasks.filter((task) => task.status === "verifying").map((task) => task.id);
  const displayBlockedCount = Math.max(counts.blocked, blockedByCoordinator ? 1 : 0);
  return {
    version: 1,
    mission: mission ? { label: compactLabel(mission.objective, 40), status: mission.status } : null,
    operation: operation ? { label: compactLabel(operation.objective, 32), status: operation.status === "open" ? "active" : operation.status } : null,
    runtime: {
      modelDisplayName: plainText(runtime?.modelDisplayName, 80) || null,
      effort: plainText(runtime?.effort, 24) || null,
    },
    commander: { state: commanderState },
    counts,
    workerIds: workerIds.slice(0, 4),
    verifierIds: verifierIds.slice(0, 4),
    blockers,
    blockedByCoordinator,
    displayBlockedCount,
    activeTasks,
    omittedTasks,
    omittedBlockers,
    context: {
      tokens,
      window: contextWindow,
      percent: contextPercent,
      ecoState,
      cacheHitRatio: cacheHitRatio === null ? null : percentage(cacheHitRatio * 100),
      cacheRead: finite(telemetry?.cache_read_tokens),
      cacheWrite: finite(telemetry?.cache_write_tokens),
      warmingRequests,
      warmingCost: finite(telemetry?.warming_runtime_catalog_cost),
      input: finite(telemetry?.input_tokens),
      output: finite(telemetry?.output_tokens),
      estimatedCost: finite(telemetry?.runtime_catalog_cost),
    },
  };
}

const n = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "?";
const token = (value) => formatTokens(value);
const cost = (value) => finite(value) === null ? "—" : `$${value.toFixed(3)}`;
const ratio = (value) => finite(value) === null ? "—" : `${Math.round(value)}%`;
const plain = (text, tone) => ({ text, tone });
const styled = (segments, theme) => segments.map(({ text, tone }) => tone && theme?.fg ? theme.fg(tone, text) : text).join("");
const effortLabel = (value) => value ? value === "xhigh" ? "XHigh" : `${value[0].toUpperCase()}${value.slice(1)}` : "—";

function pairColumns(left, right, width, theme) {
  const leftText = styled(left, theme);
  const rightText = styled(right, theme);
  const gap = width - visibleWidth(leftText) - visibleWidth(rightText);
  return gap >= 1 ? `${leftText}${" ".repeat(gap)}${rightText}` : null;
}

function fitSegments(segments, width, theme) {
  if (width <= 0) return "";
  const totalWidth = segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
  if (totalWidth <= width) return styled(segments, theme);
  let remaining = Math.max(0, width - 1);
  const fitted = [];
  for (const segment of segments) {
    if (remaining <= 0) break;
    const segmentWidth = visibleWidth(segment.text);
    if (segmentWidth <= remaining) {
      fitted.push(segment);
      remaining -= segmentWidth;
    } else {
      fitted.push({ ...segment, text: truncatePlain(segment.text, remaining, "") });
      remaining = 0;
      break;
    }
  }
  return `${styled(fitted, theme)}${theme?.fg ? theme.fg("dim", "…") : "…"}`;
}

function fallbackColumns(width, left, right, theme) {
  const separator = width > 1 ? 1 : 0;
  const available = Math.max(0, width - separator);
  const rightWidth = right.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
  const rightBudget = Math.min(rightWidth, Math.max(0, available - 1));
  const leftBudget = available - rightBudget;
  const leftText = fitSegments(left, leftBudget, theme);
  const rightText = fitSegments(right, rightBudget, theme);
  const gap = Math.max(separator, width - visibleWidth(leftText) - visibleWidth(rightText));
  return `${leftText}${" ".repeat(gap)}${rightText}`;
}

function chooseColumns(width, leftOptions, rightOptions, theme) {
  const combinations = [];
  for (let leftIndex = 0; leftIndex < leftOptions.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < rightOptions.length; rightIndex++) {
      combinations.push({ leftIndex, rightIndex, loss: leftOptions[leftIndex].loss + rightOptions[rightIndex].loss });
    }
  }
  combinations.sort((a, b) => a.loss - b.loss || a.leftIndex - b.leftIndex || a.rightIndex - b.rightIndex);
  for (const { leftIndex, rightIndex } of combinations) {
    const rendered = pairColumns(leftOptions[leftIndex].segments, rightOptions[rightIndex].segments, width, theme);
    if (rendered !== null) return rendered;
  }
  return fallbackColumns(width, leftOptions.at(-1).segments, rightOptions.at(-1).segments, theme);
}

function runtimeSegments(runtime, modelBudget = Infinity) {
  const modelName = runtime?.modelDisplayName ?? "—";
  const effort = effortLabel(runtime?.effort);
  const separator = " · ";
  const fullWidth = visibleWidth(modelName) + visibleWidth(separator) + visibleWidth(effort);
  if (fullWidth <= modelBudget) return [plain(modelName), plain(separator, "dim"), plain(effort)];
  const modelRoom = Math.max(0, modelBudget - visibleWidth(separator) - visibleWidth(effort));
  if (modelRoom >= 1) return [plain(truncatePlain(modelName, modelRoom, "…")), plain(separator, "dim"), plain(effort)];
  return [plain(truncatePlain(modelName, modelBudget, "…"))];
}

function makeExecutionOptions(model) {
  const counts = model.counts ?? {};
  const blocked = n(model.displayBlockedCount ?? counts.blocked);
  const accepted = plain(`✓${n(counts.accepted)}`, "success");
  const running = plain(`●${n(counts.running)}`, "warning");
  const pending = plain(`○${n(counts.pending)}`, "dim");
  const blockedCounter = plain(`!${blocked}`, Number(blocked) > 0 ? "error" : "dim");
  const worker = n(counts.workers), verifier = n(counts.verifiers);
  const workers = plain(`W${worker}`, Number(worker) > 0 ? "warning" : "dim");
  const verifiers = plain(`V${verifier}`, Number(verifier) > 0 ? "warning" : "dim");
  const variants = [
    { loss: 0, counters: [accepted, running, pending, blockedCounter, workers, verifiers] },
    { loss: 2, counters: [accepted, running, blockedCounter, workers, verifiers] },
    { loss: 5, counters: [running, blockedCounter, workers, verifiers] },
    { loss: 9, counters: [running, blockedCounter] },
    { loss: 14, counters: [blockedCounter] },
    { loss: 20, counters: [] },
  ];
  const runtime = runtimeSegments(model.runtime);
  return variants.flatMap(({ loss, counters }) => (counters.length ? [2, 1] : [0]).map((spaceCount) => ({
    loss,
    segments: [...runtime, ...(spaceCount ? [plain(" ".repeat(spaceCount))] : []), ...counters.flatMap((entry, index) => index ? [plain(" "), entry] : [entry])],
  })));
}

function gcSegments(state) {
  const label = state === "clean" ? "GC clean" : state === "GC pending" ? "GC pending"
    : state === "Pi compacting" ? "Pi compacting" : state === "near limit" ? "near limit" : state;
  const tone = state === "GC pending" || state === "Pi compacting" ? "warning" : state === "near limit" ? "error" : "dim";
  return [plain(label, tone)];
}

function economicsOptions(context) {
  const gc = gcSegments(context.ecoState);
  const cache = [plain("Cache "), plain(ratio(context.cacheHitRatio))];
  const estimate = [plain("Est "), plain(cost(context.estimatedCost))];
  const join = (parts) => parts.flatMap((part, index) => index ? [plain(" · "), ...part] : part);
  return [
    { loss: 0, segments: join([gc, cache, estimate]) },
    { loss: 1, segments: join([gc, cache]) },
    { loss: 4, segments: gc },
  ];
}

function contextOptions(context) {
  const value = percentage(context.percent);
  const percent = value === null ? "—%" : `${Math.round(value)}%`;
  const tone = value !== null && value >= NEAR_LIMIT_PERCENT ? "warning" : "accent";
  return [
    { loss: 0, segments: [plain(`Context ${token(context.tokens)}/${token(context.window)} ${percent}`, tone)] },
    { loss: 1, segments: [plain(`Ctx ${percent}`, tone)] },
  ];
}

export function formatStatusFooter(model, width, theme) {
  const safeWidth = Number.isSafeInteger(width) && width > 0 ? width : 1;
  const missionLabel = model.mission?.label;
  const mission = model.mission?.status === "active" && missionLabel && missionLabel !== "—" ? missionLabel : "Idle";
  const rowOneLeft = [{ loss: 0, segments: [plain(`Mission ${mission}`)] }];
  const rowOneRight = contextOptions(model.context);
  const rowTwoLeft = makeExecutionOptions(model);
  const rowTwoRight = economicsOptions(model.context);
  return [
    chooseColumns(safeWidth, rowOneLeft, rowOneRight, theme),
    chooseColumns(safeWidth, rowTwoLeft, rowTwoRight, theme),
  ];
}

function formatContextUsage(context) {
  const tokens = token(context.tokens), window = token(context.window);
  return `${tokens} / ${window}   ${context.percent === null ? "?" : `${Math.round(context.percent)}%`}`;
}

function taskRoleLabel(task) {
  if (task.status === "verifying") return "Verifier";
  if (task.role === "worker") return "Worker";
  if (task.role === "scout") return "Scout";
  if (task.role === "research") return "Research";
  return "Agent";
}

export function formatExpandedStatus(model) {
  const lines = [
    "Mission",
    `  ${model.mission?.label ?? "No active Mission"}`,
    `  Operation: ${model.operation?.label ?? "—"}`,
    `  Status: ${model.mission?.status ?? "idle"}${model.operation ? ` · Operation ${model.operation.status}` : ""}`,
    "", "Blockers",
  ];
  if (model.blockers.length) for (const blocker of model.blockers) lines.push(`  ${blocker.taskId} — ${blocker.label} blocked`);
  else if (model.blockedByCoordinator) lines.push("  The Coordinator needs attention");
  else lines.push("  None");
  if (model.omittedBlockers) lines.push(`  ${model.omittedBlockers} additional Blockers omitted`);
  lines.push(
    "",
    "Execution",
    `  Commander   ${model.commander.state}${model.operation ? ` ${model.operation.label}` : ""}`,
  );
  const roleCounts = new Map();
  for (const task of model.activeTasks) {
    const role = taskRoleLabel(task);
    const ordinal = (roleCounts.get(role) ?? 0) + 1;
    roleCounts.set(role, ordinal);
    const label = `${role} ${String(ordinal).padStart(2, "0")}`;
    lines.push(`  ${label.padEnd(11)} ${task.id.padEnd(5)} ${compactLabel(task.intent, 62).padEnd(62)} ${task.status}`);
  }
  if (!model.activeTasks.length) lines.push("  No active Workers or Verifiers");
  lines.push("", "Tasks", `  ✓ accepted   ${model.counts.accepted}`, `  ● running    ${model.counts.running}`, `  ○ pending    ${model.counts.pending}`, `  ! blocked    ${model.counts.blocked}`);
  if (model.omittedTasks) lines.push(`  ${model.omittedTasks} additional Tasks omitted`);
  lines.push(
    "", "Context Economics",
    `  Context      ${formatContextUsage(model.context)}`,
    `  GC           ${model.context.ecoState}`,
    `  Cache hit    ${ratio(model.context.cacheHitRatio)}`,
    `  Cache read   ${token(model.context.cacheRead)}`,
    `  Cache write  ${token(model.context.cacheWrite)}`,
    `  Warming      ${model.context.warmingRequests === null ? "—" : model.context.warmingRequests === 0 ? "idle" : model.context.warmingRequests}`,
    `  Input        ${token(model.context.input)}`,
    `  Output       ${token(model.context.output)}`,
    `  Est. cost    ${cost(model.context.estimatedCost)}`,
  );
  return lines.join("\n");
}
