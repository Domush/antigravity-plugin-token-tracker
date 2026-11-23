/**
 * Quota Service Client.
 * Connect-RPC client for LanguageServerService/RetrieveUserQuotaSummary.
 * Discovers the active Language Server port and CSRF token from environment,
 * daemon registration JSON files, or server logs.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CACHE_TTL_MS = 15000; // 15 seconds cache

/**
 * Formats a duration in milliseconds into a concise countdown string.
 * @param {string|Date} resetTimeStr
 * @returns {string}
 */
export function formatCountdown(resetTimeStr) {
  if (!resetTimeStr) return "N/A";
  const resetMs = resetTimeStr instanceof Date ? resetTimeStr.getTime() : new Date(resetTimeStr).getTime();
  if (Number.isNaN(resetMs)) return "N/A";

  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) return "Ready";

  const totalSecs = Math.round(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (totalSecs < 60) {
    return totalSecs >= 30 ? "1m" : "0m";
  }
  return `${minutes}m`;
}

export class QuotaService {
  constructor({ cacheTtlMs = DEFAULT_CACHE_TTL_MS, customPort = null, customCsrfToken = null } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.customPort = customPort;
    this.customCsrfToken = customCsrfToken;
    this.lastCachedResult = null;
    this.lastFetchTime = 0;
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
    if (this.customPort && this.customCsrfToken) {
      return { port: this.customPort, csrfToken: this.customCsrfToken };
    }

    // 1. Check environment variables
    const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    if (envAddr && envCsrf) {
      let port = 0;
      try {
        const url = envAddr.startsWith("http") ? new URL(envAddr) : new URL(`http://${envAddr}`);
        port = parseInt(url.port, 10);
      } catch {
        const match = envAddr.match(/:(\d+)/);
        if (match) port = parseInt(match[1], 10);
      }
      if (port > 0) {
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
            const port = parsed.httpPort || parsed.port;
            const csrfToken = parsed.csrfToken;
            if (port && csrfToken) {
              this.activeConfig = { port: parseInt(port, 10), csrfToken };
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
    const logCandidates = [
      path.join(process.env.APPDATA || "", "Antigravity", "logs", "language_server.log"),
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
            const port = parseInt(portMatch[1], 10);
            if (port > 0) {
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
   * Performs the HTTP request to Connect-RPC endpoint.
   * @param {number} port
   * @param {string} csrfToken
   * @returns {Promise<Object>}
   */
  async makeRpcRequest(port, csrfToken) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({});
      const paths = [
        "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        "/LanguageServerService/RetrieveUserQuotaSummary"
      ];

      const tryPath = (idx) => {
        if (idx >= paths.length) {
          return reject(new Error(`Failed to call RetrieveUserQuotaSummary on port ${port}: endpoint not found`));
        }

        const reqPath = paths[idx];
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: reqPath,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-codeium-csrf-token": csrfToken,
              "Connect-Protocol-Version": "1",
              "Content-Length": Buffer.byteLength(payload)
            },
            timeout: 5000
          },
          (res) => {
            if (res.statusCode === 404 && idx + 1 < paths.length) {
              res.resume();
              return tryPath(idx + 1);
            }

            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  const json = JSON.parse(data);
                  resolve(json);
                } catch (err) {
                  reject(new Error(`Malformed JSON response from Quota RPC: ${err.message}`));
                }
              } else {
                reject(new Error(`Quota RPC responded with status code ${res.statusCode}: ${data}`));
              }
            });
          }
        );

        req.on("error", (err) => {
          reject(new Error(`Connection error calling Quota RPC on 127.0.0.1:${port}: ${err.message}`));
        });

        req.on("timeout", () => {
          req.destroy(new Error(`Timeout calling Quota RPC on 127.0.0.1:${port}`));
        });

        req.write(payload);
        req.end();
      };

      tryPath(0);
    });
  }

  /**
   * Parses the raw RPC response into normalized telemetry structure.
   * @param {Object} rawData
   * @returns {Object}
   */
  normalizeQuotaResponse(rawData) {
    const defaultBucket = {
      remainingFraction: 1,
      remainingPercent: 100,
      usedPercent: 0,
      resetTime: null,
      countdown: "Ready"
    };

    const quota = {
      gemini: {
        weekly: { ...defaultBucket },
        fiveHour: { ...defaultBucket }
      },
      thirdParty: {
        weekly: { ...defaultBucket },
        fiveHour: { ...defaultBucket }
      },
      rawGroups: rawData?.response?.groups || [],
      timestamp: Date.now()
    };

    const groups = rawData?.response?.groups || [];
    for (const group of groups) {
      const name = (group.displayName || "").toLowerCase();
      const isGemini = name.includes("gemini");
      const is3p = name.includes("claude") || name.includes("gpt") || name.includes("third");
      const targetGroup = isGemini ? quota.gemini : is3p ? quota.thirdParty : null;

      if (!targetGroup) continue;

      for (const bucket of group.buckets || []) {
        const windowType = (bucket.window || "").toLowerCase();
        const fraction = typeof bucket.remainingFraction === "number" ? Math.max(0, Math.min(1, bucket.remainingFraction)) : 1;
        const remainingPercent = parseFloat((fraction * 100).toFixed(1));
        const usedPercent = parseFloat(((1 - fraction) * 100).toFixed(1));
        const resetTime = bucket.resetTime || null;
        const countdown = formatCountdown(resetTime);

        const bucketData = {
          remainingFraction: fraction,
          remainingPercent,
          usedPercent,
          resetTime,
          countdown,
          description: bucket.description || ""
        };

        if (windowType === "weekly" || bucket.bucketId?.includes("weekly")) {
          targetGroup.weekly = bucketData;
        } else if (windowType === "5h" || bucket.bucketId?.includes("5h") || bucket.displayName?.includes("Five Hour")) {
          targetGroup.fiveHour = bucketData;
        }
      }
    }

    return quota;
  }

  /**
   * Retrieves user quota summary with memory caching.
   * @param {boolean} forceRefresh
   * @returns {Promise<Object>}
   */
  async getQuotaSummary(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.lastCachedResult && now - this.lastFetchTime < this.cacheTtlMs) {
      return this.lastCachedResult;
    }

    try {
      const config = this.discoverLsConfig();
      if (!config.port || !config.csrfToken) {
        throw new Error("Language Server HTTP port or CSRF token could not be discovered.");
      }

      const raw = await this.makeRpcRequest(config.port, config.csrfToken);
      const normalized = this.normalizeQuotaResponse(raw);
      this.lastCachedResult = normalized;
      this.lastFetchTime = now;
      return normalized;
    } catch (err) {
      if (this.lastCachedResult) {
        return {
          ...this.lastCachedResult,
          isStale: true,
          error: err.message
        };
      }
      throw err;
    }
  }
}
