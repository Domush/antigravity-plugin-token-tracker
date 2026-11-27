(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MINI_RING_RADIUS = 16;
  const MINI_RING_CIRCUMFERENCE = 2 * Math.PI * MINI_RING_RADIUS;

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, num));
  }

  function formatPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0%";
    const rounded = Math.round(num * 10) / 10;
    return `${rounded}%`;
  }

  function healthClassUsage(pct) {
    const value = clampPercent(pct);
    if (value >= 85) return "danger";
    if (value >= 60) return "warn";
    return "ok";
  }

  function healthClassCache(pct) {
    const value = clampPercent(pct);
    if (value >= 50) return "ok";
    if (value >= 20) return "warn";
    return "danger";
  }

  function formatIdleElapsed(timestampValue) {
    if (!timestampValue) return "";
    const ms = new Date(timestampValue).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return "<1m";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d`;
  }

  function createSvgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, String(value));
    }
    return el;
  }

  function buildStatusIndicator(node) {
    const state = node?.runState || (node?.isActive ? "running" : "idle");
    const wrap = document.createElement("span");

    if (state === "running") {
      wrap.className = "status-ind status-running";
      wrap.title = "Processing";
      const svg = createSvgEl("svg", { viewBox: "0 0 16 16", class: "status-svg status-spin", "aria-hidden": "true" });
      svg.append(
        createSvgEl("circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-opacity": "0.24", "stroke-width": 2 }),
        createSvgEl("path", { d: "M 8 2.5 A 5.5 5.5 0 0 1 13.5 8", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" })
      );
      wrap.appendChild(svg);
      return wrap;
    }

    if (state === "waiting") {
      wrap.className = "status-ind status-waiting";
      wrap.title = "Waiting for response";
      const svg = createSvgEl("svg", { viewBox: "0 0 16 16", class: "status-svg", "aria-hidden": "true" });
      svg.append(
        createSvgEl("circle", { cx: 8, cy: 8, r: 6, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }),
        createSvgEl("path", { d: "M6.2 6.2a1.8 1.8 0 0 1 3.5.6c0 1.1-1.7 1.4-1.7 2.4", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" }),
        createSvgEl("circle", { cx: 8, cy: 11.5, r: 0.85, fill: "currentColor" })
      );
      wrap.appendChild(svg);
      return wrap;
    }

    if (state === "error") {
      wrap.className = "status-ind status-error";
      wrap.title = "Ended with error";
      const svg = createSvgEl("svg", { viewBox: "0 0 16 16", class: "status-svg", "aria-hidden": "true" });
      svg.append(
        createSvgEl("circle", { cx: 8, cy: 8, r: 6, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }),
        createSvgEl("path", { d: "M8 4.6v4.1", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" }),
        createSvgEl("circle", { cx: 8, cy: 11.3, r: 0.85, fill: "currentColor" })
      );
      wrap.appendChild(svg);
      return wrap;
    }

    const elapsed = formatIdleElapsed(node?.lastActivityAt || node?.lastUpdatedAt);
    wrap.className = "status-ind status-idle";
    wrap.title = elapsed ? `Idle (${elapsed})` : "Idle";
    const svg = createSvgEl("svg", { viewBox: "0 0 16 16", class: "status-svg", "aria-hidden": "true" });
    svg.append(
      createSvgEl("circle", { cx: 8, cy: 8, r: 5.8, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }),
      createSvgEl("path", { d: "M8 4.8v3.4l2.2 1.3", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" })
    );
    wrap.appendChild(svg);
    if (elapsed) {
      const timeEl = document.createElement("span");
      timeEl.className = "status-idle-time";
      timeEl.textContent = elapsed;
      wrap.appendChild(timeEl);
    }
    return wrap;
  }

  function onSelectConversation(conversationId) {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!id || id === "--") return;
    if (typeof window.sidecar?.ui?.toggleConversation === "function") {
      window.sidecar.ui.toggleConversation(id);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("conversationId", id);
    window.location.href = url.toString();
  }

  const HEALTH_COLOR_VARS = {
    ok: "--tt-success",
    warn: "--tt-warning",
    danger: "--tt-danger"
  };

  function resolveRingColorVar(metricKind, pct) {
    const healthClass = metricKind === "cache"
      ? healthClassCache(pct)
      : healthClassUsage(pct);
    return HEALTH_COLOR_VARS[healthClass];
  }

  function makeMiniRing(pct, colorVar, label) {
    const clamped = clampPercent(pct);
    const offset = MINI_RING_CIRCUMFERENCE - (clamped / 100) * MINI_RING_CIRCUMFERENCE;

    const wrap = document.createElement("div");
    wrap.className = "mini-ring-wrap";

    const ringBox = document.createElement("div");
    ringBox.className = "mini-ring";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 42 42");
    svg.setAttribute("aria-hidden", "true");

    const bgCircle = document.createElementNS(SVG_NS, "circle");
    bgCircle.setAttribute("class", "bg");
    bgCircle.setAttribute("cx", "21");
    bgCircle.setAttribute("cy", "21");
    bgCircle.setAttribute("r", String(MINI_RING_RADIUS));

    const fgCircle = document.createElementNS(SVG_NS, "circle");
    fgCircle.setAttribute("class", "fg");
    fgCircle.setAttribute("cx", "21");
    fgCircle.setAttribute("cy", "21");
    fgCircle.setAttribute("r", String(MINI_RING_RADIUS));
    fgCircle.style.stroke = `var(${colorVar})`;
    fgCircle.style.strokeDasharray = MINI_RING_CIRCUMFERENCE.toFixed(1);
    fgCircle.style.strokeDashoffset = offset.toFixed(1);

    svg.append(bgCircle, fgCircle);

    const numEl = document.createElement("span");
    numEl.className = "mini-ring-num";
    numEl.textContent = `${Math.round(clamped)}%`;

    ringBox.append(svg, numEl);

    const lblEl = document.createElement("span");
    lblEl.className = "mini-ring-lbl";
    lblEl.textContent = label;

    wrap.append(ringBox, lblEl);
    return wrap;
  }

  function makeMetricLine(label, valueText, pctText, healthClass) {
    const row = document.createElement("div");
    row.className = "metric-line";

    const kEl = document.createElement("span");
    kEl.className = "metric-k";
    kEl.textContent = label;

    const vEl = document.createElement("span");
    vEl.className = "metric-v";
    vEl.textContent = valueText;

    const tEl = document.createElement("span");
    tEl.className = healthClass ? `metric-tag ${healthClass}` : "metric-tag";
    tEl.textContent = pctText;

    row.append(kEl, vEl, tEl);
    return row;
  }

  function makeRingsTrio(node) {
    const ctxPct = node.percentUsed ?? 0;
    const cachePct = node.hitRatioPercent ?? 0;
    const compPct = node.percentCompacted ?? 0;

    const trio = document.createElement("div");
    trio.append(
      makeMiniRing(ctxPct, resolveRingColorVar("context", ctxPct), "Context"),
      makeMiniRing(cachePct, resolveRingColorVar("cache", cachePct), "Cache"),
      makeMiniRing(compPct, resolveRingColorVar("compaction", compPct), "Compaction")
    );
    return trio;
  }

  function makeMetricsStack(node, className) {
    const ctxPct = clampPercent(node.percentUsed ?? 0);
    const cachePct = clampPercent(node.hitRatioPercent ?? 0);
    const compPct = clampPercent(node.percentCompacted ?? 0);

    const ctxText = `${node.currentTokensFormatted || "0"} / ${node.maxTokensFormatted || "1.05M"}`;
    const cacheTotal = node.totalCacheTokensFormatted || node.currentTokensFormatted || "0";
    const cacheText = `${node.cachedTokensFormatted || "0"} / ${cacheTotal}`;
    const compText = (node.activeTokensFormatted && node.thresholdTokensFormatted)
      ? `${node.activeTokensFormatted} / ${node.thresholdTokensFormatted}`
      : `${node.trajectoryKb ?? 0} / ${node.thresholdKb ?? 0} KB`;

    const stack = document.createElement("div");
    stack.className = className;
    stack.append(
      makeMetricLine("Context", ctxText, formatPercent(ctxPct), healthClassUsage(ctxPct)),
      makeMetricLine("Cache", cacheText, formatPercent(cachePct), healthClassCache(cachePct)),
      makeMetricLine("Compaction", compText, formatPercent(compPct), healthClassUsage(compPct))
    );
    return stack;
  }

  function buildConversationLinkButton(displayText, className, conversationId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `conv-link ${className}`;
    btn.textContent = displayText;
    const rawId = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!rawId || rawId === "--") {
      btn.disabled = true;
      btn.title = "No conversation available";
      btn.setAttribute("aria-label", `${displayText} (no conversation available)`);
      return btn;
    }
    const label = displayText !== rawId
      ? `Open conversation: ${displayText} (${rawId})`
      : `Open conversation: ${rawId}`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", () => onSelectConversation(rawId));
    return btn;
  }

  function buildMetaRow(node, fallbackRole, rowClass, roleClass, modelClass) {
    const row = document.createElement("div");
    row.className = rowClass;

    const roleEl = document.createElement("span");
    roleEl.className = roleClass;
    const roleText = typeof node.subagentType === "string" && node.subagentType.trim()
      ? node.subagentType.trim()
      : fallbackRole;
    roleEl.textContent = roleText;
    roleEl.title = roleText;

    const modelEl = document.createElement("span");
    modelEl.className = modelClass;
    modelEl.textContent = node.modelName || "Unknown";
    modelEl.title = node.modelName || "Unknown";

    row.append(roleEl, modelEl);
    return row;
  }

  function buildMainCard(root) {
    const card = document.createElement("article");
    card.className = root.isCurrent ? "main-card is-current" : "main-card";

    const head = document.createElement("div");
    head.className = "card-head";

    const idGroup = document.createElement("div");
    idGroup.className = "card-id-group";

    idGroup.appendChild(buildStatusIndicator(root));

    if (root.isCurrent) {
      const curBadge = document.createElement("span");
      curBadge.className = "badge";
      curBadge.textContent = "Current";
      idGroup.appendChild(curBadge);
    }

    const convName = typeof root.conversationName === "string" ? root.conversationName.trim() : "";
    const shortId = typeof root.shortId === "string" && root.shortId.trim() ? root.shortId.trim() : "--";
    const convId = typeof root.conversationId === "string" ? root.conversationId.trim() : "";

    idGroup.appendChild(
      buildConversationLinkButton(
        convName || shortId,
        convName ? "conv-name" : "short-id",
        convId
      )
    );

    head.appendChild(idGroup);

    const metaRow = buildMetaRow(root, "main", "main-meta-row", "main-role", "main-model-name");

    const body = document.createElement("div");
    body.className = "main-body";

    const trio = makeRingsTrio(root);
    trio.className = "rings-trio";

    const stack = makeMetricsStack(root, "metrics-stack");

    body.append(trio, stack);
    card.append(head, metaRow, body);
    return card;
  }

  function buildSubagentCard(sub, subagentDisplayMode) {
    const card = document.createElement("article");
    card.className = "sub-card";

    const head = document.createElement("div");
    head.className = "sub-head";

    const subName = typeof sub.subagentName === "string" ? sub.subagentName.trim() : "";
    const shortId = typeof sub.shortId === "string" && sub.shortId.trim() ? sub.shortId.trim() : "--";
    const convId = typeof sub.conversationId === "string" ? sub.conversationId.trim() : "";

    head.append(
      buildStatusIndicator(sub),
      buildConversationLinkButton(
        subName || shortId,
        subName ? "sub-name" : "short-id sub-name-fallback",
        convId
      )
    );
    card.appendChild(head);
    card.appendChild(buildMetaRow(sub, "subagent", "sub-meta-row", "sub-role", "sub-model-name"));

    if (subagentDisplayMode === "graphic") {
      const ringsRow = makeRingsTrio(sub);
      ringsRow.className = "sub-rings-row";
      card.appendChild(ringsRow);
    } else {
      card.appendChild(makeMetricsStack(sub, "sub-stack"));
    }

    return card;
  }

  window.TokenTrackerCards = {
    clampPercent,
    formatPercent,
    formatIdleElapsed,
    buildStatusIndicator,
    onSelectConversation,
    buildMainCard,
    buildSubagentCard
  };
})();
