import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { RolloutReader, validateThreadId, IMPORT_CODEX } from "./reader.mjs";
import { formatGeminiModelBadge, GeminiTranscriptReader } from "./gemini-reader.mjs";
import { Cdp, listTargets, port as defaultPort } from "./cdp.mjs";
import { SnapshotCache } from "./snapshot-cache.mjs";
import { addCompactionEstimate } from "./compaction-estimate.mjs";
import { formatMetricsForTheme, buildT3Theme } from "./theme.mjs";
import { getLocalT3EnvironmentId, resolveT3Session, resolveT3QuotaRestriction } from "./t3-session.mjs";
import { applyQuotaRestriction } from "./quota-policy.mjs";
import { createT3AccountReader } from "./t3-account.mjs";
import { readT3Runtime, sessionKey } from "./t3-runtime.mjs";
import { SharedQuotaReader } from "./shared-quota.mjs";
import { RemoteMetricsReader, nativeQuotaAccount } from "./remote-metrics.mjs";

const here = new URL(".", import.meta.url);
const args = process.argv.slice(2);
const mode = args.shift() || "preview";
const options = {
  thread: process.env.T3CODE_THREAD_ID || process.env.T3_THREAD_ID || process.env.CODEX_THREAD_ID,
  engine: "auto", // auto | gemini | codex
  port: defaultPort,
  position: "inside",
  output: fileURLToPath(new URL("../theme/codex-infobar.json", import.meta.url)),
};

while (args.length) {
  const key = args.shift();
  if (!["--thread", "--engine", "--port", "--position", "--account-snapshot", "--output",
    "--shared-quota", "--remote-environment", "--remote-provider", "--local-provider", "--provider", "--remote-metrics"].includes(key) || !args.length) {
    throw new Error(`未知参数 ${key}`);
  }
  options[key.slice(2)] = args.shift();
}
options.port = Number(options.port);
if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
  throw new Error("端口必须介于 1024–65535。");
}
if (!["above", "below", "inside"].includes(options.position)) {
  throw new Error("不支持的显示位置。");
}
if (!["auto", "gemini", "codex"].includes(options.engine)) {
  throw new Error("--engine 必须为 auto、gemini 或 codex。");
}

const codexReader = new RolloutReader();
const geminiReader = new GeminiTranscriptReader();
const mappedReaders = new Map();
const renderer = (
  await Promise.all([
    fs.readFile(new URL("renderer.js", here), "utf8"),
    fs.readFile(new URL("account-source.js", here), "utf8"),
  ])
).join("\n;\n");
const rendererRevision = createHash("sha256").update(renderer).digest("hex");

async function resolveSnapshot(rawThreadId, client = null, previous = null, selection = null) {
  const binding = options.engine === "auto" ? resolveT3Session(rawThreadId) : null;
  const provider = binding?.provider === "antigravity" ? "gemini" : binding?.provider;
  const chosen = options.engine === "auto" && selection ? {
    provider: selection.provider, providerInstanceId: selection.providerInstanceId, model: selection.model,
  } : null;
  if (chosen?.provider === "gemini") {
    const model = selection.effort && !chosen.model.endsWith(`-${selection.effort}`)
      ? `${chosen.model}-${selection.effort}` : chosen.model;
    chosen.modelBadge = formatGeminiModelBadge(model);
  }
  if (chosen && (provider !== chosen.provider || binding?.providerInstanceId !== chosen.providerInstanceId)) {
    return { ...chosen, threadId: rawThreadId, draft: !rawThreadId, status: "unavailable" };
  }
  if (binding) {
    try {
      if (!binding.nativeId) throw new Error("当前聊天尚未创建原生会话记录。");
      if (binding.provider === "codex") {
        let reader = mappedReaders.get(binding.codexHome);
        if (!reader) {
          reader = new RolloutReader({ codexHome: binding.codexHome });
          mappedReaders.set(binding.codexHome, reader);
        }
        const data = await reader.snapshot(validateThreadId(binding.nativeId));
        return { ...await addCompactionEstimate(data, client, previous),
          threadId: rawThreadId, nativeThreadId: binding.nativeId,
          providerInstanceId: binding.providerInstanceId, provider: "codex", ...chosen };
      }
      if (binding.provider === "antigravity" || binding.provider === "gemini") {
        const data = await geminiReader.snapshot(binding.nativeId);
        const sameModel = !chosen || data.model === chosen.model || data.model?.startsWith(`${chosen.model}-`);
        return { ...data, threadId: rawThreadId, nativeThreadId: binding.nativeId,
          quotaRestriction: sameModel ? resolveT3QuotaRestriction(rawThreadId, binding.providerThreadId) : null,
          providerInstanceId: binding.providerInstanceId, provider: "gemini", ...chosen };
      }
      throw new Error(`暂不支持此引擎：${binding.provider}`);
    } catch (error) {
      return { threadId: rawThreadId, providerInstanceId: binding.providerInstanceId,
        provider, status: "unavailable", warning: error.message, ...chosen };
    }
  }
  const isImportedCodex = typeof rawThreadId === "string" && IMPORT_CODEX.test(rawThreadId);
  if (options.engine === "codex" || (options.engine === "auto" && isImportedCodex)) {
    try {
      const id = validateThreadId(rawThreadId);
      const data = await addCompactionEstimate(await codexReader.snapshot(id), client, previous);
      return { ...data, provider: "codex" };
    } catch (error) {
      if (options.engine === "codex") {
        return { threadId: rawThreadId, provider: "codex", status: "unavailable", warning: error.message };
      }
    }
  }

  if (options.engine === "auto" && rawThreadId && !isImportedCodex) {
    try {
      const id = validateThreadId(rawThreadId);
      const data = await addCompactionEstimate(await codexReader.snapshot(id), client, previous);
      if (data?.status === "ok") return { ...data, provider: "codex" };
    } catch (error) {
      return { threadId: rawThreadId, provider: "codex", status: "unavailable", warning: error.message };
    }
  }

  try {
    const id = rawThreadId ? (() => { try { return validateThreadId(rawThreadId); } catch { return rawThreadId; } })() : null;
    return await geminiReader.snapshot(id);
  } catch (error) {
    return {
      threadId: rawThreadId ?? null,
      provider: "gemini",
      status: "unavailable",
      source: "antigravity-transcript",
      warning: error.message,
    };
  }
}

async function generateThemeFile() {
  const data = await resolveSnapshot(options.thread);
  const metrics = formatMetricsForTheme(data);
  const theme = buildT3Theme(metrics);
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify({ themeId: "codex-infobar", theme }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    output: options.output,
    themeId: "codex-infobar",
    provider: data.provider,
    conversationId: data.conversationId ?? data.threadId,
    model: data.model,
    metrics,
  }, null, 2));
}

async function preview() {
  const id = options.thread ? validateThreadId(options.thread) : "4891bc12-f179-4879-b437-c926303cf25d";
  const secret = randomBytes(24).toString("hex");
  const prefix = `/${secret}/`;
  let html = await fs.readFile(new URL("preview.html", here), "utf8");
  html = html
    .replace(
      '<script src="./renderer.js">',
      `<script>history.replaceState(null,'','/threads/${id}?key=${secret}');</script><script src="${prefix}renderer.js">`
    )
    .replace("fetch('./metrics'", `fetch('${prefix}metrics'`);
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    if (
      req.headers.host !== `127.0.0.1:${address.port}` ||
      req.method !== "GET" ||
      (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${address.port}`)
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(req.url, `http://127.0.0.1:${address.port}`);
    if (url.pathname === `${prefix}metrics`) {
      const data = await resolveSnapshot(id);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } else if (url.pathname === `${prefix}renderer.js`) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(renderer);
    } else if (url.pathname === prefix || (url.pathname === `/threads/${id}` && url.searchParams.get("key") === secret)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  console.log(`T3-InfoBar 双引擎预览：http://127.0.0.1:${server.address().port}${prefix}`);
  console.log("按 Ctrl+C 关闭预览服务。");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
}

async function attach() {
  const clients = new Map();
  const readAccount = createT3AccountReader();
  let quotaClient;
  const sharedQuota = new SharedQuotaReader({ file: options["shared-quota"],
    refreshSource: context => readAccount(quotaClient, context) });
  const remoteMetrics = new RemoteMetricsReader({ file: options["remote-metrics"] });
  const diskCache = new SnapshotCache();
  const sharedSnapshots = await diskCache.load();
  let localEnvironmentId = null;
  let stopping = false;
  let lastIssue = "";
  async function cleanup() {
    stopping = true;
    for (const client of clients.values()) {
      try { await client.evaluate("window.__T3_METRICS_HUD__?.remove()"); } catch {}
      client.close();
    }
    clients.clear();
    try { await diskCache.save(sharedSnapshots, true); } catch {}
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping = true; });
  console.log(`已启动 T3-InfoBar 双引擎采集器（本机 CDP 端口 ${options.port}，模式 ${options.engine}）；按 Ctrl+C 停止。`);
  try {
    while (!stopping) {
      try {
        const targets = await listTargets(options.port);
        if (targets.length && !localEnvironmentId) localEnvironmentId = getLocalT3EnvironmentId();
        const present = new Set(targets.map(t => t.id));
        for (const [id, client] of clients) {
          if (!present.has(id) || client.closed) {
            client.close();
            clients.delete(id);
          }
        }
        for (const target of targets) {
          if (stopping) break;
          let client = clients.get(target.id);
          if (!client) {
            client = await new Cdp(target, options.port).open();
            clients.set(target.id, client);
          }
          if (stopping) break;
          try {
            const ready = await client.evaluate(
              `Boolean(window.__T3_METRICS_HUD__?.rendererRevision === ${JSON.stringify(rendererRevision)})`
            );
            if (!ready) {
              await client.evaluate(renderer);
              await client.evaluate(`window.__T3_METRICS_HUD__.rendererRevision = ${JSON.stringify(rendererRevision)}`);
              await client.evaluate(`window.__T3_METRICS_HUD__.setPosition(${JSON.stringify(options.position)})`);
              if (sharedSnapshots.size) {
                await client.evaluate(
                  `window.__T3_METRICS_HUD__.primeSnapshots(${JSON.stringify([...sharedSnapshots.values()])})`
                );
              }
            }
            await client.evaluate("window.__CODEX_METRICS_ACCOUNT__?.tickAutoReset?.()");
            const { context, selection } = await client.evaluate(`(() => {
              const hud = window.__T3_METRICS_HUD__;
              return { context: hud.getThreadContext(), selection: hud.getComposerSelection() };
            })()`);
            const id = context.threadId;
            if (!id && !selection) continue;
            const key = sessionKey(context);
            const runtime = await readT3Runtime(client, context);
            const hostEnvironmentId = runtime.localEnvironmentId ?? localEnvironmentId;
            const remote = context.environmentId && context.environmentId !== hostEnvironmentId;
            const localSelection = !remote && selection?.environmentId === hostEnvironmentId ? selection : null;
            if (!id && !localSelection) continue;
            const data = remote ? await remoteMetrics.read(client, runtime.snapshot)
              : { ...await resolveSnapshot(context.appThreadId ?? id, client, sharedSnapshots.get(key)?.snapshot, localSelection), ...context };
            if (data.providerInstanceId && (id || context.environmentId)) {
              const accountContext = {
                provider: data.provider, providerInstanceId: data.providerInstanceId,
                model: data.model, threadId: id, environmentId: context.environmentId,
              };
              quotaClient = client;
              const remoteAccount = nativeQuotaAccount(data, accountContext) ?? await readAccount(client, accountContext);
              const account = applyQuotaRestriction(await sharedQuota.reference(remoteAccount, accountContext, hostEnvironmentId), data);
              await client.evaluate(`window.__T3_METRICS_HUD__?.updateAccount(${JSON.stringify(account)})`);
            } else {
              await client.evaluate("window.__T3_METRICS_HUD__?.updateAccount(null)");
            }
            if (id) {
              sharedSnapshots.delete(key);
              sharedSnapshots.set(key, { snapshot: data, receivedAt: Date.now() });
              if (sharedSnapshots.size > 64) sharedSnapshots.delete(sharedSnapshots.keys().next().value);
            }
            await client.evaluate(`window.__T3_METRICS_HUD__.update(${JSON.stringify(data)})`);
          } catch (error) {
            if (!error.transient) {
              try { await client.evaluate("window.__T3_METRICS_HUD__?.remove()"); } catch {}
            }
            client.close();
            clients.delete(target.id);
            if (lastIssue !== error.message) console.error(error.message);
            lastIssue = error.message;
          }
        }
        lastIssue = "";
        try { await diskCache.save(sharedSnapshots); } catch {}
      } catch (error) {
        if (lastIssue !== error.message) console.error(error.message);
        lastIssue = error.message;
      }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    await cleanup();
  }
}

try {
  if (mode === "share-quota") {
    const reader = new SharedQuotaReader({ file: options["shared-quota"] });
    console.log(JSON.stringify(await reader.configure({
      targetEnvironmentId: options["remote-environment"], targetProviderInstanceId: options["remote-provider"],
      sourceProviderInstanceId: options["local-provider"], provider: options.provider,
    }), null, 2));
  } else if (mode === "snapshot") {
    console.log(JSON.stringify(await resolveSnapshot(options.thread), null, 2));
  } else if (mode === "theme") {
    await generateThemeFile();
  } else if (mode === "preview") {
    await preview();
  } else if (mode === "attach") {
    await attach();
  } else {
    throw new Error("用法：node src/cli.mjs theme|preview|snapshot|attach|share-quota [--thread ID] [--engine auto|gemini|codex] [--position above|below|inside] [--port 9342]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
