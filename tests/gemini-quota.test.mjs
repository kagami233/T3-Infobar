import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GeminiQuotaReader, parseQuotaSummary } from "../src/gemini-quota.mjs";
import { mergeRemoteMetrics, nativeQuotaAccount } from "../src/remote-metrics.mjs";

const now = Date.parse("2026-11-25T16:49:52Z");
const reset = "2026-11-25T18:37:55Z", weekly = "2026-12-02T08:37:55Z";
const expectedFingerprint = createHash("sha256").update("google-account\0account-id").digest("hex");
const source = { providerInstanceId: "google", credentialStore: "macos-keychain", expectedFingerprint };
const summary = { description: "PRIVATE DESCRIPTION", groups: [{ buckets: [
  { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.49658275, resetTime: weekly },
  { bucketId: "gemini-5h", window: "5h", remainingFraction: 0, resetTime: reset },
  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5681136, resetTime: weekly },
] }] };

test("native Gemini quotas use the pinned account, refresh once a minute, and transport no credentials", async () => {
  let clock = now, calls = [], identity = "account-id";
  const reader = new GeminiQuotaReader({ now: () => clock,
    readCredential: async () => ({ token: { access_token: "PRIVATE TOKEN", expiry: new Date(clock + 3600000).toISOString() } }),
    request: async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer PRIVATE TOKEN");
      calls.push(url);
      return { ok: true, json: async () => url.includes("userinfo") ? { id: identity, email: "PRIVATE EMAIL" } : summary };
    },
  });
  const result = await reader.read(source);
  assert.equal(result.windows.find(w => w.id === "gemini-5h").usedPercent, 100);
  assert.ok(Math.abs(result.windows[0].usedPercent - 50.341725) < 1e-6);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|account-id|expectedFingerprint|access_token/);
  assert.equal(await reader.read(source), result);
  assert.equal(calls.length, 2);
  clock += 60000;
  assert.notEqual((await reader.read(source)).checkedAt, result.checkedAt);
  assert.equal(calls.length, 3);
  assert.equal(await reader.read({ ...source, expectedFingerprint: "f".repeat(64) }), null);
  assert.equal(calls.length, 3); // cached token identity still rejects a different account pin
});

test("failed or expired sign-in never revives an old weekly quota", async () => {
  let clock = now, fail = false;
  const reader = new GeminiQuotaReader({ now: () => clock,
    readCredential: async () => { if (fail) throw new Error("PRIVATE ERROR"); return { token: { access_token: "secret", expiry: new Date(now + 120000).toISOString() } }; },
    request: async url => ({ ok: true, json: async () => url.includes("userinfo") ? { id: "account-id" } : summary }),
  });
  assert.ok(await reader.read(source));
  clock += 60000; fail = true;
  assert.equal(await reader.read(source), null);
  clock += 120000; fail = false;
  assert.equal(await reader.read(source), null);
});

test("quota transport follows the native model binding and separates Gemini from third-party weekly pools", () => {
  const base = { status: "ok", provider: "gemini", providerInstanceId: "google", model: "gemini-4-argon",
    environmentId: "remote", appThreadId: "app", threadId: "chat", nativeThreadId: "native" };
  const nativeQuota = { checkedAt: new Date(now).toISOString(), windows: parseQuotaSummary(summary) };
  const doc = { version: 1, environmentId: "remote", collectedAt: now, entries: [{ ...base, nativeQuota, contextUsedTokens: 100 }] };
  const merged = mergeRemoteMetrics(base, doc, now);
  const context = { ...base, providerInstanceId: "google" };
  const account = nativeQuotaAccount(merged, context, now);
  assert.equal(account.usageResets[0].usedPercent, 100);
  assert.ok(Math.abs(account.usageResets[1].usedPercent - 50.341725) < 1e-6);
  assert.equal(nativeQuotaAccount(mergeRemoteMetrics(base, { ...doc, entries: [{ ...doc.entries[0], model: "gemini-4-carbon" }] }, now), context, now), null);
  assert.equal(nativeQuotaAccount(mergeRemoteMetrics(base, doc, now + 91000), context, now + 91000), null);
  const scoped = { ...merged, nativeQuota: { ...nativeQuota, windows: [...nativeQuota.windows,
    { id: "gemini-argon-weekly", kind: "weekly", usedPercent: 70, resetsAt: weekly },
    { id: "gemini-carbon-weekly", kind: "weekly", usedPercent: 99, resetsAt: weekly }] } };
  assert.deepEqual(nativeQuotaAccount(scoped, context, now).usageResets.map(w => w.usedPercent), [70]);
});
