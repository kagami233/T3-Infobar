import { formatGeminiModelBadge } from "./gemini-reader.mjs";

// Keep imported app IDs intact when looking up T3 state. The HUD uses a
// normalized native UUID for display/cache compatibility.
export function sessionKey(context) {
  return JSON.stringify([context.environmentId ?? null, context.threadId ?? null]);
}

export function projectionSnapshot(projection, context) {
  const missing = { ...context, status: "unavailable", source: "t3-projection",
    warning: "远程会话尚未同步统计数据。" };
  if (!projection || projection.environmentId !== context.environmentId ||
      projection.threadId !== context.appThreadId) return missing;
  const binding = projection.binding;
  if (!binding) return missing;
  const provider = ["antigravity", "gemini"].includes(binding.driver) ? "gemini" : binding.driver;
  const turns = (projection.turns ?? []).filter(t => t.providerThreadId === binding.id);
  const stamp = value => {
    const ms = typeof value === "string" ? Date.parse(value) : value?.epochMilliseconds;
    return Number.isFinite(ms) ? ms : 0;
  };
  turns.sort((a, b) => (stamp(a.tokenUsage?.updatedAt) ?? 0) - (stamp(b.tokenUsage?.updatedAt) ?? 0));
  const usage = turns.filter(t => t.tokenUsage).at(-1)?.tokenUsage;
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const used = number(usage?.usedTokens) ?? number(binding.contextUsage?.usedTokens);
  const max = number(usage?.maxTokens) ?? number(binding.contextUsage?.maxTokens);
  const input = number(usage?.inputTokens), cached = number(usage?.cachedInputTokens);
  const model = projection.model;
  return { ...missing, provider, providerInstanceId: binding.providerInstanceId,
    nativeThreadId: binding.nativeId, model,
    modelBadge: provider === "gemini" ? formatGeminiModelBadge(
      projection.thinkingLevel ? `${model}-${projection.thinkingLevel}` : model) : null,
    status: used !== null || input !== null ? "ok" : "unavailable",
    warning: used !== null || input !== null ? undefined : missing.warning,
    updatedAt: usage?.updatedAt ?? null,
    contextUsedTokens: used, contextWindowTokens: max,
    contextRemainingTokens: used !== null && max > 0 ? Math.max(0, max - used) : null,
    lastCacheRatio: input > 0 && cached !== null && cached <= input ? cached / input : null,
    // T3's projected outputTokens describes the latest request, not a complete
    // turn total. It cannot establish turn speed or complete compaction history.
    averageOutputTps: null, compactionCount: null, historyComplete: false,
    compactReference: null, usageResets: [], active: turns.some(t => t.status === "running"),
  };
}

// Read only telemetry already synchronized by T3. Do not send credentials,
// prompts, responses, or tool arguments over the InfoBar CDP connection.
export async function mountedThreadProjection(context) {
  const localEnvironmentId = await window.desktopBridge?.getHostEnvironmentId?.() ?? null;
  const elements = [...document.querySelectorAll('[data-chat-composer-form], [data-slot="composer-host"]')];
  let result = null;
  let unavailable = false;
  const thinkingDefaults = new Map();
  for (const host of elements) {
    const key = Object.keys(host).find(k => k.startsWith("__reactFiber$"));
    let fiber = host[key];
    for (let depth = 0; fiber && depth < 150; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props?.environmentId === context.environmentId && props.environmentUnavailable === true) unavailable = true;
      if (props?.environmentId === context.environmentId && Array.isArray(props.providerStatuses)) {
        for (const provider of props.providerStatuses) {
          for (const model of provider.models ?? []) {
            const descriptor = model.capabilities?.optionDescriptors?.find(o => o.id === "thought_level");
            if (typeof descriptor?.currentValue === "string") {
              thinkingDefaults.set(JSON.stringify([provider.instanceId, model.slug]), descriptor.currentValue);
            }
          }
        }
      }
      let hook = fiber.memoizedState;
      for (let i = 0; hook && i < 60; i++, hook = hook.next) {
        const state = hook.memoizedState;
        const p = state?.projection;
        if (state?.environmentId !== context.environmentId || p?.thread?.id !== context.appThreadId) continue;
        const binding = p.providerThreads?.find(t => t.id === p.thread.activeProviderThreadId);
        const takeUsage = u => u ? Object.fromEntries(
          ["usedTokens", "maxTokens", "inputTokens", "cachedInputTokens", "outputTokens", "updatedAt"]
            .filter(k => u[k] !== undefined).map(k => [k, u[k]])) : null;
        result = {
          environmentId: state.environmentId, threadId: p.thread.id,
          model: p.thread.modelSelection?.model,
          thinkingLevel: p.thread.modelSelection?.options?.find(o => o.id === "thought_level")?.value,
          binding: binding ? { id: binding.id, driver: binding.driver,
            providerInstanceId: binding.providerInstanceId, nativeId: binding.nativeThreadRef?.nativeId,
            contextUsage: takeUsage(binding.contextUsage) } : null,
          turns: (p.providerTurns ?? []).filter(t => t.providerThreadId === binding?.id).slice(-64)
            .map(t => ({ providerThreadId: t.providerThreadId, status: t.status, tokenUsage: takeUsage(t.tokenUsage) })),
        };
      }
    }
  }
  if (result && !result.thinkingLevel) {
    result.thinkingLevel = thinkingDefaults.get(JSON.stringify([result.binding?.providerInstanceId, result.model]));
  }
  return { localEnvironmentId, projection: unavailable ? null : result };
}

export async function readT3Runtime(client, context) {
  const value = await client.evaluate(`(${mountedThreadProjection.toString()})(${JSON.stringify(context)})`);
  return { ...value, snapshot: projectionSnapshot(value.projection, context) };
}
