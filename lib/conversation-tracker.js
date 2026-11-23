/**
 * Conversation Tracker.
 * Reads Antigravity SQLite conversation database (~/.gemini/antigravity/conversations/<conversation_id>.db)
 * in read-only mode to extract:
 * - Active model and context window capacity
 * - Current context tokens and percent used
 * - Prompt cache hit ratio and cached vs uncached tokens
 * - Cumulative trajectory bytes and KB remaining until auto-compaction
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  getModelContextWindow,
  normalizeModelName,
  detectModelGroup,
  formatTokenCount,
  DEFAULT_CONTEXT_WINDOW
} from "./models.js";

export const DEFAULT_COMPACTION_THRESHOLD_BYTES = 184320; // 180 KB default trigger threshold
const BYTES_PER_TOKEN = 4; // Standard character/byte heuristic for LLM tokens

/**
 * Resolves the active conversation/session ID from hook payloads or environment variables.
 * @param {Object} payload
 * @returns {string|null}
 */
export function resolveSessionId(payload = {}) {
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    null
  );
}

export class ConversationTracker {
  constructor({
    conversationsDir = null,
    compactionThresholdBytes = null
  } = {}) {
    const home = os.homedir();
    this.conversationsDir = conversationsDir || path.join(home, ".gemini", "antigravity", "conversations");
    this.compactionThresholdBytes = compactionThresholdBytes ||
      (process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES ? parseInt(process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES, 10) : DEFAULT_COMPACTION_THRESHOLD_BYTES);
  }

  /**
   * Resolves the active conversation SQLite file path.
   * @param {string|null} preferredId
   * @returns {string}
   */
  resolveConversationDbPath(preferredId = null) {
    if (preferredId) {
      const target = preferredId.endsWith(".db") ? preferredId : `${preferredId}.db`;
      const directPath = path.isAbsolute(target) ? target : path.join(this.conversationsDir, target);
      if (fs.existsSync(directPath)) {
        return directPath;
      }
    }

    if (!fs.existsSync(this.conversationsDir)) {
      throw new Error(`Conversations directory not found: ${this.conversationsDir}`);
    }

    // Check active lock files in presence directory first
    const presenceDir = path.join(path.dirname(this.conversationsDir), "presence");
    if (fs.existsSync(presenceDir)) {
      try {
        const locks = fs.readdirSync(presenceDir).filter((f) => f.endsWith(".lock"));
        if (locks.length > 0) {
          const sortedLocks = locks
            .map((f) => {
              const fullPath = path.join(presenceDir, f);
              return { id: f.replace(".lock", ""), mtime: fs.statSync(fullPath).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);

          for (const lock of sortedLocks) {
            const dbPath = path.join(this.conversationsDir, `${lock.id}.db`);
            if (fs.existsSync(dbPath)) {
              return dbPath;
            }
          }
        }
      } catch {
        // Fall through to conversations scan
      }
    }

    // Scan all conversation databases and pick the most recently updated
    const files = fs.readdirSync(this.conversationsDir).filter((f) => f.endsWith(".db") && !f.includes("-shm") && !f.includes("-wal"));
    if (files.length === 0) {
      throw new Error(`No SQLite conversation databases found in: ${this.conversationsDir}`);
    }

    const sortedFiles = files
      .map((f) => {
        const fullPath = path.join(this.conversationsDir, f);
        return { file: f, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    return sortedFiles[0].path;
  }

  /**
   * Scans a buffer or string for recognized model names or enums.
   * @param {Buffer|string} bufferOrStr
   * @returns {string|null}
   */
  extractModelIdentifier(bufferOrStr) {
    const text = typeof bufferOrStr === "string" ? bufferOrStr : bufferOrStr.toString("latin1");
    const patterns = [
      /gemini-3\.[0-9]-flash-[a-z0-9_-]+/i,
      /gemini-3\.[0-9]-pro-[a-z0-9_-]+/i,
      /gemini-1\.[0-9]-pro-[a-z0-9_-]+/i,
      /gemini-1\.[0-9]-flash-[a-z0-9_-]+/i,
      /Gemini\s+3\.[0-9]\s+Flash\s*\([A-Za-z]+\)/i,
      /Gemini\s+3\.[0-9]\s+Pro/i,
      /claude-[a-z0-9_.-]+/i,
      /Claude\s+Sonnet\s+4\.[0-9]/i,
      /Claude\s+3\.[0-9]\s+Sonnet/i,
      /gpt-[a-z0-9_.-]+/i,
      /GPT-[a-zA-Z0-9_.-]+/i
    ];

    for (const pat of patterns) {
      const match = text.match(pat);
      if (match) {
        return match[0];
      }
    }
    return null;
  }

  /**
   * Reads and parses telemetry metrics for a conversation.
   * @param {string|null} conversationId
   * @returns {Object}
   */
  getConversationMetrics(conversationId = null) {
    const dbPath = this.resolveConversationDbPath(conversationId);
    const resolvedId = path.basename(dbPath, ".db");
    const stat = fs.statSync(dbPath);

    let db = null;
    let isCorrupt = false;
    let detectedModel = null;
    let currentContextBytes = 0;
    let prevContextBytes = 0;
    let stepCount = 0;
    let cumulativeTrajectoryBytes = 0;

    try {
      db = new DatabaseSync(dbPath, { readOnly: true });

      // Fail-fast integrity check: verify SQLite header and schema validity
      try {
        db.prepare("PRAGMA schema_version").get();
      } catch {
        // Fatal database corruption or non-database file: fallback safely without executing queries
        isCorrupt = true;
        cumulativeTrajectoryBytes = stat.size;
      }

      if (!isCorrupt) {
        // 1. Read trajectory metadata blob
        try {
          const trajRow = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get();
          if (trajRow && trajRow.data) {
            detectedModel = this.extractModelIdentifier(Buffer.from(trajRow.data));
          }
        } catch (err) {
          if (!err.message?.includes("no such table")) {
            throw err;
          }
        }

        // 2. Read latest two gen_metadata records for context tokens and prompt cache ratio
        try {
          const genRows = db.prepare("SELECT idx, data, length(data) as l FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT 2").all();
          if (genRows.length > 0) {
            currentContextBytes = genRows[0].l || (genRows[0].data ? Buffer.from(genRows[0].data).length : 0);
            if (!detectedModel && genRows[0].data) {
              detectedModel = this.extractModelIdentifier(Buffer.from(genRows[0].data));
            }
          }
          if (genRows.length > 1) {
            prevContextBytes = genRows[1].l || (genRows[1].data ? Buffer.from(genRows[1].data).length : 0);
          }
        } catch (err) {
          if (!err.message?.includes("no such table")) {
            throw err;
          }
        }

        // 3. Read steps table for trajectory byte volume and total step count
        try {
          const stepStats = db.prepare(
            "SELECT count(*) as count, SUM(coalesce(length(metadata), 0) + coalesce(length(step_payload), 0) + coalesce(length(render_info), 0) + coalesce(length(task_details), 0)) as total_bytes FROM steps"
          ).get();
          if (stepStats) {
            stepCount = stepStats.count || 0;
            cumulativeTrajectoryBytes = stepStats.total_bytes || 0;
          }
        } catch (err) {
          if (err.message?.includes("no such table")) {
            cumulativeTrajectoryBytes = stat.size;
          } else {
            throw err;
          }
        }
      }

      // 4. Resolve Model & Context Window
      const modelId = detectedModel || "gemini-3.8-flash-high";
      const modelName = normalizeModelName(modelId);
      const maxContextTokens = getModelContextWindow(modelId);
      const modelGroup = detectModelGroup(modelId);

      const currentTokens = Math.max(0, Math.round(currentContextBytes / BYTES_PER_TOKEN));
      const percentUsed = maxContextTokens > 0 ? parseFloat(((currentTokens / maxContextTokens) * 100).toFixed(1)) : 0;

      // 5. Prompt Cache Calculations (Prefix Caching)
      const prevTokens = Math.max(0, Math.round(prevContextBytes / BYTES_PER_TOKEN));
      const cachedTokens = Math.min(prevTokens, currentTokens);
      const uncachedTokens = Math.max(0, currentTokens - cachedTokens);
      const hitRatio = currentTokens > 0 ? cachedTokens / currentTokens : 0;
      const hitRatioPercent = parseFloat((hitRatio * 100).toFixed(1));

      // 6. Context Compaction Calculations
      const thresholdBytes = this.compactionThresholdBytes;
      const trajectoryKb = parseFloat((cumulativeTrajectoryBytes / 1024).toFixed(1));
      const thresholdKb = Math.round(thresholdBytes / 1024);
      const bytesRemaining = Math.max(0, thresholdBytes - cumulativeTrajectoryBytes);
      const kbRemaining = Math.max(0, Math.round(bytesRemaining / 1024));
      const percentCompacted = Math.min(100, Math.round((cumulativeTrajectoryBytes / thresholdBytes) * 100));
      const isNearCompaction = kbRemaining <= 35 || percentCompacted >= 80;

      return {
        conversationId: resolvedId,
        dbPath,
        lastModified: new Date(stat.mtimeMs).toISOString(),
        stepCount,
        model: {
          id: modelId,
          displayName: modelName,
          maxTokens: maxContextTokens,
          group: modelGroup
        },
        contextWindow: {
          currentTokens,
          maxTokens: maxContextTokens,
          percentUsed,
          contextBytes: currentContextBytes,
          currentTokensFormatted: formatTokenCount(currentTokens),
          maxTokensFormatted: formatTokenCount(maxContextTokens)
        },
        cache: {
          cachedTokens,
          uncachedTokens,
          totalTokens: currentTokens,
          hitRatio: parseFloat(hitRatio.toFixed(3)),
          hitRatioPercent,
          cachedTokensFormatted: formatTokenCount(cachedTokens),
          uncachedTokensFormatted: formatTokenCount(uncachedTokens)
        },
        compaction: {
          trajectoryBytes: cumulativeTrajectoryBytes,
          trajectoryKb,
          thresholdBytes,
          thresholdKb,
          kbRemaining,
          percentCompacted,
          isNearCompaction
        }
      };
    } finally {
      if (db) {
        db.close();
      }
    }
  }
}
