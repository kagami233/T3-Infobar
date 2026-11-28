import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Cdp, listTargets, stateRoot } from "./cdp.mjs";
import { UUID } from "./reader.mjs";
import { getLocalT3EnvironmentId } from "./t3-session.mjs";

const run = promisify(execFile);
const START = "/* t3-infobar-device-colors:start */";
const END = "/* t3-infobar-device-colors:end */";
const LOCAL = ["101 114 134 / 0.13", "189 195 210 / 0.14"];
const REMOTE = [
  ["252 106 92 / 0.36", "255 143 124 / 0.35"],
  ["42 192 201 / 0.34", "84 221 229 / 0.31"],
  ["32 125 119 / 0.12", "81 191 175 / 0.15"],
  ["148 108 42 / 0.12", "229 179 82 / 0.15"],
];

function rule(id, [light, dark]) {
  return `li[data-thread-item^="${id}:"] [data-sidebar-row^="${id}:"] {
  --t3-infobar-device-tint: light-dark(rgb(${light}), rgb(${dark}));
  background-image: linear-gradient(var(--t3-infobar-device-tint), var(--t3-infobar-device-tint));
}`;
}

export function withSidebarColors(css, localId, visibleIds) {
  if (typeof localId !== "string" || !UUID.test(localId)) throw new Error("无法识别本机 T3 环境。");
  localId = localId.toLowerCase();
  const start = css.indexOf(START);
  const end = css.indexOf(END, Math.max(start, 0));
  if ((start < 0) !== (end < 0)) throw new Error("现有的侧边栏分色样式不完整。");

  const previous = start < 0 ? "" : css.slice(start, end);
  const savedIds = [...previous.matchAll(/^li\[data-thread-item\^="([^":]+):"\]/gm)].map(match => match[1]);
  const visible = [...visibleIds].filter(id => typeof id === "string" && UUID.test(id))
    .map(id => id.toLowerCase()).sort();
  const ids = new Set([...savedIds.filter(id => UUID.test(id)).map(id => id.toLowerCase()), ...visible]);
  ids.delete(localId);

  const rules = [rule(localId, LOCAL), ...[...ids].map((id, index) => rule(id, REMOTE[index % REMOTE.length]))];
  const block = [START, ...rules, END].join("\n");
  return start < 0
    ? `${css.trimEnd()}\n\n${block}\n`
    : css.slice(0, start) + block + css.slice(end + END.length);
}

async function findVisibleEnvironments(port, localId) {
  const ids = new Set();
  let foundHost = false;
  for (const target of await listTargets(port)) {
    if (!/^t3code(?:-dev)?:\/\/app(?:\/|$)/.test(target.url)) continue;
    const client = await new Cdp(target, port).open();
    try {
      const result = await client.evaluate(`(async () => {
        const local = await window.desktopBridge?.getHostEnvironmentId?.();
        const ids = [];
        for (const row of document.querySelectorAll('li[data-thread-item] [data-sidebar-row]')) {
          const key = row.getAttribute('data-sidebar-row');
          if (key && row.closest('li[data-thread-item]')?.getAttribute('data-thread-item') === key) {
            ids.push(key.split(':', 1)[0]);
          }
        }
        return { local, ids };
      })()`);
      if (result?.local?.toLowerCase() !== localId) continue;
      foundHost = true;
      for (const id of result.ids) if (UUID.test(id)) ids.add(id.toLowerCase());
    } finally {
      client.close();
    }
  }
  if (!foundHost || !ids.size) throw new Error("请用 InfoBar 启动 T3，并展开含有对话的侧边栏后重试。");
  return ids;
}

export async function applySidebarColors(port) {
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  const localId = getLocalT3EnvironmentId(home);
  if (!localId || !UUID.test(localId)) throw new Error("无法识别本机 T3 环境。");
  const ids = await findVisibleEnvironments(port, localId);
  const file = path.join(home, "userdata/themes/codex-infobar.json");
  const original = await fs.readFile(file, "utf8");
  const theme = JSON.parse(original);
  if (typeof theme.css !== "string") throw new Error("已安装的 InfoBar 主题缺少 CSS。");
  theme.css = withSidebarColors(theme.css, localId, ids);

  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const backup = path.join(stateRoot, "codex-infobar.before-sidebar-colors.json");
  try { await fs.writeFile(backup, original, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-sidebar-colors-"));
  try {
    const temporary = path.join(dir, "codex-infobar.json");
    await fs.writeFile(temporary, JSON.stringify(theme, null, 2) + "\n", { mode: 0o600 });
    await run("t3", ["theme", "set", "--base-dir", home, "--id", "codex-infobar", temporary], { timeout: 15000 });
    const applied = JSON.parse(await fs.readFile(file, "utf8"));
    if (applied.css !== theme.css) throw new Error("无法验证已安装的 InfoBar 主题。");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  ids.add(localId);
  return { environments: ids.size, backup };
}
