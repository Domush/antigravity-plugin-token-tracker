/**
 * Antigravity Token Tracker — Native Aux Pane Sidecar Server.
 * Hosts the Web UI inside Antigravity's Aux Pane via sidecar_sdk,
 * with graceful standalone fallback for local testing and debugging.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ConversationTracker } from "../../lib/conversation-tracker.js";
import { QuotaService } from "../../lib/quota-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_FILE = path.join(__dirname, "index.html");

const tracker = new ConversationTracker();
const quotaService = new QuotaService();

function getPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, "../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return pkg.version || "1.0.0";
    }
  } catch {
    // Non-fatal package read
  }
  return "1.0.0";
}

function getRenderedHtml() {
  const raw = fs.readFileSync(HTML_FILE, "utf8");
  const version = getPackageVersion();
  return raw.replace(/id="tt-dash-version">--<\/span>/g, `id="tt-dash-version">v${version}</span>`);
}

async function getTelemetryPayload(preferredConvId = null, forceRefresh = false) {
  let convId = preferredConvId;
  if (!convId) {
    try {
      const activeFile = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "token-tracker", "active_conversation.json");
      if (fs.existsSync(activeFile)) {
        const parsed = JSON.parse(fs.readFileSync(activeFile, "utf8"));
        convId = parsed.conversationId || null;
      }
    } catch {
      // Non-fatal state read
    }
  }

  let metrics = null;
  let quota = null;
  let trackerError = null;
  let quotaError = null;

  try {
    metrics = tracker.getConversationMetrics(convId);
  } catch (err) {
    trackerError = err.message;
  }

  try {
    quota = await quotaService.getQuotaSummary(forceRefresh);
  } catch (err) {
    quotaError = err.message;
  }

  return {
    ok: Boolean(metrics || quota),
    timestamp: Date.now(),
    conversationId: metrics?.conversationId || convId || "unknown",
    stepCount: metrics?.stepCount || 0,
    model: metrics?.model || {
      id: "gemini-3.8-flash-high",
      displayName: "Gemini 3.8 Flash (High)",
      maxTokens: 1048576,
      group: "gemini"
    },
    contextWindow: metrics?.contextWindow || {
      currentTokens: 0,
      maxTokens: 1048576,
      percentUsed: 0,
      contextBytes: 0,
      currentTokensFormatted: "0",
      maxTokensFormatted: "1M"
    },
    cache: metrics?.cache || {
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      hitRatio: 0,
      hitRatioPercent: 0,
      cachedTokensFormatted: "0",
      uncachedTokensFormatted: "0"
    },
    compaction: metrics?.compaction || {
      trajectoryBytes: 0,
      trajectoryKb: 0,
      thresholdBytes: 184320,
      thresholdKb: 180,
      kbRemaining: 180,
      percentCompacted: 0,
      isNearCompaction: false
    },
    quota: quota || {
      gemini: {
        weekly: { remainingFraction: 1, remainingPercent: 100, usedPercent: 0, countdown: "Ready" },
        fiveHour: { remainingFraction: 1, remainingPercent: 100, usedPercent: 0, countdown: "Ready" }
      },
      thirdParty: {
        weekly: { remainingFraction: 1, remainingPercent: 100, usedPercent: 0, countdown: "Ready" },
        fiveHour: { remainingFraction: 1, remainingPercent: 100, usedPercent: 0, countdown: "Ready" }
      }
    },
    errors: {
      tracker: trackerError,
      quota: quotaError
    }
  };
}

// Sidecar SDK Dynamic Import
let SidecarApp = null;
try {
  const sdkModule = await import("file:///C:/Users/domus/.gemini/config/node_modules/sidecar_sdk/index.mjs");
  SidecarApp = sdkModule.SidecarApp;
} catch {
  try {
    const sdkModule = await import("sidecar_sdk");
    SidecarApp = sdkModule.SidecarApp;
  } catch {
    // Standalone fallback
  }
}

const isSidecarEnv = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
  SidecarApp
);

if (isSidecarEnv) {
  const app = new SidecarApp();

  app.page("/", () => {
    return getRenderedHtml();
  });

  app.api("/api/telemetry", async (data) => {
    return getTelemetryPayload(data?.conversationId || app.config?.conversationId, false);
  }, "GET");

  app.api("/api/refresh", async (data) => {
    return getTelemetryPayload(data?.conversationId || app.config?.conversationId, true);
  }, "GET");

  app.api("/api/refresh", async (data) => {
    return getTelemetryPayload(data?.conversationId || app.config?.conversationId, true);
  }, "POST");

  await app.run();
  console.log("[TokenTracker Sidecar] Native Aux Pane Web UI mounted.");
} else {
  // Standalone loopback HTTP server fallback
  const port = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
    ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10)
    : 8979;

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getRenderedHtml());
      return;
    }

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "standalone", pid: process.pid, port }));
      return;
    }

    if (url.pathname === "/api/telemetry") {
      const convId = url.searchParams.get("conversationId");
      const payload = await getTelemetryPayload(convId, false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === "/api/refresh") {
      const convId = url.searchParams.get("conversationId");
      const payload = await getTelemetryPayload(convId, true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[TokenTracker Sidecar] Standalone dashboard server listening at http://127.0.0.1:${port}`);
  });
}
