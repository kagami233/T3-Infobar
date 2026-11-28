import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stateRoot } from "./cdp.mjs";
import { selectT3Account } from "./t3-account.mjs";

const INSTANCE = /^[a-zA-Z0-9_-]{1,120}$/;
const ENVIRONMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instance = value => typeof value === "string" && INSTANCE.test(value);

export function sharedAccountKey(provider) {
  const auth = provider?.auth;
  if (auth?.status !== "authenticated") return null;
  const identity = auth.accountId || auth.email
    ? [provider.driver, auth.type ?? null, auth.accountId ?? null,
      auth.email?.toLowerCase() ?? null, auth.workspaceId ?? null]
    : provider.usageLimits?.credentialFingerprint
      ? [provider.driver, provider.usageLimits.credentialFingerprint] : null;
  return identity ? createHash("sha256").update(JSON.stringify(identity)).digest("hex") : null;
}

// Explicit user-confirmed bindings only. Matching email addresses alone never
// establishes that two connections use the same subscription quota pool.
export class SharedQuotaReader {
  constructor({ file = path.join(stateRoot, "shared-quota.json"),
    t3Home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"),
    now = Date.now, refreshSource } = {}) {
    this.file = file;
    this.t3Home = t3Home;
    this.now = now;
    this.refreshSource = refreshSource;
    this.sources = new Map();
  }

  async config() {
    try {
      if ((await fs.stat(this.file)).size > 65536) throw new Error("共享额度配置过大。");
      const config = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (config.version !== 1 || !Array.isArray(config.mappings) || config.mappings.length > 100) {
        throw new Error("共享额度配置格式无效。");
      }
      return config;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, mappings: [] };
      throw error;
    }
  }

  async localEnvironment() {
    const id = (await fs.readFile(path.join(this.t3Home, "userdata/environment-id"), "utf8")).trim();
    if (!ENVIRONMENT.test(id)) throw new Error("本机 T3 环境 ID 无效。");
    return id;
  }

  async localProvider(instanceId) {
    if (!instance(instanceId)) throw new Error("本地连接 ID 无效。");
    const file = path.join(this.t3Home, "caches", `${instanceId}.json`);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("本地用量缓存无效。");
    const key = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.sources.get(instanceId);
    if (cached?.key === key) return cached.value;
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.instanceId !== instanceId) throw new Error("本地用量缓存的连接身份不匹配。");
    this.sources.set(instanceId, { key, value });
    if (this.sources.size > 8) this.sources.delete(this.sources.keys().next().value);
    return value;
  }

  async configure({ targetEnvironmentId, targetProviderInstanceId, sourceProviderInstanceId, provider }) {
    if (!ENVIRONMENT.test(targetEnvironmentId) || !instance(targetProviderInstanceId) ||
        !instance(sourceProviderInstanceId) || !["codex", "gemini"].includes(provider)) {
      throw new Error("请指定远程环境、远程连接、本地连接以及 codex 或 gemini 引擎。");
    }
    const sourceEnvironmentId = await this.localEnvironment();
    if (sourceEnvironmentId === targetEnvironmentId) throw new Error("共享额度引用仅用于远程环境。");
    const source = await this.localProvider(sourceProviderInstanceId);
    const driverMatches = provider === "codex" ? source.driver === "codex"
      : ["antigravity", "gemini"].includes(source.driver);
    const sourceAccountKey = sharedAccountKey(source);
    if (!driverMatches || !sourceAccountKey) throw new Error("本地连接未登录，或无法确定对应账号身份。");
    const rule = { targetEnvironmentId, targetProviderInstanceId, sourceEnvironmentId,
      sourceProviderInstanceId, provider, sourceAccountKey };
    const config = await this.config();
    config.mappings = config.mappings.filter(r => r.targetEnvironmentId !== targetEnvironmentId ||
      r.targetProviderInstanceId !== targetProviderInstanceId);
    config.mappings.push(rule);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
    return { file: this.file, targetEnvironmentId, targetProviderInstanceId, sourceProviderInstanceId, provider };
  }

  async reference(account, context, localEnvironmentId) {
    // Keep the remote provider authoritative when it supplies quota windows.
    const activeRemoteQuota = account?.usageResets?.some(w => w.resetsAt * 1000 > this.now() &&
      typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent));
    if (activeRemoteQuota || !context.environmentId ||
        !localEnvironmentId || context.environmentId === localEnvironmentId) return account;
    try {
      const config = await this.config();
      const rule = config.mappings.find(r => r.targetEnvironmentId === context.environmentId &&
        r.targetProviderInstanceId === context.providerInstanceId && r.provider === context.provider &&
        r.sourceEnvironmentId === localEnvironmentId);
      if (!rule || await this.localEnvironment() !== localEnvironmentId) return account;
      try { await this.refreshSource?.({ environmentId: localEnvironmentId,
        providerInstanceId: rule.sourceProviderInstanceId, provider: context.provider, model: context.model }); } catch {}
      const source = await this.localProvider(rule.sourceProviderInstanceId);
      if (!rule.sourceAccountKey || sharedAccountKey(source) !== rule.sourceAccountKey) return account;
      const local = selectT3Account([{ ...source, environmentId: localEnvironmentId }], {
        provider: context.provider, providerInstanceId: rule.sourceProviderInstanceId,
        environmentId: localEnvironmentId, model: context.model,
      }, this.now());
      if (!local?.usageResets?.length || local.usageState === "unsupported") return account;
      // Re-scope only account quota to the target session. Local turn metrics
      // and local reset cards are never transplanted into a remote session.
      return { ...account, provider: context.provider, environmentId: context.environmentId,
        threadId: context.threadId, model: context.model, sourceInstanceId: context.providerInstanceId,
        observedAt: local.observedAt, cached: true, usageResets: local.usageResets,
        usageState: undefined, usageUrl: undefined, sourceBadge: null,
        resetCardCount: account?.resetCardCount ?? null,
        resetCards: account?.resetCards ?? [], resetCardExpiries: account?.resetCardExpiries ?? [],
        referenceEnvironmentId: localEnvironmentId, referenceProviderInstanceId: rule.sourceProviderInstanceId,
        sourceDescription: "套餐额度按已确认的共享账号引用本地记录。" };
    } catch {
      return account;
    }
  }
}
