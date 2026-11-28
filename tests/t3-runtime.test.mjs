import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectionSnapshot, mountedThreadProjection, sessionKey } from "../src/t3-runtime.mjs";
import { SnapshotCache } from "../src/snapshot-cache.mjs";

const id = "01234567-89ab-cdef-0123-456789abcdef";
const local = "11234567-89ab-cdef-0123-456789abcdef";
const remote = "21234567-89ab-cdef-0123-456789abcdef";
const context = { environmentId: remote, threadId: id, appThreadId: `import:codex_example:${id}` };
function projection() {
  return { environmentId: remote, threadId: context.appThreadId, model: "gpt-6.1-sol",
    binding: { id: "binding", driver: "codex", providerInstanceId: "codex",
      contextUsage: { usedTokens: 70000, maxTokens: 200000 } },
    turns: [{ providerThreadId: "binding", status: "running", tokenUsage: {
      usedTokens: 81000, maxTokens: 200000, inputTokens: 60000, cachedInputTokens: 50000,
      outputTokens: 1000, updatedAt: "2026-11-25T10:00:00Z" } }],
  };
}

test("remote projection reports context and cache while keeping unsupported metrics unknown", () => {
  const p = projection();
  p.turns.push({ providerThreadId: "another-binding", tokenUsage: { usedTokens: 99999 } });
  const value = projectionSnapshot(p, context);
  assert.equal(value.contextRemainingTokens, 119000);
  assert.equal(value.lastCacheRatio, 5 / 6);
  assert.equal(value.averageOutputTps, null);
  assert.equal(value.compactionCount, null);
  assert.equal(value.historyComplete, false);
  assert.equal(value.status, "ok");
  assert.equal(projectionSnapshot(p, { ...context, environmentId: local }).status, "unavailable");
  assert.equal(projectionSnapshot(p, { ...context, appThreadId: id }).status, "unavailable");
});

test("remote Gemini can report context without token usage or fabricated cache and quota", () => {
  const p = projection();
  p.model = "gemini-4-argon";
  p.thinkingLevel = "high";
  p.binding.driver = "antigravity";
  p.binding.contextUsage = { usedTokens: 349423, maxTokens: 1048576 };
  p.turns = [];
  const value = projectionSnapshot(p, context);
  assert.equal(value.contextRemainingTokens, 699153);
  assert.equal(value.lastCacheRatio, null);
  assert.equal(value.modelBadge, "Argon·High");
  assert.deepEqual(value.usageResets, []);
});

test("a new running provider turn preserves the last recorded usage and active state", () => {
  const p = projection();
  p.turns[0].status = "completed";
  p.turns.push({ providerThreadId: "binding", status: "running", tokenUsage: null });
  const snapshot = projectionSnapshot(p, context);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.contextUsedTokens, 81000);
  assert.equal(snapshot.active, true);
});

test("browser projection reader sends only telemetry from the exact environment and app ID", async () => {
  const p = projection();
  const full = { thread: { id: context.appThreadId, activeProviderThreadId: "binding", modelSelection: { model: p.model } },
    providerThreads: [{ ...p.binding, nativeThreadRef: { nativeId: id }, secret: "secret" }],
    providerTurns: p.turns, messages: [{ text: "private prompt" }] };
  const host = { __reactFiber$test: { memoizedState: { memoizedState: { environmentId: remote, projection: full } } } };
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = { desktopBridge: { getHostEnvironmentId: async () => local } };
  globalThis.document = { querySelectorAll: () => [host] };
  try {
    const result = await mountedThreadProjection(context);
    assert.equal(result.localEnvironmentId, local);
    assert.equal(result.projection.binding.nativeId, id);
    assert.doesNotMatch(JSON.stringify(result), /private prompt|secret/);
    assert.equal((await mountedThreadProjection({ ...context, environmentId: local })).projection, null);
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

test("disk cache isolates identical native IDs across machines and retains provider identity", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "t3-scoped-cache-"));
  try {
    const cache = new SnapshotCache({ file: path.join(folder, "cache.json"), now: () => 10000 });
    const a = { snapshot: { ...projectionSnapshot(projection(), context), provider: "gemini", modelBadge: "Argon·High" }, receivedAt: 9000 };
    const b = { snapshot: { ...a.snapshot, environmentId: local, provider: "codex", modelBadge: null }, receivedAt: 9000 };
    await cache.save(new Map([[sessionKey(a.snapshot), a], [sessionKey(b.snapshot), b]]));
    const loaded = await cache.load();
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get(sessionKey(a.snapshot)).snapshot.provider, "gemini");
    assert.equal(loaded.get(sessionKey(b.snapshot)).snapshot.provider, "codex");
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
