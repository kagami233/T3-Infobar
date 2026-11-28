import assert from "node:assert/strict";
import test from "node:test";
import { parseQuotaFailure, applyQuotaRestriction } from "../src/quota-policy.mjs";
import { selectT3Account, createT3AccountReader } from "../src/t3-account.mjs";

const checkedAt = Date.parse("2026-11-25T14:35:32Z");
const failedAt = Date.parse("2026-11-25T16:33:06Z");
const now = failedAt + 60000;
const reset = Date.parse("2026-11-25T18:37:55Z") / 1000;
const context = { environmentId: "remote", threadId: "chat", provider: "gemini", providerInstanceId: "google", model: "gemini-4-argon" };
const provider = { environmentId: "remote", instanceId: "google", driver: "antigravity", auth: { status: "authenticated" },
  usageLimits: { checkedAt: new Date(checkedAt).toISOString(), windows: [
    { id: "gemini-5h", usedPercent: 22.06668, resetsAt: new Date(reset * 1000).toISOString() },
    { id: "gemini-weekly", usedPercent: 31.63888, kind: "weekly", resetsAt: new Date((reset + 86400) * 1000).toISOString() },
  ] } };
const error = { type: "error", status: "failed", title: "Usage limit reached", completedAt: new Date(failedAt).toISOString(),
  text: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h4m48s." };

test("a real quota failure overrides stale 78 percent without fabricating weekly usage", () => {
  const account = selectT3Account([provider], context, now);
  assert.deepEqual(account.usageResets.map(w => w.usedPercent), [null, null]);
  const restriction = parseQuotaFailure(error);
  assert.deepEqual(restriction, { observedAt: failedAt, resetsAt: reset - 1 });
  assert.deepEqual(parseQuotaFailure({ ...error, text: undefined, failure: {
    class: "usage_limit", code: "RESOURCE_EXHAUSTED", resetAt: new Date((reset - 1) * 1000).toISOString(),
  } }), restriction);
  const snapshot = { ...context, quotaRestriction: restriction };
  const blocked = applyQuotaRestriction(account, snapshot, now);
  assert.deepEqual(blocked.usageResets.map(w => w.usedPercent), [100, null]);
  assert.equal(blocked.usageResets[0].restrictionUntil, reset - 1);
  assert.equal(applyQuotaRestriction(account, snapshot, reset * 1000), account);
  assert.equal(parseQuotaFailure({ ...error, type: "assistant_message" }), null);
  assert.equal(parseQuotaFailure({ ...error, text: "Please retry later" }), null);
  assert.equal(parseQuotaFailure({ ...error, completedAt: "invalid" }), null);
  const recovered = { ...account, observedAt: now, usageResets: [{ ...account.usageResets[0], usedPercent: 12 }] };
  assert.equal(applyQuotaRestriction(recovered, snapshot, now), recovered);
  const localReference = { ...recovered, referenceEnvironmentId: "local" };
  assert.equal(applyQuotaRestriction(localReference, snapshot, now).usageResets[0].usedPercent, 100);
  const unknown = applyQuotaRestriction(null, snapshot, now);
  assert.equal(unknown.usageResets[0].usedPercent, null);
  assert.equal(unknown.usageResets[0].resetsAt, reset - 1);
  const ambiguous = { ...account, usageResets: [account.usageResets[0], { ...account.usageResets[1], resetsAt: reset }] };
  assert.ok(applyQuotaRestriction(ambiguous, snapshot, now).usageResets.every(w => w.usedPercent === null));
});

test("Gemini percentages expire after 90 seconds while reset timestamps remain intact", () => {
  assert.equal(selectT3Account([provider], context, checkedAt + 90000).usageResets[0].usedPercent, 22.06668);
  const stale = selectT3Account([provider], context, checkedAt + 90001);
  assert.equal(stale.usageResets[0].usedPercent, null);
  assert.equal(stale.usageResets[0].resetsAt, reset);
});

test("quota refresh is scoped and throttled; a failed probe never makes old percentages fresh", async () => {
  let clock = now;
  const calls = [];
  const reader = createT3AccountReader({ now: () => clock, rpc: async (_, env, method, args) => {
    calls.push({ env, method, args });
    return method === "infobar.readQuota" ? [provider] : [];
  } });
  const client = { evaluate() { throw new Error("No fallback expected"); } };
  assert.equal((await reader(client, context)).usageResets[0].usedPercent, null);
  assert.equal(calls.length, 2);
  await reader(client, context); assert.equal(calls.length, 2);
  clock += 16000; await reader(client, context);
  assert.equal(calls.filter(c => c.method === "infobar.refreshQuota").length, 1);
  clock += 60000; await reader(client, context);
  assert.equal(calls.filter(c => c.method === "infobar.refreshQuota").length, 2);
  assert.ok(calls.every(c => c.env === context.environmentId && c.args.instanceId === "google"));
});
