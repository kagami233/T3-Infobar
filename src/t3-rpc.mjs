// Use the desktop's already authenticated RPC client. No connection tokens or
// provider credentials leave the page. The installer also uses this transport.
export async function mountedRpcCall(environmentId, method, payload, timeoutMs = 2200) {
  const allowed = ["infobar.describe", "infobar.readQuota", "infobar.refreshQuota", "projects.readFile", "projects.writeFile", "terminal.open", "terminal.attach",
    "terminal.observe", "terminal.write", "terminal.close"];
  if (!allowed.includes(method)) throw new Error("InfoBar RPC method is not allowed");
  const host = document.querySelector('[data-chat-composer-form]') || document.querySelector('[data-slot="composer-host"]');
  let fiber = host?.[Object.keys(host || {}).find(k => k.startsWith("__reactFiber$"))];
  let registry;
  for (let i = 0; fiber && !registry && i < 180; i++, fiber = fiber.return) {
    let dep = fiber.dependencies?.firstContext;
    for (let j = 0; dep && j < 30; j++, dep = dep.next) {
      if (dep.memoizedValue?.nodes instanceof Map) { registry = dep.memoizedValue; break; }
    }
  }
  if (!registry) throw new Error("T3 runtime is unavailable");
  const nodes = [...registry.nodes.values()];
  const runtime = nodes.find(n => n.atom?.factory && n.atom.layer &&
    typeof n.atom.atom === "function" && n._value?._tag === "Success")?.atom;
  if (!runtime) throw new Error("T3 effect runtime is unavailable");
  const maximumTimeout = method === "infobar.refreshQuota" ? 8000 : 4000;
  const deadline = Date.now() + Math.min(maximumTimeout, Math.max(100, timeoutMs));
  const owners = window.__T3_INFOBAR_RPC_OWNERS__ ||= new WeakMap();
  async function run(effect) {
    const atom = runtime.atom(effect), unmount = registry.mount(atom);
    try {
      do {
        const state = registry.get(atom);
        if (state._tag === "Success") return state.value;
        if (state._tag === "Failure") throw new Error(String(state.cause));
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      throw new Error("T3 telemetry request timed out");
    } finally { unmount(); }
  }
  for (const node of nodes) {
    const connection = node._value?.value?.value;
    if (!connection?.client || !connection.initialConfig) continue;
    let owner = owners.get(connection), config;
    if (!owner || method === "infobar.describe") {
      try { config = await run(connection.initialConfig); } catch { continue; }
      owner = config.environment?.environmentId;
      if (owner) owners.set(connection, owner);
    }
    if (owner !== environmentId) continue;
    if (method === "infobar.describe") return { environmentId,
      cwd: config.cwd, keybindingsConfigPath: config.keybindingsConfigPath,
      platform: config.environment.platform };
    if (method === "infobar.readQuota" || method === "infobar.refreshQuota") {
      if (typeof payload.instanceId !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(payload.instanceId)) {
        throw new Error("Invalid provider instance");
      }
      const result = await run(connection.client[method === "infobar.readQuota" ? "server.getConfig" : "server.refreshProviders"](
        method === "infobar.readQuota" ? {} : { instanceId: payload.instanceId }));
      // The server config contains secrets and unrelated providers. Only this
      // selected provider's quota metadata may leave the authenticated page.
      return (result.providers ?? []).filter(p => p.instanceId === payload.instanceId).map(p => ({
        instanceId: p.instanceId, driver: p.driver, environmentId,
        auth: { status: p.auth?.status, subscriptionSharing: Boolean(p.auth?.subscriptionSharing) },
        usageLimits: p.usageLimits ? {
          checkedAt: p.usageLimits.checkedAt,
          unavailable: p.usageLimits.unavailable ? { reason: p.usageLimits.unavailable.reason } : undefined,
          resetCredits: p.usageLimits.resetCredits ? {
            availableCount: p.usageLimits.resetCredits.availableCount,
            nextExpiresAt: p.usageLimits.resetCredits.nextExpiresAt,
          } : undefined,
          windows: (p.usageLimits.windows ?? []).slice(0, 128).map(w => ({
            id: w.id, kind: w.kind, usedPercent: w.usedPercent, resetsAt: w.resetsAt,
            windowDurationMins: w.windowDurationMins, modelIds: w.modelIds?.slice(0, 64),
          })),
        } : undefined,
      }));
    }
    if (typeof connection.client[method] !== "function") break;
    return run(connection.client[method](payload));
  }
  throw new Error("Requested T3 environment is not connected");
}

export async function callT3Rpc(client, environmentId, method, payload, timeoutMs = 2200) {
  const expression = `(async()=>{try{return {ok:true,value:await (${mountedRpcCall.toString()})(${JSON.stringify(environmentId)},${JSON.stringify(method)},${JSON.stringify(payload)},${timeoutMs})};}catch(error){return {ok:false,message:String(error.message).slice(0,2000)};}})()`;
  const result = await client.evaluate(expression, Math.max(5000, timeoutMs + 1000));
  if (!result?.ok) throw new Error(result?.message || "T3 RPC call failed");
  return result.value;
}
