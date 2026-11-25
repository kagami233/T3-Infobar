// An email can belong to multiple registrations and quota pools. Only the
// selected provider's snapshot can describe the current connection's allowance.
export function selectT3Account(providers, context, now = Date.now()) {
  const exact = providers.find(p => p.instanceId === context.providerInstanceId);
  const isGemini = context.provider === "gemini" && ["antigravity", "gemini"].includes(exact?.driver);
  if ((!isGemini && (context.provider !== "codex" || exact?.driver !== "codex")) ||
      exact?.auth?.status !== "authenticated") return null;
  const scope = { provider: context.provider, threadId: context.threadId ?? null,
    model: context.model ?? null, sourceInstanceId: exact.instanceId };
  const usable = p => p?.usageLimits && !p.usageLimits.unavailable &&
    (p.usageLimits.windows?.length || p.usageLimits.resetCredits);
  const source = exact;
  if (!usable(source)) {
    if (exact.auth.subscriptionSharing && exact.usageLimits?.unavailable?.reason === "unsupported") {
      return {
        ...scope, observedAt: now, cached: false, usageResets: [], resetCardCount: null,
        resetCardExpiries: [], resetCards: [], sourceInstanceId: exact.instanceId,
        sourceBadge: null, usageState: "unsupported",
        usageUrl: "https://chatgpt.com/#settings/Usage",
        sourceDescription: "当前共享连接未提供剩余额度、重置时间和可用重置卡数量，请在账户用量页面查看。— 表示未知，不表示额度或卡片为零。",
      };
    }
    return null;
  }
  const limits = source.usageLimits;
  const observedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > 7 * 86400000) return null;
  const timestamp = (value, future = true) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 && (!future || ms > now) ? Math.floor(ms / 1000) : null;
  };
  // T3's Antigravity adapter reports separate Gemini and third-party pools.
  // Prefer explicit model restrictions; otherwise accept only recognized IDs.
  const baseModel = value => typeof value === "string"
    ? value.toLowerCase().replace(/-(?:xhigh|high|medium|low|ultra|ultrathink|max)$/, "") : "";
  const model = baseModel(context.model);
  const matchesModel = w => {
    if (Array.isArray(w.modelIds) && w.modelIds.length) {
      return w.modelIds.some(id => baseModel(id) === model);
    }
    if (!isGemini) return true;
    if (model.startsWith("gemini-")) return /^gemini-(?:5h|weekly)$/.test(w.id);
    if (/^(?:claude-|gpt-)/.test(model)) return /^3p-(?:5h|weekly)$/.test(w.id);
    return false;
  };
  const windows = (limits.windows ?? []).filter(w =>
    matchesModel(w) && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 &&
    w.usedPercent <= 100 && timestamp(w.resetsAt, false)
  ).map(w => ({
    limitId: isGemini ? (model.startsWith("gemini-") ? "gemini" : "antigravity-3p") : "codex",
    limitName: isGemini ? (model.startsWith("gemini-") ? "Gemini" : "Claude/GPT") : "账户额度",
    window: w.kind === "weekly" ? "secondary" : "primary",
    windowMinutes: w.windowDurationMins ?? null,
    usedPercent: w.usedPercent, resetsAt: timestamp(w.resetsAt, false), observedAt: limits.checkedAt,
  }));
  const credits = isGemini ? null : limits.resetCredits;
  const nextExpiry = timestamp(credits?.nextExpiresAt);
  const expiredSummary = Boolean(credits?.nextExpiresAt && !nextExpiry);
  const count = !expiredSummary && Number.isSafeInteger(credits?.availableCount) && credits.availableCount >= 0
    ? credits.availableCount : null;
  return {
    ...scope, observedAt, cached: true, usageResets: windows,
    resetCardCount: count, resetCardExpiries: [],
    resetCards: nextExpiry && count > 0 ? [{ expiresAt: nextExpiry }] : [],
    sourceInstanceId: source.instanceId,
    sourceBadge: isGemini && now - observedAt > 90000 ? "缓存" : null,
    sourceDescription: isGemini
      ? "来自 T3 当前 Antigravity 连接的账户用量记录；按模型匹配额度池，覆盖此账户的其他会话。"
      : "来自 T3 当前账户的用量记录。",
  };
}

// T3 already subscribes to these snapshots. Read its mounted state without
// opening another authenticated connection or exposing credentials.
function mountedProviderSnapshots() {
  const host = document.querySelector('[data-slot="composer-host"]') || document.querySelector('[data-chat-composer-form]');
  const key = Object.keys(host || {}).find(k => k.startsWith("__reactFiber$"));
  let root = host?.[key];
  while (root?.return) root = root.return;
  root = root?.stateNode?.current || root;
  const pending = [root], found = new Map(), seen = new WeakSet();
  let budget = 15000;
  function inspect(value, depth) {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 3) return;
    seen.add(value);
    if (typeof value.instanceId === "string" && ["codex", "antigravity", "gemini"].includes(value.driver) && value.usageLimits) {
      const old = found.get(value.instanceId);
      if (!old || Date.parse(value.usageLimits.checkedAt) > Date.parse(old.usageLimits.checkedAt)) found.set(value.instanceId, value);
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) inspect(item, depth + 1);
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (name === "children" || name === "ref") continue;
      if (/provider|config|presentation|environment|value|current|state/i.test(name)) inspect(item, depth + 1);
    }
  }
  while (pending.length && budget-- > 0) {
    const fiber = pending.pop();
    if (!fiber) continue;
    inspect(fiber.memoizedProps, 0);
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i < 40; i++, hook = hook.next) inspect(hook.memoizedState, 0);
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  return [...found.values()];
}

export function createT3AccountReader() {
  const cache = new WeakMap();
  return async (client, context) => {
    const key = JSON.stringify(context);
    const previous = cache.get(client);
    if (previous?.key === key && Date.now() - previous.at < 15000) return previous.value;
    const value = await client.evaluate(`(${selectT3Account.toString()})((${mountedProviderSnapshots.toString()})(), ${JSON.stringify(context)})`);
    cache.set(client, { key, at: Date.now(), value });
    return value;
  };
}
