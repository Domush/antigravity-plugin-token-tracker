/**
 * Antigravity Token Tracker — In-Input-Box Status Bar Widget.
 * Self-contained vanilla JS injected into Antigravity Electron renderer.
 * Attaches to #antigravity.agentSidePanelInputBox to the left of the Local Permissions
 * selector ('Turbo ∨') and presents an interactive hover/click telemetry popover card.
 */

(function initTokenTracker() {
  if (window.__antigravity_token_tracker_installed) {
    return;
  }
  window.__antigravity_token_tracker_installed = true;

  const DEFAULT_PORTS = [8976, 8977, 8978];
  let activeTelemetryPort = 8976;
  let telemetryData = null;
  let isPinned = false;
  let hideTimeout = null;

  // 1. Inject Styles
  function injectStyles() {
    if (document.getElementById("token-tracker-injected-styles")) return;
    const style = document.createElement("style");
    style.id = "token-tracker-injected-styles";
    style.textContent = `
      #token-tracker-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        margin-right: 6px;
        border-radius: 12px;
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
        font-size: 11px;
        font-weight: 500;
        background: var(--vscode-badge-background, rgba(59, 130, 246, 0.15));
        color: var(--vscode-badge-foreground, #60a5fa);
        border: 1px solid rgba(255, 255, 255, 0.1);
        cursor: pointer;
        user-select: none;
        transition: all 0.15s ease-in-out;
        z-index: 99;
      }
      #token-tracker-pill:hover, #token-tracker-pill.pinned {
        background: rgba(59, 130, 246, 0.25);
        border-color: rgba(96, 165, 250, 0.4);
      }
      .tt-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #22c55e;
        display: inline-block;
      }
      .tt-dot.warn { background-color: #f59e0b; }
      .tt-dot.alert { background-color: #ef4444; }
      
      #token-tracker-popover {
        position: fixed;
        width: 320px;
        background: var(--vscode-editor-background, #18181b);
        color: var(--vscode-editor-foreground, #e4e4e7);
        border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
        padding: 12px;
        font-family: var(--vscode-font-family, sans-serif);
        font-size: 12px;
        z-index: 10000;
        display: none;
        pointer-events: auto;
      }
      #token-tracker-popover.visible { display: block; }
      .tt-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 8px;
        margin-bottom: 10px;
      }
      .tt-title { font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 6px; }
      .tt-model-tag {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: #93c5fd;
      }
      .tt-section { margin-bottom: 10px; }
      .tt-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 11px; }
      .tt-label { color: #a1a1aa; }
      .tt-val { font-weight: 500; }
      .tt-bar-bg {
        width: 100%;
        height: 6px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 3px;
        overflow: hidden;
      }
      .tt-bar-fill {
        height: 100%;
        background: #3b82f6;
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      .tt-bar-fill.warn { background: #f59e0b; }
      .tt-bar-fill.alert { background: #ef4444; }
      .tt-bar-fill.cache { background: #10b981; }
      .tt-footer {
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        padding-top: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 10px;
        color: #71717a;
      }
      .tt-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: inherit;
        border-radius: 4px;
        padding: 3px 8px;
        cursor: pointer;
        font-size: 10px;
      }
      .tt-btn:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }
    `;
    document.head.appendChild(style);
  }

  // 2. Create or Retrieve DOM Elements
  function getOrCreatePill() {
    let pill = document.getElementById("token-tracker-pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "token-tracker-pill";
      pill.innerHTML = `
        <span class="tt-dot" id="tt-status-dot"></span>
        <span id="tt-pill-label">⚡ Tokens: --</span>
      `;
      pill.addEventListener("mouseenter", showPopover);
      pill.addEventListener("mouseleave", scheduleHidePopover);
      pill.addEventListener("click", togglePinPopover);
    }
    return pill;
  }

  function getOrCreatePopover() {
    let popover = document.getElementById("token-tracker-popover");
    if (!popover) {
      popover = document.createElement("div");
      popover.id = "token-tracker-popover";
      popover.addEventListener("mouseenter", () => {
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      popover.addEventListener("mouseleave", scheduleHidePopover);
      document.body.appendChild(popover);
    }
    return popover;
  }

  function showPopover() {
    if (hideTimeout) clearTimeout(hideTimeout);
    const popover = getOrCreatePopover();
    const pill = getOrCreatePill();
    updatePopoverContent(popover);

    const rect = pill.getBoundingClientRect();
    const popoverHeight = 310;
    const topPos = rect.top - popoverHeight - 8 > 10 ? rect.top - popoverHeight - 8 : rect.bottom + 8;
    const leftPos = Math.max(10, Math.min(window.innerWidth - 330, rect.left));

    popover.style.top = `${topPos}px`;
    popover.style.left = `${leftPos}px`;
    popover.classList.add("visible");
  }

  function scheduleHidePopover() {
    if (isPinned) return;
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      const popover = document.getElementById("token-tracker-popover");
      if (popover && !isPinned) {
        popover.classList.remove("visible");
      }
    }, 250);
  }

  function togglePinPopover(e) {
    e.stopPropagation();
    isPinned = !isPinned;
    const pill = getOrCreatePill();
    pill.classList.toggle("pinned", isPinned);
    if (isPinned) {
      showPopover();
    } else {
      scheduleHidePopover();
    }
  }

  document.addEventListener("click", (e) => {
    if (!isPinned) return;
    const popover = document.getElementById("token-tracker-popover");
    const pill = document.getElementById("token-tracker-pill");
    if (popover && !popover.contains(e.target) && pill && !pill.contains(e.target)) {
      isPinned = false;
      pill.classList.remove("pinned");
      popover.classList.remove("visible");
    }
  });

  // 3. Render Popover Content
  function updatePopoverContent(popover) {
    if (!telemetryData) {
      popover.innerHTML = `
        <div class="tt-header">
          <span class="tt-title">⚡ Token Tracker Telemetry</span>
          <span class="tt-model-tag">Connecting...</span>
        </div>
        <div style="padding: 12px 0; text-align: center; color: #a1a1aa;">Fetching active metrics...</div>
      `;
      return;
    }

    const { model, contextWindow, cache, compaction, quota, stepCount } = telemetryData;
    const g5h = quota?.gemini?.fiveHour || { remainingPercent: 100, countdown: "Ready" };
    const gWk = quota?.gemini?.weekly || { remainingPercent: 100, countdown: "Ready" };

    const ctxFillClass = contextWindow.percentUsed > 85 ? "alert" : contextWindow.percentUsed > 60 ? "warn" : "";
    const compFillClass = compaction.isNearCompaction ? "alert" : compaction.percentCompacted > 60 ? "warn" : "";

    const hasTokenHeadroom = Boolean(compaction.tokensRemainingFormatted && compaction.thresholdTokensFormatted);
    const compactionHeadroomText = hasTokenHeadroom
      ? `${compaction.tokensRemainingFormatted} tokens left`
      : `${compaction.kbRemaining} KB left`;
    const compactionSubText = hasTokenHeadroom
      ? `Active: ${compaction.activeTokensFormatted || "0"} / Trigger: ${compaction.thresholdTokensFormatted} (~${compaction.trajectoryKb} / ${compaction.thresholdKb} KB)`
      : `Active: ${compaction.trajectoryKb} KB / Trigger: ${compaction.thresholdKb} KB`;

    popover.innerHTML = `
      <div class="tt-header">
        <span class="tt-title">⚡ Token Tracker Telemetry</span>
        <span class="tt-model-tag">${model.displayName}</span>
      </div>
      
      <!-- Context Window -->
      <div class="tt-section">
        <div class="tt-row">
          <span class="tt-label">Context Window</span>
          <span class="tt-val">${contextWindow.currentTokensFormatted} / ${contextWindow.maxTokensFormatted} (${contextWindow.percentUsed}%)</span>
        </div>
        <div class="tt-bar-bg"><div class="tt-bar-fill ${ctxFillClass}" style="width: ${Math.min(100, contextWindow.percentUsed)}%;"></div></div>
      </div>

      <!-- Prompt Cache -->
      <div class="tt-section">
        <div class="tt-row">
          <span class="tt-label">Prompt Cache Hit Ratio</span>
          <span class="tt-val" style="color: #34d399;">${cache.hitRatioPercent}%</span>
        </div>
        <div class="tt-bar-bg"><div class="tt-bar-fill cache" style="width: ${Math.min(100, cache.hitRatioPercent)}%;"></div></div>
        <div class="tt-row" style="margin-top: 3px; font-size: 10px; color: #a1a1aa;">
          <span>Cached: ${cache.cachedTokensFormatted}</span>
          <span>Uncached: ${cache.uncachedTokensFormatted}</span>
        </div>
      </div>

      <!-- Compaction Countdown -->
      <div class="tt-section">
        <div class="tt-row">
          <span class="tt-label">Auto-Compaction Headroom</span>
          <span class="tt-val" style="color: ${compaction.isNearCompaction ? '#f87171' : '#e4e4e7'};">
            ${compactionHeadroomText}
          </span>
        </div>
        <div class="tt-bar-bg"><div class="tt-bar-fill ${compFillClass}" style="width: ${Math.min(100, compaction.percentCompacted)}%;"></div></div>
        <div class="tt-row" style="margin-top: 3px; font-size: 10px; color: #a1a1aa;">
          <span>${compactionSubText}</span>
        </div>
      </div>

      <!-- Quota Rings -->
      <div class="tt-section">
        <div class="tt-row">
          <span class="tt-label">Gemini 5-Hour Limit</span>
          <span class="tt-val">${g5h.remainingPercent}% (${g5h.countdown})</span>
        </div>
        <div class="tt-bar-bg"><div class="tt-bar-fill" style="width: ${Math.min(100, g5h.remainingPercent)}%;"></div></div>
        
        <div class="tt-row" style="margin-top: 6px;">
          <span class="tt-label">Gemini Weekly Limit</span>
          <span class="tt-val">${gWk.remainingPercent}% (${gWk.countdown})</span>
        </div>
        <div class="tt-bar-bg"><div class="tt-bar-fill" style="width: ${Math.min(100, gWk.remainingPercent)}%;"></div></div>
      </div>

      <!-- Footer -->
      <div class="tt-footer">
        <span>Step ${stepCount}</span>
        <button class="tt-btn" id="tt-btn-refresh">Refresh</button>
      </div>
    `;

    const btnRefresh = popover.querySelector("#tt-btn-refresh");
    if (btnRefresh) {
      btnRefresh.addEventListener("click", (e) => {
        e.stopPropagation();
        fetchTelemetry(true);
      });
    }
  }

  // 4. Update Pill Text and Color
  function updatePillView() {
    const pill = getOrCreatePill();
    const dot = pill.querySelector("#tt-status-dot");
    const label = pill.querySelector("#tt-pill-label");
    if (!dot || !label) return;

    if (!telemetryData) {
      label.textContent = "⚡ Tokens: --";
      dot.className = "tt-dot";
      return;
    }

    const { contextWindow, cache, compaction, quota } = telemetryData;
    const g5h = quota?.gemini?.fiveHour;
    const qPct = g5h ? `${Math.round(g5h.remainingPercent)}%` : "--";

    label.textContent = `⚡ 5h: ${qPct} | ${contextWindow.currentTokensFormatted} ctx | ${cache.hitRatioPercent}% cache`;

    if (compaction.isNearCompaction || (g5h && g5h.remainingPercent < 15)) {
      dot.className = "tt-dot alert";
    } else if (compaction.percentCompacted > 65 || (g5h && g5h.remainingPercent < 35)) {
      dot.className = "tt-dot warn";
    } else {
      dot.className = "tt-dot";
    }
  }

  // 5. Mount Pill next to Turbo selector inside #antigravity.agentSidePanelInputBox
  function mountPill() {
    const inputBox =
      document.getElementById("antigravity.agentSidePanelInputBox") ||
      document.querySelector('[id="antigravity.agentSidePanelInputBox"]') ||
      document.querySelector(".agent-side-panel-input-box");

    if (!inputBox) return;

    const pill = getOrCreatePill();
    if (pill.isConnected && inputBox.contains(pill)) {
      return; // Already attached
    }

    // Search for Turbo selector or action toolbar
    let target = null;
    const allEls = inputBox.querySelectorAll("*");
    for (const el of allEls) {
      if (el.children.length === 0 && el.textContent && el.textContent.includes("Turbo")) {
        target = el.closest("button") || el.parentElement;
        break;
      }
    }

    if (target && target.parentElement) {
      target.parentElement.insertBefore(pill, target);
    } else {
      // Dock at bottom or toolbar inside input box
      const toolbar = inputBox.querySelector(".actions-container, .toolbar, .footer") || inputBox;
      toolbar.appendChild(pill);
    }
  }

  // 6. Telemetry Polling Loop
  async function fetchTelemetry(isManual = false) {
    const portsToTry = [activeTelemetryPort, ...DEFAULT_PORTS.filter((p) => p !== activeTelemetryPort)];
    for (const p of portsToTry) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/${isManual ? "refresh" : "telemetry"}`, {
          cache: "no-store"
        });
        if (res.ok) {
          activeTelemetryPort = p;
          telemetryData = await res.json();
          updatePillView();
          const popover = document.getElementById("token-tracker-popover");
          if (popover && popover.classList.contains("visible")) {
            updatePopoverContent(popover);
          }
          return;
        }
      } catch {
        // Try next port
      }
    }
  }

  // 7. Initialize MutationObserver
  injectStyles();
  mountPill();
  fetchTelemetry();
  setInterval(() => fetchTelemetry(false), 4000);

  const observer = new MutationObserver(() => {
    mountPill();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
