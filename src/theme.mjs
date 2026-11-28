// Generate a T3 Code native theme JSON (`codex-infobar.json`) with an embedded
// SVG InfoBar inside `[data-slot="composer-host"]::after` supporting both
// Google Gemini (Antigravity 1M / 800k threshold + Model·Tier badge) and Codex.

const numeric = v => typeof v === "number" && Number.isFinite(v) && v >= 0;

function formatTokens(value) {
  if (!numeric(value)) return "—";
  if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M tok`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k tok`;
  return `${Math.round(value)} tok`;
}

function formatCountdown(resetsAt, now = Date.now()) {
  if (!numeric(resetsAt) || resetsAt <= 0) return "—";
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return "等待更新";
  const minutes = Math.ceil(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days === 0) return `${String(hours).padStart(2, "0")}时 ${String(minutes % 60).padStart(2, "0")}分`;
  return `${days}天 ${String(hours).padStart(2, "0")}时 ${String(minutes % 60).padStart(2, "0")}分`;
}

export function formatMetricsForTheme(snapshot = {}, account = null, now = Date.now()) {
  const isGemini = snapshot?.provider === "gemini" || Boolean(snapshot?.modelBadge);
  const speed = numeric(snapshot.averageOutputTps) ? `${snapshot.averageOutputTps.toFixed(1)} tok/s` : "—";
  const cache = numeric(snapshot.lastCacheRatio) && snapshot.lastCacheRatio <= 1
    ? `${(snapshot.lastCacheRatio * 100).toFixed(1)}%` : "—";
  const compact = numeric(snapshot.compactionCount) ? `${Math.round(snapshot.compactionCount)}次` : "—";
  const context = numeric(snapshot.contextRemainingTokens) ? formatTokens(snapshot.contextRemainingTokens) : "—";
  const ref = snapshot.compactReference;
  const budget = ref?.kind === "calibrated-compaction-estimate" && numeric(ref.remainingPercent)
    ? `≈${Math.floor(ref.remainingPercent)}%` : "—";

  const matchingAccount = account && (!account.provider || account.provider === snapshot.provider) &&
    (!account.sourceInstanceId || !snapshot.providerInstanceId || account.sourceInstanceId === snapshot.providerInstanceId);
  const resets = matchingAccount && Array.isArray(account.usageResets) && (!isGemini || account.provider === "gemini")
    ? account.usageResets : [];
  const primary = resets[0] ?? null;
  const remainingPercent = primary && numeric(primary.usedPercent) && primary.resetsAt * 1000 > now
    ? Math.max(0, Math.min(100, Math.round(100 - primary.usedPercent)))
    : null;
  const countdown = primary ? formatCountdown(primary.resetsAt, now) : "—";

  const slot7Kind = isGemini ? "tier" : "cards";
  const slot7Value = isGemini
    ? (snapshot.modelBadge || "Argon·High")
    : (matchingAccount && Number.isSafeInteger(account.resetCardCount) && account.resetCardCount >= 0
        ? `${account.resetCardCount}张` : "—");

  return {
    provider: isGemini ? "gemini" : "codex",
    speed,
    cache,
    compact,
    context,
    budget,
    remainingPercent,
    countdown,
    slot7Kind,
    slot7Value,
    cards: slot7Value,
  };
}

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildInfoBarSvgDataUri(metrics, appearance = "dark") {
  const isDark = appearance === "dark";
  const textColor = isDark ? "#e6e6e6" : "#1f2328";
  const iconColor = isDark ? "#a6a6a6" : "#656d76";
  const lowQuota = metrics.remainingPercent !== null && metrics.remainingPercent < 20;
  const ringColor = lowQuota
    ? "#f87171"
    : (isDark ? "#9be8c2" : "#3fb950");
  const isTier = metrics.slot7Kind === "tier" || metrics.provider === "gemini";
  const slot7Color = isTier
    ? (isDark ? "#8ab4f8" : "#1a73e8")
    : (isDark ? "#e9c77b" : "#c69026");
  const slot7Paths = isTier
    ? `<path d='M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z'/>`
    : `<path d='M7 3h12a2 2 0 0 1 2 2v12'/><path d='M5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z'/><path d='M7 12h6M7 16h3'/>`;

  const pct = metrics.remainingPercent;
  const quotaLabel = pct === null ? "—" : String(Math.round(pct));
  const trackDash = pct === null ? " stroke-dasharray='3 4'" : "";
  const trackStroke = lowQuota ? ringColor : iconColor;
  const trackOpacity = lowQuota ? "0.45" : "0.24";
  const fillCircle = pct !== null && pct > 0
    ? `<circle cx='12' cy='12' r='9' pathLength='100' fill='none' stroke='${ringColor}' stroke-width='1.8' stroke-dasharray='${pct} ${100 - pct}' transform='rotate(-90 12 12)'/>`
    : "";

  const slot7Text = metrics.slot7Value ?? metrics.cards ?? "—";

  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 620 26' width='620' height='26'>` +
    `<style>.t{font:500 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:${textColor};font-variant-numeric:tabular-nums}.q{font:500 10.4px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:${textColor};text-anchor:middle;dominant-baseline:central}.i{fill:none;stroke:${iconColor};stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;opacity:.88}</style>` +
    `<g transform='translate(0,1)'><g class='i' transform='scale(0.5833) translate(0,8)'><path d='M3 13a9 9 0 0 1 18 0'/><path d='M12 13l4-4M6 18h12'/></g><text class='t' x='20' y='16'>${escapeXml(metrics.speed)}</text></g>` +
    `<g transform='translate(94,1)'><g class='i' transform='scale(0.5833) translate(0,8)'><path d='M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4Z'/><path d='M4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6'/><path d='M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4'/></g><text class='t' x='20' y='16'>${escapeXml(metrics.cache)}</text></g>` +
    `<g transform='translate(166,1)'><g class='i' transform='scale(0.5833) translate(0,8)'><path d='M12 2v6m-3-3 3 3 3-3'/><path d='M12 22v-6m-3 3 3-3 3 3'/><path d='M5 12h14'/></g><text class='t' x='20' y='16'>${escapeXml(metrics.compact)}</text></g>` +
    `<g transform='translate(222,1)'><g class='i' transform='scale(0.5833) translate(0,8)'><path d='m12 3-9 5 9 5 9-5-9-5Z'/><path d='m3 12 9 5 9-5'/><path d='m3 16 9 5 9-5'/></g><text class='t' x='20' y='16'>${escapeXml(metrics.context)}</text></g>` +
    `<g transform='translate(316,1)'><g class='i' transform='scale(0.5833) translate(0,8)'><path d='M4 3v6l4-3-4-3Z'/><path d='M20 3v6l-4-3 4-3Z'/><path d='M4 15v6l4-3-4-3Z'/><path d='M20 15v6l-4-3 4-3Z'/><path d='M9 12h6'/></g><text class='t' x='20' y='16'>${escapeXml(metrics.budget)}</text></g>` +
    `<g transform='translate(384,0)'><g transform='translate(1,1)'><circle cx='12' cy='12' r='9' pathLength='100' fill='none' stroke='${trackStroke}' stroke-opacity='${trackOpacity}' stroke-width='1.8'${trackDash}/>${fillCircle}<text class='q' x='12' y='12.5'>${escapeXml(quotaLabel)}</text></g><text class='t' x='32' y='17'>${escapeXml(metrics.countdown)}</text></g>` +
    `<g transform='translate(504,1)'><g class='i' style='stroke:${slot7Color};opacity:1' transform='scale(0.5833) translate(0,8)'>${slot7Paths}</g><text class='t' x='20' y='16'>${escapeXml(slot7Text)}</text></g>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function buildT3Theme(metrics) {
  const darkUri = buildInfoBarSvgDataUri(metrics, "dark");
  const lightUri = buildInfoBarSvgDataUri(metrics, "light");

  return {
    name: "Codex InfoBar",
    appearance: "dark",
    canvas: "#191919",
    accent: "#5d7e68",
    colors: {
      canvas: "#191919",
      chrome: "#1d1d1d",
      toolbar: "#1d1d1d",
      toolbarForeground: "#e6e6e6",
      toolbarBorder: "#2c2c2c",
      toolbarControl: "#282828",
      toolbarControlForeground: "#d8d8d8",
      toolbarControlHover: "#323834",
      surface: "#202020",
      surfaceRaised: "#282828",
      surfaceOverlay: "#303030",
      text: "#e8e8e8",
      textMuted: "#a6a6a6",
      border: "#303030",
      input: "#303030",
      focus: "#5d7e68",
      accent: "#5d7e68",
      accentForeground: "#eef8f2",
      accentSurface: "#26332c",
      accentSurfaceForeground: "#9be8c2",
      secondary: "#282828",
      secondaryForeground: "#d4d4d4",
      muted: "#262626",
      mutedForeground: "#999999",
      placeholder: "#777777",
      secondaryLabel: "#999999",
      iconMuted: "#999999",
      messageSurface: "#262626",
      messageForeground: "#e8e8e8",
      codeBackground: "#151515",
      codeForeground: "#e6e6e6",
      sidebar: "#1b1b1b",
      sidebarForeground: "#e6e6e6",
      sidebarMutedForeground: "#949494",
      sidebarControlSurface: "#252525",
      sidebarRowHover: "#242424",
      sidebarRowActive: "#2c3530",
      sidebarRowSelected: "#29332d",
      sidebarBorder: "#2a2a2a",
      terminalBackground: "#151515",
      terminalForeground: "#e6e6e6"
    },
    variants: {
      light: {
        canvas: "#ffffff",
        chrome: "#f6f8fa",
        toolbar: "#f6f8fa",
        toolbarForeground: "#1f2328",
        toolbarBorder: "#e5e7eb",
        toolbarControl: "#ffffff",
        toolbarControlForeground: "#1f2328",
        toolbarControlHover: "#eef1f4",
        surface: "#fcfcfc",
        surfaceRaised: "#f7f8fa",
        surfaceOverlay: "#ffffff",
        text: "#1f2328",
        textMuted: "#656d76",
        border: "#e2e4e8",
        input: "#ffffff",
        focus: "#3fb950",
        accent: "#3fb950",
        accentForeground: "#ffffff",
        accentSurface: "#e6f6ea",
        accentSurfaceForeground: "#1a7f37",
        secondary: "#f3f4f6",
        secondaryForeground: "#1f2328",
        muted: "#f0f2f5",
        mutedForeground: "#656d76",
        placeholder: "#8c959f",
        secondaryLabel: "#656d76",
        iconMuted: "#656d76",
        messageSurface: "#f4f6f8",
        messageForeground: "#1f2328",
        codeBackground: "#f6f8fa",
        codeForeground: "#1f2328",
        sidebar: "#f6f8fa",
        sidebarForeground: "#1f2328",
        sidebarMutedForeground: "#656d76",
        sidebarControlSurface: "#eaeef2",
        sidebarRowHover: "#eef1f4",
        sidebarRowActive: "#e6f4ea",
        sidebarRowSelected: "#e8f3ec",
        sidebarBorder: "#e5e7eb",
        terminalBackground: "#f6f8fa",
        terminalForeground: "#1f2328"
      }
    },
    css: [
      "/* T3-Infobar Theme & Embedded Bottom Bar Skin for T3 Code */",
      "[data-chat-composer-form] {",
      "  display: flex !important;",
      "  flex-direction: column !important;",
      "  border-radius: 20px !important;",
      "}",
      "[data-chat-composer-form]:not(:has(#t3-metrics-hud)):not(:has(#codex-metrics-hud))::after {",
      "  content: \"\" !important;",
      "  position: relative !important;",
      "  inset: auto !important;",
      "  top: auto !important;",
      "  right: auto !important;",
      "  bottom: auto !important;",
      "  left: auto !important;",
      "  order: 999 !important;",
      "  display: block !important;",
      "  width: calc(100% - 24px) !important;",
      "  height: 36px !important;",
      "  flex: 0 0 36px !important;",
      "  margin: 4px 12px 10px 12px !important;",
      "  border-radius: 9px !important;",
      "  border: 1px solid color-mix(in srgb, currentColor 15%, transparent) !important;",
      "  background-color: color-mix(in srgb, currentColor 3%, transparent) !important;",
      "  background-repeat: no-repeat !important;",
      "  background-position: 10px center !important;",
      "  background-size: auto 26px !important;",
      "  box-sizing: border-box !important;",
      "  pointer-events: none;",
      "}",
      `.dark [data-chat-composer-form]:not(:has(#t3-metrics-hud)):not(:has(#codex-metrics-hud))::after {`,
      `  background-image: url("${darkUri}");`,
      `}`,
      `:root:not(.dark) [data-chat-composer-form]:not(:has(#t3-metrics-hud)):not(:has(#codex-metrics-hud))::after {`,
      `  background-image: url("${lightUri}");`,
      `}`,
      "[data-thread-details-card] {",
      "  border-radius: 12px !important;",
      "  border: 1px solid color-mix(in srgb, currentColor 14%, transparent) !important;",
      "  background: color-mix(in srgb, currentColor 3%, transparent) !important;",
      "  font-variant-numeric: tabular-nums;",
      "}",
      "[data-user-message-bubble] {",
      "  border-radius: 16px !important;",
      "  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);",
      "}",
      ".chat-markdown-codeblock {",
      "  border-radius: 12px !important;",
      "  border: 1px solid color-mix(in srgb, currentColor 12%, transparent) !important;",
      "}",
      "[data-thread-item] {",
      "  border-radius: 8px !important;",
      "}"
    ].join("\n")
  };
}
