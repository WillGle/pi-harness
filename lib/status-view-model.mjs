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
  activeOperationId, coordinatorStates = {}, contextUsage, telemetry, gcPending = false, piCompacting = false,
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
const token = (value) => value === null ? "—" : formatTokens(value);
const cost = (value) => value === null ? "—" : `$${value.toFixed(3)}`;
const ratio = (value) => value === null ? "—" : `${Math.round(value)}%`;
const ecoWide = (state) => state === "GC✓" ? "GC✓" : state;
const ecoSmall = (state) => state === "clean" || state === "GC✓" ? "OK" : state === "GC pending" ? "GC pending" : state === "near limit" ? "near" : "Pi compact";
const taskIds = (ids) => ids.length > 3 ? `${ids.slice(0, 3).join(",")},+${ids.length - 3}` : ids.join(",");
const tones = { dim: "dim", accepted: "success", running: "warning", blocked: "error", context: "accent" };
const segmentsWidth = (segments) => visibleWidth(segments.map((segment) => segment.text).join(""));
const styled = (segments, theme) => segments.map(({ text, tone }) => tone && theme?.fg ? theme.fg(tone, text) : text).join("");
const line = (...segments) => segments.filter((segment) => segment?.text).map((segment) => ({ tone: "dim", ...segment }));
const plain = (text, tone = "dim") => ({ text, tone });

function blockerText(model, maximum = 32) {
  const blocker = model.blockers[0];
  if (!blocker) return model.blockedByCoordinator ? "Coordinator needs attention" : "";
  const suffix = " blocked";
  const prefix = `${blocker.taskId} `;
  const room = Math.max(1, maximum - visibleWidth(prefix) - visibleWidth(suffix));
  return `${prefix}${truncatePlain(blocker.label, room)}${suffix}`;
}

function militaryCandidates(model, width) {
  const mission = model.mission?.label ?? "—";
  const operation = model.operation?.label ?? "—";
  const c = model.counts;
  const blockedCount = model.displayBlockedCount;
  const activeBlocker = blockerText(model, width >= 80 ? 44 : 28);
  const wide = line(
    plain(`M ${truncatePlain(mission, 30, "…")} › O ${truncatePlain(operation, 24, "…")} | `),
    plain(`✓${n(c.accepted)} `, tones.accepted), plain(`●${n(c.running)} `, tones.running), plain(`○${n(c.pending)} `),
    plain(`!${n(blockedCount)}${activeBlocker ? ` ${activeBlocker}` : ""} | `, blockedCount ? tones.blocked : "dim"),
    plain(`Cmd ${model.commander.state} | `),
    plain(`W${n(c.workers)}${model.workerIds.length ? ` ${taskIds(model.workerIds)}` : ""} | `, c.workers ? tones.running : "dim"),
    plain(`V${n(c.verifiers)}${model.verifierIds.length ? ` ${taskIds(model.verifierIds)}` : ""}`, c.verifiers ? tones.running : "dim"),
  );
  const mediumBlocked = line(
    plain(`M ${truncatePlain(mission, 25, "…")} | `),
    plain(`!${n(blockedCount)}${activeBlocker ? ` ${activeBlocker}` : ""} | `, blockedCount ? tones.blocked : "dim"),
    plain(`●${n(c.running)} | `, tones.running), plain(`W${n(c.workers)} V${n(c.verifiers)}`, c.workers || c.verifiers ? tones.running : "dim"),
  );
  const medium = line(
    plain(`M ${truncatePlain(mission, 26, "…")} › O ${truncatePlain(operation, 19, "…")} | `),
    plain(`✓${n(c.accepted)} `, tones.accepted), plain(`●${n(c.running)} `, tones.running), plain(`○${n(c.pending)} `), plain(`!${n(blockedCount)} | `, blockedCount ? tones.blocked : "dim"),
    plain(`W${n(c.workers)} V${n(c.verifiers)}`, c.workers || c.verifiers ? tones.running : "dim"),
  );
  const smallWithBlocker = line(
    plain(`M ${truncatePlain(mission, 21, "…")} | `),
    plain(`! ${truncatePlain(activeBlocker || `${n(blockedCount)} blocked`, 22, "…")} | `, blockedCount ? tones.blocked : "dim"),
    plain(`●${n(c.running)} | `, tones.running), plain(`W${n(c.workers)} V${n(c.verifiers)}`, c.workers || c.verifiers ? tones.running : "dim"),
  );
  const small = line(
    plain(`M ${truncatePlain(mission, 28, "…")} | `),
    plain(`●${n(c.running)} !${n(blockedCount)} | `, blockedCount ? tones.blocked : tones.running),
    plain(`W${n(c.workers)} V${n(c.verifiers)}`, c.workers || c.verifiers ? tones.running : "dim"),
  );
  if (width >= 120 && segmentsWidth(wide) <= width) return wide;
  if (width >= 80 && c.blocked > 0 && segmentsWidth(mediumBlocked) <= width) return mediumBlocked;
  if (width >= 80 && segmentsWidth(medium) <= width) return medium;
  if (c.blocked > 0 && segmentsWidth(smallWithBlocker) <= width) return smallWithBlocker;
  if (segmentsWidth(small) <= width) return small;
  const compactTail = ` ●${n(c.running)} !${n(blockedCount)} W${n(c.workers)} V${n(c.verifiers)}`;
  const missionRoom = Math.max(0, width - visibleWidth(`M ${compactTail}`));
  const compactMission = truncatePlain(mission, missionRoom, "…");
  return line(
    plain(`M${compactMission ? ` ${compactMission}` : ""}${compactTail}`, blockedCount ? tones.blocked : tones.dim),
  );
}

function contextCandidates(model, width) {
  const c = model.context;
  const pct = c.percent === null ? "?%" : `${Math.round(c.percent)}%`;
  const contextValue = `${token(c.tokens)}/${token(c.window)} ${pct}`;
  const cells = 7;
  const filled = c.percent === null ? null : Math.max(0, Math.min(cells, Math.round(c.percent / 100 * cells)));
  const bar = filled === null ? "" : ` ${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
  const ecoTone = c.ecoState === "GC pending" || c.ecoState === "Pi compacting" ? "warning" : c.ecoState === "near limit" ? "error" : "dim";
  const cache = `Cache ${ratio(c.cacheHitRatio)} · read ${token(c.cacheRead)} · write ${token(c.cacheWrite)}`;
  const warm = c.warmingRequests === null ? "Warm —" : c.warmingRequests === 0 ? "Warm idle" : `Warm ${c.warmingRequests}${c.warmingCost !== null && c.warmingCost > 0 ? ` · ${cost(c.warmingCost)}` : ""}`;
  const io = `I/O ↑${token(c.input)} ↓${token(c.output)}`;
  const wide = line(
    plain(`Ctx ${contextValue}${bar} | `, c.percent !== null && c.percent >= NEAR_LIMIT_PERCENT ? "warning" : "accent"),
    plain(`Eco ${ecoWide(c.ecoState)} | `, ecoTone),
    plain(`${cache} | `), plain(`${warm} | `), plain(`${io} | `), plain(`Est ${cost(c.estimatedCost)}`),
  );
  const medium = line(
    plain(`Ctx ${contextValue} | `, c.percent !== null && c.percent >= NEAR_LIMIT_PERCENT ? "warning" : "accent"),
    plain(`Eco ${ecoWide(c.ecoState)} | `, ecoTone),
    plain(`Cache ${ratio(c.cacheHitRatio)} R${token(c.cacheRead)}/W${token(c.cacheWrite)} | `),
    plain(`Est ${cost(c.estimatedCost)}`),
  );
  const small = line(
    plain(`Ctx ${c.percent === null ? "?" : `${Math.round(c.percent)}%`} | `, c.percent !== null && c.percent >= NEAR_LIMIT_PERCENT ? "warning" : "accent"),
    plain(`Eco ${ecoSmall(c.ecoState)} | `, ecoTone), plain(`Cache ${ratio(c.cacheHitRatio)}`),
  );
  if (width >= 120 && segmentsWidth(wide) <= width) return wide;
  if (width >= 80 && segmentsWidth(medium) <= width) return medium;
  if (segmentsWidth(small) <= width) return small;
  const compactEco = ecoSmall(c.ecoState);
  const compactContext = line(
    plain(`Ctx ${c.percent === null ? "?" : `${Math.round(c.percent)}%`} | `, c.percent !== null && c.percent >= NEAR_LIMIT_PERCENT ? "warning" : "accent"),
    plain(`Eco ${compactEco}`, ecoTone),
  );
  if (segmentsWidth(compactContext) <= width) return compactContext;
  const minimalContext = line(plain(`C${c.percent === null ? "?" : `${Math.round(c.percent)}%`} E${compactEco}`, ecoTone));
  return minimalContext;
}

export function formatStatusFooter(model, width, theme) {
  const safeWidth = Number.isSafeInteger(width) && width > 0 ? width : 1;
  const lines = [militaryCandidates(model, safeWidth), contextCandidates(model, safeWidth)];
  return lines.map((segments) => styled(segments, theme));
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
