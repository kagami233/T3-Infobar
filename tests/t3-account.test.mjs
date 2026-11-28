import assert from "node:assert/strict";
import test from "node:test";
import { createT3AccountReader, selectT3Account } from "../src/t3-account.mjs";

const now = Date.now();
const context = { provider: "codex", providerInstanceId: "shared", model: "gpt-6.1-sol", defaultCodexHome: "C:\\User\\.codex" };
function providers() {
  return [{ instanceId: "shared", driver: "codex",
    auth: { status: "authenticated", type: "chatgpt", email: "one@example.test", subscriptionSharing: true },
    runtimePaths: { homePath: "C:\\User\\.codex" },
    usageLimits: { checkedAt: new Date(now).toISOString(), windows: [], unavailable: { reason: "unsupported" } },
  }, { instanceId: "codex", driver: "codex",
    auth: { status: "authenticated", type: "chatgpt", email: "one@example.test" },
    usageLimits: { checkedAt: new Date(now).toISOString(),
      windows: [{ kind: "weekly", usedPercent: 29, windowDurationMins: 10080, resetsAt: new Date(now + 86400000).toISOString() }],
      resetCredits: { availableCount: 3, nextExpiresAt: new Date(now + 172800000).toISOString() },
    },
  }];
}

test("shared connection never substitutes the same-email independent quota", () => {
  const result = selectT3Account(providers(), context, now);
  assert.equal(result.sourceBadge, null);
  assert.equal(result.usageState, "unsupported");
  assert.deepEqual(result.usageResets, []);
  assert.equal(result.resetCardCount, null);
  assert.equal(result.usageUrl, "https://chatgpt.com/#settings/Usage");
  assert.equal(result.sourceInstanceId, "shared");
  assert.equal(JSON.stringify(result).includes("example.test"), false);
});
test("another account or workspace never supplies quota", () => {
  const p = providers();
  p[1].auth.email = "other@example.test";
  assert.equal(selectT3Account(p, context, now).resetCardCount, null);
  p[1].auth.email = p[0].auth.email;
  p[0].auth.workspaceId = "workspace-a";
  p[1].auth.workspaceId = "workspace-b";
  assert.equal(selectT3Account(p, context, now).resetCardCount, null);
});
test("expired credit summary is unknown; a confirmed empty inventory is zero", () => {
  const p = providers();
  const nativeContext = { ...context, providerInstanceId: "codex" };
  p[1].usageLimits.resetCredits.nextExpiresAt = new Date(now - 1).toISOString();
  assert.equal(selectT3Account(p, nativeContext, now).resetCardCount, null);
  p[1].usageLimits.resetCredits = { availableCount: 0 };
  assert.equal(selectT3Account(p, nativeContext, now).resetCardCount, 0);
});
test("supported selected provider takes priority; Gemini clears Codex account data", () => {
  const p = providers();
  p[0].usageLimits = { ...p[1].usageLimits, resetCredits: { availableCount: 1 } };
  const result = selectT3Account(p, context, now);
  assert.equal(result.resetCardCount, 1);
  assert.equal(result.sourceBadge, null);
  assert.equal(selectT3Account(p, { ...context, provider: "gemini" }, now), null);
});

test("the remote Codex connection refreshes both its quota and reset cards", async () => {
  const remoteContext = { ...context, environmentId: "remote-machine", providerInstanceId: "codex" };
  const client = { evaluate() { assert.fail("Expected the selected environment's quota RPC"); } };
  const calls = [];
  let clock = now;
  let redeemed = false;
  let provider = { ...providers()[1], environmentId: remoteContext.environmentId };
  provider.usageLimits.resetCredits.availableCount = 4;
  const read = createT3AccountReader({
    now: () => clock,
    async rpc(clientArg, environmentId, method, payload) {
      assert.equal(clientArg, client);
      assert.equal(environmentId, remoteContext.environmentId);
      assert.deepEqual(payload, { instanceId: remoteContext.providerInstanceId });
      calls.push(method);
      if (method === "infobar.refreshQuota" && redeemed) {
        const updated = providers()[1];
        updated.usageLimits = { ...updated.usageLimits, checkedAt: new Date(clock).toISOString(),
          windows: [{ ...updated.usageLimits.windows[0], usedPercent: 0 }] };
        provider = { ...updated, environmentId };
      }
      return [provider];
    },
  });

  const before = await read(client, remoteContext);
  assert.equal(before.resetCardCount, 4);
  assert.equal(before.usageResets[0].usedPercent, 29);

  redeemed = true;
  clock = now + 1000;
  assert.equal(await read(client, remoteContext), before);
  clock = now + 15000;
  assert.equal((await read(client, remoteContext)).resetCardCount, 4);
  clock = now + 60000;
  const after = await read(client, remoteContext);
  assert.equal(after.resetCardCount, 3);
  assert.equal(after.usageResets[0].usedPercent, 0);
  assert.equal(after.observedAt, clock);
  assert.equal(calls.filter(method => method === "infobar.refreshQuota").length, 2);
});

function geminiProvider() {
  const reset = new Date(now + 3600000).toISOString();
  return { instanceId: "antigravity", driver: "antigravity", auth: { status: "authenticated" },
    usageLimits: { checkedAt: new Date(now).toISOString(), windows: [
      { id: "3p-5h", kind: "session", usedPercent: 86, resetsAt: reset, windowDurationMins: 300 },
      { id: "gemini-5h", kind: "session", usedPercent: 99.2, resetsAt: reset, windowDurationMins: 300 },
      { id: "3p-weekly", kind: "weekly", usedPercent: 43, resetsAt: reset, windowDurationMins: 10080 },
      { id: "gemini-weekly", kind: "weekly", usedPercent: 26, resetsAt: reset, windowDurationMins: 10080 },
    ] } };
}
const geminiContext = { provider: "gemini", providerInstanceId: "antigravity", model: "gemini-4-neon-high", threadId: "chat" };

test("Gemini reads account-wide five-hour and weekly pools without mixing third-party usage", () => {
  const result = selectT3Account([...providers(), geminiProvider()], geminiContext, now);
  assert.deepEqual(result.usageResets.map(w => w.usedPercent), [99.2, 26]);
  assert.deepEqual(result.usageResets.map(w => w.windowMinutes), [300, 10080]);
  assert.ok(result.usageResets.every(w => w.limitId === "gemini"));
  assert.equal(result.resetCardCount, null);
  assert.equal(result.threadId, "chat");
  assert.equal(result.sourceInstanceId, "antigravity");
  const thirdParty = selectT3Account([geminiProvider()], { ...geminiContext, model: "claude-opus-5-5-high" }, now);
  assert.deepEqual(thirdParty.usageResets.map(w => w.usedPercent), [86, 43]);
  assert.equal(selectT3Account([geminiProvider()], { ...geminiContext, providerInstanceId: "missing" }, now), null);
});

test("explicit model restrictions take precedence; unknown models never borrow another pool", () => {
  const p = geminiProvider();
  p.usageLimits.windows = [{ id: "other", usedPercent: 12, resetsAt: new Date(now + 10000).toISOString(), modelIds: ["gemini-4-neon"] },
    { id: "gemini-5h", usedPercent: 50, resetsAt: new Date(now + 10000).toISOString(), modelIds: ["gemini-4-carbon"] }];
  assert.deepEqual(selectT3Account([p], geminiContext, now).usageResets.map(w => w.usedPercent), [12]);
  assert.deepEqual(selectT3Account([p], { ...geminiContext, model: "unknown" }, now).usageResets, []);
});

test("expired Gemini windows keep the original reset time for waiting-for-update display", () => {
  const p = geminiProvider();
  p.usageLimits.windows[1].resetsAt = new Date(now - 60000).toISOString();
  const result = selectT3Account([p], geminiContext, now);
  assert.equal(result.usageResets.length, 2);
  assert.equal(result.usageResets[0].resetsAt, Math.floor((now - 60000) / 1000));
  p.usageLimits.checkedAt = new Date(now - 8 * 86400000).toISOString();
  assert.equal(selectT3Account([p], geminiContext, now), null);
});

test("identically named providers on other machines never supply remote account quota", () => {
  const p = geminiProvider();
  p.environmentId = "local-machine";
  const ctx = { ...geminiContext, environmentId: "remote-machine" };
  assert.equal(selectT3Account([p], ctx, now), null);
  p.environmentId = ctx.environmentId;
  assert.equal(selectT3Account([p], ctx, now).usageResets.length, 2);
});
