(() => {
  "use strict";
  const KEY = "__T3_METRICS_HUD__";
  const LEGACY_KEY = "__CODEX_METRICS_HUD__";
  const HOST_ID = "t3-metrics-hud";
  const EXPIRY_MS = 30000;
  const ACCOUNT_EXPIRY_MS = 90000;
  const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const IMPORT_CODEX = new RegExp(`^import:codex(?:_[0-9a-f-]+)?:${UUID}$`, "i");
  const ROUTE = new RegExp(`^/(?:local|threads?|projects/[^/]+/threads?|hotkey-window/thread)/([^/?#]+)/?$`, "i");
  window[KEY]?.remove?.();
  if (window[LEGACY_KEY] && window[LEGACY_KEY] !== window[KEY]) window[LEGACY_KEY]?.remove?.();

  let snapshot = null;
  let accountSnapshot = null;
  let receivedAt = 0;
  let collectorAt = 0;
  let position = "inside";
  let removed = false;
  let mounted = false;
  let lastRoute = null;
  let lastView = "";
  let cardsMetric = null;
  const snapshots = new Map();
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-t3-metrics-hud", "true");
  host.setAttribute("data-codex-metrics-hud", "true");
  host.setAttribute("data-position", position);

  const layoutStyle = document.createElement("style");
  layoutStyle.textContent = `
    [data-chat-composer-form]:has(#${HOST_ID}[data-position="inside"]),
    [data-slot="composer-host"]:has(> #${HOST_ID}[data-position="inside"]),
    [data-composer-layout="single-line"]:has(> [data-composer-body] > #${HOST_ID}[data-position="inside"]) {
      display: flex !important;
      flex-direction: column !important;
      --composer-surface-border-radius: var(--composer-border-radius, 20px);
      border-radius: var(--composer-border-radius, 20px) !important;
    }
  `;
  host.appendChild(layoutStyle);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { display:block; min-width:0; max-width:100%; margin:6px 0;
      flex:0 0 auto; box-sizing:border-box;
      color:var(--muted-foreground, var(--color-token-text-secondary, #a6a6a6));
      font:11px/1.5 var(--font-sans, -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif); }
    :host([hidden]) { display:none !important; }
    .bar { display:flex; flex-wrap:nowrap; align-items:center; gap:3px 14px; padding:5px 10px;
      border:1px solid color-mix(in srgb,currentColor 15%,transparent); border-radius:9px;
      background:color-mix(in srgb,currentColor 3%,transparent); min-width:0; overflow-x:auto; }
    .metric { display:inline-flex; align-items:center; flex:0 0 auto; min-height:26px; gap:6px; white-space:nowrap; line-height:normal; }
    .value { display:inline-flex; align-items:center; line-height:normal; min-height:16px; }
    .icon { display:block; width:14px; height:14px; flex:0 0 14px; opacity:.85; }
    .metric:hover .icon { opacity:1; }
    .icon.quota-ring { opacity:1; width:26px; height:26px; flex-basis:26px; }
    .quota-wrap { position:relative; display:inline-grid; place-items:center; width:26px; height:26px; flex:0 0 26px; }
    .quota-label { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:10.4px; line-height:normal; pointer-events:none; }
    .quota-track { stroke:currentColor; opacity:.24; }
    .quota-fill { stroke:var(--codex-hud-quota-color, #9be8c2); }
    .quota-ring[data-quota-low="true"] .quota-fill,
    .quota-ring[data-quota-low="true"] .quota-track { stroke:var(--codex-hud-quota-low-color, #f87171); }
    .quota-unknown { opacity:.5; }
    .reset-card { color:var(--codex-hud-card-color, #e9c77b); opacity:1; }
    .tier-icon { color:var(--codex-hud-tier-color, #8ab4f8); opacity:1; }
    .value, .quota-label { color:var(--foreground, var(--color-token-text-primary, inherit)); font-variant-numeric:tabular-nums; font-weight:500; }
    @media(max-width:600px) { .bar { gap:3px 10px; padding:4px 8px; } }
  `;
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-live", "off");
  bar.setAttribute("aria-label", "T3 InfoBar 会话统计");
  shadow.append(style, bar);

  function normalizeThreadId(raw) {
    if (typeof raw !== "string" || !raw) return null;
    const decoded = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
    const imported = IMPORT_CODEX.exec(decoded)?.[1];
    if (imported) return imported.toLowerCase();
    if (/^thread:subagent:[a-f0-9]+$/i.test(decoded)) return decoded;
    const direct = new RegExp(`^${UUID}$`, "i").exec(decoded)?.[1];
    if (direct) return direct.toLowerCase();
    const prefixed = new RegExp(`^local:${UUID}$`, "i").exec(decoded)?.[1];
    return prefixed ? prefixed.toLowerCase() : null;
  }

  function cardTooltipText() {
    const count = resetCardCount();
    return `重置卡:${count === null ? "—" : `${count}张`}${accountSnapshot?.sourceDescription ? `\n${accountSnapshot.sourceDescription}` : ""}`;
  }

  function composerThread(composer) {
    if (!composer) return null;
    const key = Object.getOwnPropertyNames(composer).find(k => k.startsWith("__reactFiber$"));
    let fiber = key && composer[key];
    if (!fiber) return null;
    const ancestors = new Set();
    let root;
    for (let depth = 0; fiber && depth < 512; depth++, fiber = fiber.return) {
      ancestors.add(fiber);
      if (fiber.alternate) ancestors.add(fiber.alternate);
      root = fiber;
    }
    const current = root?.stateNode?.current;
    if (!current || !ancestors.has(current)) return null;
    const pending = [{ fiber: current, parent: null }];
    let budget = 4096;
    while (pending.length && budget-- > 0) {
      const item = pending.pop();
      if (item.fiber.stateNode === composer) {
        let emptyConversation = false;
        for (let cursor = item; cursor; cursor = cursor.parent) {
          const props = cursor.fiber.memoizedProps;
          if (!props) continue;
          if (typeof props.threadId === "string") {
            const id = normalizeThreadId(props.threadId);
            if (id) return { id };
          }
          if (Object.prototype.hasOwnProperty.call(props, "conversationId") && props.conversationId === null) {
            if (typeof props.hostId === "string" && props.hostId !== "local") return { id: null, draft: false };
            emptyConversation = true;
          }
          if (typeof props.conversationId === "string" && (typeof props.hostId !== "string" || props.hostId === "local")) {
            const id = normalizeThreadId(props.conversationId);
            return { id };
          }
        }
        return emptyConversation ? { id: null, draft: true } : null;
      }
      for (let child = item.fiber.child; child && budget-- > 0; child = child.sibling) {
        if (ancestors.has(child)) pending.push({ fiber: child, parent: item });
      }
    }
    return null;
  }

  function getThreadId() {
    try {
      const url = new URL(window.location.href);
      const qThread = normalizeThreadId(url.searchParams.get("threadId") || url.searchParams.get("thread"));
      if (qThread) return qThread;
      const path = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
      const environmentRoute = new RegExp(`^/${UUID}/([^/?#]+)/?$`, "i").exec(path);
      if (environmentRoute) return normalizeThreadId(environmentRoute[2]);
      const routeMatch = ROUTE.exec(path)?.[1];
      const direct = normalizeThreadId(routeMatch);
      if (direct) return direct;

      const t3Rows = Array.from(document.querySelectorAll('[data-thread-item][data-active="true"], [data-thread-item][data-state="active"], [data-thread-item][aria-current="page"], [data-thread-item][aria-selected="true"]'));
      if (t3Rows.length === 1) {
        const rawId = t3Rows[0].getAttribute("data-thread-id") || t3Rows[0].getAttribute("data-thread-item");
        const normalized = normalizeThreadId(rawId);
        if (normalized) return normalized;
      }

      if (url.protocol !== "app:" || !["/index.html", "/detached-window.html"].includes(path)) {
        const thread = composerThread(findComposer());
        if (thread?.id) return thread.id;
        return null;
      }
      const thread = composerThread(findComposer());
      if (thread) return thread.id;
      const initial = url.searchParams.get("initialRoute");
      if (initial && !ROUTE.test(initial.split("?")[0])) return null;
      const rows = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-active="true"]'));
      if (!rows.length) return null;
      const ids = new Set();
      for (const row of rows) {
        if (row.getAttribute("data-app-action-sidebar-thread-host-id") !== "local") return null;
        const key = row.getAttribute("data-app-action-sidebar-thread-id");
        const id = normalizeThreadId(key);
        if (!id) return null;
        ids.add(id);
      }
      return ids.size === 1 ? Array.from(ids)[0] : null;
    } catch { return null; }
  }

  function getThreadContext() {
    try {
      const url = new URL(window.location.href);
      const path = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
      const route = new RegExp(`^/${UUID}/([^/?#]+)/?$`, "i").exec(path);
      if (route) return { environmentId: route[1].toLowerCase(),
        appThreadId: decodeURIComponent(route[2]), threadId: normalizeThreadId(route[2]) };
    } catch {}
    const id = getThreadId();
    return { environmentId: null, appThreadId: id, threadId: id };
  }
  function sessionKey(value = getThreadContext()) {
    return JSON.stringify([value.environmentId ?? null, value.threadId ?? null]);
  }

  function isNewConversation(composer) {
    try {
      const url = new URL(window.location.href);
      if (composer && (composer.getAttribute?.("data-slot") === "composer-host" || composer.hasAttribute?.("data-chat-composer-form"))) {
        return true;
      }
      if (url.protocol !== "app:" || !["/index.html", "/detached-window.html"].includes(url.pathname)) return false;
      const initial = url.searchParams.get("initialRoute")?.split("?")[0];
      if (["/avatar-overlay", "/spotlight", "/global-dictation"].includes(initial)) return false;
      return composerThread(composer)?.draft === true;
    } catch { return false; }
  }

  function visible(node) {
    if (!node || node === host || node.closest?.(`#${HOST_ID}`)) return false;
    if (node.closest?.('[hidden], [aria-hidden="true"]')) return false;
    const bounds = node.getBoundingClientRect();
    const computed = getComputedStyle(node);
    return bounds.width >= 180 && bounds.height > 0 && computed.display !== "none" &&
      computed.visibility !== "hidden" && bounds.bottom > 0 && bounds.top < innerHeight;
  }

  function findComposer() {
    for (const node of document.querySelectorAll("[data-chat-composer-form]")) {
      if (visible(node)) return node;
    }
    for (const node of document.querySelectorAll('[data-slot="composer-host"]')) {
      if (visible(node)) return node;
    }
    for (const node of document.querySelectorAll("[data-composer-body]")) {
      if (visible(node)) return node;
    }
    for (const node of document.querySelectorAll(".composer-surface-chrome")) {
      if (visible(node)) return node;
    }
    for (const editor of document.querySelectorAll('.composer-tiptap, .ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea')) {
      if (!visible(editor)) continue;
      const composer = editor.closest?.('[data-chat-composer-form], [data-slot="composer-host"], [data-testid*="composer"], [data-composer], form');
      if (visible(composer)) return composer;
    }
    return null;
  }

  function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  function tokens(value) {
    if (!numeric(value)) return "—";
    if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
  }
  function resetWindows() {
    const source = freshAccount() && Array.isArray(accountSnapshot.usageResets)
      ? accountSnapshot.usageResets : snapshot?.provider === "gemini" ? [] : snapshot?.usageResets;
    return (Array.isArray(source) ? source : []).filter(w =>
      numeric(w.resetsAt) && w.resetsAt > 0 && w.resetsAt * 1000 <= 8640000000000000);
  }
  function freshAccount() {
    if ((accountSnapshot?.environmentId ?? null) !== (snapshot?.environmentId ?? null)) return false;
    if (accountSnapshot?.threadId && accountSnapshot.threadId !== getThreadId()) return false;
    if (accountSnapshot?.provider && accountSnapshot.provider !== snapshot?.provider) return false;
    if (snapshot?.provider === "gemini" && accountSnapshot?.provider !== "gemini") return false;
    if (accountSnapshot?.sourceInstanceId && snapshot?.providerInstanceId &&
        accountSnapshot.sourceInstanceId !== snapshot.providerInstanceId) return false;
    if (accountSnapshot?.model && accountSnapshot.model !== snapshot?.model) return false;
    const age = Date.now() - accountSnapshot?.observedAt;
    return Number.isFinite(age) && age >= 0 && age <= (accountSnapshot?.cached ? 7 * 86400000 : ACCOUNT_EXPIRY_MS);
  }
  function deadline(w) {
    const eligible = w.limitId === "codex" ||
      (w.limitId == null && (w.limitName == null || w.limitName === "codex"));
    const cards = freshAccount() && eligible && Array.isArray(accountSnapshot.resetCards)
      ? accountSnapshot.resetCards : [];
    const expiresAt = cards.map(card => card.expiresAt).filter(value =>
      Number.isSafeInteger(value) && value * 1000 > Date.now() && value < w.resetsAt).sort((a, b) => a - b)[0];
    return { at: expiresAt ?? w.resetsAt, card: expiresAt !== undefined };
  }
  function resetCardCount() {
    if (!freshAccount() || !Number.isSafeInteger(accountSnapshot.resetCardCount) || accountSnapshot.resetCardCount < 0) return null;
    const expired = (Array.isArray(accountSnapshot.resetCardExpiries) ? accountSnapshot.resetCardExpiries : [])
      .filter(at => Number.isSafeInteger(at) && at > 0 && at * 1000 <= Date.now()).length;
    return Math.max(0, accountSnapshot.resetCardCount - expired);
  }
  function resetCountdown(resetsAt) {
    const milliseconds = resetsAt * 1000 - Date.now();
    if (milliseconds <= 0) return "等待更新";
    const minutes = Math.ceil(milliseconds / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    if (days === 0) return `${String(hours).padStart(2, "0")}时 ${String(minutes % 60).padStart(2, "0")}分`;
    return `${days}天 ${String(hours).padStart(2, "0")}时 ${String(minutes % 60).padStart(2, "0")}分`;
  }
  function windowLabel(w) {
    const minutes = w.windowMinutes;
    if (!numeric(minutes) || !minutes) return w.window === "secondary" ? "窗口 2" : "窗口 1";
    if (minutes % 1440 === 0) return `${minutes / 1440}天窗口`;
    if (minutes % 60 === 0) return `${minutes / 60}小时窗口`;
    return `${minutes}分钟窗口`;
  }
  function resetDisplay() {
    const windows = resetWindows();
    const multipleBuckets = new Set(windows.map(w => w.limitId)).size > 1;
    return windows.length ? windows.map(w => {
      const selected = deadline(w);
      return `${multipleBuckets ? `${w.limitName || w.limitId || "用量"} ` : ""}${windows.length > 1 ? `${windowLabel(w)} ` : ""}${resetCountdown(selected.at)}:${selected.card}`;
    }).join(" / ") : "—";
  }
  function resetMetric(stale = false) {
    if (freshAccount() && accountSnapshot.usageState === "unsupported") {
      metric("reset", "账户用量", "查看用量", accountSnapshot.sourceDescription);
      return;
    }
    const windows = stale ? [] : resetWindows();
    if (!windows.length) {
      metric("reset", "用量重置", "—", "");
      return;
    }
    const multipleBuckets = new Set(windows.map(w => w.limitId)).size > 1;
    const clock = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    for (const w of windows) {
      const bucket = w.limitName || w.limitId;
      const current = w.resetsAt * 1000 > Date.now();
      const quotaFresh = snapshot?.provider !== "gemini" || Date.now() - accountSnapshot?.observedAt <= ACCOUNT_EXPIRY_MS ||
        (numeric(w.restrictionUntil) && w.restrictionUntil * 1000 > Date.now());
      const remaining = current && quotaFresh && numeric(w.usedPercent)
        ? Math.max(0, Math.min(100, 100 - w.usedPercent)) : null;
      const selected = deadline(w);
      const sourceBadge = accountSnapshot?.sourceBadge ? `${accountSnapshot.sourceBadge} ` : "";
      const value = snapshot?.provider === "gemini" ? resetCountdown(selected.at)
        : `${sourceBadge}${multipleBuckets ? `${bucket || "用量"} ` : ""}${windows.length > 1 ? `${windowLabel(w)} ` : ""}${resetCountdown(selected.at)}`;
      metric("reset", selected.card ? "重置卡到期" : "用量重置", value,
        selected.card ? `${clock.format(selected.at * 1000)}（北京时间）` : resetCountdown(selected.at),
        remaining, selected.card);
    }
  }
  const icons = {
    speed: ["M3 13a9 9 0 0 1 18 0", "M12 13l4-4M6 18h12"],
    cache: ["M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4Z", "M4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6", "M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4"],
    compact: ["M12 2v6m-3-3 3 3 3-3", "M12 22v-6m-3 3 3-3 3 3", "M5 12h14"],
    context: ["m12 3-9 5 9 5 9-5-9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
    budget: ["M4 3v6l4-3-4-3Z", "M20 3v6l-4-3 4-3Z", "M4 15v6l4-3-4-3Z", "M20 15v6l-4-3 4-3Z", "M9 12h6"],
    cards: ["M7 3h12a2 2 0 0 1 2 2v12", "M5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z", "M7 12h6M7 16h3"],
    tier: ["M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"],
  };
  function metric(iconName, label, value, tooltip, remainingPercent = null, card = false) {
    if (iconName === "cards" && cardsMetric) {
      const text = cardTooltipText();
      if (cardsMetric.title !== text) {
        cardsMetric.title = text;
        cardsMetric.setAttribute("aria-label", text);
      }
      if (cardsMetric.children[1].textContent !== value) cardsMetric.children[1].textContent = value;
      return;
    }
    const item = document.createElement("span");
    item.className = "metric";
    const hoverNames = {
      speed: "平均token输出速度",
      cache: "命中缓存",
      compact: "压缩次数",
      context: "上下文余量",
      budget: "剩余压缩余量",
      tier: "模型与思考档位",
    };
    item.title = iconName === "reset" && freshAccount() && accountSnapshot.usageState === "unsupported"
      ? `查看账户用量\n${tooltip || ""}`
      : iconName === "reset"
      ? card ? tooltip
        : `套餐剩余：${remainingPercent === null ? "—" : Math.round(remainingPercent) + "%"}；重置剩余时间：${tooltip || value}`
      : iconName === "tier" && tooltip
        ? tooltip
        : `${hoverNames[iconName] ?? label}：${value}`;
    if (iconName === "cards") item.title = cardTooltipText();
    item.setAttribute("role", "group");
    const quotaLabel = iconName === "reset" ? `；${remainingPercent !== null ? `剩余 ${Math.round(remainingPercent * 10) / 10}%` : "剩余额度未知"}` : "";
    item.setAttribute("aria-label", `${label}：${value}${quotaLabel}`);
    item.setAttribute("data-metric", iconName);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const iconClass = iconName === "tier" ? "icon tier-icon" : "icon";
    for (const [name, val] of Object.entries({ class: iconClass, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) {
      icon.setAttribute(name, val);
    }
    if (iconName === "reset") {
      icon.setAttribute("class", "icon quota-ring");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "butt");
      icon.setAttribute("data-quota-low", String(remainingPercent !== null && remainingPercent < 20));
      const circle = (attributes) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        for (const [name, val] of Object.entries({ cx: "12", cy: "12", r: "9", pathLength: "100", ...attributes })) node.setAttribute(name, val);
        icon.appendChild(node);
      };
      circle(remainingPercent === null
        ? { class: "quota-track quota-unknown", "stroke-dasharray": "3 4" }
        : { class: "quota-track" });
      if (remainingPercent > 0) circle({
        class: "quota-fill", "stroke-dasharray": `${remainingPercent} ${100 - remainingPercent}`,
        "stroke-dashoffset": "0",
        transform: "rotate(-90 12 12)",
      });
    } else {
      for (const shape of icons[iconName]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", shape);
        icon.appendChild(path);
      }
    }
    const usageLink = iconName === "reset" && freshAccount() &&
      accountSnapshot.usageState === "unsupported" &&
      accountSnapshot.usageUrl === "https://chatgpt.com/#settings/Usage";
    const number = document.createElement(usageLink ? "a" : "span");
    number.className = "value";
    number.textContent = value;
    if (usageLink) {
      number.setAttribute("href", accountSnapshot.usageUrl);
      number.setAttribute("target", "_blank");
      number.setAttribute("rel", "noopener noreferrer");
      number.style.textDecoration = "underline";
      number.addEventListener?.("click", event => {
        if (typeof window.desktopBridge?.openExternal === "function") {
          event.preventDefault();
          void window.desktopBridge.openExternal("https://chatgpt.com/#settings/Usage");
        }
      });
    }
    if (iconName === "reset") {
      const wrap = document.createElement("span");
      wrap.className = "quota-wrap";
      wrap.setAttribute("aria-hidden", "true");
      const lbl = document.createElement("span");
      lbl.setAttribute("class", "quota-label");
      lbl.textContent = remainingPercent === null ? "—" : String(Math.round(remainingPercent));
      wrap.append(icon, lbl);
      item.append(wrap, number);
    } else item.append(icon, number);
    if (card) {
      const badge = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [name, val] of Object.entries({ class: "icon reset-card", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) badge.setAttribute(name, val);
      for (const shape of ["M20 9V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M2 7h18", "M22 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z", "M16 13v3l2 1"]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", shape);
        badge.appendChild(path);
      }
      item.appendChild(badge);
    }
    if (iconName === "cards") {
      cardsMetric = item;
      item.setAttribute("aria-label", cardTooltipText());
    }
    if (cardsMetric?.parentElement === bar) cardsMetric.before(item);
    else bar.appendChild(item);
  }

  function render(stale, cached = false) {
    const expiredGeminiQuota = snapshot?.provider === "gemini" && Date.now() - accountSnapshot?.observedAt > ACCOUNT_EXPIRY_MS;
    const view = JSON.stringify([snapshot, stale, cached, freshAccount() ? accountSnapshot : null, expiredGeminiQuota, resetDisplay(), resetCardCount()]);
    if (view === lastView) return;
    lastView = view;
    const isGemini = snapshot?.provider === "gemini" || Boolean(snapshot?.modelBadge);
    if (isGemini && cardsMetric) {
      cardsMetric.remove();
      cardsMetric = null;
    }
    for (const item of Array.from(bar.children)) if (item !== cardsMetric) item.remove();
    bar.title = "";
    const values = stale || snapshot?.status !== "ok" ? {} : snapshot;
    metric("speed", "平均输出", numeric(values.averageOutputTps) ? `${values.averageOutputTps.toFixed(1)} tok/s` : "—",
      "输出 token ÷ 回合耗时，包含等待与工具执行；不代表模型实时生成速度。");
    const ratio = values.lastCacheRatio;
    metric("cache", "缓存", numeric(ratio) && ratio <= 1 ? `${(ratio * 100).toFixed(1)}%` : "—",
      "最近一次用量记录的缓存输入 token ÷ 总输入 token。");
    const compactCount = numeric(values.compactionCount) ? `${Math.round(values.compactionCount)}次` : "—";
    const partialHistory = values.historyComplete === false;
    metric("compact", "压缩次数", compactCount,
      `包含手动 (/compact) 和自动压缩，按完成事件去重。${partialHistory ? "当前可读历史可能不完整，此处仅为已记录次数。" : ""}`);
    metric("context", "上下文余量", numeric(values.contextRemainingTokens) ? `${tokens(values.contextRemainingTokens)} tok` : "—",
      `最近记录的上下文占用 ${tokens(values.contextUsedTokens)} / ${tokens(values.contextWindowTokens)} tok；上下文上限不等于压缩阈值。`);
    const reference = values.compactReference;
    const estimated = reference?.kind === "calibrated-compaction-estimate" && numeric(reference.remainingPercent);
    const budgetTooltip = reference?.source === "gemini-800k-threshold"
      ? "按 Gemini 1M 窗口的 800k (80%) 自动压缩阈值估算的剩余空间。"
      : "按配置、近期压缩记录及请求增长余量校准的估计。";
    metric("budget", "剩余压缩余量", estimated ? `≈${Math.floor(reference.remainingPercent)}%` : "—", budgetTooltip);
    resetMetric(stale);
    if (isGemini) {
      const badgeValue = values.modelBadge || snapshot?.modelBadge || "Gemini";
      const rawModel = values.model || snapshot?.model;
      metric("tier", "模型与思考档位", badgeValue, `模型与思考档位：${badgeValue}${rawModel ? `（${rawModel}）` : ""}`);
    } else {
      const cards = resetCardCount();
      metric("cards", "可用重置卡", cards === null ? "—" : `${cards}张`, `${accountSnapshot?.sourceDescription || ""}\n当前账户尚未过期的可用 Codex 重置卡数量。`);
    }
  }

  function refresh() {
    if (removed) return;
    const threadId = getThreadId();
    const key = sessionKey();
    const composer = findComposer();
    const draft = !threadId && isNewConversation(composer);
    if (key !== lastRoute) {
      const cached = snapshots.get(key);
      snapshot = cached?.snapshot ?? (threadId ? { threadId, status: "unavailable" } : null);
      receivedAt = cached?.receivedAt ?? Date.now();
      lastRoute = key;
    }
    if (draft && !snapshot) {
      snapshot = { threadId: null, status: "unavailable", draft: true };
      receivedAt = Date.now();
    }
    if (!threadId && !draft) {
      host.remove();
      mounted = false;
      return;
    }
    if (!composer?.parentElement) {
      if (document.hidden && host.isConnected) return;
      host.remove();
      mounted = false;
      return;
    }
    host.style.position = "relative";
    host.style.order = position === "inside" ? "999" : "";
    host.style.margin = position === "inside" ? "2px 12px 10px" : "6px 0";
    host.style.maxWidth = position === "inside" ? "calc(100% - 24px)" : "100%";
    host.style.alignSelf = "stretch";
    if (position === "inside") {
      if (host.parentElement !== composer) composer.appendChild(host);
    } else if (position === "below") {
      if (host.previousElementSibling !== composer) composer.after(host);
    } else if (host.nextElementSibling !== composer) {
      composer.before(host);
    }
    mounted = true;
    const old = Date.now() - receivedAt > EXPIRY_MS;
    render(old && Date.now() - collectorAt > EXPIRY_MS, old && Date.now() - collectorAt <= EXPIRY_MS);
  }

  const timer = setInterval(refresh, 500);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(refresh) : null;
  observer?.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-active",
      "data-state",
      "aria-current",
      "aria-selected",
      "data-thread-id",
      "data-app-action-sidebar-thread-active",
      "data-app-action-sidebar-thread-id",
      "data-app-action-sidebar-thread-host-id",
    ],
  });
  window.addEventListener("popstate", refresh);
  window.addEventListener("hashchange", refresh);
  window.addEventListener("focus", refresh);

  const api = {
    version: "0.3.3",
    getThreadId,
    getThreadContext,
    normalizeThreadId,
    primeSnapshots(entries) {
      if (removed || !Array.isArray(entries)) return false;
      collectorAt = Date.now();
      for (const entry of entries.slice(-64)) {
        const id = normalizeThreadId(entry?.snapshot?.threadId);
        if (!id || !numeric(entry.receivedAt) || entry.receivedAt > Date.now()) continue;
        const key = sessionKey({ ...entry.snapshot, threadId: id });
        if ((snapshots.get(key)?.receivedAt ?? -1) > entry.receivedAt) continue;
        snapshots.delete(key);
        snapshots.set(key, { snapshot: { ...entry.snapshot, threadId: id }, receivedAt: entry.receivedAt });
        if (key === sessionKey()) { snapshot = { ...entry.snapshot, threadId: id }; receivedAt = entry.receivedAt; }
      }
      while (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
      refresh();
      return true;
    },
    updateAccount(value) {
      if (removed) return false;
      accountSnapshot = value && numeric(value.observedAt) ? value : null;
      refresh();
      return true;
    },
    update(value) {
      if (removed) return false;
      if (!value || typeof value !== "object") return false;
      const incomingId = normalizeThreadId(value.threadId);
      const currentId = getThreadId();
      if ((value.environmentId ?? null) !== (getThreadContext().environmentId ?? null)) return false;
      if (currentId && incomingId && incomingId !== currentId) {
        refresh();
        return false;
      }
      const effectiveId = incomingId || currentId;
      snapshot = { ...value, threadId: effectiveId };
      receivedAt = Date.now();
      collectorAt = receivedAt;
      if (effectiveId) {
        const key = sessionKey(snapshot);
        snapshots.delete(key);
        snapshots.set(key, { snapshot, receivedAt });
        if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
      }
      refresh();
      return mounted;
    },
    setPosition(value) {
      if (!["above", "inside", "below"].includes(value)) return false;
      position = value;
      host.setAttribute("data-position", position);
      refresh();
      return true;
    },
    getStatus() {
      return {
        mounted,
        threadId: getThreadId(),
        environmentId: getThreadContext().environmentId,
        provider: snapshot?.provider ?? (snapshot?.modelBadge ? "gemini" : "codex"),
        position,
        stale: Boolean(snapshot && Date.now() - receivedAt > EXPIRY_MS),
        removed,
        instanceId,
        newConversation: Boolean(snapshot?.draft),
      };
    },
    remove() {
      removed = true;
      window.__CODEX_METRICS_ACCOUNT__?.remove?.();
      clearInterval(timer);
      observer?.disconnect();
      snapshots.clear();
      window.removeEventListener("popstate", refresh);
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("focus", refresh);
      host.remove();
      snapshot = null;
      accountSnapshot = null;
      mounted = false;
      if (window[KEY] === api) delete window[KEY];
      if (window[LEGACY_KEY] === api) delete window[LEGACY_KEY];
      return true;
    },
  };
  window[KEY] = api;
  window[LEGACY_KEY] = api;
  refresh();
  return api.getStatus();
})();
