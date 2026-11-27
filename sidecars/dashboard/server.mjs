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
import { ConversationTracker } from "../../lib/conversation-tracker.js";
import { QuotaService } from "../../lib/quota-service.js";
import {
  normalizeConversationId,
  parseIncludeAgentsFlag,
  buildTelemetryPayload
} from "./telemetry-payload.mjs";

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
      if (typeof pkg?.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    }
  } catch (err) {
    console.debug("[TokenTracker Sidecar] Unable to read package.json version:", err?.message || String(err));
  }
  return "1.1.1";
}

function getRenderedHtml() {
  const raw = fs.readFileSync(HTML_FILE, "utf8");
  const version = getPackageVersion();
  return raw.replace(/id="tt-dash-version">--<\/span>/g, `id="tt-dash-version">v${version}</span>`);
}

const getRenderedCss = () => fs.readFileSync(CSS_FILE, "utf8");
const getRenderedCardsJs = () => fs.readFileSync(CARDS_JS_FILE, "utf8");
const getRenderedAppJs = () => fs.readFileSync(APP_JS_FILE, "utf8");

function getTelemetryPayload(preferredConvId = null, forceRefresh = false, { includeAgents = true } = {}) {
  return buildTelemetryPayload({
    tracker,
    quotaService,
    preferredConvId,
    forceRefresh,
    includeAgents
  });
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
  } catch (err) {
    console.debug("[TokenTracker Sidecar] sidecar_sdk unavailable, using standalone mode:", err?.message || String(err));
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
