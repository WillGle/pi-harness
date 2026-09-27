export const PROACTIVE_COMPACT_ENTRY = "pi-harness-proactive-compaction";
// Soft GC maintenance trigger; Pi owns reserve-token/overflow compaction.
export const MIN_PROACTIVE_PERCENT = 50;
export const MAX_PROACTIVE_PERCENT = 90;

export function proactiveCompactionPolicy() {
  return { enabled: true, threshold_percent: 70 };
}

export function setProactiveThreshold(value) {
  if (!/^(?:[5-8][0-9]|90)$/.test(String(value))) throw new Error("Context maintenance threshold must be a whole percentage from 50 to 90.");
  return { enabled: true, threshold_percent: Number(value) };
}

export function restoreProactivePolicy(value) {
  if (!value || typeof value !== "object") return proactiveCompactionPolicy();
  if (value.threshold_percent === null && value.enabled === false) return { enabled: false, threshold_percent: null };
  try {
    const policy = setProactiveThreshold(value.threshold_percent);
    return { ...policy, enabled: value.enabled === true };
  } catch { return proactiveCompactionPolicy(); }
}
