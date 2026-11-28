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

test("an expired login renews in the background and fresh quota still requires the pinned account", async () => {
  const renewal = Promise.withResolvers();
  const t3Home = "/test/t3";
  let expiry = now - 1000, renewals = 0, requests = 0, identity = "account-id";
  const reader = new GeminiQuotaReader({
    now: () => now,
    readCredential: async () => ({ token: { access_token: `test-token-${identity}`, expiry: new Date(expiry).toISOString() } }),
    renewCredential: dir => { assert.equal(dir, t3Home); renewals++; return renewal.promise; },
    request: async url => {
      requests++;
      return { ok: true, json: async () => url.includes("userinfo") ? { id: identity } : summary };
    },
  });
  assert.equal(await reader.read(source, { t3Home }), null);
  assert.equal(await reader.read(source, { t3Home }), null);
  assert.equal(renewals, 1);
  assert.equal(requests, 0);

  expiry = now + 3600000;
  renewal.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok((await reader.read(source, { t3Home })).windows.length);
  assert.equal(requests, 2);
  identity = "another-account";
  assert.equal(await reader.read({ ...source, providerInstanceId: "second" }, { t3Home }), null);
  assert.equal(requests, 3);
});

test("quota stays available while renewing a token that is close to expiry", async () => {
  const t3Home = "/test/t3";
  const pending = Promise.withResolvers();
  let clock = now, expiry = now + 301000, renewals = 0;
  const reader = new GeminiQuotaReader({
    now: () => clock,
    readCredential: async () => ({ token: { access_token: "test-token", expiry: new Date(expiry).toISOString() } }),
    renewCredential: () => { renewals++; return pending.promise; },
    request: async url => ({ ok: true, json: async () => url.includes("userinfo") ? { id: "account-id" } : summary }),
  });

  const first = await reader.read(source, { t3Home });
  assert.equal(renewals, 0);
  clock += 2000;
  assert.equal(await reader.read(source, { t3Home }), first);
  assert.equal(renewals, 1);
  clock += 12000;
  assert.equal(await reader.read(source, { t3Home }), first);
  assert.equal(renewals, 1);

  expiry = now + 3600000;
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const renewed = await reader.read(source, { t3Home });
  assert.ok(renewed);
  assert.notEqual(renewed.checkedAt, first.checkedAt);
  assert.equal(renewals, 1);
});

test("the last minute retries a renewal that failed or left the expiry unchanged", async () => {
  const t3Home = "/test/t3";
  let clock = now, expiry = now + 57000, renewals = 0;
  const reader = new GeminiQuotaReader({
    now: () => clock,
    readCredential: async () => ({ token: { access_token: "test-token", expiry: new Date(expiry).toISOString() } }),
    renewCredential: async () => {
      renewals++;
      if (renewals === 1) throw new Error("Offline");
      if (renewals === 3) expiry = now + 3600000;
    },
    request: async url => ({ ok: true, json: async () => url.includes("userinfo") ? { id: "account-id" } : summary }),
  });
  const first = await reader.read(source, { t3Home });
  assert.equal(renewals, 1);
  clock += 9000;
  assert.equal(await reader.read(source, { t3Home }), first);
  assert.equal(renewals, 1);
  clock += 1000;
  assert.equal(await reader.read(source, { t3Home }), first);
  assert.equal(renewals, 2);
  await new Promise(resolve => setImmediate(resolve));
  clock += 10000;
  assert.equal(await reader.read(source, { t3Home }), first);
  assert.equal(renewals, 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual((await reader.read(source, { t3Home })).checkedAt, first.checkedAt);
});

test("device login renews with no quota mapping or open Gemini session", async () => {
  const t3Home = "/test/t3";
  let clock = now, expiry = NaN, probes = 0, renewals = 0;
  const reader = new GeminiQuotaReader({
    now: () => clock,
    readExpiry: async () => { probes++; return expiry; },
    renewCredential: async home => {
      assert.equal(home, t3Home);
      renewals++;
      expiry = clock + 3600000;
    },
    request: async () => assert.fail("Device renewal must not request account quota"),
  });
  await reader.maintainLogin(t3Home);
  assert.equal(renewals, 0);
  assert.equal(probes, 1);

  expiry = now + 361000;
  clock += 60000;
  await reader.maintainLogin(t3Home);
  assert.equal(renewals, 0);
  clock += 2000;
  await reader.maintainLogin(t3Home);
  assert.equal(renewals, 1);
  await reader.maintainLogin(t3Home);
  assert.equal(renewals, 1);
  assert.equal(probes, 3);
});

test("a long-expired login retries at most once a minute", async () => {
  let clock = now, renewals = 0;
  const reader = new GeminiQuotaReader({
    now: () => clock,
    readExpiry: async () => now - 120000,
    renewCredential: async () => { renewals++; throw new Error("Authorization revoked"); },
  });
  await reader.maintainLogin("/test/t3");
  clock += 10000;
  await reader.maintainLogin("/test/t3");
  assert.equal(renewals, 1);
  clock += 50000;
  await reader.maintainLogin("/test/t3");
  assert.equal(renewals, 2);
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
