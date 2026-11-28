import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedQuotaReader } from "../src/shared-quota.mjs";

const local = "11234567-89ab-cdef-0123-456789abcdef";
const remote = "21234567-89ab-cdef-0123-456789abcdef";
const now = Date.parse("2026-11-25T10:00:00Z");
const context = { environmentId: remote, threadId: "chat", provider: "gemini",
  providerInstanceId: "remote-google", model: "gemini-4-argon-high" };
const resetsAt = new Date(now + 3600000).toISOString();

async function setup(t, provider = "gemini") {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "t3-shared-quota-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, "userdata"));
  await fs.mkdir(path.join(folder, "caches"));
  await fs.writeFile(path.join(folder, "userdata/environment-id"), local);
  const p = { instanceId: "source", driver: provider === "gemini" ? "antigravity" : "codex",
    auth: { status: "authenticated", type: "subscription", email: "one@example.test" },
    usageLimits: { checkedAt: new Date(now).toISOString(), windows: provider === "gemini" ? [
      { id: "gemini-5h", kind: "session", windowDurationMins: 300, usedPercent: 22, resetsAt },
      { id: "gemini-weekly", kind: "weekly", windowDurationMins: 10080, usedPercent: 31, resetsAt },
      { id: "3p-5h", kind: "session", windowDurationMins: 300, usedPercent: 99, resetsAt },
    ] : [{ id: "primary", kind: "weekly", usedPercent: 40, resetsAt }],
    resetCredits: { availableCount: 9, nextExpiresAt: new Date(now + 10000).toISOString() } },
  };
  const file = path.join(folder, "caches/source.json");
  await fs.writeFile(file, JSON.stringify(p));
  const reader = new SharedQuotaReader({ t3Home: folder, file: path.join(folder, "shared-quota.json"), now: () => now });
  const ctx = provider === "gemini" ? context : { ...context, provider, providerInstanceId: "remote-codex", model: "gpt-6.1-sol" };
  const configure = () => reader.configure({ targetEnvironmentId: remote,
    targetProviderInstanceId: ctx.providerInstanceId, sourceProviderInstanceId: "source", provider });
  return { reader, p, file, ctx, configure };
}

test("only an explicitly configured remote connection can borrow local quota", async t => {
  const { reader, configure } = await setup(t);
  assert.equal(await reader.reference(null, context, local), null);
  await configure();
  const result = await reader.reference(null, context, local);
  assert.deepEqual(result.usageResets.map(w => w.usedPercent), [22, 31]);
  assert.equal(result.environmentId, remote);
  assert.equal(result.threadId, "chat");
  assert.equal(result.sourceInstanceId, "remote-google");
  assert.equal(result.referenceEnvironmentId, local);
  assert.equal(result.resetCardCount, null);
  assert.equal(result.contextUsedTokens, undefined);
  assert.equal(result.averageOutputTps, undefined);
  assert.doesNotMatch(JSON.stringify(result), /example\.test/);
  assert.equal(await reader.reference(null, { ...context, providerInstanceId: "unconfirmed" }, local), null);
  assert.equal(await reader.reference(null, { ...context, environmentId: local }, local), null);
  assert.equal(await reader.reference(null, { ...context, provider: "codex" }, local), null);
});

test("valid remote quota wins; local quota can replace unsupported or expired remote records", async t => {
  const { reader, configure } = await setup(t);
  await configure();
  const account = { usageResets: [{ usedPercent: 80, resetsAt: (now + 60000) / 1000 }] };
  assert.equal(await reader.reference(account, context, local), account);
  const unsupported = { usageState: "unsupported", usageUrl: "https://chatgpt.com/#settings/Usage", usageResets: [] };
  const result = await reader.reference(unsupported, context, local);
  assert.equal(result.usageState, undefined);
  assert.equal(result.usageUrl, undefined);
  const expired = { usageResets: [{ usedPercent: 99, resetsAt: (now - 1000) / 1000 }] };
  assert.equal((await reader.reference(expired, context, local)).usageResets[0].usedPercent, 22);
});

test("changing the source account, environment or cache identity disables the reference", async t => {
  const { reader, p, file, configure } = await setup(t);
  await configure();
  assert.equal(await reader.reference(null, context, remote), null);
  p.auth.email = "different-longer@example.test";
  await fs.writeFile(file, JSON.stringify(p));
  assert.equal(await reader.reference(null, context, local), null);
  p.auth.email = "one@example.test";
  p.instanceId = "different-source";
  await fs.writeFile(file, JSON.stringify(p));
  assert.equal(await reader.reference(null, context, local), null);
});

test("Codex quota reference preserves remote card data and never substitutes local cards", async t => {
  const { reader, ctx, configure } = await setup(t, "codex");
  await configure();
  const remoteAccount = { resetCardCount: 2, resetCards: [{ expiresAt: (now + 200000) / 1000 }] };
  const result = await reader.reference(remoteAccount, ctx, local);
  assert.equal(result.usageResets[0].usedPercent, 40);
  assert.equal(result.resetCardCount, 2);
  assert.deepEqual(result.resetCards, remoteAccount.resetCards);
  assert.equal((await reader.reference(null, ctx, local)).resetCardCount, null);
});

test("invalid, missing and obsolete local data remains unknown", async t => {
  const { reader, p, file, configure } = await setup(t);
  await configure();
  p.usageLimits.checkedAt = new Date(now - 8 * 86400000).toISOString();
  await fs.writeFile(file, JSON.stringify(p));
  assert.equal(await reader.reference(null, context, local), null);
  await fs.writeFile(file, "incomplete JSON");
  assert.equal(await reader.reference(null, context, local), null);
  await assert.rejects(reader.configure({ targetEnvironmentId: remote, sourceProviderInstanceId: "source", provider: "gemini" }));
});
