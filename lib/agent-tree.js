/**
 * Active Agent Tree Discovery.
 * Uses live Language Server cascade run statuses (with recent .db/.db-wal/.lock fallback
 * when offline) to build a condensed root -> active subagent tree with context, cache,
 * and compaction telemetry.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConversationTracker } from "./conversation-tracker.js";
import { inspectDatabaseMetadata } from "./subagent-tracker.js";
import { DEFAULT_CONTEXT_WINDOW } from "./models.js";
import {
  DEFAULT_ACTIVE_RECENCY_MS,
  validateSafeConversationId,
  validatePositiveInt,
  verifyConfinedRegularFile,
  validateCascadeStatuses,
  getCascadeEntry,
  listCascadeEntries,
  readPresenceLocks,
  getWalMtimeMs,
  readConversationTitleMap,
  resolveConversationActiveState
} from "./active-status.js";

const DEFAULT_TREE_MAX_SCAN = 50;
const MAX_ANCESTOR_DEPTH = 16;

/**
 * Validates and normalizes an optional conversation ID, returning null if missing or unsafe.
 * @param {*} rawId
 * @param {string} label
 * @returns {string|null}
 */
function normalizeOptionalSafeId(rawId, label) {
  if (typeof rawId !== "string" || !rawId.trim()) {
    return null;
  }
  try {
    return validateSafeConversationId(rawId, label);
  } catch (err) {
    console.error(`[TokenTracker AgentTree] Skipping unsafe ${label} "${rawId}": ${err.message}`);
    return null;
  }
}

/**
 * Formats a conversation's metrics into a condensed UI tree node.
 * @param {Object} params
 * @returns {Object}
 */
function buildCondensedNode({
  conversationId,
  rootConversationId,
  conversationName,
  subagentType,
  subagentName,
  isCurrent,
  isActive,
  runState,
  lastActivityAt,
  lastUpdatedAt,
  metrics
}) {
  const shortId = conversationId.length > 8 ? conversationId.slice(0, 8) : conversationId;
  const comp = metrics.compaction || {};
  const cache = metrics.cache || {};
  const resolvedUpdatedAt = lastUpdatedAt || metrics.lastModified || null;
  return {
    conversationId,
    shortId,
    rootConversationId: rootConversationId || null,
    conversationName: conversationName || null,
    subagentType: subagentType || null,
    subagentName: subagentName || null,
    isCurrent: Boolean(isCurrent),
    isActive: Boolean(isActive),
    runState: runState || (isActive ? "running" : "idle"),
    lastActivityAt: lastActivityAt || resolvedUpdatedAt || null,
    stepCount: metrics.stepCount || 0,
    lastUpdatedAt: resolvedUpdatedAt,
    modelId: metrics.model?.id || null,
    modelName: metrics.model?.displayName || "Unknown",
    maxTokens: metrics.model?.maxTokens || DEFAULT_CONTEXT_WINDOW,
    compactionTokens: metrics.model?.compactionTokens ?? null,
    cumulativeHistoryBytes: comp.cumulativeHistoryBytes ?? 0,
    currentTokensFormatted: metrics.contextWindow?.currentTokensFormatted || "0",
    maxTokensFormatted: metrics.contextWindow?.maxTokensFormatted || "1.05M",
    percentUsed: metrics.contextWindow?.percentUsed ?? 0,
    cachedTokensFormatted: cache.cachedTokensFormatted || "0",
    totalCacheTokensFormatted: cache.totalTokensFormatted || metrics.contextWindow?.currentTokensFormatted || "0",
    hitRatioPercent: cache.hitRatioPercent ?? 0,
    activeTokensFormatted: comp.activeTokensFormatted || null,
    thresholdTokensFormatted: comp.thresholdTokensFormatted || null,
    trajectoryKb: comp.trajectoryKb ?? 0,
    thresholdKb: comp.thresholdKb ?? 0,
    tokensRemainingFormatted: comp.tokensRemainingFormatted || null,
    kbRemaining: comp.kbRemaining ?? 0,
    percentCompacted: comp.percentCompacted ?? 0,
    isNearCompaction: Boolean(comp.isNearCompaction),
    children: []
  };
}

/**
 * Inspects a single conversation ID safely and returns a condensed node or null on error.
 * @param {string} conversationId
 * @param {Object} context
 * @returns {Object|null}
 */
function loadConversationNode(conversationId, {
  resolvedDir,
  realResolvedDir,
  lockMap,
  cascadeStatuses,
  titleMap,
  activeRecencyMs,
  nowMs,
  currentId,
  tracker
}) {
  const dbPath = path.join(resolvedDir, `${conversationId}.db`);
  const verified = verifyConfinedRegularFile(dbPath, realResolvedDir);
  if (!verified) {
    return null;
  }

  let metadata;
  try {
    metadata = inspectDatabaseMetadata(verified.realPath, null);
  } catch (err) {
    console.error(`[TokenTracker AgentTree] Non-fatal error inspecting "${conversationId}": ${err.message}`);
    return null;
  }

  let metrics;
  try {
    metrics = tracker.getConversationMetrics(conversationId, { strict: true });
  } catch (err) {
    console.error(`[TokenTracker AgentTree] Non-fatal error reading metrics for "${conversationId}": ${err.message}`);
    return null;
  }

  const cascadeEntry = getCascadeEntry(cascadeStatuses, conversationId);
  const candidateRoots = [
    metadata.rootConversationId,
    cascadeEntry?.rootConversationId,
    cascadeEntry?.parentConversationId
  ];
  let normalizedRoot = null;
  for (const candidate of candidateRoots) {
    const safeCandidate = normalizeOptionalSafeId(candidate, "rootConversationId");
    if (safeCandidate && safeCandidate !== conversationId) {
      normalizedRoot = safeCandidate;
      break;
    }
  }
  const hasLock = lockMap.has(conversationId);
  const lockMtimeMs = hasLock ? lockMap.get(conversationId) : 0;
  const walMtimeMs = getWalMtimeMs(resolvedDir, realResolvedDir, conversationId);
  const latestMtimeMs = Math.max(verified.mtimeMs, walMtimeMs);

  const isActive = resolveConversationActiveState({
    conversationId,
    cascadeStatuses,
    hasLock,
    lockMtimeMs,
    dbMtimeMs: verified.mtimeMs,
    walMtimeMs,
    activeRecencyMs,
    nowMs
  });

  const cascadeTitle = typeof cascadeEntry?.title === "string" && cascadeEntry.title.trim()
    ? cascadeEntry.title.trim()
    : null;
  const dbTitle = titleMap instanceof Map ? (titleMap.get(conversationId) || null) : null;
  const subagentName = typeof cascadeEntry?.subagentRole === "string" && cascadeEntry.subagentRole.trim()
    ? cascadeEntry.subagentRole.trim()
    : null;
  const lastUpdatedAt = latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null;
  const isCascadeRunning = Boolean(cascadeEntry?.isRunning);
  const isError = !isCascadeRunning && cascadeEntry?.latestTerminationReason === "EXECUTOR_TERMINATION_REASON_ERROR";
  const isRunning = isCascadeRunning || (isActive && !isError);
  const runState = isError ? "error" : isRunning ? "running" : "idle";
  const lastActivityAt = cascadeEntry?.lastModifiedTime || lastUpdatedAt;

  return buildCondensedNode({
    conversationId,
    rootConversationId: normalizedRoot,
    conversationName: cascadeTitle || dbTitle || null,
    subagentType: metadata.subagentType || cascadeEntry?.subagentType || null,
    subagentName,
    isCurrent: Boolean(currentId && conversationId === currentId),
    isActive,
    runState,
    lastActivityAt,
    lastUpdatedAt,
    metrics
  });
}

/**
 * Builds a condensed tree of active main and subagent conversations.
 * @param {Object} [options]
 * @param {string} [options.conversationsDir]
 * @param {string|null} [options.currentConversationId=null]
 * @param {number} [options.maxScan=50]
 * @param {ConversationTracker|null} [options.tracker=null]
 * @param {Map<string, Object>|Object|null} [options.cascadeStatuses=null]
 * @param {number} [options.activeRecencyMs=120000]
 * @returns {{ roots: Array<Object>, totalActiveCount: number, mainCount: number, subagentCount: number }}
 */
export function findActiveAgentTree(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("findActiveAgentTree options must be a plain object.");
  }

  const {
    conversationsDir,
    currentConversationId = null,
    maxScan = DEFAULT_TREE_MAX_SCAN,
    tracker = null,
    cascadeStatuses = null,
    activeRecencyMs = DEFAULT_ACTIVE_RECENCY_MS
  } = options;

  const safeMaxScan = validatePositiveInt(maxScan, "maxScan");
  const safeActiveRecencyMs = validatePositiveInt(activeRecencyMs, "activeRecencyMs");
  const normalizedCascadeStatuses = validateCascadeStatuses(cascadeStatuses);

  let currentId = null;
  if (currentConversationId !== null && currentConversationId !== undefined) {
    if (typeof currentConversationId !== "string") {
      throw new TypeError("currentConversationId must be a string or null.");
    }
    if (currentConversationId.trim().length > 0) {
      currentId = validateSafeConversationId(currentConversationId, "currentConversationId");
    }
  }

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
    return { roots: [], totalActiveCount: 0, mainCount: 0, subagentCount: 0 };
  }
  if (!fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`conversationsDir is not a directory: ${resolvedDir}`);
  }

  const realResolvedDir = fs.realpathSync(resolvedDir);
  const effectiveTracker = tracker || new ConversationTracker({ conversationsDir: resolvedDir });
  const { entries: lockEntries, lockMap } = readPresenceLocks(resolvedDir, "TokenTracker AgentTree");
  const nowMs = Date.now();

  const candidateIds = new Set();
  if (currentId) {
    candidateIds.add(currentId);
  }

  if (normalizedCascadeStatuses !== null) {
    for (const [rawId, entry] of listCascadeEntries(normalizedCascadeStatuses)) {
      if (candidateIds.size >= safeMaxScan) break;
      if (!entry || entry.isIdle !== false) continue;
      try {
        candidateIds.add(validateSafeConversationId(rawId, "cascadeConversationId"));
      } catch (err) {
        console.error(`[TokenTracker AgentTree] Skipping unsafe cascade ID "${rawId}": ${err.message}`);
      }
    }
  } else {
    for (const lock of lockEntries.slice(0, safeMaxScan)) {
      candidateIds.add(lock.id);
    }
  }

  const antigravityRootDir = path.dirname(resolvedDir);
  const idsNeedingTitle = [];
  for (const id of candidateIds) {
    const entry = getCascadeEntry(normalizedCascadeStatuses, id);
    const hasCascadeTitle = typeof entry?.title === "string" && entry.title.trim().length > 0;
    if (!hasCascadeTitle) {
      idsNeedingTitle.push(id);
    }
  }
  const titleMap = idsNeedingTitle.length > 0
    ? readConversationTitleMap(antigravityRootDir, idsNeedingTitle)
    : new Map();

  const loadCtx = {
    resolvedDir,
    realResolvedDir,
    lockMap,
    cascadeStatuses: normalizedCascadeStatuses,
    titleMap,
    activeRecencyMs: safeActiveRecencyMs,
    nowMs,
    currentId,
    tracker: effectiveTracker
  };

  const nodeMap = new Map();
  for (const id of candidateIds) {
    const node = loadConversationNode(id, loadCtx);
    if (node) {
      nodeMap.set(id, node);
    }
  }

  // Strictly prune idle subagents first
  const activeSubagents = [];
  for (const [id, node] of nodeMap.entries()) {
    if (node.rootConversationId) {
      if (!node.isActive) {
        nodeMap.delete(id);
      } else {
        activeSubagents.push(node);
      }
    }
  }

  // Walk ancestor chains for active subagents up to the true main root (avoiding idle intermediate promotion)
  const activeParentIds = new Set();
  for (const subNode of activeSubagents) {
    const visited = new Set([subNode.conversationId]);
    let curParentId = subNode.rootConversationId;
    let topMainId = null;
    let nearestActiveAncestorId = null;

    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && curParentId; depth += 1) {
      const safeParentId = normalizeOptionalSafeId(curParentId, "rootConversationId");
      if (!safeParentId || visited.has(safeParentId)) break;
      visited.add(safeParentId);

      if (!nodeMap.has(safeParentId)) {
        const parentNode = loadConversationNode(safeParentId, loadCtx);
        if (parentNode) {
          nodeMap.set(parentNode.conversationId, parentNode);
        }
      }

      const parentNode = nodeMap.get(safeParentId);
      if (!parentNode) break;

      if (!parentNode.rootConversationId) {
        topMainId = parentNode.conversationId;
        break;
      }
      if (parentNode.isActive && !nearestActiveAncestorId) {
        nearestActiveAncestorId = parentNode.conversationId;
      }
      curParentId = parentNode.rootConversationId;
    }

    const resolvedParentId = topMainId || nearestActiveAncestorId;
    if (resolvedParentId) {
      subNode.rootConversationId = resolvedParentId;
      activeParentIds.add(resolvedParentId);
    } else {
      subNode.rootConversationId = null;
    }
  }

  // Prune any idle intermediate subagents pulled in during ancestor traversal, plus inactive unowned main agents
  for (const [id, node] of nodeMap.entries()) {
    if (node.rootConversationId) {
      if (!node.isActive) {
        nodeMap.delete(id);
      }
    } else {
      const keepMain = node.isCurrent || node.isActive || activeParentIds.has(id);
      if (!keepMain) {
        nodeMap.delete(id);
      }
    }
  }

  const missingTitleIds = [...nodeMap.values()]
    .filter((n) => !n.rootConversationId && !n.conversationName)
    .map((n) => n.conversationId);
  if (missingTitleIds.length > 0) {
    const extraTitles = readConversationTitleMap(antigravityRootDir, missingTitleIds);
    for (const [id, title] of extraTitles.entries()) {
      const node = nodeMap.get(id);
      if (node) node.conversationName = title;
    }
  }

  const roots = [];
  for (const node of nodeMap.values()) {
    if (node.rootConversationId && nodeMap.has(node.rootConversationId)) {
      nodeMap.get(node.rootConversationId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const compareDescIso = (aIso, bIso) => (bIso || "").localeCompare(aIso || "");

  for (const root of roots) {
    root.children.sort((a, b) => compareDescIso(a.lastUpdatedAt, b.lastUpdatedAt));
  }

  roots.sort((a, b) => {
    const aHasCurrent = a.isCurrent || a.children.some((c) => c.isCurrent);
    const bHasCurrent = b.isCurrent || b.children.some((c) => c.isCurrent);
    if (aHasCurrent !== bHasCurrent) {
      return aHasCurrent ? -1 : 1;
    }
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return compareDescIso(a.lastUpdatedAt, b.lastUpdatedAt);
  });

  let totalActiveCount = 0;
  let subagentCount = 0;
  for (const root of roots) {
    if (root.isActive) totalActiveCount += 1;
    for (const child of root.children) {
      subagentCount += 1;
      if (child.isActive) totalActiveCount += 1;
    }
  }

  return {
    roots,
    totalActiveCount,
    mainCount: roots.length,
    subagentCount
  };
}
