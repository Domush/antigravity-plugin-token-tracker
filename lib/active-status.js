/**
 * Active / Idle Status & Path Confinement Helpers.
 * Shared by subagent-tracker.js and agent-tree.js to validate identifiers,
 * verify non-symlink regular files, and resolve live agent activity from Language
 * Server GetAllCascadeTrajectories statuses with recent file-activity fallback.
 */

import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_ACTIVE_RECENCY_MS = 120000;
const MAX_SQL_VARIABLES = 500;

/**
 * Validates that a conversation ID is a safe, non-empty identifier without path traversal.
 * @param {*} value
 * @param {string} [label="conversationId"]
 * @returns {string} Normalized conversation stem without trailing ".db".
 */
export function validateSafeConversationId(value, label = "conversationId") {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError(`${label} must be a non-empty string.`);
  }
  if (
    trimmed.includes("\0") ||
    /[/\\:]/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed === "." ||
    path.isAbsolute(trimmed)
  ) {
    throw new Error(`Invalid ${label}: path traversal, path separators, or absolute paths are not allowed.`);
  }

  const stem = trimmed.endsWith(".db") ? trimmed.slice(0, -3) : trimmed;
  if (!stem || stem === "." || stem === "..") {
    throw new Error(`Invalid ${label}: path traversal or empty stem is not allowed.`);
  }
  return stem;
}

/**
 * Validates a positive finite integer option.
 * @param {*} value
 * @param {string} label
 * @returns {number}
 */
export function validatePositiveInt(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${label} must be a positive finite integer.`);
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite integer (received ${value}).`);
  }
  return value;
}

/**
 * Verifies a path is a non-symlink regular file confined inside `realDir`.
 * Returns `{ realPath, mtimeMs }` or `null` when missing or unsafe.
 * @param {string} targetPath
 * @param {string} realDir
 * @returns {{ realPath: string, mtimeMs: number }|null}
 */
export function verifyConfinedRegularFile(targetPath, realDir) {
  let lstat;
  try {
    lstat = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    console.error(`[TokenTracker SubagentTracker] Skipping unreadable path (${targetPath}): ${err.message}`);
    return null;
  }

  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    console.error(`[TokenTracker SubagentTracker] Skipping symlink or non-file path: ${targetPath}`);
    return null;
  }

  let realPath;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch (err) {
    console.error(`[TokenTracker SubagentTracker] Failed resolving real path (${targetPath}): ${err.message}`);
    return null;
  }

  const realParent = path.dirname(realPath);
  const inBounds = process.platform === "win32"
    ? realParent.toLowerCase() === realDir.toLowerCase()
    : realParent === realDir;
  if (!inBounds) {
    console.error(`[TokenTracker SubagentTracker] Skipping path escaping directory bounds: ${targetPath}`);
    return null;
  }

  return { realPath, mtimeMs: lstat.mtimeMs };
}

/**
 * Returns true if value is a non-null plain object.
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates a finite non-negative number option.
 * @param {*} value
 * @param {string} label
 * @returns {number}
 */
function validateNonNegativeNumber(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${label} must be a finite non-negative number.`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number (received ${value}).`);
  }
  return value;
}

/**
 * Validates optional cascadeStatuses input (Map, plain object, or null/undefined).
 * @param {*} cascadeStatuses
 * @returns {Map<string, Object>|Object|null}
 */
export function validateCascadeStatuses(cascadeStatuses) {
  if (cascadeStatuses === null || cascadeStatuses === undefined) {
    return null;
  }
  if (cascadeStatuses instanceof Map) {
    return cascadeStatuses;
  }
  if (isPlainObject(cascadeStatuses)) {
    return cascadeStatuses;
  }
  throw new TypeError("cascadeStatuses must be a Map, plain object, or null.");
}

/**
 * Looks up a conversation entry in a Map or plain object cascadeStatuses structure.
 * @param {Map<string, Object>|Object|null} cascadeStatuses
 * @param {string} conversationId
 * @returns {Object|null}
 */
export function getCascadeEntry(cascadeStatuses, conversationId) {
  if (!cascadeStatuses || !conversationId) {
    return null;
  }
  if (cascadeStatuses instanceof Map) {
    return cascadeStatuses.get(conversationId) || null;
  }
  return Object.prototype.hasOwnProperty.call(cascadeStatuses, conversationId)
    ? cascadeStatuses[conversationId] || null
    : null;
}

/**
 * Iterates `[conversationId, entry]` pairs across a Map or plain object.
 * @param {Map<string, Object>|Object|null} cascadeStatuses
 * @returns {Array<[string, Object]>}
 */
export function listCascadeEntries(cascadeStatuses) {
  if (!cascadeStatuses) {
    return [];
  }
  if (cascadeStatuses instanceof Map) {
    return Array.from(cascadeStatuses.entries());
  }
  return Object.entries(cascadeStatuses);
}

/**
 * Reads active presence `.lock` files as sorted entries `{ id, mtimeMs }` (newest first).
 * @param {string} resolvedConversationsDir
 * @param {string} [logPrefix="TokenTracker"]
 * @returns {{ entries: Array<{ id: string, mtimeMs: number }>, lockMap: Map<string, number> }}
 */
export function readPresenceLocks(resolvedConversationsDir, logPrefix = "TokenTracker") {
  const entries = [];
  const lockMap = new Map();
  const parentDir = path.dirname(path.resolve(resolvedConversationsDir));
  const presenceDir = path.join(parentDir, "presence");

  let presenceLstat;
  try {
    presenceLstat = fs.lstatSync(presenceDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { entries, lockMap };
    }
    console.error(`[${logPrefix}] Failed inspecting presence directory (${presenceDir}): ${err.message}`);
    return { entries, lockMap };
  }

  if (presenceLstat.isSymbolicLink() || !presenceLstat.isDirectory()) {
    console.error(`[${logPrefix}] Skipping symlink or non-directory presence path: ${presenceDir}`);
    return { entries, lockMap };
  }

  let realParentDir;
  let realPresenceDir;
  try {
    realParentDir = fs.realpathSync(parentDir);
    realPresenceDir = fs.realpathSync(presenceDir);
  } catch (err) {
    console.error(`[${logPrefix}] Failed resolving presence directory (${presenceDir}): ${err.message}`);
    return { entries, lockMap };
  }

  const realPresenceParent = path.dirname(realPresenceDir);
  const inParentBounds = process.platform === "win32"
    ? realPresenceParent.toLowerCase() === realParentDir.toLowerCase()
    : realPresenceParent === realParentDir;
  if (!inParentBounds) {
    console.error(`[${logPrefix}] Skipping presence directory escaping parent bounds: ${presenceDir}`);
    return { entries, lockMap };
  }

  try {
    const files = fs.readdirSync(realPresenceDir);
    for (const file of files) {
      if (!file.endsWith(".lock")) continue;
      const verified = verifyConfinedRegularFile(path.join(realPresenceDir, file), realPresenceDir);
      if (!verified) continue;
      const rawId = file.slice(0, -5);
      try {
        const id = validateSafeConversationId(rawId, "lockConversationId");
        entries.push({ id, mtimeMs: verified.mtimeMs });
      } catch (err) {
        console.error(`[${logPrefix}] Skipping unsafe lock ID "${rawId}": ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[${logPrefix}] Failed reading presence directory (${realPresenceDir}): ${err.message}`);
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of entries) {
    lockMap.set(item.id, item.mtimeMs);
  }
  return { entries, lockMap };
}

/**
 * Safely returns the `.db-wal` modification time in milliseconds, or 0 if absent/unsafe.
 * @param {string} resolvedDir
 * @param {string} realResolvedDir
 * @param {string} conversationId
 * @returns {number}
 */
export function getWalMtimeMs(resolvedDir, realResolvedDir, conversationId) {
  const walPath = path.join(resolvedDir, `${conversationId}.db-wal`);
  const verified = verifyConfinedRegularFile(walPath, realResolvedDir);
  return verified ? verified.mtimeMs : 0;
}

/**
 * Safely reads conversation titles from `conversation_summaries.db` in read-only mode.
 * Chunks queries to stay safely below SQLite parameter limits and returns an empty Map
 * if the root directory, database, or table is missing or unsafe.
 * @param {string} antigravityRootDir
 * @param {Iterable<string>} ids
 * @returns {Map<string, string>}
 */
export function readConversationTitleMap(antigravityRootDir, ids) {
  const titleMap = new Map();
  if (!antigravityRootDir || typeof antigravityRootDir !== "string") {
    return titleMap;
  }

  const normalizedIds = [];
  const seen = new Set();
  for (const rawId of ids || []) {
    if (typeof rawId !== "string") continue;
    const trimmed = rawId.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalizedIds.push(trimmed);
  }
  if (normalizedIds.length === 0) {
    return titleMap;
  }

  let realRootDir;
  try {
    const rootLstat = fs.lstatSync(antigravityRootDir);
    if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
      return titleMap;
    }
    realRootDir = fs.realpathSync(antigravityRootDir);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error(`[TokenTracker AgentTree] Failed inspecting root dir (${antigravityRootDir}): ${err.message}`);
    }
    return titleMap;
  }

  const dbPath = path.join(realRootDir, "conversation_summaries.db");
  const verified = verifyConfinedRegularFile(dbPath, realRootDir);
  if (!verified) {
    return titleMap;
  }

  let db = null;
  try {
    db = new DatabaseSync(verified.realPath, { readOnly: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")
      .get();
    if (!hasTable) {
      return titleMap;
    }

    for (let offset = 0; offset < normalizedIds.length; offset += MAX_SQL_VARIABLES) {
      const batch = normalizedIds.slice(offset, offset + MAX_SQL_VARIABLES);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT conversation_id, title FROM conversation_summaries WHERE conversation_id IN (${placeholders})`)
        .all(...batch);
      for (const row of rows) {
        if (typeof row?.conversation_id === "string" && typeof row?.title === "string") {
          const trimmedTitle = row.title.trim();
          if (trimmedTitle) {
            titleMap.set(row.conversation_id, trimmedTitle);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[TokenTracker AgentTree] Non-fatal error reading conversation_summaries.db: ${err.message}`);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (closeErr) {
        console.error(`[TokenTracker AgentTree] Non-fatal error closing conversation_summaries.db: ${closeErr.message}`);
      }
    }
  }

  return titleMap;
}

/**
 * Determines whether a conversation is actively running or idle.
 * - When `cascadeStatuses` is provided: active iff present in `cascadeStatuses` and `!entry.isIdle`.
 * - When `cascadeStatuses` is null (LS offline): active iff `.lock` exists AND `.db`/`.db-wal`/`.lock`
 *   was modified within `activeRecencyMs` of `nowMs`.
 * @param {Object} params
 * @returns {boolean}
 */
export function resolveConversationActiveState(params) {
  if (!isPlainObject(params)) {
    throw new TypeError("params must be a plain object.");
  }

  const {
    conversationId,
    cascadeStatuses = null,
    hasLock = false,
    lockMtimeMs = 0,
    dbMtimeMs = 0,
    walMtimeMs = 0,
    activeRecencyMs = DEFAULT_ACTIVE_RECENCY_MS,
    nowMs = Date.now()
  } = params;

  const safeConversationId = validateSafeConversationId(conversationId, "conversationId");
  const normalizedCascadeStatuses = validateCascadeStatuses(cascadeStatuses);
  const safeActiveRecencyMs = validatePositiveInt(activeRecencyMs, "activeRecencyMs");
  if (typeof hasLock !== "boolean") {
    throw new TypeError("hasLock must be a boolean.");
  }
  const safeLockMtimeMs = validateNonNegativeNumber(lockMtimeMs, "lockMtimeMs");
  const safeDbMtimeMs = validateNonNegativeNumber(dbMtimeMs, "dbMtimeMs");
  const safeWalMtimeMs = validateNonNegativeNumber(walMtimeMs, "walMtimeMs");
  const safeNowMs = validateNonNegativeNumber(nowMs, "nowMs");

  if (normalizedCascadeStatuses !== null) {
    const entry = getCascadeEntry(normalizedCascadeStatuses, safeConversationId);
    if (!entry || entry.isIdle !== false) {
      return false;
    }
    if (typeof entry.status === "string") {
      const normalizedStatus = entry.status.trim();
      if (!normalizedStatus || normalizedStatus === "CASCADE_RUN_STATUS_IDLE" || normalizedStatus === "CASCADE_RUN_STATUS_UNSPECIFIED") {
        return false;
      }
    }
    return true;
  }

  if (!hasLock) {
    return false;
  }

  const latestMtimeMs = Math.max(safeDbMtimeMs, safeWalMtimeMs, safeLockMtimeMs);
  return latestMtimeMs > 0 && safeNowMs - latestMtimeMs <= safeActiveRecencyMs;
}
