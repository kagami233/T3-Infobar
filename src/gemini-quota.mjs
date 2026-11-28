import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const hash = text => createHash("sha256").update(text).digest("hex");
const ID = /^(?:gemini(?:-(?:argon|carbon|neon|hydrogen))?|3p)-(?:5h|weekly)$/;
const RENEWAL_WINDOW_MS = 5 * 60_000;
const URGENT_WINDOW_MS = 60_000;
const RENEWAL_RETRY_MS = 60_000;
const URGENT_RETRY_MS = 10_000;

export function parseQuotaSummary(summary) {
  const groups = summary?.groups?.some(g => g.buckets?.length) ? summary.groups : [{ buckets: summary?.buckets }];
  const windows = new Map();
  for (const group of groups) for (const bucket of group.buckets ?? []) {
    if (bucket.disabled || !ID.test(bucket.bucketId) || !["5h", "weekly"].includes(bucket.window) ||
        !bucket.bucketId.endsWith(`-${bucket.window}`) || !Number.isFinite(bucket.remainingFraction) ||
        bucket.remainingFraction < 0 || bucket.remainingFraction > 1 || !Number.isFinite(Date.parse(bucket.resetTime))) continue;
    windows.set(bucket.bucketId, { id: bucket.bucketId, kind: bucket.window === "weekly" ? "weekly" : "session",
      usedPercent: (1 - bucket.remainingFraction) * 100, resetsAt: new Date(bucket.resetTime).toISOString(),
      windowDurationMins: bucket.window === "weekly" ? 10080 : 300 });
  }
  return [...windows.values()];
}

async function keychainCredential() {
  if (process.platform !== "darwin") throw new Error("macOS keychain is unavailable");
  let { stdout } = await exec("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 32768 });
  stdout = stdout.trim();
  if (stdout.startsWith("go-keyring-base64:")) stdout = Buffer.from(stdout.slice(18), "base64").toString("utf8");
  else if (stdout.startsWith("go-keyring-encoded:")) stdout = Buffer.from(stdout.slice(19), "hex").toString("utf8");
  return JSON.parse(stdout);
}

async function renewKeychainCredential(t3Home) {
  const root = path.join(t3Home, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  const { releaseId } = JSON.parse(await fs.readFile(path.join(root, "active.json"), "utf8"));
  if (typeof releaseId !== "string" || !/^[a-f0-9]{64}$/.test(releaseId)) {
    throw new Error("Invalid Antigravity release");
  }
  const binary = path.join(root, "versions", releaseId, process.platform === "win32" ? "agy.exe" : "antigravity");
  // Let the installed CLI renew its own login as it loads the model catalog.
  await exec(binary, ["models"], { cwd: os.homedir(), timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true });
}

async function windowsCredentialExpiry() {
  const script = await fs.readFile(new URL("windows-antigravity-expiry.ps1", import.meta.url), "utf8");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { timeout: 10000, maxBuffer: 32768, windowsHide: true });
  return /^\d+$/.test(stdout.trim()) ? Number(stdout.trim()) : NaN;
}

// Credentials stay on the device. Native quota is returned only for the
// Google account pinned by the explicit shared-account mapping.
export class GeminiQuotaReader {
  constructor({ now = Date.now, request = fetch, readCredential = keychainCredential,
    renewCredential = renewKeychainCredential,
    readExpiry = process.platform === "win32" && readCredential === keychainCredential
      ? windowsCredentialExpiry
      : async () => Date.parse((await readCredential())?.token?.expiry) } = {}) {
    this.now = now; this.request = request; this.readCredential = readCredential;
    this.readExpiry = readExpiry;
    this.renewCredential = renewCredential; this.lastRenewalAt = -Infinity;
    this.renewalPending = false;
    this.nextLoginCheck = 0;
    this.loginExpiry = NaN;
    this.cache = new Map(); this.identities = new Map();
  }

  async maintainLogin(t3Home) {
    const now = this.now();
    if (now >= this.nextLoginCheck) {
      this.nextLoginCheck = now + 60_000;
      try { this.loginExpiry = await this.readExpiry(); }
      catch { this.loginExpiry = NaN; }
    }
    await this.renewIfDue(t3Home, this.loginExpiry);
  }

  async renewIfDue(t3Home, expiresAt) {
    const now = this.now();
    const remaining = expiresAt - now;
    const retry = Math.abs(remaining) <= URGENT_WINDOW_MS ? URGENT_RETRY_MS : RENEWAL_RETRY_MS;
    if (!t3Home || !Number.isFinite(remaining) || remaining > RENEWAL_WINDOW_MS ||
        this.renewalPending || now - this.lastRenewalAt < retry) return;

    this.lastRenewalAt = now;
    this.renewalPending = true;
    try {
      await this.renewCredential(t3Home);
      const renewedExpiry = await this.readExpiry();
      // The CLI can exit successfully and keep a token it still considers valid.
      if (renewedExpiry > expiresAt) {
        this.loginExpiry = renewedExpiry;
        for (const state of this.cache.values()) state.at = -Infinity;
      }
    } catch {
      // Read quota as usual with the current token and retry when due.
    } finally {
      this.renewalPending = false;
    }
  }

  async read(source, { t3Home } = {}) {
    if (source?.credentialStore !== "macos-keychain" || !/^[a-f0-9]{64}$/.test(source.expectedFingerprint)) return null;
    const key = JSON.stringify([source.providerInstanceId, source.expectedFingerprint]);
    let state = this.cache.get(key);
    const fresh = () => {
      const now = this.now();
      return state?.value && state.expiresAt > now && now - Date.parse(state.value.checkedAt) <= 90000 ? state.value : null;
    };
    if (state && this.now() - state.at < 60000) {
      void this.renewIfDue(t3Home, state.expiresAt);
      return fresh();
    }
    state = { at: this.now(), value: state?.value };
    this.cache.set(key, state);
    if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
    try {
      const credential = await this.readCredential();
      const token = credential?.token;
      const expiry = Date.parse(token?.expiry);
      if (typeof token?.access_token !== "string" || !Number.isFinite(expiry)) throw new Error("Sign-in unavailable");
      const tokenKey = hash(token.access_token);
      if (expiry <= this.now() + 5000) {
        state.expiresAt = expiry;
        if (this.identities.get(tokenKey) !== source.expectedFingerprint) state.value = null;
        void this.renewIfDue(t3Home, expiry);
        return fresh();
      }
      const headers = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json",
        "User-Agent": "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)" };
      const getJson = async (url, options = {}) => {
        const response = await this.request(url, { ...options, headers, redirect: "error", signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("Quota endpoint unavailable");
        return response.json();
      };
      let identity = this.identities.get(tokenKey);
      if (!identity) {
        const user = await getJson("https://www.googleapis.com/oauth2/v2/userinfo");
        if (typeof user.id !== "string" || !user.id) throw new Error("Account identity unavailable");
        identity = hash(`google-account\0${user.id}`);
        this.identities.set(tokenKey, identity);
        if (this.identities.size > 8) this.identities.delete(this.identities.keys().next().value);
      }
      if (identity !== source.expectedFingerprint) { state.value = null; return null; }
      state.expiresAt = expiry;
      void this.renewIfDue(t3Home, expiry);
      let windows = [];
      const checkedAt = new Date(this.now()).toISOString();
      for (const host of ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]) {
        try {
          windows = parseQuotaSummary(await getJson(`https://${host}/v1internal:retrieveUserQuotaSummary`,
            { method: "POST", body: "{}" }));
          if (windows.length) break;
        } catch {}
      }
      if (!windows.length) throw new Error("No quota windows");
      state.value = { checkedAt, windows };
      return fresh();
    } catch {
      // A failed identity/credential check must not preserve a previous user's quota.
      state.value = null;
      return null;
    }
  }
}
