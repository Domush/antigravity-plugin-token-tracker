/**
 * Subagent Conversation Tracker.
 * Discovers child subagent Antigravity SQLite conversations linked to a root
 * conversation ID by inspecting gen_metadata trailers and trajectory metadata blobs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ConversationTracker } from "./conversation-tracker.js";
import { toLatin1Text } from "./model-detector.js";
import {
  DEFAULT_ACTIVE_RECENCY_MS,
  validateSafeConversationId,
  validatePositiveInt,
  verifyConfinedRegularFile,
  validateCascadeStatuses,
  getCascadeEntry,
  readPresenceLocks,
  getWalMtimeMs,
  resolveConversationActiveState
} from "./active-status.js";

export {
  validateSafeConversationId,
  validatePositiveInt,
  verifyConfinedRegularFile
};

const GEN_METADATA_TAIL_BYTES = 4096;
const DEFAULT_MAX_SCAN = 100;
const ROOT_KEY_PATTERN = "(?:root_cascade_id|root_conversation_id|rootConversationId|parent_cascade_id|parent_conversation_id|parentConversationId)";
const SUBAGENT_TYPE_TEXT_REGEX = /(?:\\?["']?(?:subagent_type|subagentType)\\?["']?\s*[:=]\s*)(?:\\?"([A-Za-z0-9_-]{2,60})\\?"|\\?'([A-Za-z0-9_-]{2,60})\\?'|([A-Za-z0-9_-]{2,60})(?![A-Za-z0-9_-]))/;
const SUBAGENT_TYPE_PROTO_REGEX = /(?:subagent_type|subagentType)(?!\\?["']?\s*[:=])(?:[\x0a\x12\x1a\x22\x2a\x32\x3a][\x01-\xff]{1,2}){0,2}[\x0a\x12\x1a\x22\x2a\x32\x3a]([\x02-\x3c])([A-Za-z0-9_-]{2,60})/g;
const ROOT_ID_TEXT_REGEX = new RegExp(
  `(?:\\\\?["']?${ROOT_KEY_PATTERN}\\\\?["']?\\s*[:=]\\s*)(?:\\\\?"([A-Za-z0-9._-]+)\\\\?"|\\\\?'([A-Za-z0-9._-]+)\\\\?'|([A-Za-z0-9._-]+)(?![A-Za-z0-9_-]))`
);
const ROOT_ID_PROTO_REGEX = new RegExp(
  `${ROOT_KEY_PATTERN}(?!\\\\?["']?\\s*[:=])(?:[\\x0a\\x12\\x1a\\x22\\x2a\\x32\\x3a][\\x01-\\xff]{1,2}){0,2}[\\x0a\\x12\\x1a\\x22\\x2a\\x32\\x3a]([\\x02-\\x7f])([A-Za-z0-9._-]{2,127})`,
  "g"
);

/**
 * Escapes special regular-expression characters in a literal string.
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Encodes a non-negative integer as a protobuf base-128 varint in latin1 string form.
 * @param {number} len
 * @returns {string}
 */
function encodeVarintLatin1(len) {
  let value = len;
  let out = "";
  while (value >= 0x80) {
    out += String.fromCharCode((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out += String.fromCharCode(value);
  return out;
}

/**
 * Checks whether decoded metadata text links to the target root conversation ID.
 * Separates text/JSON matching from binary protobuf length-prefixed matching
 * so trailing protobuf field tags (6-15) never trigger false negative matches.
 * @param {string} text
 * @param {string} rootId
 * @returns {boolean}
 */
export function matchesRootConversationId(text, rootId) {
  if (!text) return false;
  const escapedRoot = escapeRegex(rootId);

  const textPattern = new RegExp(
    `\\\\?["']?${ROOT_KEY_PATTERN}\\\\?["']?\\s*[:=]\\s*\\\\?["']?${escapedRoot}(?![A-Za-z0-9_-])`
  );
  if (textPattern.test(text)) {
    return true;
  }

  const encodedLen = escapeRegex(encodeVarintLatin1(rootId.length));
  const protoPattern = new RegExp(
    `${ROOT_KEY_PATTERN}(?!\\\\?["']?\\s*[:=])(?:[\\x0a\\x12\\x1a\\x22\\x2a\\x32\\x3a][\\x01-\\xff]{1,2}){0,2}[\\x0a\\x12\\x1a\\x22\\x2a\\x32\\x3a]${encodedLen}${escapedRoot}`
  );
  return protoPattern.test(text);
}

/**
 * Extracts a root/parent conversation ID from decoded metadata text.
 * @param {string} text
 * @returns {string|null}
 */
export function extractRootConversationId(text) {
  if (!text) return null;

  const textMatch = text.match(ROOT_ID_TEXT_REGEX);
  if (textMatch) {
    const raw = textMatch[1] || textMatch[2] || textMatch[3] || null;
    if (raw) {
      try {
        return validateSafeConversationId(raw, "rootConversationId");
      } catch {
        return null;
      }
    }
  }

  ROOT_ID_PROTO_REGEX.lastIndex = 0;
  let protoMatch;
  while ((protoMatch = ROOT_ID_PROTO_REGEX.exec(text)) !== null) {
    const declaredLen = protoMatch[1].charCodeAt(0);
    const candidate = protoMatch[2];
    if (candidate.length >= declaredLen && declaredLen >= 2) {
      const sliced = candidate.slice(0, declaredLen);
      try {
        return validateSafeConversationId(sliced, "rootConversationId");
      } catch {
        // Continue scanning
      }
    }
  }

  return null;
}

/**
 * Extracts optional subagent_type ([A-Za-z0-9_-]{2,60}) from decoded metadata text.
 * @param {string} text
 * @returns {string|null}
 */
export function extractSubagentType(text) {
  if (!text) return null;

  const textMatch = text.match(SUBAGENT_TYPE_TEXT_REGEX);
  if (textMatch) {
    return textMatch[1] || textMatch[2] || textMatch[3] || null;
  }

  SUBAGENT_TYPE_PROTO_REGEX.lastIndex = 0;
  let protoMatch;
  while ((protoMatch = SUBAGENT_TYPE_PROTO_REGEX.exec(text)) !== null) {
    const declaredLen = protoMatch[1].charCodeAt(0);
    const candidate = protoMatch[2];
    if (candidate.length >= declaredLen && declaredLen >= 2) {
      const sliced = candidate.slice(0, declaredLen);
      if (/^[A-Za-z0-9_-]{2,60}$/.test(sliced)) {
        return sliced;
      }
    }
  }

  return null;
}

/**
 * Reads active conversation IDs from non-symlink `<id>.lock` files in sibling presence/.
 * @param {string} conversationsDir
 * @returns {Set<string>}
 */
export function readActiveLockIds(conversationsDir) {
  const { lockMap } = readPresenceLocks(conversationsDir, "TokenTracker SubagentTracker");
  return new Set(lockMap.keys());
}

/**
 * Inspects a candidate SQLite database read-only to extract metadata from gen_metadata
 * tail (4096 bytes) and trajectory_metadata_blob fallback.
 * @param {string} dbPath
 * @param {string|null} [targetRootId=null]
 * @returns {{ matched: boolean, rootConversationId: string|null, subagentType: string|null }}
 */
export function inspectDatabaseMetadata(dbPath, targetRootId = null) {
  let db = null;
  let matchedRoot = false;
  let rootConversationId = null;
  let subagentType = null;

  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("PRAGMA schema_version").get();

    const inspectText = (text) => {
      if (targetRootId && !matchedRoot) {
        matchedRoot = matchesRootConversationId(text, targetRootId);
      }
      if (!rootConversationId) {
        rootConversationId = extractRootConversationId(text);
      }
      if (!subagentType) {
        subagentType = extractSubagentType(text);
      }
    };

    try {
      const genRow = db.prepare("SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT 1").get();
      if (genRow && genRow.data) {
        const genBuf = Buffer.from(genRow.data);
        const tail = genBuf.length > GEN_METADATA_TAIL_BYTES
          ? genBuf.subarray(genBuf.length - GEN_METADATA_TAIL_BYTES)
          : genBuf;
        inspectText(toLatin1Text(tail));
      }
    } catch (err) {
      if (!err.message?.includes("no such table")) {
        throw err;
      }
    }

    const needMore = targetRootId ? (!matchedRoot || !subagentType) : (!rootConversationId || !subagentType);
    if (needMore) {
      try {
        const trajRow = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get();
        if (trajRow && trajRow.data) {
          inspectText(toLatin1Text(Buffer.from(trajRow.data)));
        }
      } catch (err) {
        if (!err.message?.includes("no such table")) {
          throw err;
        }
      }
    }
  } finally {
    if (db) {
      try {
        db.close();
      } catch (closeErr) {
        console.error(`[TokenTracker SubagentTracker] Error closing database (${dbPath}): ${closeErr.message}`);
      }
    }
  }

  return {
    matched: targetRootId ? matchedRoot : Boolean(rootConversationId),
    rootConversationId: targetRootId && matchedRoot ? targetRootId : rootConversationId,
    subagentType
  };
}

/**
 * Discovers child subagent conversations linked to a root conversation ID.
 * @param {Object} options
 * @param {string} options.rootConversationId
 * @param {string} [options.conversationsDir]
 * @param {boolean} [options.activeOnly=false]
 * @param {number} [options.maxScan=100]
 * @param {ConversationTracker|null} [options.tracker=null]
 * @param {Map<string, Object>|Object|null} [options.cascadeStatuses=null]
 * @param {number} [options.activeRecencyMs=120000]
 * @returns {{ subagents: Array<Object>, scannedCount: number, activeCount: number }}
 */
export function findSubagentConversations(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("findSubagentConversations options must be a plain object.");
  }

  const {
    rootConversationId,
    conversationsDir,
    activeOnly = false,
    maxScan = DEFAULT_MAX_SCAN,
    tracker = null,
    cascadeStatuses = null,
    activeRecencyMs = DEFAULT_ACTIVE_RECENCY_MS
  } = options;

  const rootId = validateSafeConversationId(rootConversationId, "rootConversationId");

  if (typeof activeOnly !== "boolean") {
    throw new TypeError("activeOnly must be a boolean.");
  }
  const safeMaxScan = validatePositiveInt(maxScan, "maxScan");
  const safeActiveRecencyMs = validatePositiveInt(activeRecencyMs, "activeRecencyMs");
  const normalizedCascadeStatuses = validateCascadeStatuses(cascadeStatuses);

  if (tracker !== null && tracker !== undefined) {
    if (typeof tracker !== "object" || typeof tracker.getConversationMetrics !== "function") {
      throw new TypeError("tracker must be a ConversationTracker instance with getConversationMetrics().");
    }
  }

  let resolvedDir;
  if (conversationsDir !== undefined && conversationsDir !== null) {
    if (typeof conversationsDir !== "string" || !conversationsDir.trim()) {
      throw new TypeError("conversationsDir must be a non-empty string when provided.");
    }
    resolvedDir = path.resolve(conversationsDir);
  } else {
    const defaultDir = tracker?.conversationsDir || path.join(os.homedir(), ".gemini", "antigravity", "conversations");
    resolvedDir = path.resolve(defaultDir);
  }

  if (!fs.existsSync(resolvedDir)) {
    return { subagents: [], scannedCount: 0, activeCount: 0 };
  }
  if (!fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`conversationsDir is not a directory: ${resolvedDir}`);
  }

  const realResolvedDir = fs.realpathSync(resolvedDir);
  const effectiveTracker = tracker || new ConversationTracker({ conversationsDir: resolvedDir });
  const { lockMap } = readPresenceLocks(resolvedDir, "TokenTracker SubagentTracker");
  const nowMs = Date.now();
  const rootDbName = `${rootId}.db`;
  const isWin = process.platform === "win32";

  const rawFiles = fs.readdirSync(resolvedDir).filter((file) => {
    if (!file.endsWith(".db") || file.includes("-shm") || file.includes("-wal")) {
      return false;
    }
    return isWin ? file.toLowerCase() !== rootDbName.toLowerCase() : file !== rootDbName;
  });

  const candidates = [];
  for (const file of rawFiles) {
    const rawSubId = file.slice(0, -3);
    let subId;
    try {
      subId = validateSafeConversationId(rawSubId, "subagentConversationId");
    } catch (err) {
      console.error(`[TokenTracker SubagentTracker] Skipping unsafe database filename "${file}": ${err.message}`);
      continue;
    }

    const dbPath = path.join(resolvedDir, file);
    const verified = verifyConfinedRegularFile(dbPath, realResolvedDir);
    if (!verified) continue;

    const hasLock = lockMap.has(subId);
    const lockMtimeMs = hasLock ? lockMap.get(subId) : 0;
    const walMtimeMs = normalizedCascadeStatuses === null && hasLock
      ? getWalMtimeMs(resolvedDir, realResolvedDir, subId)
      : 0;

    candidates.push({
      subId,
      dbPath: verified.realPath,
      mtimeMs: verified.mtimeMs,
      isActive: resolveConversationActiveState({
        conversationId: subId,
        cascadeStatuses: normalizedCascadeStatuses,
        hasLock,
        lockMtimeMs,
        dbMtimeMs: verified.mtimeMs,
        walMtimeMs,
        activeRecencyMs: safeActiveRecencyMs,
        nowMs
      })
    });
  }

  // Prioritize active agents so they are always included within maxScan, then newest mtimeMs
  candidates.sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return b.mtimeMs - a.mtimeMs;
  });

  const boundedCandidates = candidates.slice(0, safeMaxScan);
  const subagents = [];
  let scannedCount = 0;

  for (const candidate of boundedCandidates) {
    if (activeOnly && !candidate.isActive) {
      continue;
    }

    scannedCount += 1;
    let inspection;
    try {
      inspection = inspectDatabaseMetadata(candidate.dbPath, rootId);
    } catch (err) {
      console.error(`[TokenTracker SubagentTracker] Non-fatal error inspecting "${candidate.subId}": ${err.message}`);
      continue;
    }

    const cascadeEntry = getCascadeEntry(normalizedCascadeStatuses, candidate.subId);
    const cascadeLinked = Boolean(
      cascadeEntry &&
      (cascadeEntry.rootConversationId === rootId || cascadeEntry.parentConversationId === rootId)
    );
    if (!inspection.matched && !cascadeLinked) {
      continue;
    }

    let metrics;
    try {
      metrics = effectiveTracker.getConversationMetrics(candidate.subId, { strict: true });
    } catch (err) {
      console.error(`[TokenTracker SubagentTracker] Non-fatal error reading metrics for "${candidate.subId}": ${err.message}`);
      continue;
    }

    subagents.push({
      conversationId: candidate.subId,
      rootConversationId: rootId,
      subagentType: inspection.subagentType || cascadeEntry?.subagentType || null,
      isActive: candidate.isActive,
      lastUpdatedAt: new Date(candidate.mtimeMs).toISOString(),
      metrics
    });
  }

  const activeCount = subagents.filter((entry) => entry.isActive).length;
  return { subagents, scannedCount, activeCount };
}
