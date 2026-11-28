import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Cdp, listTargets, stateRoot, port } from "./cdp.mjs";
import { callT3Rpc } from "./t3-rpc.mjs";
import { SharedQuotaReader, sharedAccountKey } from "./shared-quota.mjs";
import { collectorRevision } from "./remote-registration.mjs";

export const sourceFiles = ["remote-agent.mjs", "t3-session.mjs", "reader.mjs", "metrics.mjs",
  "gemini-reader.mjs", "compaction-estimate.mjs", "quota-policy.mjs", "gemini-quota.mjs", "remote-registration.mjs"];
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const portableNode = {
  version: "24.11.1",
  sha256: "b05aa3a66efe680023f930bd5af3fdbbd542794da5644ca2ad711d68cbd4dc35",
};

export function launchAgentPlist(node, base) {
  const args = [node, `${base}/src/remote-agent.mjs`, "--config", `${base}/collector.json`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.t3infobar.metrics</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(base)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(base)}/collector.log</string>
<key>StandardErrorPath</key><string>${xml(base)}/collector-error.log</string>
</dict></plist>\n`;
}

export async function installRemote(client, { environmentId, appThreadId,
  configFile = path.join(stateRoot, "remote-metrics.json"), rpc = callT3Rpc } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(environmentId) || typeof appThreadId !== "string" || appThreadId.length > 400) {
    throw new Error("Specify --environment UUID and --thread APP_THREAD_ID");
  }
  const call = (method, payload) => rpc(client, environmentId, method, payload, 3500);
  const info = await call("infobar.describe", {});
  if (info.platform?.os !== "darwin") throw new Error("This installer currently supports macOS LaunchAgents only");
  const home = /^\/Users\/[^/]+/.exec(info.keybindingsConfigPath || info.cwd || "")?.[0];
  if (!home) throw new Error("Cannot establish the remote user's home directory");
  const base = `${home}/Library/Application Support/T3-InfoBar-Agent`;
  const write = (relativePath, contents) => call("projects.writeFile", { cwd: base, relativePath, contents });
  const read = async relativePath => {
    const result = await call("projects.readFile", { cwd: base, relativePath });
    if (result.truncated || typeof result.contents !== "string" || result.contents.length > 131072) {
      throw new Error("Remote telemetry file is truncated or oversized");
    }
    return JSON.parse(result.contents);
  };
  for (const file of sourceFiles) {
    await write(`src/${file}`, await fs.readFile(new URL(file, import.meta.url), "utf8"));
  }
  console.log("Uploaded the telemetry-only collector sources.");
  const terminal = { threadId: appThreadId, terminalId: randomUUID() };
  await call("terminal.open", { ...terminal, cwd: base, cols: 120, rows: 24 });
  async function command(data) { await call("terminal.write", { ...terminal, data: data + "\r" }); }
  async function waitFile(file, accept, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do {
      try { const value = await read(file); if (accept(value)) return value; } catch {}
      await new Promise(resolve => setTimeout(resolve, 400));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for collector ${file}`);
  }
  try {
    const nonce = randomUUID();
    const probe = `require('node:fs').writeFileSync(${JSON.stringify(`${base}/probe.json`)},JSON.stringify({nonce:${JSON.stringify(nonce)},version:process.versions.node,execPath:process.execPath,home:require('node:os').homedir()}))`;
    const existingRuntime = `${base}/runtime/node-v${portableNode.version}-darwin-arm64/bin/node`;
    await command(info.platform.arch === "arm64"
      ? `if [ -x ${shellQuote(existingRuntime)} ]; then ${shellQuote(existingRuntime)} -e ${shellQuote(probe)}; else node -e ${shellQuote(probe)}; fi`
      : `node -e ${shellQuote(probe)}`);
    let node = await waitFile("probe.json", p => p.nonce === nonce);
    let [major, minor] = node.version.split(".").map(Number);
    if ((major < 22 || (major === 22 && minor < 17)) && info.platform.arch === "arm64") {
      console.log("Installing a checksum-verified private Node runtime; the system Node stays unchanged.");
      const name = `node-v${portableNode.version}-darwin-arm64`;
      const runtime = `${base}/runtime`, archive = `${runtime}/${name}.tar.gz`;
      const executable = `${runtime}/${name}/bin/node`;
      await command(`(mkdir -p ${shellQuote(runtime)} && curl -fL --connect-timeout 15 --max-time 120 -o ${shellQuote(archive)} ${shellQuote(`https://nodejs.org/dist/v${portableNode.version}/${name}.tar.gz`)} && printf '%s  %s\\n' ${shellQuote(portableNode.sha256)} ${shellQuote(archive)} | shasum -a 256 -c - && tar -xzf ${shellQuote(archive)} -C ${shellQuote(runtime)} && ${shellQuote(executable)} -e ${shellQuote(probe)}) >${shellQuote(`${base}/runtime-install.log`)} 2>&1`);
      node = await waitFile("probe.json", p => p.nonce === nonce && p.execPath === executable, 130000);
      [major, minor] = node.version.split(".").map(Number);
    }
    if (major < 22 || (major === 22 && minor < 17) || node.home !== home || !node.execPath.startsWith("/")) {
      throw new Error("The remote collector requires Node 22.17+ running as the T3 user");
    }
    console.log(`Validated remote Node ${node.version}.`);
    let previous;
    try { previous = await read("collector.json"); } catch {}
    if (previous && previous.environmentId !== environmentId) throw new Error("Existing collector belongs to another environment");
    const threads = [...new Set([...(previous?.threads ?? []), appThreadId])];
    const t3Home = typeof info.keybindingsConfigPath === "string" && info.keybindingsConfigPath.endsWith("/userdata/keybindings.json")
      ? info.keybindingsConfigPath.slice(0, -"/userdata/keybindings.json".length) : `${home}/.t3`;
    const quotaSources = [];
    const shared = new SharedQuotaReader();
    const localEnvironment = await shared.localEnvironment();
    for (const rule of (await shared.config()).mappings.filter(r => r.targetEnvironmentId === environmentId &&
      r.sourceEnvironmentId === localEnvironment && r.provider === "gemini")) {
      const provider = await shared.localProvider(rule.sourceProviderInstanceId);
      if (sharedAccountKey(provider) === rule.sourceAccountKey && /^[a-f0-9]{64}$/.test(provider.usageLimits?.credentialFingerprint)) quotaSources.push({ providerInstanceId: rule.targetProviderInstanceId,
        credentialStore: "macos-keychain", expectedFingerprint: provider.usageLimits.credentialFingerprint });
    }
    await write("collector.json", JSON.stringify({ version: 1, environmentId, t3Home, intervalMs: 2000, threads, quotaSources }, null, 2));
    const startedAt = Date.now();
    await command(`${shellQuote(node.execPath)} ${shellQuote(`${base}/src/remote-agent.mjs`)} --config ${shellQuote(`${base}/collector.json`)} --once --snapshot-file probe-snapshots.json`);
    const first = await waitFile("probe-snapshots.json", d => d.collectorRevision === collectorRevision && d.environmentId === environmentId &&
      d.collectedAt >= startedAt - 5000 && d.entries?.some(e => e.appThreadId === appThreadId), 45000);
    const firstEntry = first.entries.find(e => e.appThreadId === appThreadId);
    if (firstEntry.status !== "ok") throw new Error(`Native telemetry is unavailable: ${firstEntry.reason || "unknown"}`);
    console.log("Validated native session telemetry on the remote machine.");
    const plist = `${home}/Library/LaunchAgents/com.t3infobar.metrics.plist`;
    await write("launchagent.plist", launchAgentPlist(node.execPath, base));
    await command(`mkdir -p ${shellQuote(`${home}/Library/LaunchAgents`)} && cp ${shellQuote(`${base}/launchagent.plist`)} ${shellQuote(plist)}; launchctl bootout gui/$(id -u) ${shellQuote(plist)} >/dev/null 2>&1; launchctl bootstrap gui/$(id -u) ${shellQuote(plist)}`);
    const active = await waitFile("snapshots.json", d => d.collectorRevision === collectorRevision && d.environmentId === environmentId && d.collectedAt > first.collectedAt, 45000);
    let config = { version: 1, sources: [] };
    try { config = JSON.parse(await fs.readFile(configFile, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (config.version !== 1 || !Array.isArray(config.sources)) throw new Error("Invalid local remote-metrics configuration");
    config.sources = [...config.sources.filter(s => s.environmentId !== environmentId), { environmentId, cwd: base }];
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, configFile);
    } finally { await fs.rm(temporary, { force: true }); }
    return { environmentId, collectorDirectory: base, configFile,
      entry: active.entries.find(e => e.appThreadId === appThreadId) };
  } finally {
    try { await call("terminal.close", terminal); } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  while (args.length) { const flag = args.shift(); options[flag] = args.shift(); }
  const targets = await listTargets(Number(options["--port"] || port));
  if (!targets.length) throw new Error("Open the T3 desktop app first");
  const client = await new Cdp(targets[0], Number(options["--port"] || port)).open();
  try {
    console.log(JSON.stringify(await installRemote(client, { environmentId: options["--environment"], appThreadId: options["--thread"] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { client.close(); }
}
