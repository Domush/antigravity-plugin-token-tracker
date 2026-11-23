/**
 * Telemetry Server.
 * Loopback HTTP server (127.0.0.1) providing real-time telemetry JSON to:
 * 1) In-app status-bar widget injected into #antigravity.agentSidePanelInputBox
 * 2) Native Aux Pane Sidecar Web UI
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ConversationTracker } from "./conversation-tracker.js";
import { QuotaService } from "./quota-service.js";

export const DEFAULT_TELEMETRY_PORT = 8976;

export class TelemetryServer {
  constructor({
    port = DEFAULT_TELEMETRY_PORT,
    tracker = null,
    quotaService = null,
    pluginDataDir = null
  } = {}) {
    this.requestedPort = port;
    this.port = port;
    this.tracker = tracker || new ConversationTracker();
    this.quotaService = quotaService || new QuotaService();
    const home = os.homedir();
    this.pluginDataDir = pluginDataDir || path.join(home, ".gemini", "antigravity", "plugin_data", "token-tracker");
    this.server = null;
    this.registryPath = path.join(this.pluginDataDir, "telemetry-server.json");
    this.activeConversationId = null;
  }

  /**
   * Ensures the plugin data directory exists.
   */
  ensureDataDir() {
    if (!fs.existsSync(this.pluginDataDir)) {
      fs.mkdirSync(this.pluginDataDir, { recursive: true });
    }
  }

  /**
   * Writes the live server registry file for client discovery.
   */
  writeRegistry() {
    try {
      this.ensureDataDir();
      const payload = {
        port: this.port,
        pid: process.pid,
        url: `http://127.0.0.1:${this.port}`,
        activeConversationId: this.activeConversationId,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.registryPath, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      console.error(`[TokenTracker Server] Failed to write registry: ${err.message}`);
    }
  }

  /**
   * Cleans up the registry file on server shutdown.
   */
  removeRegistry() {
    try {
      if (fs.existsSync(this.registryPath)) {
        fs.unlinkSync(this.registryPath);
      }
    } catch {
      // Ignore cleanup error
    }
  }

  /**
   * Aggregates telemetry data into a consolidated response.
   * @param {string|null} preferredConversationId
   * @param {boolean} forceQuotaRefresh
   * @returns {Promise<Object>}
   */
  async getTelemetryPayload(preferredConversationId = null, forceQuotaRefresh = false) {
    const convId = preferredConversationId || this.activeConversationId;
    let metrics = null;
    let quota = null;
    let trackerError = null;
    let quotaError = null;

    try {
      metrics = this.tracker.getConversationMetrics(convId);
      if (metrics && metrics.conversationId) {
        this.activeConversationId = metrics.conversationId;
      }
    } catch (err) {
      trackerError = err.message;
    }

    try {
      quota = await this.quotaService.getQuotaSummary(forceQuotaRefresh);
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

  /**
   * Starts the HTTP server on loopback interface (127.0.0.1).
   * @returns {Promise<number>}
   */
  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // Enforce CORS for in-app webview / browser fetch
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-requested-with");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

        if (req.method === "GET" && url.pathname === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), pid: process.pid, port: this.port }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/telemetry") {
          const convId = url.searchParams.get("conversationId") || null;
          const payload = await this.getTelemetryPayload(convId, false);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/refresh") {
          const convId = url.searchParams.get("conversationId") || null;
          const payload = await this.getTelemetryPayload(convId, true);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/set-conversation") {
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            try {
              const data = JSON.parse(body || "{}");
              if (data.conversationId) {
                this.activeConversationId = data.conversationId;
                this.writeRegistry();
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, activeConversationId: this.activeConversationId }));
            } catch (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Endpoint not found" }));
      });

      server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && this.port === this.requestedPort) {
          // If default port is taken, listen on dynamic available port
          this.port = 0;
          server.listen(0, "127.0.0.1");
        } else {
          reject(err);
        }
      });

      server.listen(this.port, "127.0.0.1", () => {
        this.port = server.address().port;
        this.server = server;
        this.writeRegistry();
        console.log(`[TokenTracker Server] Listening at http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /**
   * Shuts down the HTTP server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      this.removeRegistry();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// Standalone execution entrypoint
const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  const srv = new TelemetryServer();
  srv.start().then((port) => {
    console.log(`Telemetry server active on loopback port ${port}. Press Ctrl+C to terminate.`);
    const shutdown = () => {
      srv.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((err) => {
    console.error(`Failed to start telemetry server: ${err.message}`);
    process.exit(1);
  });
}
