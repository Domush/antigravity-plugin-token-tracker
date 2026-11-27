/**
 * Quota Service Client.
 * Connect-RPC client for LanguageServerService/RetrieveUserQuotaSummary.
 * Discovers the active Language Server port and CSRF token from environment,
 * daemon registration JSON files, or server logs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeConnectRpcCall } from "./ls-rpc.js";
import { parseCascadeStatuses as parseCascadeStatusesPayload, extractLatestModelUsage } from "./ls-cascade.js";
import { formatCountdown, normalizeQuotaResponse, refreshQuotaCountdowns } from "./ls-quota-normalize.js";
import { validateSafeConversationId } from "./active-status.js";

export { formatCountdown };

const DEFAULT_CACHE_TTL_MS = 3000; // 3 seconds cache for auto-updating quotas
const DEFAULT_CASCADE_CACHE_TTL_MS = 2000; // 2 seconds cache for live cascade states
const DEFAULT_USAGE_CACHE_TTL_MS = 3000; // 3 seconds cache when stepCount is unavailable
const DEFAULT_SERVER_FORCE_REFRESH_MS = 15000; // 15 seconds backend refresh interval
const MAX_USAGE_CACHE_ENTRIES = 64;

function isValidPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

function validateCustomPort(port) {
  if (port === null || port === undefined) return null;
  if (typeof port !== "number" || Number.isNaN(port)) {
    throw new TypeError("customPort must be an integer between 1 and 65535.");
  }
  if (!isValidPort(port)) {
    throw new RangeError(`customPort must be an integer between 1 and 65535 (received ${port}).`);
  }
  return port;
}

function validateCustomCsrfToken(csrfToken) {
  if (csrfToken === null || csrfToken === undefined) return null;
  if (typeof csrfToken !== "string") {
    throw new TypeError("customCsrfToken must be a non-empty string.");
  }
  const trimmed = csrfToken.trim();
  if (!trimmed) {
    throw new RangeError("customCsrfToken must be a non-empty string.");
  }
  return trimmed;
}

export class QuotaService {
  constructor({
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cascadeCacheTtlMs = DEFAULT_CASCADE_CACHE_TTL_MS,
    customPort = null,
    customCsrfToken = null
  } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.cascadeCacheTtlMs = cascadeCacheTtlMs;
    this.customPort = validateCustomPort(customPort);
    this.customCsrfToken = validateCustomCsrfToken(customCsrfToken);
    this.lastCachedResult = null;
    this.lastFetchTime = 0;
    this.lastServerForceRefreshTime = Date.now();
    this.lastCascadeResult = null;
    this.lastCascadeFetchTime = 0;
    this.cascadeUsageCache = new Map();
    this.activeConfig = null;
  }

  /**
   * Resolves the Antigravity user home directory.
   * @returns {string}
   */
  getAntigravityHomeDir() {
    const home = os.homedir();
    return path.join(home, ".gemini", "antigravity");
  }

  /**
   * Discovers the Language Server port and CSRF token.
   * @returns {{ port: number, csrfToken: string }}
   */
  discoverLsConfig() {
    if (this.customPort !== null && this.customPort !== undefined && this.customCsrfToken !== null && this.customCsrfToken !== undefined) {
      return {
        port: validateCustomPort(this.customPort),
        csrfToken: validateCustomCsrfToken(this.customCsrfToken)
      };
    }

    // 1. Check environment variables
    const envAddr = typeof process.env.ANTIGRAVITY_LS_ADDRESS === "string"
      ? process.env.ANTIGRAVITY_LS_ADDRESS.trim()
      : "";
    const envCsrf = typeof process.env.ANTIGRAVITY_CSRF_TOKEN === "string"
      ? process.env.ANTIGRAVITY_CSRF_TOKEN.trim()
      : "";
    if (envAddr && envCsrf) {
      let port = 0;
      try {
        const url = envAddr.startsWith("http") ? new URL(envAddr) : new URL(`http://${envAddr}`);
        port = /^\d+$/.test(url.port) ? Number(url.port) : 0;
      } catch {
        const match = envAddr.match(/:(\d+)/);
        if (match) port = Number(match[1]);
      }
      if (isValidPort(port)) {
        this.activeConfig = { port, csrfToken: envCsrf };
        return this.activeConfig;
      }
    }

    // 2. Discover from daemon hub_*.json files
    const daemonDir = path.join(this.getAntigravityHomeDir(), "daemon");
    if (fs.existsSync(daemonDir)) {
      try {
        const files = fs.readdirSync(daemonDir).filter((f) => f.startsWith("hub_") && f.endsWith(".json"));
        // Sort newest first
        const sorted = files
          .map((f) => {
            const fullPath = path.join(daemonDir, f);
            return { file: f, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);

        for (const item of sorted) {
          try {
            const content = fs.readFileSync(item.path, "utf8");
            const parsed = JSON.parse(content);
            const rawPort = parsed.httpPort ?? parsed.port;
            const parsedPort = typeof rawPort === "number"
              ? rawPort
              : typeof rawPort === "string" && /^\d+$/.test(rawPort.trim())
                ? Number(rawPort.trim())
                : NaN;
            const csrfToken = parsed.csrfToken;
            if (isValidPort(parsedPort) && typeof csrfToken === "string" && csrfToken.trim()) {
              this.activeConfig = { port: parsedPort, csrfToken: csrfToken.trim() };
              return this.activeConfig;
            }
          } catch {
            // Check next file
          }
        }
      } catch {
        // Fallback to logs
      }
    }

    // 3. Discover from language_server.log
    const appDataDir = typeof process.env.APPDATA === "string" ? process.env.APPDATA.trim() : "";
    const logCandidates = [
      ...(appDataDir ? [path.join(appDataDir, "Antigravity", "logs", "language_server.log")] : []),
      path.join(os.homedir(), "Library", "Logs", "Antigravity", "language_server.log"),
      path.join(os.homedir(), ".config", "Antigravity", "logs", "language_server.log")
    ];

    for (const logPath of logCandidates) {
      if (fs.existsSync(logPath)) {
        try {
          const stats = fs.statSync(logPath);
          const readSize = Math.min(stats.size, 16384);
          const buf = Buffer.alloc(readSize);
          const fd = fs.openSync(logPath, "r");
          try {
            fs.readSync(fd, buf, 0, readSize, stats.size - readSize);
          } finally {
            fs.closeSync(fd);
          }

          const tail = buf.toString("utf8");
          const portMatch = tail.match(/Language server listening on random port at (\d+) for HTTP/);
          if (portMatch) {
            const port = Number(portMatch[1]);
            if (isValidPort(port)) {
              this.activeConfig = { port, csrfToken: this.activeConfig?.csrfToken || "" };
              return this.activeConfig;
            }
          }
        } catch {
          // Log read error, proceed to fallback
        }
      }
    }

    // Fallback default
    return this.activeConfig || { port: 50995, csrfToken: "" };
  }

  /**
   * Performs a Connect-RPC POST request against candidate endpoint paths.
   * @param {number} port
   * @param {string} csrfToken
   * @param {Array<string>} paths
   * @param {string} [label="Quota RPC"]
   * @param {string} [methodName="RetrieveUserQuotaSummary"]
   * @param {{ body?: Object, timeoutMs?: number }} [options={}]
   * @returns {Promise<Object>}
   */
  async makeRpcCall(
    port,
    csrfToken,
    paths,
    label = "Quota RPC",
    methodName = "RetrieveUserQuotaSummary",
    options = {}
  ) {
    return makeConnectRpcCall(port, csrfToken, paths, label, methodName, options);
  }

  /**
   * Performs the HTTP request to RetrieveUserQuotaSummary Connect-RPC endpoint.
   * @param {number} port
   * @param {string} csrfToken
   * @param {boolean} [serverForceRefresh=false]
   * @returns {Promise<Object>}
   */
  async makeRpcRequest(port, csrfToken, serverForceRefresh = false) {
    return this.makeRpcCall(
      port,
      csrfToken,
      [
        "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        "/LanguageServerService/RetrieveUserQuotaSummary"
      ],
      "Quota RPC",
      "RetrieveUserQuotaSummary",
      {
        body: serverForceRefresh ? { forceRefresh: true } : {}
      }
    );
  }

  /**
   * Parses the raw RPC response into normalized telemetry structure.
   * @param {Object} rawData
   * @returns {Object}
   */
  normalizeQuotaResponse(rawData) {
    return normalizeQuotaResponse(rawData);
  }

  /**
   * Retrieves user quota summary with memory caching.
   * @param {boolean} forceRefresh
   * @returns {Promise<Object>}
   */
  async getQuotaSummary(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.lastCachedResult && now - this.lastFetchTime < this.cacheTtlMs) {
      return refreshQuotaCountdowns(this.lastCachedResult);
    }

    try {
      const config = this.discoverLsConfig();
      const csrfToken = typeof config?.csrfToken === "string" ? config.csrfToken.trim() : "";
      if (!config?.port || !csrfToken) {
        throw new Error("Language Server HTTP port or CSRF token could not be discovered.");
      }

      const shouldForceServer =
        Boolean(forceRefresh) ||
        now - this.lastServerForceRefreshTime >= DEFAULT_SERVER_FORCE_REFRESH_MS;
      const raw = await this.makeRpcRequest(config.port, csrfToken, shouldForceServer);
      const normalized = this.normalizeQuotaResponse(raw);
      this.lastCachedResult = normalized;
      this.lastFetchTime = now;
      if (shouldForceServer) {
        this.lastServerForceRefreshTime = now;
      }
      return normalized;
    } catch (err) {
      if (this.lastCachedResult) {
        return {
          ...refreshQuotaCountdowns(this.lastCachedResult),
          isStale: true,
          error: err.message
        };
      }
      throw err;
    }
  }

  /**
   * Parses raw GetAllCascadeTrajectories payload into a Map keyed by conversationId.
   * @param {Object} rawData
   * @returns {Map<string, Object>}
   */
  parseCascadeStatuses(rawData) {
    return parseCascadeStatusesPayload(rawData);
  }

  /**
   * Retrieves live cascade run statuses from LanguageServerService/GetAllCascadeTrajectories.
   * Returns null gracefully when Language Server is unreachable or unsupported.
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<Map<string, Object>|null>}
   */
  async getCascadeStatuses(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.lastCascadeResult !== null && now - this.lastCascadeFetchTime < this.cascadeCacheTtlMs) {
      return this.lastCascadeResult;
    }

    try {
      const config = this.discoverLsConfig();
      const csrfToken = typeof config?.csrfToken === "string" ? config.csrfToken.trim() : "";
      if (!config?.port || !csrfToken) {
        this.lastCascadeResult = null;
        this.lastCascadeFetchTime = 0;
        return null;
      }

      const raw = await this.makeRpcCall(
        config.port,
        csrfToken,
        [
          "/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories",
          "/LanguageServerService/GetAllCascadeTrajectories"
        ],
        "Cascade RPC",
        "GetAllCascadeTrajectories"
      );

      const parsed = this.parseCascadeStatuses(raw);
      this.lastCascadeResult = parsed;
      this.lastCascadeFetchTime = now;
      return parsed;
    } catch (err) {
      this.lastCascadeResult = null;
      this.lastCascadeFetchTime = 0;
      const isExpectedOffline =
        err?.isNotFound === true ||
        err?.isNetworkError === true ||
        err?.statusCode === 404;
      if (!isExpectedOffline) {
        console.error(`[TokenTracker QuotaService] Non-fatal GetAllCascadeTrajectories error: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Retrieves exact latest step `modelUsage` for a conversation via GetCascadeTrajectorySteps.
   * Caches by `stepCount` (or 3s TTL when `stepCount` is null), bounded to 64 entries.
   * Returns null gracefully on invalid IDs or offline/unsupported Language Server.
   * @param {string} conversationId
   * @param {number|null} [stepCount=null]
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<{ inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, outputTokens: number, totalPromptTokens: number, model: string|null }|null>}
   */
  async getCascadeUsage(conversationId, stepCount = null, forceRefresh = false) {
    let safeConvId;
    try {
      safeConvId = validateSafeConversationId(conversationId, "conversationId");
    } catch {
      return null;
    }

    const now = Date.now();
    const hasValidStepCount = Number.isSafeInteger(stepCount) && stepCount >= 0;
    const cached = this.cascadeUsageCache.get(safeConvId);
    if (!forceRefresh && cached) {
      const isFresh = hasValidStepCount
        ? cached.stepCount === stepCount
        : now - cached.fetchedAt < DEFAULT_USAGE_CACHE_TTL_MS;
      if (isFresh) {
        this.cascadeUsageCache.delete(safeConvId);
        this.cascadeUsageCache.set(safeConvId, cached);
        return cached.usage;
      }
    }

    try {
      const config = this.discoverLsConfig();
      const csrfToken = typeof config?.csrfToken === "string" ? config.csrfToken.trim() : "";
      if (!config?.port || !csrfToken) {
        return null;
      }

      const raw = await this.makeRpcCall(
        config.port,
        csrfToken,
        [
          "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
          "/LanguageServerService/GetCascadeTrajectorySteps"
        ],
        "Cascade Steps RPC",
        "GetCascadeTrajectorySteps",
        {
          body: { cascadeId: safeConvId },
          timeoutMs: 2500
        }
      );

      const usage = extractLatestModelUsage(raw);
      this.cascadeUsageCache.delete(safeConvId);
      if (this.cascadeUsageCache.size >= MAX_USAGE_CACHE_ENTRIES) {
        const oldestKey = this.cascadeUsageCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cascadeUsageCache.delete(oldestKey);
        }
      }
      this.cascadeUsageCache.set(safeConvId, {
        usage,
        stepCount: hasValidStepCount ? stepCount : null,
        fetchedAt: now
      });
      return usage;
    } catch (err) {
      const isExpectedOffline =
        err?.isNotFound === true ||
        err?.isNetworkError === true ||
        err?.statusCode === 404 ||
        err?.statusCode === 400;
      if (!isExpectedOffline) {
        console.error(`[TokenTracker QuotaService] Non-fatal GetCascadeTrajectorySteps error: ${err.message}`);
      }
      return null;
    }
  }
}
