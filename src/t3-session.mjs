import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQuotaFailure } from "./quota-policy.mjs";

export function resolveT3QuotaRestriction(threadId, providerThreadId, { home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3") } = {}) {
  let db;
  try {
    db = new DatabaseSync(path.join(home, "userdata/statev2.sqlite"), { readOnly: true });
    const turn = db.prepare(`SELECT provider_turn_id, status FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ? AND provider_thread_id = ? AND status IN ('completed', 'failed')
      ORDER BY ordinal DESC LIMIT 1`).get(threadId, providerThreadId);
    if (turn?.status !== "failed") return null;
    const errors = db.prepare(`SELECT payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ? AND provider_thread_id = ? AND provider_turn_id = ? AND type = 'error'
      ORDER BY ordinal DESC LIMIT 8`).all(threadId, providerThreadId, turn.provider_turn_id);
    for (const row of errors) {
      const restriction = parseQuotaFailure(JSON.parse(row.payload_json));
      if (restriction) return restriction;
    }
    return null;
  } catch { return null; }
  finally { db?.close(); }
}

const defaultHome = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");

export function getLocalT3EnvironmentId(home = defaultHome) {
  try {
    return readFileSync(path.join(home, "userdata/environment-id"), "utf8").trim().toLowerCase() || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// T3's app thread UUID is different from the provider's native conversation ID.
// Read only the active binding; never substitute another conversation's logs.
export function resolveT3Session(threadId, { home = defaultHome } = {}) {
  if (!threadId) return null;
  let db;
  try {
    db = new DatabaseSync(path.join(home, "userdata/statev2.sqlite"), { readOnly: true });
    const row = db.prepare(`
      SELECT p.driver, p.provider_instance_id, p.provider_thread_id, p.payload_json, t.payload_json AS app_payload_json
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_threads p
        ON p.provider_thread_id = t.active_provider_thread_id
      WHERE t.thread_id = ? AND t.deleted_at IS NULL
    `).get(threadId);
    if (!row) return null;
    const binding = JSON.parse(row.payload_json);
    const app = JSON.parse(row.app_payload_json || "{}");
    const nativeId = binding.nativeThreadRef?.nativeId;
    const instance = row.provider_instance_id;
    if (!instance || !/^[a-zA-Z0-9_-]+$/.test(instance)) return null;
    return {
      provider: row.driver,
      providerInstanceId: instance,
      providerThreadId: row.provider_thread_id,
      nativeId,
      model: app.modelSelection?.instanceId === instance ? app.modelSelection.model : null,
      contextWindowTokens: Number.isFinite(binding.contextUsage?.maxTokens) ? binding.contextUsage.maxTokens : null,
      codexHome: instance === "codex"
        ? path.join(os.homedir(), ".codex")
        : path.join(home, "userdata/providers/codex", instance, "shadow"),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ERR_SQLITE_ERROR") return null;
    throw error;
  } finally {
    db?.close();
  }
}
