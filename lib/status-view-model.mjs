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
export function buildStatusViewModel({ works = {}, selectedWorkId, contextUsage, telemetry, piCompacting = false, runtime = {} } = {}) {
  const work = works[selectedWorkId];
  const allTasks = Object.values(work?.tasks ?? {}).map((task) => {
    const childRole = task.attempts.at(-1)?.children.at(-1)?.role;
    const verifying = task.status === "running" && ["reviewer", "security-reviewer"].includes(childRole);
    return { id: task.task_id, intent: plainText(task.assignment.scope, 500), role: verifying ? "verifier" : task.assignment.owner,
      status: verifying ? "verifying" : task.status === "result_available" ? "awaiting acceptance" : ["unknown", "failed"].includes(task.status) ? "blocked" : task.status === "ready" ? "pending" : task.status };
  });
  const counts = { accepted: 0, running: 0, pending: 0, blocked: 0, workers: 0, verifiers: 0 };
  for (const task of allTasks) {
    if (task.status === "accepted") counts.accepted++;
    else if (["running", "verifying"].includes(task.status)) counts.running++;
    else if (["pending", "awaiting acceptance"].includes(task.status)) counts.pending++;
    else if (task.status === "blocked") counts.blocked++;
    if (task.status === "running" && task.role === "worker") counts.workers++;
    if (task.status === "verifying") counts.verifiers++;
  }
  const blockedTasks = allTasks.filter((task) => task.status === "blocked");
  const tokens = finite(contextUsage?.tokens), contextWindow = finite(contextUsage?.contextWindow) ?? finite(telemetry?.context_window);
  const contextPercent = percentage(contextUsage?.percent) ?? (tokens !== null && contextWindow > 0 ? percentage(tokens / contextWindow * 100) : null);
  const cacheHitRatio = finite(telemetry?.cache_hit_ratio);
  return {
    version: 1, work: work ? { label: compactLabel(work.objective, 40), status: work.status } : null,
    runtime: { modelDisplayName: plainText(runtime.modelDisplayName, 80) || null, effort: plainText(runtime.effort, 24) || null },
    commander: { state: counts.running ? "executing" : counts.blocked ? "blocked" : work?.status === "complete" ? "complete" : "idle" },
    counts,
    blockers: blockedTasks.slice(0, MAX_BLOCKERS).map((task) => ({ taskId: task.id, label: compactLabel(task.intent, 72) })),
    activeTasks: allTasks.filter((task) => ["running", "verifying"].includes(task.status)).slice(0, MAX_TASK_ROWS),
    omittedTasks: Math.max(0, allTasks.length - MAX_TASK_ROWS), omittedBlockers: Math.max(0, blockedTasks.length - MAX_BLOCKERS),
    context: { tokens, window: contextWindow, percent: contextPercent,
      ecoState: piCompacting ? "Pi compacting" : contextPercent === null ? "unknown" : contextPercent >= NEAR_LIMIT_PERCENT ? "near limit" : "within limit",
      cacheHitRatio: cacheHitRatio === null ? null : percentage(cacheHitRatio * 100),
      cacheRead: finite(telemetry?.cache_read_tokens), cacheWrite: finite(telemetry?.cache_write_tokens),
      input: finite(telemetry?.input_tokens), output: finite(telemetry?.output_tokens), estimatedCost: finite(telemetry?.runtime_catalog_cost), coverage: telemetry?.coverage },
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

function makeExecutionOptions(model) {
  const counts = model.counts ?? {};
  const blocked = n(counts.blocked);
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
  const runtime = [plain(model.runtime?.modelDisplayName ?? "—"), plain(" · ", "dim"), plain(effortLabel(model.runtime?.effort))];
  return variants.flatMap(({ loss, counters }) => (counters.length ? [2, 1] : [0]).map((spaceCount) => ({
    loss,
    segments: [...runtime, ...(spaceCount ? [plain(" ".repeat(spaceCount))] : []), ...counters.flatMap((entry, index) => index ? [plain(" "), entry] : [entry])],
  })));
}

function contextSegments(state) {
  return [plain(state, state === "Pi compacting" ? "warning" : state === "near limit" ? "error" : "dim")];
}

function economicsOptions(context) {
  const pressure = contextSegments(context.ecoState);
  const cache = [plain("Cache "), plain(ratio(context.cacheHitRatio))];
  const estimate = [plain("Est "), plain(cost(context.estimatedCost))];
  const join = (parts) => parts.flatMap((part, index) => index ? [plain(" · "), ...part] : part);
  return [
    { loss: 0, segments: join([pressure, cache, estimate]) },
    { loss: 1, segments: join([pressure, cache]) },
    { loss: 4, segments: pressure },
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
  const missionLabel = model.work?.label;
  const mission = model.work?.status === "active" && missionLabel && missionLabel !== "—" ? missionLabel : "Idle";
  const rowOneLeft = [{ loss: 0, segments: [plain(`Work ${mission}`)] }];
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
    "Work",
    `  ${model.work?.label ?? "No active work"}`,
    `  Status: ${model.work?.status ?? "idle"}`,
    "", "Blockers",
  ];
  if (model.blockers.length) for (const blocker of model.blockers) lines.push(`  ${blocker.taskId} — ${blocker.label} blocked`);
  else lines.push("  None");
  if (model.omittedBlockers) lines.push(`  ${model.omittedBlockers} additional Blockers omitted`);
  lines.push(
    "",
    "Execution",
    `  Commander   ${model.commander.state}`,
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
    `  Pressure     ${model.context.ecoState}`,
    `  Cache hit    ${ratio(model.context.cacheHitRatio)}`,
    `  Cache read   ${token(model.context.cacheRead)}`,
    `  Cache write  ${token(model.context.cacheWrite)}`,
    `  Input        ${token(model.context.input)}`,
    `  Output       ${token(model.context.output)}`,
    `  Est. cost    ${cost(model.context.estimatedCost)} (runtime catalog; not provider billing)`,
    `  Cost usage   ${model.context.coverage ? `${model.context.coverage.runtime_catalog_cost.known}/${model.context.coverage.runtime_catalog_cost.expected} recorded events` : "unknown"}`,
  );
  return lines.join("\n");
}
