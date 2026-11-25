import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

export const stateRoot = process.env.T3_INFOBAR_STATE || (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "T3-InfoBar")
  : path.join(os.homedir(), "Library/Application Support/T3-InfoBar"));

export const port = Number(process.env.T3_INFOBAR_PORT || process.env.CODEX_INFOBAR_PORT || 9342);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Invalid T3_INFOBAR_PORT");
}

export async function resolveT3App() {
  const override = process.env.T3_INFOBAR_APP || process.env.CODEX_INFOBAR_APP;
  if (process.platform === "darwin") {
    const candidates = override
      ? [override]
      : [
          "/Applications/T3 Code.app",
          path.join(os.homedir(), "Applications/T3 Code.app"),
          "/Applications/Codex.app",
          path.join(os.homedir(), "Applications/Codex.app"),
        ];
    for (const app of candidates) {
      try {
        const { stdout: exe } = await run("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleExecutable",
          `${app}/Contents/Info.plist`,
        ]);
        return { app, executable: `${app}/Contents/MacOS/${exe.trim()}` };
      } catch {}
    }
    throw new Error("T3 Code app not found; set T3_INFOBAR_APP to the .app path");
  }
  throw new Error("resolveT3App currently configured for macOS; pass --port for any Chromium/Electron debug endpoint");
}

export async function listTargets(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`调试端口 HTTP ${response.status}`);
  return (await response.json()).filter(t => {
    if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
    const url = t.url || "";
    const allowedPrefix =
      url.startsWith("app://") ||
      url.startsWith("t3code://") ||
      url.startsWith("t3code-dev://") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost") ||
      url.startsWith("file://");
    if (!allowedPrefix) return false;
    try {
      validSocket(t.webSocketDebuggerUrl, debugPort);
      return true;
    } catch {
      return false;
    }
  });
}

export function validSocket(raw, debugPort) {
  const url = new URL(raw);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    Number(url.port) !== Number(debugPort) ||
    url.username ||
    url.password
  ) {
    throw new Error("拒绝非本机或端口不匹配的调试连接。");
  }
  return url.href;
}

export class Cdp {
  constructor(target, debugPort) {
    this.socket = new WebSocket(validSocket(target.webSocketDebuggerUrl, debugPort));
    this.pending = new Map();
    this.id = 0;
    this.closed = false;
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("调试连接已关闭"));
      }
      this.pending.clear();
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error("调试连接超时"));
      }, 5000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        this.close();
        reject(new Error("调试连接失败"));
      }, { once: true });
    });
    return this;
  }
  async evaluate(expression) {
    if (this.closed) throw new Error("调试连接已关闭");
    const id = ++this.id;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error("调试命令超时");
        error.transient = true;
        reject(error);
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    if (result.exceptionDetails) throw new Error("状态条脚本执行失败");
    return result.result?.value;
  }
  close() {
    this.socket.close();
    this.closed = true;
  }
}
