/**
 * Antigravity Token Tracker — Native Aux Pane Sidecar Server.
 * Hosts the Web UI inside Antigravity's Aux Pane via sidecar_sdk,
 * with graceful standalone fallback for local testing and debugging.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConversationTracker, buildCompactionMetrics } from "../../lib/conversation-tracker.js";
import { applyModelUsageMetrics, applyModelUsageToTreeNode } from "../../lib/compaction.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../lib/models.js";
import { QuotaService } from "../../lib/quota-service.js";
import { findActiveAgentTree } from "../../lib/agent-tree.js";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache"
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_FILE = path.join(__dirname, "index.html");
const CSS_FILE = path.join(__dirname, "styles.css");
const CARDS_JS_FILE = path.join(__dirname, "cards.js");
const APP_JS_FILE = path.join(__dirname, "app.js");

const tracker = new ConversationTracker();
const quotaService = new QuotaService();

function normalizeConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIncludeAgentsFlag(value) {
  if (value === undefined || value === null || value === "") return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "false") {
      return false;
    }
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const MAX_BODY_BYTES = 65536;
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += bufChunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        req.pause();
        const err = new Error("Request body too large.");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(bufChunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks, totalBytes).toString("utf8");
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

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

function getRenderedCss() {
  return fs.readFileSync(CSS_FILE, "utf8");
}

function getRenderedCardsJs() {
  return fs.readFileSync(CARDS_JS_FILE, "utf8");
}

function getRenderedAppJs() {
  return fs.readFileSync(APP_JS_FILE, "utf8");
}

async function getTelemetryPayload(preferredConvId = null, forceRefresh = false, { includeAgents = true } = {}) {
  const explicitConvId = normalizeConversationId(preferredConvId);
  let convId = explicitConvId;
  if (!convId) {
    try {
      const activeFile = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "token-tracker", "active_conversation.json");
      if (fs.existsSync(activeFile)) {
        const parsed = JSON.parse(fs.readFileSync(activeFile, "utf8"));
        convId = normalizeConversationId(parsed.conversationId);
      }
    } catch {
      // Non-fatal state read
    }
  }

  let metrics = null;
  let quota = null;
  let cascadeStatuses = null;
  let mainUsage = null;
  let trackerError = null;
  let quotaError = null;

  try {
    metrics = tracker.getConversationMetrics(convId, { strict: Boolean(explicitConvId) });
  } catch (err) {
    trackerError = err.message;
  }

  const quotaPromise = quotaService.getQuotaSummary(forceRefresh).catch((err) => {
    quotaError = err.message;
    return null;
  });
  const cascadePromise = includeAgents
    ? quotaService.getCascadeStatuses(forceRefresh).catch(() => null)
    : Promise.resolve(null);
  const mainUsagePromise = metrics?.conversationId
    ? quotaService.getCascadeUsage(metrics.conversationId, metrics.stepCount, forceRefresh).catch(() => null)
    : Promise.resolve(null);

  [quota, cascadeStatuses, mainUsage] = await Promise.all([quotaPromise, cascadePromise, mainUsagePromise]);

  if (metrics && mainUsage) {
    metrics = applyModelUsageMetrics(metrics, mainUsage, tracker.compactionThresholdBytes);
  }

  let agentTree = null;
  if (includeAgents) {
    try {
      const currentConvId = metrics?.conversationId || convId || null;
      agentTree = findActiveAgentTree({
        conversationsDir: tracker.conversationsDir,
        currentConversationId: currentConvId,
        tracker,
        cascadeStatuses
      });

      if (agentTree?.roots?.length > 0) {
        const treeNodes = [];
        for (const root of agentTree.roots) {
          treeNodes.push(root);
          if (Array.isArray(root.children)) {
            treeNodes.push(...root.children);
          }
        }
        await Promise.all(
          treeNodes.map(async (node) => {
            if (!node?.conversationId) return;
            const usage = node.conversationId === metrics?.conversationId && mainUsage
              ? mainUsage
              : await quotaService.getCascadeUsage(node.conversationId, node.stepCount ?? null, forceRefresh).catch(() => null);
            if (usage) {
              applyModelUsageToTreeNode(node, usage, tracker.compactionThresholdBytes);
              if (usage.isWaitingForUser) {
                node.runState = "waiting";
              }
            }
          })
        );
      }
    } catch (err) {
      console.error(`[TokenTracker Sidecar] Agent tree scan non-fatal error: ${err.message}`);
    }
  }

  const resolvedConvId = metrics?.conversationId || convId || "unknown";
  let conversationName = null;
  if (agentTree?.roots) {
    for (const root of agentTree.roots) {
      if (root.conversationId === resolvedConvId && root.conversationName) {
        conversationName = root.conversationName;
        break;
      }
    }
  }

  return {
    ok: Boolean(metrics || quota),
    timestamp: Date.now(),
    conversationId: resolvedConvId,
    ...(conversationName ? { conversationName } : {}),
    ...(mainUsage?.isWaitingForUser ? { runState: "waiting" } : {}),
    ...(metrics?.lastModified ? { lastActivityAt: metrics.lastModified } : {}),
    stepCount: metrics?.stepCount || 0,
    model: metrics?.model || {
      id: "gemini-3.8-flash-high",
      displayName: "Gemini 3.8 Flash (High)",
      maxTokens: DEFAULT_CONTEXT_WINDOW,
      group: "gemini"
    },
    contextWindow: metrics?.contextWindow || {
      currentTokens: 0,
      maxTokens: DEFAULT_CONTEXT_WINDOW,
      percentUsed: 0,
      contextBytes: 0,
      currentTokensFormatted: "0",
      maxTokensFormatted: "1.05M"
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
    compaction: metrics?.compaction || buildCompactionMetrics(0, DEFAULT_CONTEXT_WINDOW, tracker.compactionThresholdBytes, 0),
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
    },
    ...(includeAgents ? { agentTree } : {})
  };
}

// Sidecar SDK Dynamic Import
let SidecarApp = null;
let SidecarResponse = null;
try {
  const userSdkUrl = pathToFileURL(
    path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs")
  ).href;
  const sdkModule = await import(userSdkUrl);
  SidecarApp = sdkModule.SidecarApp;
  SidecarResponse = sdkModule.Response || null;
} catch {
  try {
    const sdkModule = await import("sidecar_sdk");
    SidecarApp = sdkModule.SidecarApp;
    SidecarResponse = sdkModule.Response || null;
  } catch {
    // Standalone fallback
  }
}

function createStaticPageResponse(body, contentType) {
  if (SidecarResponse) {
    return new SidecarResponse(body, { contentType });
  }
  return body;
}

function createJsonApiResponse(payload) {
  if (SidecarResponse) {
    return new SidecarResponse(JSON.stringify(payload), {
      contentType: "application/json; charset=utf-8",
      headers: NO_CACHE_HEADERS
    });
  }
  return payload;
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

  app.page("/styles.css", () => {
    return createStaticPageResponse(getRenderedCss(), "text/css; charset=utf-8");
  });

  app.page("/cards.js", () => {
    return createStaticPageResponse(getRenderedCardsJs(), "application/javascript; charset=utf-8");
  });

  app.page("/app.js", () => {
    return createStaticPageResponse(getRenderedAppJs(), "application/javascript; charset=utf-8");
  });

  app.api("/api/telemetry", async (data) => {
    const explicitConvId = normalizeConversationId(data?.conversationId) || normalizeConversationId(app.config?.conversationId);
    const includeAgents = parseIncludeAgentsFlag(data?.includeAgents);
    return createJsonApiResponse(await getTelemetryPayload(explicitConvId, false, { includeAgents }));
  }, "GET");

  app.api("/api/refresh", async (data) => {
    const explicitConvId = normalizeConversationId(data?.conversationId) || normalizeConversationId(app.config?.conversationId);
    const includeAgents = parseIncludeAgentsFlag(data?.includeAgents);
    return createJsonApiResponse(await getTelemetryPayload(explicitConvId, true, { includeAgents }));
  }, "GET");

  app.api("/api/refresh", async (data) => {
    const explicitConvId = normalizeConversationId(data?.conversationId) || normalizeConversationId(app.config?.conversationId);
    const includeAgents = parseIncludeAgentsFlag(data?.includeAgents);
    return createJsonApiResponse(await getTelemetryPayload(explicitConvId, true, { includeAgents }));
  }, "POST");

  await app.run();
  console.log("[TokenTracker Sidecar] Native Aux Pane Web UI mounted.");
} else {
  // Standalone loopback HTTP server fallback
  const rawPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  let port = 8979;
  if (rawPort !== undefined && rawPort !== "") {
    const trimmedPort = String(rawPort).trim();
    if (!/^\d+$/.test(trimmedPort)) {
      throw new RangeError(`Invalid ANTIGRAVITY_SIDECAR_WEB_PORT "${rawPort}": must be an integer between 0 and 65535.`);
    }
    const parsedPort = Number(trimmedPort);
    if (!Number.isSafeInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new RangeError(`Invalid ANTIGRAVITY_SIDECAR_WEB_PORT "${rawPort}": must be an integer between 0 and 65535.`);
    }
    port = parsedPort;
  }
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const activePort = server.address()?.port ?? boundPort;
      const url = new URL(req.url, `http://127.0.0.1:${activePort}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getRenderedHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/styles.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(getRenderedCss());
        return;
      }

      if (req.method === "GET" && url.pathname === "/cards.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(getRenderedCardsJs());
        return;
      }

      if (req.method === "GET" && url.pathname === "/app.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(getRenderedAppJs());
        return;
      }

      if (req.method === "GET" && url.pathname === "/preload.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end("// Standalone mode: sidecar preload bridge inactive.\n");
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", mode: "standalone", pid: process.pid, port: activePort }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/telemetry") {
        const convId = normalizeConversationId(url.searchParams.get("conversationId"));
        const includeAgents = parseIncludeAgentsFlag(url.searchParams.get("includeAgents"));
        const payload = await getTelemetryPayload(convId, false, { includeAgents });
        res.writeHead(200, { "Content-Type": "application/json", ...NO_CACHE_HEADERS });
        res.end(JSON.stringify(payload));
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/refresh") {
        let bodyConvId = null;
        let bodyIncludeAgents;
        if (req.method === "POST") {
          try {
            const body = await readJsonBody(req);
            bodyConvId = normalizeConversationId(body?.conversationId);
            bodyIncludeAgents = body?.includeAgents;
          } catch (err) {
            const status = err?.statusCode === 413 ? 413 : 400;
            res.writeHead(status, {
              "Content-Type": "application/json",
              ...(status === 413 ? { Connection: "close" } : {})
            });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
          }
        }
        const convId = bodyConvId || normalizeConversationId(url.searchParams.get("conversationId"));
        const rawIncludeAgents = bodyIncludeAgents !== undefined ? bodyIncludeAgents : url.searchParams.get("includeAgents");
        const includeAgents = parseIncludeAgentsFlag(rawIncludeAgents);
        const payload = await getTelemetryPayload(convId, true, { includeAgents });
        res.writeHead(200, { "Content-Type": "application/json", ...NO_CACHE_HEADERS });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (err) {
      const status = err instanceof URIError || err?.code === "ERR_INVALID_URL" ? 400 : 500;
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err?.message || "Internal Server Error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.listen(port, "127.0.0.1", () => {
    boundPort = server.address()?.port ?? port;
    console.log(`[TokenTracker Sidecar] Standalone dashboard server listening at http://127.0.0.1:${boundPort}`);
  });
}
