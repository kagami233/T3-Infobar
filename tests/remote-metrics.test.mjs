import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { geminiTelemetry, collectDocument, runAgent } from "../src/remote-agent.mjs";
import { parseGeminiTranscript } from "../src/gemini-reader.mjs";
import { RolloutReader } from "../src/reader.mjs";
import { mergeRemoteMetrics, RemoteMetricsReader } from "../src/remote-metrics.mjs";
import { activeRegistrations, collectorRevision, registrationFile, renewAfterMs } from "../src/remote-registration.mjs";

const env = "21234567-89ab-cdef-0123-456789abcdef";
const nativeId = "31234567-89ab-cdef-0123-456789abcdef";
const now = Date.parse("2026-11-25T10:00:30Z");
const base = { status: "ok", environmentId: env, appThreadId: "app-thread", nativeThreadId: nativeId,
  provider: "gemini", providerInstanceId: "google", model: "gemini-4-argon", contextUsedTokens: 100000,
  usageResets: [{ usedPercent: 20 }], resetCardCount: 4 };
function document(entry = {}) {
  return { version: 1, environmentId: env, collectedAt: now, entries: [{ ...base,
    averageOutputTps: 40, lastCacheRatio: 0.8, compactionCount: 2, historyComplete: false,
    compactReference: { kind: "calibrated-compaction-estimate", limit: 800000, reserve: 0, sampleCount: 2 },
    ...entry }] };
}
async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-remote-metrics-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("only the four native-log metrics merge into the matching remote binding", () => {
  const result = mergeRemoteMetrics(base, document({ contextUsedTokens: 900000, usageResets: [], resetCardCount: 99 }), now);
  assert.equal(result.averageOutputTps, 40);
  assert.equal(result.lastCacheRatio, 0.8);
  assert.equal(result.compactionCount, 2);
  assert.equal(result.compactReference.remainingPercent, 87.5);
  assert.equal(result.contextUsedTokens, 100000);
  assert.equal(mergeRemoteMetrics({ ...base, lastCacheRatio: 0.9 }, document({ lastCacheRatio: null }), now).lastCacheRatio, 0.9);
  assert.equal(result.resetCardCount, 4);
  assert.deepEqual(result.usageResets, base.usageResets);
  for (const change of [{ nativeThreadId: "wrong" }, { providerInstanceId: "wrong" }, { appThreadId: "wrong" }, { provider: "codex" }]) {
    assert.equal(mergeRemoteMetrics(base, document(change), now), base);
  }
  assert.equal(mergeRemoteMetrics(base, { ...document(), collectedAt: now - 31000 }, now), base);
  assert.equal(mergeRemoteMetrics(base, { ...document(), environmentId: "wrong" }, now), base);
});

test("truncated, malformed and failed remote file reads preserve projected data", async t => {
  const dir = await folder(t), file = path.join(dir, "sources.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, sources: [{ environmentId: env, cwd: "/owned/infobar" }] }));
  let response = { contents: JSON.stringify(document()), truncated: true };
  const reader = new RemoteMetricsReader({ file, now: () => now, rpc: async (_, environment, method, args) => {
    assert.equal(environment, env); assert.equal(method, "projects.readFile");
    assert.deepEqual(args, { cwd: "/owned/infobar", relativePath: "snapshots.json" });
    return response;
  } });
  assert.equal(await reader.read({}, base), base);
  response = { contents: "unfinished JSON" };
  assert.equal(await reader.read({}, base), base);
  response = { contents: JSON.stringify(document()), truncated: false };
  assert.equal((await reader.read({}, base)).averageOutputTps, 40);
  const waiting = { ...base, status: "unavailable", contextUsedTokens: null, contextWindowTokens: null,
    contextRemainingTokens: null, warning: "waiting for projection" };
  response = { contents: JSON.stringify(document({ contextUsedTokens: 51856, contextWindowTokens: 258400,
    averageOutputTps: null, lastCacheRatio: 0.919, compactionCount: 1 })), truncated: false };
  const recovered = await reader.read({}, waiting);
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.contextRemainingTokens, 206544);
  assert.equal(recovered.lastCacheRatio, 0.919);
  assert.equal(recovered.compactionCount, 1);
  assert.equal(recovered.averageOutputTps, null);
  assert.equal(recovered.warning, undefined);
  assert.equal(mergeRemoteMetrics({ ...waiting, nativeThreadId: "another-native" }, JSON.parse(response.contents), now).status, "unavailable");
});

test("Gemini telemetry strips private content and counts only recorded compaction events", async t => {
  const dir = await folder(t), file = path.join(dir, "transcript.jsonl");
  const response = { type: "PLANNER_RESPONSE", step_index: 1, created_at: "2026-11-25T10:00:10Z",
    model: "gemini-4-argon-high", input_tokens: 50000, cache_read_tokens: 10000, output_tokens: 600,
    content: "PRIVATE RESPONSE", tool_calls: [{ arguments: "PRIVATE TOOL" }] };
  const events = [{ type: "USER_INPUT", created_at: "2026-11-25T10:00:00Z", content: "PRIVATE PROMPT /compact" },
    response, response,
    { type: "TOOL_RESPONSE", created_at: "2026-11-25T10:00:12Z", content: "PRIVATE RESULT" },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: "2026-11-25T10:00:20Z", input_tokens: 9000, cache_read_tokens: 26000, output_tokens: 200 },
    { type: "CONTEXT_COMPACTION", created_at: "2026-11-25T10:00:22Z", summary: "PRIVATE SUMMARY" }];
  await fs.writeFile(file, events.map(e => JSON.stringify(e)).join("\n"));
  const telemetry = await geminiTelemetry(file);
  assert.doesNotMatch(telemetry.text, /PRIVATE|arguments|summary/);
  const data = parseGeminiTranscript(telemetry.text, { recordedCompactionsOnly: true, strictUsage: true });
  assert.equal(data.averageOutputTps, 40);
  assert.equal(data.lastCacheRatio, 26000 / 35000);
  assert.equal(data.compactionCount, 1);
  assert.equal(data.historyComplete, false);
  const missing = parseGeminiTranscript(JSON.stringify({ type: "PLANNER_RESPONSE", output_tokens: 100 }), { strictUsage: true });
  assert.equal(missing.lastCacheRatio, null);
  assert.equal(missing.contextUsedTokens, null);
});

test("opened remote sessions register independently, renew and expire on the collector clock", async t => {
  const dir = await folder(t), file = path.join(dir, "sources.json");
  await fs.mkdir(path.join(dir, "registrations"));
  await fs.writeFile(file, JSON.stringify({ version: 1, sources: [{ environmentId: env, cwd: dir }] }));
  let clock = Date.now(), writes = 0, revision = 4, rejectWrite = false;
  const reader = new RemoteMetricsReader({ file, now: () => clock, rpc: async (_, environment, method, payload) => {
    assert.equal(environment, env);
    if (method === "projects.readFile") return { contents: JSON.stringify({ ...document(),
      collectedAt: clock, collectorRevision: revision }) };
    assert.equal(method, "projects.writeFile");
    writes++;
    if (rejectWrite) throw new Error("offline");
    await fs.writeFile(path.join(dir, payload.relativePath), payload.contents);
  } });
  await reader.read({}, base);
  assert.equal(writes, 0);
  revision = collectorRevision;
  rejectWrite = true;
  assert.equal((await reader.read({}, base)).averageOutputTps, 40);
  rejectWrite = false;
  clock += 6000;
  const imported = { ...base, appThreadId: "import:codex:" + nativeId };
  await Promise.all([reader.read({}, base), reader.read({}, imported), reader.read({}, imported)]);
  assert.equal(writes, 3);
  await reader.read({}, imported);
  assert.equal(writes, 3);
  const idle = registrationFile(env, "settled", false);
  await fs.writeFile(path.join(dir, idle.relativePath), idle.contents);
  assert.deepEqual(new Set(await activeRegistrations(dir, env, clock)), new Set([base.appThreadId, imported.appThreadId]));
  assert.deepEqual(await activeRegistrations(dir, "other", clock), []);
  clock += renewAfterMs;
  await reader.read({}, base);
  assert.equal(writes, 4);
  assert.deepEqual(await activeRegistrations(dir, env, clock + 180000), []);
});

test("the remote agent follows the active SQLite binding and writes a telemetry-only document", async t => {
  const dir = await folder(t);
  await fs.mkdir(path.join(dir, "userdata"));
  await fs.writeFile(path.join(dir, "userdata/environment-id"), env);
  const db = new DatabaseSync(path.join(dir, "userdata/statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, active_provider_thread_id TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, driver TEXT, provider_instance_id TEXT, payload_json TEXT);`);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)").run("app-thread", "binding",
    JSON.stringify({ modelSelection: { instanceId: "google", model: "gemini-4-argon" } }));
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)").run("binding", "antigravity", "google",
    JSON.stringify({ nativeThreadRef: { nativeId }, contextUsage: { maxTokens: 1048576 } }));
  db.close();
  const logs = path.join(dir, "userdata/providers/antigravity/profile/antigravity-acp/brain", nativeId, ".system_generated/logs");
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, "transcript.jsonl"), [
    { type: "USER_INPUT", created_at: "2026-11-25T10:00:00Z", content: "PRIVATE PROMPT" },
    { type: "PLANNER_RESPONSE", created_at: "2026-11-25T10:00:10Z", input_tokens: 1000, cache_read_tokens: 2000, output_tokens: 500 },
  ].map(e => JSON.stringify(e)).join("\n"));
  const config = { version: 1, environmentId: env, t3Home: dir, threads: ["app-thread"] };
  const doc = await collectDocument(config, now);
  assert.equal(doc.entries[0].averageOutputTps, 50);
  assert.equal(doc.entries[0].lastCacheRatio, 2 / 3);
  assert.equal(doc.entries[0].nativeThreadId, nativeId);
  assert.equal(doc.entries[0].compactionCount, 0);
  assert.doesNotMatch(JSON.stringify(doc), /PRIVATE PROMPT|transcript\.jsonl|caches|tool_calls/);
  const quota = { checkedAt: new Date(now).toISOString(), windows: [{ id: "gemini-weekly", kind: "weekly", usedPercent: 50 }] };
  const withQuota = await collectDocument({ ...config, quotaSources: [{ providerInstanceId: "google" }] }, now,
    { quotaReader: { read: async source => { assert.equal(source.providerInstanceId, "google"); return quota; } } });
  assert.deepEqual(withQuota.entries[0].nativeQuota, quota);
  await assert.rejects(collectDocument({ ...config, environmentId: nativeId }));
  const configPath = path.join(dir, "collector.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  await runAgent(configPath, { once: true });
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "snapshots.json"), "utf8")).entries[0].status, "ok");
  await runAgent(configPath, { once: true, snapshotFile: "probe-snapshots.json" });
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "probe-snapshots.json"), "utf8")).collectorRevision, collectorRevision);
  const registration = registrationFile(env, "app-thread");
  await fs.mkdir(path.join(dir, "registrations"));
  await fs.writeFile(path.join(dir, registration.relativePath), registration.contents);
  await fs.writeFile(configPath, JSON.stringify({ ...config, threads: [] }));
  await runAgent(configPath, { once: true });
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "snapshots.json"), "utf8")).entries[0].averageOutputTps, 50);
  await assert.rejects(runAgent(configPath, { once: true, snapshotFile: "../outside.json" }));
});

test("a fork reads only its own ordinal range, retaining the binding check after the boundary", async t => {
  const home = await folder(t);
  const dir = path.join(home, "sessions/2026/11/28");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "rollout-test-" + nativeId + ".jsonl");
  const rows = [
    ["session_meta", { id: nativeId, subagent_history_start_ordinal: 5 }],
    ["session_meta", { id: env }],
    ["event_msg", { type: "task_started", turn_id: "parent" }],
    ["token_usage_record", { usage: { total_tokens: 90000 } }],
    ["compacted", { turn_id: "parent" }],
    ["event_msg", { type: "task_started", turn_id: "child", model_context_window: 1000 }],
    ["token_usage_record", { thread_id: nativeId, turn_id: "child", usage: { total_tokens: 200 },
      turn_token_usage: { output_tokens: 40 } }],
    ["event_msg", { type: "task_complete", turn_id: "child", duration_ms: 2000 }],
  ];
  const write = () => fs.writeFile(file, rows.map(([type, payload], ordinal) =>
    JSON.stringify({ type, payload, ordinal, timestamp: new Date(now + ordinal * 1000).toISOString() })).join("\n"));
  await write();
  const reader = new RolloutReader({ codexHome: home });
  const snapshot = await reader.snapshot(nativeId);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.contextRemainingTokens, 800);
  assert.equal(snapshot.averageOutputTps, 20);
  assert.equal(snapshot.compactionCount, 0);
  rows.push(["session_meta", { id: env }]);
  await write();
  assert.equal((await reader.snapshot(nativeId)).status, "unavailable");
});
