// A terminal provider failure is evidence of a restriction, not a quota poll.
// Keep only its timestamp and deadline; never transport the error body.
export function parseQuotaFailure(item) {
  if (item?.type !== "error" || item.status !== "failed") return null;
  const observedAt = Date.parse(item.completedAt || item.updatedAt);
  if (!Number.isFinite(observedAt)) return null;
  if (item.failure?.class === "usage_limit") {
    const reset = Date.parse(item.failure.resetAt);
    if (reset > observedAt && reset - observedAt <= 7 * 86400000) {
      return { observedAt, resetsAt: Math.floor(reset / 1000) };
    }
  } else if (item.title !== "Usage limit reached") return null;
  const text = item.failure?.message ?? (typeof item.text === "string" ? item.text : "");
  if (!/\b(?:individual|weekly|usage|quota|five[- ]hour|5h)\b.*\b(?:quota|limit)\b.*\breached\b/i.test(text)) return null;
  const match = /\bResets in\s+(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text);
  const seconds = match && [86400, 3600, 60, 1].reduce((sum, unit, i) => sum + Number(match[i + 1] || 0) * unit, 0);
  if (!Number.isFinite(observedAt) || !seconds || seconds > 7 * 86400) return null;
  return { observedAt, resetsAt: Math.floor(observedAt / 1000) + seconds };
}

export function applyQuotaRestriction(account, snapshot, now = Date.now()) {
  const restriction = snapshot?.quotaRestriction;
  if (snapshot?.provider !== "gemini" || !restriction ||
      !Number.isFinite(restriction.observedAt) || restriction.observedAt > now ||
      !Number.isSafeInteger(restriction.resetsAt) || restriction.resetsAt * 1000 <= now ||
      restriction.resetsAt * 1000 - restriction.observedAt > 7 * 86400000) return account;
  // A newer successful quota probe can establish recovery before this deadline.
  if (!account?.referenceEnvironmentId && account?.observedAt > restriction.observedAt && account.usageResets?.some(w =>
    Math.abs(w.resetsAt - restriction.resetsAt) <= 120 && typeof w.usedPercent === "number" && w.usedPercent < 100)) return account;
  const windows = account?.usageResets ?? [];
  const matched = windows.filter(w => Math.abs(w.resetsAt - restriction.resetsAt) <= 120).length === 1;
  // Do not infer which pool was exhausted from a generic error. Only a matching
  // reset deadline identifies an existing window; otherwise show unknown quota.
  const usageResets = matched ? windows.map(w => ({ ...w,
    usedPercent: Math.abs(w.resetsAt - restriction.resetsAt) <= 120 ? 100 : w.usedPercent,
    restrictionUntil: Math.abs(w.resetsAt - restriction.resetsAt) <= 120 ? restriction.resetsAt : undefined,
  })) : [{ limitId: "gemini", limitName: "Gemini", window: "primary",
    usedPercent: null, resetsAt: restriction.resetsAt }];
  return { ...account, provider: "gemini", environmentId: snapshot.environmentId ?? null,
    threadId: snapshot.threadId, model: snapshot.model, sourceInstanceId: snapshot.providerInstanceId,
    observedAt: Math.max(account?.observedAt || 0, restriction.observedAt), cached: true,
    usageState: undefined, sourceBadge: null, usageResets };
}
