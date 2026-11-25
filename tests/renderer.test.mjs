import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { validateThreadId } from "../src/reader.mjs";
import { parseGeminiTranscript, formatGeminiModelBadge } from "../src/gemini-reader.mjs";
import { formatMetricsForTheme, buildT3Theme } from "../src/theme.mjs";

const source = fs.readFileSync(new URL("../src/renderer.js", import.meta.url), "utf8");
const THREAD = "01234567-89ab-cdef-0123-456789abcdef";
const OTHER = "11234567-89ab-cdef-0123-456789abcdef";
const T3_IMPORT = `import:codex_86e17730-7ab2-441b-a6a7-b265e5001c3d:${THREAD}`;

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.textContent = "";
    this.style = {};
    this.title = "";
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  attachShadow() { this.shadowRoot = new Element("shadow"); return this.shadowRoot; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; return node; }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  before(node) { this.insert(node, 0); }
  after(node) { this.insert(node, 1); }
  insert(node, offset) {
    const parent = this.parentElement;
    node.remove();
    parent.children.splice(parent.children.indexOf(this) + offset, 0, node);
    node.parentElement = parent;
  }
  get nextElementSibling() { const nodes = this.parentElement?.children ?? []; return nodes[nodes.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { const nodes = this.parentElement?.children ?? []; return nodes[nodes.indexOf(this) - 1] ?? null; }
  get lastElementChild() { return this.children.at(-1); }
  get isConnected() { return this.parentElement !== null; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 700, height: 100, left: 0, right: 700, top: 500, bottom: 600 }; }
  content() { return this.textContent + this.children.map(child => child.content()).join(""); }
}

function environment(path = `/threads/${THREAD}`) {
  let now = 1000;
  const timers = new Map();
  const listeners = new Map();
  const parent = new Element("main");
  const composer = new Element("div");
  composer.setAttribute("data-slot", "composer-host");
  parent.appendChild(composer);
  const nodes = [];
  let composerVisible = true;
  let t3SidebarRows = [];
  const window = {
    location: { href: `http://127.0.0.1:3000/` + path.replace(/^\//, "") },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const document = {
    createElement(tag) { const node = new Element(tag); nodes.push(node); return node; },
    createElementNS(namespace, tag) { return this.createElement(tag); },
    querySelectorAll(selector) {
      if (selector.includes("[data-thread-item]")) return t3SidebarRows;
      if (composerVisible && selector === '[data-slot="composer-host"]') return [composer];
      return [];
    },
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    innerHeight: 900,
    innerWidth: 1000,
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    Date: { now: () => now, parse: Date.parse },
    setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return {
    window,
    parent,
    composer,
    get api() { return window.__T3_METRICS_HUD__; },
    get host() { return nodes.filter(node => node.id === "t3-metrics-hud").at(-1); },
    navigate(next) {
      window.location.href = `http://127.0.0.1:3000${next}`;
      for (const callback of timers.values()) callback();
    },
    tick(ms) {
      now += ms;
      for (const callback of timers.values()) callback();
    },
    setT3ActiveThread(threadId) {
      const row = new Element("div");
      row.setAttribute("data-thread-item", threadId);
      row.setAttribute("data-active", "true");
      t3SidebarRows = threadId ? [row] : [];
      this.tick(1);
    },
  };
}

function codexSnapshot(overrides = {}) {
  return {
    provider: "codex",
    threadId: THREAD,
    status: "ok",
    source: "local-rollout",
    active: true,
    averageOutputTps: 24.6,
    lastCacheRatio: 0.984,
    compactionCount: 1,
    contextUsedTokens: 35800,
    contextWindowTokens: 200000,
    contextRemainingTokens: 164200,
    compactReference: {
      kind: "calibrated-compaction-estimate",
      limit: 130000,
      remaining: 93600,
      remainingPercent: 72.4,
      reserve: 2048,
      source: "model-default",
      sampleCount: 2,
    },
    ...overrides,
  };
}

test("mounts inside T3 [data-slot='composer-host'] and renders Codex-InfoBar metrics", () => {
  const env = environment(`/threads/${THREAD}`);
  assert.equal(env.api.getThreadId(), THREAD);
  assert.equal(env.api.getStatus().mounted, true);
  assert.equal(env.host.parentElement, env.composer);

  env.api.updateAccount({
    observedAt: 1000,
    resetCardCount: 3,
    resetCardExpiries: [200000],
    usageResets: [{ limitId: "codex", window: "primary", windowMinutes: 10080, usedPercent: 22, resetsAt: 400000 }],
  });
  env.api.update(codexSnapshot());
  const text = env.host.shadowRoot.content();
  assert.match(text, /24\.6 tok\/s/);
  assert.match(text, /98\.4%/);
  assert.match(text, /1次/);
  assert.match(text, /164\.2k tok/);
  assert.match(text, /≈72%/);
  assert.match(text, /78/);
  assert.match(text, /3张/);
});

test("parseGeminiTranscript computes 1M window, 800k threshold, cache ratio, speed, and model badge", () => {
  assert.equal(formatGeminiModelBadge("gemini-4-argon-high"), "Argon·High");
  assert.equal(formatGeminiModelBadge("gemini-4-neon-xhigh"), "Neon·XHigh");
  assert.equal(formatGeminiModelBadge("gemini-3.8-flash-medium"), "3.8Flash·Med");

  const sampleJsonl = [
    JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-25T09:00:00Z", content: "Hello" }),
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-25T09:00:10Z",
      model: "gemini-4-argon-high",
      input_tokens: 2824,
      cache_read_tokens: 161281,
      output_tokens: 1364,
    }),
  ].join("\n");

  const parsed = parseGeminiTranscript(sampleJsonl, {
    threadId: THREAD,
    now: Date.parse("2026-11-25T09:00:20Z"),
  });

  assert.equal(parsed.provider, "gemini");
  assert.equal(parsed.modelBadge, "Argon·High");
  assert.equal(parsed.contextWindowTokens, 1_000_000);
  assert.equal(parsed.contextUsedTokens, 2824 + 161281 + 1364); // 165,469
  assert.equal(parsed.contextRemainingTokens, 1_000_000 - 165469); // 834,531
  assert.ok(Math.abs(parsed.lastCacheRatio - 161281 / (2824 + 161281)) < 1e-6);
  assert.ok(Math.abs(parsed.averageOutputTps - 136.4) < 1e-3);
  assert.equal(parsed.compactReference.limit, 800_000);
  assert.equal(Math.floor(parsed.compactReference.remainingPercent), 79);
});

test("dual-engine renderer auto-switches slot 7 between Gemini model badge and Codex reset cards", () => {
  const env = environment(`/threads/${THREAD}`);
  const geminiSnap = parseGeminiTranscript(
    [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-25T09:00:00Z", content: "Hi" }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T09:00:20Z",
        model: "gemini-4-argon-high",
        input_tokens: 2824,
        cache_read_tokens: 161281,
        output_tokens: 1000,
      }),
    ].join("\n"),
    { threadId: THREAD, now: 2000 }
  );
  env.api.update(geminiSnap);
  const geminiText = env.host.shadowRoot.content();
  assert.match(geminiText, /Argon·High/);
  assert.match(geminiText, /834\.9k tok/);
  assert.match(geminiText, /≈79%/);
  assert.equal(env.api.getStatus().provider, "gemini");

  // Switch back to a Codex snapshot
  env.api.updateAccount({
    observedAt: 1000,
    resetCardCount: 3,
    resetCardExpiries: [],
    usageResets: [{ limitId: "codex", window: "primary", windowMinutes: 10080, usedPercent: 22, resetsAt: 400000 }],
  });
  env.api.update(codexSnapshot());
  const codexText = env.host.shadowRoot.content();
  assert.match(codexText, /3张/);
  assert.doesNotMatch(codexText, /Argon·High/);
  assert.equal(env.api.getStatus().provider, "codex");
});

test("resolves T3 import:codex thread IDs in URL, sidebar [data-thread-item], and reader", () => {
  assert.equal(validateThreadId(T3_IMPORT), THREAD);
  const env = environment(`/threads/${encodeURIComponent(T3_IMPORT)}`);
  assert.equal(env.api.getThreadId(), THREAD);

  env.navigate("/workspace");
  env.setT3ActiveThread(`import:codex_86e17730-7ab2-441b-a6a7-b265e5001c3d:${OTHER}`);
  assert.equal(env.api.getThreadId(), OTHER);
});

test("low quota (<20%) turns quota ring red and preserves cards DOM node across updates", () => {
  const env = environment(`/threads/${THREAD}`);
  env.api.updateAccount({
    observedAt: 1000,
    resetCardCount: 2,
    resetCardExpiries: [],
    usageResets: [{ limitId: "codex", window: "primary", windowMinutes: 10080, usedPercent: 85, resetsAt: 400000 }],
  });
  env.api.update(codexSnapshot());
  const bar = env.host.shadowRoot.children[1];
  const resetItem = bar.children.find(c => c.getAttribute("data-metric") === "reset");
  const ringSvg = resetItem.children[0].children[0];
  assert.equal(ringSvg.getAttribute("data-quota-low"), "true");

  const cardsItemBefore = bar.children.find(c => c.getAttribute("data-metric") === "cards");
  assert.equal(cardsItemBefore.title, "重置卡:2张");
  env.api.update(codexSnapshot({ averageOutputTps: 31.2 }));
  const cardsItemAfter = bar.children.find(c => c.getAttribute("data-metric") === "cards");
  assert.equal(cardsItemAfter, cardsItemBefore);
});

test("buildT3Theme produces valid T3 Code theme JSON for both Gemini and Codex snapshots", () => {
  const s = codexSnapshot({ provider: "gemini", modelBadge: "Argon·High" });
  const metrics = formatMetricsForTheme(s, null, 1000);
  assert.equal(metrics.slot7Kind, "tier");
  assert.equal(metrics.slot7Value, "Argon·High");
  const theme = buildT3Theme(metrics);
  assert.equal(theme.name, "Codex InfoBar");
  assert.match(theme.css, /\[data-chat-composer-form\]:not\(:has\(#t3-metrics-hud\)\)/);
  assert.match(theme.css, /Argon%C2%B7High/);
});
