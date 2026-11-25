import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveT3Session } from "../src/t3-session.mjs";

test("T3 binding follows the selected provider and exact native conversation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-infobar-binding-"));
  fs.mkdirSync(path.join(home, "userdata"));
  const db = new DatabaseSync(path.join(home, "userdata/statev2.sqlite"));
  try {
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads
        (thread_id TEXT, active_provider_thread_id TEXT, deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_provider_threads
        (provider_thread_id TEXT, driver TEXT, provider_instance_id TEXT, payload_json TEXT);
    `);
    const put = db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)");
    put.run("codex-binding", "codex", "codex_instance", JSON.stringify({ nativeThreadRef: { nativeId: "codex-native" } }));
    put.run("gemini-binding", "antigravity", "gemini_instance", JSON.stringify({ nativeThreadRef: { nativeId: "gemini-native" } }));
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)").run("chat", "codex-binding");
    assert.equal(resolveT3Session("chat", { home }).nativeId, "codex-native");
    assert.equal(resolveT3Session("chat", { home }).provider, "codex");
    db.prepare("UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id='codex' WHERE provider_thread_id='codex-binding'").run();
    assert.equal(resolveT3Session("chat", { home }).codexHome, path.join(os.homedir(), ".codex"));
    db.prepare("UPDATE orchestration_v2_projection_threads SET active_provider_thread_id=?").run("gemini-binding");
    assert.equal(resolveT3Session("chat", { home }).nativeId, "gemini-native");
    assert.equal(resolveT3Session("chat", { home }).provider, "antigravity");
    assert.equal(resolveT3Session("another-chat", { home }), null);
  } finally {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
