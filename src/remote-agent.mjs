import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveT3Session, resolveT3QuotaRestriction } from "./t3-session.mjs";
import { RolloutReader, UUID } from "./reader.mjs";
import { GeminiTranscriptReader, parseGeminiTranscript } from "./gemini-reader.mjs";
import { estimateCompaction } from "./compaction-estimate.mjs";
import { GeminiQuotaReader } from "./gemini-quota.mjs";
import { activeRegistrations, collectorRevision } from "./remote-registration.mjs";

// This module runs on the machine that owns the logs. Only the allowlisted
// numeric summaries below are written to snapshots.json for transport.
export async function geminiTelemetry(file) {
  const stat = await fs.stat(file);
  let pending = "", dropping = false, bytes = 0, complete = true;
  const events = [], seen = new Set();
  function accept(line) {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { complete = false; return; }
    if (!["USER_INPUT", "PLANNER_RESPONSE", "TOOL_RESPONSE", "TOOL_RESULT", "COMPACTION", "CONTEXT_COMPACTION"].includes(e.type)) return;
    const event = { type: e.type };
    if (typeof e.created_at === "string" && Number.isFinite(Date.parse(e.created_at))) event.created_at = e.created_at;
    if (Number.isSafeInteger(e.step_index) && e.step_index >= 0) event.step_index = e.step_index;
    for (const key of ["input_tokens", "cache_read_tokens", "output_tokens"]) {
      if (typeof e[key] === "number" && Number.isFinite(e[key]) && e[key] >= 0) event[key] = e[key];
    }
    if (typeof e.model === "string" && /^[a-zA-Z0-9_.:+-]{1,128}$/.test(e.model)) event.model = e.model;
    if (Array.isArray(e.tool_calls) && e.tool_calls.length) event.tool_calls = [{}];
    const encoded = JSON.stringify(event);
    // Identical repeated rows must not inflate speed or compaction counts.
    if (seen.has(encoded)) return;
    seen.add(encoded);
    bytes += Buffer.byteLength(encoded);
    if (bytes > 64 * 1024 * 1024) throw new Error("Telemetry exceeds the retained event limit");
    events.push(encoded);
  }
  if (stat.size) for await (const chunk of createReadStream(file, { encoding: "utf8", end: stat.size - 1 })) {
    let start = 0, end;
    while ((end = chunk.indexOf("\n", start)) >= 0) {
      const part = chunk.slice(start, end);
      if (!dropping && pending.length + part.length <= 4 * 1024 * 1024) accept(pending + part);
      else complete = false;
      pending = ""; dropping = false; start = end + 1;
    }
    if (!dropping) {
      pending += chunk.slice(start);
      if (pending.length > 4 * 1024 * 1024) { pending = ""; dropping = true; complete = false; }
    }
  }
  if (pending && !dropping) accept(pending);
  return { text: events.join("\n"), complete };
}

const readers = new Map(), geminiCache = new Map(), nativeQuotaReader = new GeminiQuotaReader();
async function codexReference(data, home) {
  let models = [], policy = {};
  try { models = JSON.parse(await fs.readFile(path.join(home, "models_cache.json"), "utf8")).models ?? []; } catch {}
  try {
    const root = (await fs.readFile(path.join(home, "config.toml"), "utf8")).split(/^\s*\[/m)[0];
    const limit = /^\s*model_auto_compact_token_limit\s*=\s*(\d+)/m.exec(root);
    if (limit) policy.limit = Number(limit[1]);
    const scope = /^\s*model_auto_compact_token_limit_scope\s*=\s*"([^"]+)"/m.exec(root);
    if (scope) policy.scope = scope[1];
  } catch {}
  return estimateCompaction(data, Array.isArray(models) ? models : [], policy);
}

export async function collectThread(appThreadId, { t3Home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"),
  quotaSources = [], quotaReader = nativeQuotaReader } = {}) {
  if (typeof appThreadId !== "string" || appThreadId.length > 400) throw new Error("Invalid app thread ID");
  const binding = resolveT3Session(appThreadId, { home: t3Home });
  if (!binding?.nativeId || !UUID.test(binding.nativeId)) throw new Error("Native thread binding is unavailable");
  let data;
  if (binding.provider === "codex") {
    if (!readers.has(binding.codexHome)) readers.set(binding.codexHome, new RolloutReader({ codexHome: binding.codexHome }));
    data = await readers.get(binding.codexHome).snapshot(binding.nativeId);
    data.compactReference = await codexReference(data, binding.codexHome);
  } else if (["antigravity", "gemini"].includes(binding.provider)) {
    const reader = new GeminiTranscriptReader({ providersRoot: path.join(t3Home, "userdata/providers/antigravity") });
    const candidates = (await reader.findTranscriptFiles()).filter(f => f.conversationId === binding.nativeId.toLowerCase());
    if (candidates.length !== 1) throw new Error("No unambiguous Gemini transcript for this binding");
    const file = candidates[0].file, stat = await fs.stat(file), key = `${stat.mtimeMs}:${stat.size}`;
    let cached = geminiCache.get(file);
    if (cached?.key !== key) {
      cached = { key, telemetry: await geminiTelemetry(file) };
      geminiCache.set(file, cached);
      if (geminiCache.size > 8) geminiCache.delete(geminiCache.keys().next().value);
    }
    data = parseGeminiTranscript(cached.telemetry.text, {
      threadId: binding.nativeId, contextWindowTokens: binding.contextWindowTokens || 1_000_000,
      recordedCompactionsOnly: true, strictUsage: true,
    });
  } else throw new Error("Unsupported native provider");
  const quotaSource = quotaSources.find(s => s.providerInstanceId === binding.providerInstanceId);
  const nativeQuota = binding.provider !== "codex" && quotaSource ? await quotaReader.read(quotaSource, { t3Home }) : null;
  return { appThreadId, nativeThreadId: binding.nativeId, providerInstanceId: binding.providerInstanceId,
    nativeQuota,
    provider: binding.provider === "codex" ? "codex" : "gemini", model: binding.model ?? data.model,
    quotaRestriction: binding.provider === "codex" ? null : resolveT3QuotaRestriction(appThreadId, binding.providerThreadId, { home: t3Home }),
    updatedAt: data.updatedAt, status: data.status,
    averageOutputTps: data.averageOutputTps, lastCacheRatio: data.lastCacheRatio,
    compactionCount: data.compactionCount, historyComplete: data.historyComplete,
    contextUsedTokens: data.contextUsedTokens, contextWindowTokens: data.contextWindowTokens,
    contextRemainingTokens: data.contextRemainingTokens, compactReference: data.compactReference };
}

export async function collectDocument(config, now = Date.now(), { quotaReader = nativeQuotaReader, directory } = {}) {
  if (config.version !== 1 || !UUID.test(config.environmentId) || !Array.isArray(config.threads) ||
      config.threads.length > 64 || config.threads.some(t => typeof t !== "string" || t.length > 400)) {
    throw new Error("Invalid remote collector config");
  }
  const home = config.t3Home || process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  const environmentId = (await fs.readFile(path.join(home, "userdata/environment-id"), "utf8")).trim();
  if (environmentId !== config.environmentId) throw new Error("Collector environment identity mismatch");
  const entries = [];
  if (config.quotaSources !== undefined && (!Array.isArray(config.quotaSources) || config.quotaSources.length > 16)) throw new Error("Invalid quota sources");
  const active = directory ? await activeRegistrations(directory, environmentId, now) : [];
  const threads = [...new Set([...active, ...config.threads])].slice(0, 64);
  for (const thread of threads) {
    try { entries.push(await collectThread(thread, { t3Home: home, quotaSources: config.quotaSources ?? [], quotaReader })); }
    catch (error) {
      const reason = /binding/.test(error.message) ? "binding_unavailable"
        : /Gemini transcript/.test(error.message) ? "transcript_unavailable"
        : error.code === "ENOENT" ? "log_not_found" : "log_unavailable";
      entries.push({ appThreadId: thread, status: "unavailable", reason });
    }
  }
  return { version: 1, collectorRevision, environmentId, collectedAt: now, entries };
}

export async function runAgent(configPath, { once = false, snapshotFile = "snapshots.json" } = {}) {
  if (typeof snapshotFile !== "string" || snapshotFile.length > 100 || !/^[a-zA-Z0-9_.-]+\.json$/.test(snapshotFile)) throw new Error("Invalid snapshot filename");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping = true; });
  do {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const document = await collectDocument(config, Date.now(), { directory: path.dirname(configPath) });
    if (!once) void nativeQuotaReader.maintainLogin(config.t3Home || process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"));
    document.collectedAt = Date.now();
    const destination = path.join(path.dirname(configPath), snapshotFile);
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(document) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temp, destination);
    } finally { await fs.rm(temp, { force: true }); }
    if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, Math.max(1000, Math.min(30000, config.intervalMs || 2000))));
  } while (!once && !stopping);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.argv[process.argv.indexOf("--config") + 1];
  if (!process.argv.includes("--config") || !config) throw new Error("Use --config /absolute/path/collector.json");
  const output = process.argv.indexOf("--snapshot-file");
  runAgent(config, { once: process.argv.includes("--once"), snapshotFile: output >= 0 ? process.argv[output + 1] : "snapshots.json" })
    .catch(() => { console.error("InfoBar collector could not read its telemetry configuration."); process.exitCode = 1; });
}
