import fs from "node:fs/promises";
import path from "node:path";
import { stateRoot } from "./cdp.mjs";
import { callT3Rpc } from "./t3-rpc.mjs";
import { selectT3Account } from "./t3-account.mjs";
import { collectorRevision, registrationFile, renewAfterMs } from "./remote-registration.mjs";

export function nativeQuotaAccount(snapshot, context, now = Date.now()) {
  if (snapshot?.provider !== "gemini" || !snapshot.nativeQuota) return null;
  return selectT3Account([{ instanceId: snapshot.providerInstanceId, driver: "antigravity",
    environmentId: snapshot.environmentId, auth: { status: "authenticated" }, usageLimits: snapshot.nativeQuota }], context, now);
}

const numeric = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function mergeRemoteMetrics(base, document, now = Date.now()) {
  if (document?.version !== 1 || document.environmentId !== base.environmentId ||
      !numeric(document.collectedAt) || document.collectedAt > now + 5000 ||
      now - document.collectedAt > 30000 || !Array.isArray(document.entries) || document.entries.length > 64) return base;
  if (!base.appThreadId || !base.nativeThreadId || !base.providerInstanceId || !["codex", "gemini"].includes(base.provider)) return base;
  const entry = document.entries.find(e => e.appThreadId === base.appThreadId &&
    e.nativeThreadId === base.nativeThreadId && e.provider === base.provider &&
    e.providerInstanceId === base.providerInstanceId && e.status === "ok");
  if (!entry) return base;
  const value = { ...base, extraMetricsSource: "remote-native-log", extraMetricsObservedAt: entry.updatedAt ?? null };
  const restriction = entry.quotaRestriction;
  const quota = entry.nativeQuota, checkedAt = Date.parse(quota?.checkedAt);
  if (entry.model === base.model && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= 90000 &&
      Array.isArray(quota.windows) && quota.windows.length <= 32) {
    value.nativeQuota = { checkedAt: new Date(checkedAt).toISOString(), windows: quota.windows.filter(w =>
      typeof w.id === "string" && /^(?:gemini(?:-(?:argon|carbon|neon|hydrogen))?|3p)-(?:5h|weekly)$/.test(w.id) &&
      numeric(w.usedPercent) && w.usedPercent <= 100 && Number.isFinite(Date.parse(w.resetsAt))).map(w => ({
        id: w.id, kind: w.kind === "weekly" ? "weekly" : "session", usedPercent: w.usedPercent,
        resetsAt: new Date(w.resetsAt).toISOString(), windowDurationMins: w.kind === "weekly" ? 10080 : 300,
      })) };
  }
  if (entry.model === base.model && numeric(restriction?.observedAt) && Number.isSafeInteger(restriction.resetsAt) &&
      restriction.observedAt <= now && restriction.resetsAt * 1000 > now &&
      restriction.resetsAt * 1000 - restriction.observedAt <= 7 * 86400000) {
    value.quotaRestriction = { observedAt: restriction.observedAt, resetsAt: restriction.resetsAt };
  }
  value.averageOutputTps = numeric(entry.averageOutputTps) && entry.averageOutputTps < 1e7 ? entry.averageOutputTps : null;
  if (numeric(entry.lastCacheRatio) && entry.lastCacheRatio <= 1) value.lastCacheRatio = entry.lastCacheRatio;
  value.compactionCount = Number.isSafeInteger(entry.compactionCount) && entry.compactionCount >= 0 ? entry.compactionCount : null;
  value.historyComplete = entry.historyComplete === true;
  // A new provider turn may not have projected token usage yet. The exact
  // native binding still permits the remote log's last observed context.
  // Projected values always take precedence; never substitute another thread.
  if (!numeric(base.contextUsedTokens) && numeric(entry.contextUsedTokens)) value.contextUsedTokens = entry.contextUsedTokens;
  if (!numeric(base.contextWindowTokens) && numeric(entry.contextWindowTokens) && entry.contextWindowTokens > 0) value.contextWindowTokens = entry.contextWindowTokens;
  if (!numeric(base.contextRemainingTokens) && numeric(value.contextUsedTokens) && numeric(value.contextWindowTokens)) {
    value.contextRemainingTokens = Math.max(0, value.contextWindowTokens - value.contextUsedTokens);
  }
  if (base.status !== "ok" && (numeric(value.contextUsedTokens) || numeric(value.lastCacheRatio) ||
      numeric(value.compactionCount) || numeric(value.averageOutputTps))) {
    value.status = "ok";
    value.warning = undefined;
    value.updatedAt ??= entry.updatedAt ?? null;
  }
  const ref = entry.compactReference;
  if (ref?.kind === "calibrated-compaction-estimate" && numeric(ref.limit) && ref.limit > 0 &&
      numeric(ref.reserve) && Number.isSafeInteger(ref.sampleCount) && ref.sampleCount >= 0) {
    const used = value.contextUsedTokens;
    if (numeric(used)) {
      const remaining = Math.max(0, ref.limit - used - ref.reserve);
      value.compactReference = { kind: ref.kind, limit: ref.limit, reserve: ref.reserve,
        remaining, remainingPercent: Math.min(100, remaining / ref.limit * 100),
        source: base.provider === "gemini" ? "gemini-800k-threshold" : "remote-native-policy",
        sampleCount: ref.sampleCount };
    }
  }
  return value;
}

export class RemoteMetricsReader {
  renewals = new Map();
  constructor({ file = path.join(stateRoot, "remote-metrics.json"), now = Date.now,
    rpc = callT3Rpc } = {}) { this.file = file; this.now = now; this.rpc = rpc; }
  async read(client, snapshot) {
    if (!snapshot.nativeThreadId || !snapshot.providerInstanceId || !snapshot.appThreadId) return snapshot;
    try {
      if ((await fs.stat(this.file)).size > 65536) return snapshot;
      const config = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (config.version !== 1 || !Array.isArray(config.sources)) return snapshot;
      const source = config.sources.find(s => s.environmentId === snapshot.environmentId);
      if (!source || typeof source.cwd !== "string") return snapshot;
      const file = await this.rpc(client, snapshot.environmentId, "projects.readFile", {
        cwd: source.cwd, relativePath: "snapshots.json",
      });
      if (file.truncated || typeof file.contents !== "string" || file.contents.length > 131072) return snapshot;
      const document = JSON.parse(file.contents);
      const now = this.now();
      if (document.version === 1 && document.collectorRevision >= collectorRevision &&
          document.environmentId === snapshot.environmentId && ["codex", "gemini"].includes(snapshot.provider)) {
        const registration = registrationFile(snapshot.environmentId, snapshot.appThreadId);
        const key = JSON.stringify([source.environmentId, source.cwd, registration.relativePath]);
        if (!(this.renewals.get(key) > now)) {
          for (const [id, until] of this.renewals) if (until <= now) this.renewals.delete(id);
          this.renewals.set(key, now + renewAfterMs);
          try {
            await this.rpc(client, source.environmentId, "projects.writeFile", { cwd: source.cwd, ...registration });
          } catch { this.renewals.set(key, now + 5000); }
        }
      }
      return mergeRemoteMetrics(snapshot, document, now);
    } catch { return snapshot; }
  }
}
