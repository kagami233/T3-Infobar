import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const collectorRevision = 5;
export const renewAfterMs = 30000;
const leaseMs = 120000;

function filename(id) {
  return createHash("sha256").update(id).digest("hex") + ".json";
}

export function registrationFile(environmentId, appThreadId, active = true) {
  if (typeof appThreadId !== "string" || !appThreadId.length || appThreadId.length > 400) {
    throw new Error("Invalid app thread ID");
  }
  return { relativePath: "registrations/" + filename(appThreadId),
    contents: JSON.stringify({ environmentId, appThreadId, active }) };
}

export async function activeRegistrations(directory, environmentId, now) {
  const root = path.join(directory, "registrations");
  let files;
  try { files = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const recent = [];
  for (const entry of files) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    try {
      const stat = await fs.stat(file);
      if (stat.size > 4096 || now - stat.mtimeMs > leaseMs) continue;
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      if (record.environmentId === environmentId && record.active === true &&
          typeof record.appThreadId === "string" && record.appThreadId.length <= 400 &&
          filename(record.appThreadId) === entry.name) {
        recent.push({ id: record.appThreadId, at: stat.mtimeMs });
      }
    } catch (error) {
      // A client may be replacing its own record. Retry on the next cycle.
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return recent.sort((a, b) => b.at - a.at).map(record => record.id);
}
