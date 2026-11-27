const SUBAGENT_MODE_STORAGE_KEY = "tt-subagent-display-mode";
const POLL_INTERVAL_MS = 3000;

const {
  clampPercent,
  formatPercent,
  buildMainCard,
  buildSubagentCard
} = window.TokenTrackerCards;

let subagentDisplayMode = readSubagentDisplayMode();
let lastAgentTree = null;
let latestRequestId = 0;
let isPollInFlight = false;
let pollTimerId = null;

function readSubagentDisplayMode() {
  try {
    return window.localStorage.getItem(SUBAGENT_MODE_STORAGE_KEY) === "text" ? "text" : "graphic";
  } catch {
    return "graphic";
  }
}

function writeSubagentDisplayMode(mode) {
  try {
    window.localStorage.setItem(SUBAGENT_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage restrictions in sandboxed environments
  }
}

function syncSubagentModeButton() {
  const btn = document.getElementById("tt-sub-mode-btn");
  if (!btn) return;
  const isGraphic = subagentDisplayMode === "graphic";
  btn.textContent = isGraphic ? "Subagents: Rings" : "Subagents: Text";
  btn.classList.toggle("active", isGraphic);
  btn.setAttribute("aria-pressed", String(isGraphic));
}

function renderAgentTree(agentTree) {
  syncSubagentModeButton();
  const container = document.getElementById("tt-tree-root");
  const countsEl = document.getElementById("tt-agents-counts");
  if (!container || !countsEl) return;

  const roots = Array.isArray(agentTree?.roots) ? agentTree.roots : [];
  const mainCount = typeof agentTree?.mainCount === "number" ? agentTree.mainCount : roots.length;
  const subCount = typeof agentTree?.subagentCount === "number"
    ? agentTree.subagentCount
    : roots.reduce((sum, root) => {
        const visibleKids = Array.isArray(root.children)
          ? root.children.filter(Boolean)
          : [];
        return sum + visibleKids.length;
      }, 0);

  countsEl.textContent = `${mainCount} Main · ${subCount} Subagents`;
  container.replaceChildren();

  if (roots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No active agents detected.";
    container.appendChild(empty);
    return;
  }

  for (const root of roots) {
    const group = document.createElement("div");
    group.className = "tree-group";
    group.appendChild(buildMainCard(root));

    const visibleChildren = Array.isArray(root.children)
      ? root.children.filter(Boolean)
      : [];

    if (visibleChildren.length > 0) {
      const branch = document.createElement("div");
      branch.className = "sub-branch";
      for (const sub of visibleChildren) {
        branch.appendChild(buildSubagentCard(sub, subagentDisplayMode));
      }
      group.appendChild(branch);
    }

    container.appendChild(group);
  }
}

function renderQuotaCard(prefix, bucket) {
  const pctEl = document.getElementById(`${prefix}-pct`);
  const resetEl = document.getElementById(`${prefix}-reset`);
  const barEl = document.getElementById(`${prefix}-bar`);
  if (!pctEl || !resetEl || !barEl) return;

  const pct = clampPercent(bucket?.remainingPercent ?? 100);
  pctEl.textContent = formatPercent(pct);
  resetEl.textContent = bucket?.countdown || "--";
  barEl.style.width = `${pct}%`;

  if (pct < 20) {
    barEl.style.background = "var(--tt-danger)";
  } else if (pct < 50) {
    barEl.style.background = "var(--tt-warning)";
  } else {
    barEl.style.background = "var(--tt-success)";
  }
}

function renderQuotas(quota) {
  renderQuotaCard("tt-g5h", quota?.gemini?.fiveHour);
  renderQuotaCard("tt-gwk", quota?.gemini?.weekly);
  renderQuotaCard("tt-3p5h", quota?.thirdParty?.fiveHour);
  renderQuotaCard("tt-3pwk", quota?.thirdParty?.weekly);
}

function buildFallbackTreeFromTelemetry(data) {
  if (!data || !data.conversationId || data.conversationId === "unknown") {
    return { roots: [], mainCount: 0, subagentCount: 0, totalActiveCount: 0 };
  }
  const convId = String(data.conversationId);
  const convName = typeof data.conversationName === "string" && data.conversationName.trim()
    ? data.conversationName.trim()
    : null;
  const subagentType = typeof data.subagentType === "string" && data.subagentType.trim()
    ? data.subagentType.trim()
    : null;
  const runState = data.runState || "idle";
  return {
    roots: [
      {
        conversationId: convId,
        shortId: convId.length > 8 ? convId.slice(0, 8) : convId,
        conversationName: convName,
        subagentType,
        isCurrent: true,
        isActive: runState === "running" || runState === "waiting",
        runState,
        lastActivityAt: data.lastActivityAt || null,
        modelName: data.model?.displayName || "Unknown",
        currentTokensFormatted: data.contextWindow?.currentTokensFormatted || "0",
        maxTokensFormatted: data.contextWindow?.maxTokensFormatted || "1.05M",
        percentUsed: data.contextWindow?.percentUsed ?? 0,
        cachedTokensFormatted: data.cache?.cachedTokensFormatted || "0",
        totalCacheTokensFormatted: data.cache?.totalTokensFormatted || data.contextWindow?.currentTokensFormatted || "0",
        hitRatioPercent: data.cache?.hitRatioPercent ?? 0,
        activeTokensFormatted: data.compaction?.activeTokensFormatted || null,
        thresholdTokensFormatted: data.compaction?.thresholdTokensFormatted || null,
        trajectoryKb: data.compaction?.trajectoryKb ?? 0,
        thresholdKb: data.compaction?.thresholdKb ?? 0,
        tokensRemainingFormatted: data.compaction?.tokensRemainingFormatted || null,
        kbRemaining: data.compaction?.kbRemaining ?? 0,
        percentCompacted: data.compaction?.percentCompacted ?? 0,
        isNearCompaction: Boolean(data.compaction?.isNearCompaction),
        children: []
      }
    ],
    mainCount: 1,
    subagentCount: 0,
    totalActiveCount: 1
  };
}

function getPinnedConversationId() {
  const fromSidecar = typeof window.sidecar?.conversationId === "string"
    ? window.sidecar.conversationId.trim()
    : "";
  if (fromSidecar) return fromSidecar;
  const fromQuery = new URLSearchParams(window.location.search).get("conversationId");
  const trimmedQuery = typeof fromQuery === "string" ? fromQuery.trim() : "";
  return trimmedQuery || null;
}

async function updateDashboard(forceRefresh = false) {
  if (!forceRefresh && isPollInFlight) {
    return;
  }
  const requestId = ++latestRequestId;
  if (!forceRefresh) {
    isPollInFlight = true;
  }
  const liveDot = document.getElementById("tt-live-dot");
  try {
    const endpoint = forceRefresh ? "/api/refresh" : "/api/telemetry";
    const pinnedConvId = getPinnedConversationId();
    const params = new URLSearchParams();
    if (pinnedConvId) params.set("conversationId", pinnedConvId);
    const query = params.toString();
    const url = query ? `${endpoint}?${query}` : endpoint;

    const res = await (window.sidecar?.fetch
      ? window.sidecar.fetch(url, { cache: "no-store" })
      : fetch(url, { cache: "no-store" }));
    if (requestId !== latestRequestId) return;
    if (!res.ok) {
      if (liveDot) liveDot.classList.add("offline");
      return;
    }

    const data = await res.json();
    if (requestId !== latestRequestId) return;
    if (liveDot) liveDot.classList.toggle("offline", !data?.ok);

    renderQuotas(data?.quota);
    lastAgentTree = data?.agentTree || buildFallbackTreeFromTelemetry(data);
    renderAgentTree(lastAgentTree);
  } catch (err) {
    if (requestId !== latestRequestId) return;
    if (liveDot) liveDot.classList.add("offline");
    console.error("Dashboard update failed:", err);
  } finally {
    if (!forceRefresh) {
      isPollInFlight = false;
    }
  }
}

function scheduleNextPoll() {
  if (pollTimerId !== null) {
    clearTimeout(pollTimerId);
  }
  pollTimerId = setTimeout(async () => {
    pollTimerId = null;
    await updateDashboard(false);
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

document.getElementById("tt-sub-mode-btn")?.addEventListener("click", () => {
  subagentDisplayMode = subagentDisplayMode === "text" ? "graphic" : "text";
  writeSubagentDisplayMode(subagentDisplayMode);
  syncSubagentModeButton();
  if (lastAgentTree) {
    renderAgentTree(lastAgentTree);
  }
});

document.getElementById("tt-refresh-btn")?.addEventListener("click", () => {
  if (pollTimerId !== null) {
    clearTimeout(pollTimerId);
    pollTimerId = null;
  }
  updateDashboard(true).finally(scheduleNextPoll);
});

syncSubagentModeButton();
updateDashboard(false).finally(scheduleNextPoll);
