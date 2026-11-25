import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

// T3's app thread UUID is different from the provider's native conversation ID.
// Read only the active binding; never substitute another conversation's logs.
export function resolveT3Session(threadId, {
  home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"),
} = {}) {
  if (!threadId) return null;
  let db;
  try {
    db = new DatabaseSync(path.join(home, "userdata/statev2.sqlite"), { readOnly: true });
    const row = db.prepare(`
      SELECT p.driver, p.provider_instance_id, p.payload_json
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_threads p
        ON p.provider_thread_id = t.active_provider_thread_id
      WHERE t.thread_id = ? AND t.deleted_at IS NULL
    `).get(threadId);
    if (!row) return null;
    const binding = JSON.parse(row.payload_json);
    const nativeId = binding.nativeThreadRef?.nativeId;
    const instance = row.provider_instance_id;
    if (!instance || !/^[a-zA-Z0-9_-]+$/.test(instance)) return null;
    return {
      provider: row.driver,
      providerInstanceId: instance,
      nativeId,
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
