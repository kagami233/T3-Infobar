import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const hash = text => createHash("sha256").update(text).digest("hex");
const ID = /^(?:gemini(?:-(?:argon|carbon|neon|hydrogen))?|3p)-(?:5h|weekly)$/;

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

// Credentials remain on their owning Mac. The account fingerprint was pinned
// by the user's explicit shared-account mapping; another login is rejected.
export class GeminiQuotaReader {
  constructor({ now = Date.now, request = fetch, readCredential = keychainCredential } = {}) {
    this.now = now; this.request = request; this.readCredential = readCredential;
    this.cache = new Map(); this.identities = new Map();
  }
  async read(source) {
    if (source?.credentialStore !== "macos-keychain" || !/^[a-f0-9]{64}$/.test(source.expectedFingerprint)) return null;
    const key = JSON.stringify([source.providerInstanceId, source.expectedFingerprint]);
    let state = this.cache.get(key);
    const fresh = () => state?.value && this.now() - Date.parse(state.value.checkedAt) <= 90000 ? state.value : null;
    if (state && this.now() - state.at < 60000) return fresh();
    state = { at: this.now(), value: state?.value }; this.cache.set(key, state);
    if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
    try {
      const credential = await this.readCredential();
      const token = credential?.token;
      if (typeof token?.access_token !== "string" || Date.parse(token.expiry) <= this.now() + 5000 ||
          !Number.isFinite(Date.parse(token.expiry))) throw new Error("Sign-in expired");
      const tokenKey = hash(token.access_token);
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
