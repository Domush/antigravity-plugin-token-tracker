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
  formatTokenCount
} from "./models.js";
import {
  stripMonitorConfigOverrides,
  extractStrippedTrailer,
  extractModelIdentifier as detectModelIdentifier
} from "./model-detector.js";
import {
  DEFAULT_COMPACTION_THRESHOLD_BYTES,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  BYTES_PER_TOKEN,
  resolveCompactionThreshold,
  buildCompactionMetrics
} from "./compaction.js";

export {
  DEFAULT_COMPACTION_THRESHOLD_BYTES,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  buildCompactionMetrics
};

const GEN_METADATA_TRAILER_BYTES = 2048;

/**
 * Verifies that a target path exists as a regular non-symlink file confined inside `realParentDir`.
 * Returns the canonical real path or null if missing (ENOENT).
 * Throws when the target is a symlink, non-file, or escapes `realParentDir`.
 * @param {string} targetPath
 * @param {string} realParentDir
 * @param {boolean} [throwOnUnsafe=true]
 * @returns {{ realPath: string, mtimeMs: number }|null}
 */
function resolveRegularFileInDir(targetPath, realParentDir, throwOnUnsafe = true) {
  let lstat;
  try {
    lstat = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    if (throwOnUnsafe) {
      throw new Error(`Invalid conversation database path: symlinks and non-files are not allowed (${path.basename(targetPath)}).`);
    }
    return null;
  }

  const realPath = fs.realpathSync(targetPath);
  const actualParent = path.dirname(realPath);
  const isSameDir = process.platform === "win32"
    ? actualParent.toLowerCase() === realParentDir.toLowerCase()
    : actualParent === realParentDir;
  if (!isSameDir) {
    if (throwOnUnsafe) {
      throw new Error(`Invalid conversation database path: path escapes conversations directory (${path.basename(targetPath)}).`);
    }
    return null;
  }

  return { realPath, mtimeMs: lstat.mtimeMs };
}

/**
 * Resolves the active conversation/session ID from hook payloads or environment variables.
 * @param {Object} payload
 * @returns {string|null}
 */
export function resolveSessionId(payload = {}) {
  const candidates = [
    payload?.conversationId,
    payload?.conversation_id,
    payload?.rootConversationId,
    payload?.root_conversation_id,
    payload?.parentConversationId,
    payload?.parent_conversation_id,
    payload?.sessionId,
    payload?.session_id,
    process.env.ANTIGRAVITY_CONVERSATION_ID,
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Determines whether a hook payload belongs to a background subagent rather than
 * the primary root conversation.
 * @param {Object} payload
 * @param {string|null} resolvedConvId
 * @returns {boolean}
 */
export function isSubagentPayload(payload = {}, resolvedConvId = null) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (payload.isSubagent === true || payload.is_subagent === true) {
    return true;
  }

  const subagentType = payload.subagentType ?? payload.subagent_type;
  if (typeof subagentType === "string" && subagentType.trim().length > 0) {
    return true;
  }

  const ancestorIds = [
    payload.rootConversationId,
    payload.root_conversation_id,
    payload.parentConversationId,
    payload.parent_conversation_id
  ]
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());

  if (ancestorIds.length === 0) {
    return false;
  }

  const effectiveResolvedId =
    typeof resolvedConvId === "string" && resolvedConvId.trim().length > 0
      ? resolvedConvId.trim()
      : resolveSessionId(payload);

  const childIds = [
    effectiveResolvedId,
    payload.conversationId,
    payload.conversation_id,
    payload.sessionId,
    payload.session_id
  ]
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());

  for (const childId of childIds) {
    for (const ancestorId of ancestorIds) {
      if (childId !== ancestorId) {
        return true;
      }
    }
  }

  return false;
}

export class ConversationTracker {
  constructor({
    conversationsDir = null,
    compactionThresholdBytes = null
  } = {}) {
    const home = os.homedir();
    this.conversationsDir = conversationsDir || path.join(home, ".gemini", "antigravity", "conversations");
    this.compactionThresholdBytes = resolveCompactionThreshold(compactionThresholdBytes);
  }

  /**
   * Resolves the active conversation SQLite file path.
   * Rejects path traversal, path separators, null bytes, and absolute overrides.
   * @param {string|null} preferredId
   * @param {{ strict?: boolean }} [options]
   * @returns {string}
   */
  resolveConversationDbPath(preferredId = null, { strict = false } = {}) {
    if (preferredId !== null && preferredId !== undefined && typeof preferredId !== "string") {
      throw new TypeError("conversationId must be a string when provided.");
    }
    const normalizedId = typeof preferredId === "string" ? preferredId.trim() : "";
    if (strict && !normalizedId) {
      throw new Error("Strict conversation lookup requires a non-empty conversationId.");
    }

    if (normalizedId) {
      if (
        normalizedId.includes("\0") ||
        /[/\\:]/.test(normalizedId) ||
        normalizedId.includes("..") ||
        normalizedId === "." ||
        path.isAbsolute(normalizedId)
      ) {
        throw new Error("Invalid conversationId: path traversal or absolute path is not allowed.");
      }
      const target = normalizedId.endsWith(".db") ? normalizedId : `${normalizedId}.db`;
      const stem = target.slice(0, -3);
      if (!stem || stem === "." || stem === "..") {
        throw new Error("Invalid conversationId: path traversal or absolute path is not allowed.");
      }

      const resolvedConvDir = path.resolve(this.conversationsDir);
      const directPath = path.resolve(resolvedConvDir, target);
      if (path.dirname(directPath) !== resolvedConvDir || path.basename(directPath) !== target) {
        throw new Error("Invalid conversationId: path traversal or absolute path is not allowed.");
      }

      if (fs.existsSync(resolvedConvDir)) {
        const realConvDir = fs.realpathSync(resolvedConvDir);
        const verified = resolveRegularFileInDir(directPath, realConvDir, true);
        if (verified) {
          return verified.realPath;
        }
      }
      if (strict) {
        throw new Error(`Conversation database not found for "${normalizedId}".`);
      }
    }

    if (!fs.existsSync(this.conversationsDir)) {
      throw new Error(`Conversations directory not found: ${this.conversationsDir}`);
    }

    const resolvedConvDir = path.resolve(this.conversationsDir);
    const realConvDir = fs.realpathSync(resolvedConvDir);

    // Check active lock files in presence directory first
    const presenceDir = path.join(path.dirname(resolvedConvDir), "presence");
    if (fs.existsSync(presenceDir)) {
      try {
        const realPresenceDir = fs.realpathSync(presenceDir);
        const locks = fs.readdirSync(presenceDir).filter((f) => f.endsWith(".lock"));
        if (locks.length > 0) {
          const sortedLocks = locks
            .map((f) => {
              const lockInfo = resolveRegularFileInDir(path.join(presenceDir, f), realPresenceDir, false);
              if (!lockInfo) return null;
              return { id: f.slice(0, -5), mtime: lockInfo.mtimeMs };
            })
            .filter((item) => item && item.id && !item.id.includes("..") && !/[/\\:]/.test(item.id))
            .sort((a, b) => b.mtime - a.mtime);

          for (const lock of sortedLocks) {
            const dbPath = path.join(resolvedConvDir, `${lock.id}.db`);
            const verified = resolveRegularFileInDir(dbPath, realConvDir, false);
            if (verified) {
              return verified.realPath;
            }
          }
        }
      } catch {
        // Fall through to conversations scan
      }
    }

    // Scan all conversation databases and pick the most recently updated
    const files = fs.readdirSync(resolvedConvDir).filter((f) => f.endsWith(".db") && !f.includes("-shm") && !f.includes("-wal"));
    const sortedFiles = files
      .map((f) => {
        const verified = resolveRegularFileInDir(path.join(resolvedConvDir, f), realConvDir, false);
        if (!verified) return null;
        return { file: f, path: verified.realPath, mtime: verified.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    if (sortedFiles.length === 0) {
      throw new Error(`No SQLite conversation databases found in: ${this.conversationsDir}`);
    }

    return sortedFiles[0].path;
  }

  /**
   * Scans a buffer, Uint8Array, or string for recognized model names or enums.
   * Ordered from most-specific tiered/vendor patterns to generic vendor fallbacks.
   * @param {Buffer|Uint8Array|string|null|undefined} bufferOrStr
   * @param {{ preferLast?: boolean }} [options]
   * @returns {string|null}
   */
  extractModelIdentifier(bufferOrStr, options = {}) {
    return detectModelIdentifier(bufferOrStr, options);
  }

  /**
   * Reads and parses telemetry metrics for a conversation.
   * @param {string|null} conversationId
   * @param {{ strict?: boolean }} [options]
   * @returns {Object}
   */
  getConversationMetrics(conversationId = null, { strict = false } = {}) {
    const dbPath = this.resolveConversationDbPath(conversationId, { strict });
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
        let trajData = null;
        let genRows = [];

        // 1. Read trajectory metadata blob
        try {
          const trajRow = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get();
          if (trajRow && trajRow.data) {
            trajData = Buffer.from(trajRow.data);
          }
        } catch (err) {
          if (!err.message?.includes("no such table")) {
            throw err;
          }
        }

        // 2. Read latest gen_metadata records for context tokens and prompt cache ratio
        try {
          genRows = db.prepare("SELECT idx, data, length(data) as l FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT 10").all();
          if (genRows.length > 0) {
            currentContextBytes = genRows[0].l || (genRows[0].data ? Buffer.from(genRows[0].data).length : 0);
          }
          if (genRows.length > 1) {
            const firstPrevBytes = genRows[1].l || (genRows[1].data ? Buffer.from(genRows[1].data).length : 0);
            if (currentContextBytes > 16384 && firstPrevBytes <= 2048) {
              const substantialRow = genRows.slice(2).find((row) => {
                const len = row.l || (row.data ? Buffer.from(row.data).length : 0);
                return len > 2048;
              });
              prevContextBytes = substantialRow
                ? (substantialRow.l || (substantialRow.data ? Buffer.from(substantialRow.data).length : 0))
                : 0;
            } else {
              prevContextBytes = firstPrevBytes;
            }
          }
        } catch (err) {
          if (!err.message?.includes("no such table")) {
            throw err;
          }
        }

        // Model extraction priority:
        // 1) Latest gen_metadata row (genRows[0]) padded trailer (tail-most match)
        // 2) Latest gen_metadata row (genRows[0]) full buffer with overrides stripped
        // 3) Previous gen_metadata row (genRows[1]) padded trailer (tail-most match)
        // 4) trajectory_metadata_blob with monitor config overrides stripped
        if (genRows.length > 0 && genRows[0]?.data) {
          const gen0Buf = Buffer.from(genRows[0].data);
          const gen0Trailer = extractStrippedTrailer(gen0Buf, GEN_METADATA_TRAILER_BYTES);
          detectedModel =
            this.extractModelIdentifier(gen0Trailer, { preferLast: true }) ||
            this.extractModelIdentifier(stripMonitorConfigOverrides(gen0Buf));
        }

        if (!detectedModel && genRows.length > 1 && genRows[1]?.data) {
          const gen1Buf = Buffer.from(genRows[1].data);
          const gen1Trailer = extractStrippedTrailer(gen1Buf, GEN_METADATA_TRAILER_BYTES);
          detectedModel = this.extractModelIdentifier(gen1Trailer, { preferLast: true });
        }

        if (!detectedModel && trajData) {
          detectedModel = this.extractModelIdentifier(stripMonitorConfigOverrides(trajData));
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

      // 6. Context Compaction Calculations (Active prompt context relative to model trigger)
      const compaction = buildCompactionMetrics(
        currentContextBytes,
        maxContextTokens,
        this.compactionThresholdBytes,
        cumulativeTrajectoryBytes
      );

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
          uncachedTokensFormatted: formatTokenCount(uncachedTokens),
          totalTokensFormatted: formatTokenCount(currentTokens)
        },
        compaction
      };
    } finally {
      if (db) {
        db.close();
      }
    }
  }
}
