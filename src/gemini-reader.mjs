import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GEMINI_CONTEXT_WINDOW = 1_000_000;
const GEMINI_COMPACT_LIMIT = 800_000; // 80% of 1M context window
const ROLLING_WINDOW_SECONDS = 5 * 3600; // 5-hour rolling quota window
const DEFAULT_WINDOW_TOKEN_BUDGET = 5_000_000; // 5M billed/weighted tokens per 5h rolling window default

const numeric = v => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function formatGeminiModelBadge(rawModel) {
  if (typeof rawModel !== "string" || !rawModel.trim()) return null;
  const m = rawModel.trim().toLowerCase();
  const tierMap = {
    xhigh: "XHigh",
    ultrathink: "Ultra",
    ultra: "Ultra",
    max: "Max",
    high: "High",
    medium: "Med",
    low: "Low",
  };
  let tier = null;
  let base = m;
  for (const [suffix, label] of Object.entries(tierMap)) {
    if (base.endsWith(`-${suffix}`)) {
      tier = label;
      base = base.slice(0, -(suffix.length + 1));
      break;
    }
  }
  const familyMap = {
    "gemini-4-argon": "Argon",
    "gemini-4-neon": "Neon",
    "gemini-4-carbon": "Carbon",
    "gemini-4-hydrogen": "Hydrogen",
    "gemini-3.8-flash": "3.8Flash",
    "gemini-pro-orchestrator-argon": "Orch·Argon",
    "gemini-pro-orchestrator-neon": "Orch·Neon",
    "gemini-pro-orchestrator": "Orch·Carbon",
  };
  const family = familyMap[base] ?? base.replace(/^gemini-/, "").replace(/(^|-)([a-z])/g, (_, p1, c) => (p1 ? "·" : "") + c.toUpperCase());
  return tier ? `${family}·${tier}` : family;
}

export function parseGeminiTranscript(text, {
  threadId = null,
  conversationId = null,
  now = Date.now(),
  contextWindowTokens = GEMINI_CONTEXT_WINDOW,
  compactLimitTokens = GEMINI_COMPACT_LIMIT,
  rollingWindowTokenBudget = DEFAULT_WINDOW_TOKEN_BUDGET,
} = {}) {
  const lines = String(text).split("\n");
  let model = null;
  let updatedAt = null;
  let lastInput = null;
  let lastCacheRead = null;
  let lastOutput = null;
  let prevTotalInput = null;
  let compactionCount = 0;

  let turnStartMs = null;
  let turnEndMs = null;
  let turnOutputTokens = 0;
  let lastCompletedTurnTps = null;
  let active = false;

  const windowStartMs = now - ROLLING_WINDOW_SECONDS * 1000;
  let rollingWeightedTokens = 0;
  let oldestWindowStepMs = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof step.created_at === "string" ? Date.parse(step.created_at) : null;
    if (Number.isFinite(ts)) {
      updatedAt = new Date(ts).toISOString();
    }

    if (step.type === "USER_INPUT") {
      if (turnStartMs !== null && turnEndMs !== null && turnEndMs > turnStartMs && turnOutputTokens > 0) {
        lastCompletedTurnTps = turnOutputTokens / ((turnEndMs - turnStartMs) / 1000);
      }
      turnStartMs = Number.isFinite(ts) ? ts : null;
      turnEndMs = null;
      turnOutputTokens = 0;
      active = true;
      if (typeof step.content === "string" && /(?:^|\s)\/compact(?:\s|$)/i.test(step.content)) {
        compactionCount += 1;
      }
      continue;
    }

    if (["COMPACTION", "CONTEXT_COMPACTION", "SUMMARY"].includes(step.type)) {
      compactionCount += 1;
      prevTotalInput = null;
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      if (typeof step.model === "string" && step.model) {
        model = step.model;
      }
      const inTok = numeric(step.input_tokens) ? step.input_tokens : 0;
      const cacheTok = numeric(step.cache_read_tokens) ? step.cache_read_tokens : 0;
      const outTok = numeric(step.output_tokens) ? step.output_tokens : 0;
      const totalIn = inTok + cacheTok;

      // Detect implicit/auto context compaction when total prompt tokens drop by >35% (>30k tokens)
      if (prevTotalInput !== null && prevTotalInput >= 50_000 && totalIn > 0 && totalIn < prevTotalInput * 0.65) {
        compactionCount += 1;
      }
      if (totalIn > 0) prevTotalInput = totalIn;

      lastInput = inTok;
      lastCacheRead = cacheTok;
      lastOutput = outTok;

      turnOutputTokens += outTok;
      if (Number.isFinite(ts)) {
        turnEndMs = ts;
        if (ts >= windowStartMs) {
          // Cached tokens count at 0.1x weight toward quota budget, fresh input + output at 1x/2x
          rollingWeightedTokens += inTok + Math.round(cacheTok * 0.1) + outTok * 2;
          if (oldestWindowStepMs === null || ts < oldestWindowStepMs) {
            oldestWindowStepMs = ts;
          }
        }
      }
      active = Boolean(Array.isArray(step.tool_calls) && step.tool_calls.length > 0);
    } else if (Number.isFinite(ts) && turnStartMs !== null) {
      turnEndMs = ts;
    }
  }

  let averageOutputTps = null;
  if (turnStartMs !== null && turnEndMs !== null && turnEndMs > turnStartMs && turnOutputTokens > 0) {
    averageOutputTps = turnOutputTokens / ((turnEndMs - turnStartMs) / 1000);
  } else if (lastCompletedTurnTps !== null) {
    averageOutputTps = lastCompletedTurnTps;
  }

  const totalInput = lastInput !== null && lastCacheRead !== null ? lastInput + lastCacheRead : null;
  const lastCacheRatio = totalInput && totalInput > 0 ? lastCacheRead / totalInput : null;
  const contextUsedTokens = totalInput !== null && lastOutput !== null ? totalInput + lastOutput : null;
  const contextRemainingTokens = contextUsedTokens !== null
    ? Math.max(0, contextWindowTokens - contextUsedTokens)
    : null;

  const compactRemainingTokens = contextUsedTokens !== null
    ? Math.max(0, compactLimitTokens - contextUsedTokens)
    : null;
  const compactRemainingPercent = compactRemainingTokens !== null
    ? Math.min(100, (compactRemainingTokens / compactLimitTokens) * 100)
    : null;

  const usedPercent = Math.min(100, Math.round((rollingWeightedTokens / rollingWindowTokenBudget) * 1000) / 10);
  const resetsAt = oldestWindowStepMs !== null
    ? Math.floor((oldestWindowStepMs + ROLLING_WINDOW_SECONDS * 1000) / 1000)
    : Math.floor((now + ROLLING_WINDOW_SECONDS * 1000) / 1000);

  const modelBadge = formatGeminiModelBadge(model);

  return {
    provider: "gemini",
    threadId: threadId ?? conversationId,
    conversationId,
    model,
    modelBadge,
    updatedAt,
    lastCacheRatio,
    contextUsedTokens,
    contextWindowTokens,
    contextRemainingTokens,
    compactLimitTokens,
    compactRemainingTokens,
    compactReference: compactRemainingPercent !== null
      ? {
          kind: "calibrated-compaction-estimate",
          limit: compactLimitTokens,
          remaining: compactRemainingTokens,
          remainingPercent: compactRemainingPercent,
          reserve: 0,
          source: "gemini-800k-threshold",
          sampleCount: compactionCount,
        }
      : null,
    compactionCount,
    historyComplete: true,
    averageOutputTps,
    usageResets: [
      {
        limitId: "gemini",
        limitName: "Gemini 5h",
        window: "primary",
        windowMinutes: 300,
        usedPercent,
        resetsAt,
        observedAt: updatedAt ?? new Date(now).toISOString(),
      },
    ],
    active,
    status: contextUsedTokens !== null ? "ok" : "unavailable",
    source: "antigravity-transcript",
  };
}

export class GeminiTranscriptReader {
  constructor({
    providersRoot = path.join(os.homedir(), ".t3/userdata/providers/antigravity"),
  } = {}) {
    this.providersRoot = providersRoot;
  }

  async findTranscriptFiles() {
    const files = [];
    try {
      for await (const entry of fs.glob("*/antigravity-acp/brain/*/.system_generated/logs/transcript.jsonl", {
        cwd: this.providersRoot,
      })) {
        const fullPath = path.join(this.providersRoot, entry);
        const parts = entry.split(path.sep);
        const brainIdx = parts.indexOf("brain");
        const conversationId = brainIdx >= 0 ? parts[brainIdx + 1]?.toLowerCase() : null;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) files.push({ file: fullPath, conversationId, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    } catch {}
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  }

  async snapshot(idOrNull = null, options = {}) {
    const normalized = typeof idOrNull === "string" ? idOrNull.toLowerCase() : null;
    const files = await this.findTranscriptFiles();
    if (!files.length) {
      throw new Error("未找到本地 Antigravity / Google Gemini 会话日志 (transcript.jsonl)。");
    }
    const exact = normalized ? files.find(f => f.conversationId === normalized) : null;
    const chosen = exact ?? files[0];
    const text = await fs.readFile(chosen.file, "utf8");
    return parseGeminiTranscript(text, {
      ...options,
      threadId: normalized ?? chosen.conversationId,
      conversationId: chosen.conversationId,
    });
  }
}
