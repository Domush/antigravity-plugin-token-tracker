/**
 * Active-Context Compaction Threshold & Headroom Calculations.
 * Validates explicit threshold overrides and computes active-context headroom
 * metrics relative to the active model's context window capacity.
 */

import {
  formatTokenCount,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_CAP_TOKENS,
  getModelCompactionThreshold,
  getModelContextWindow,
  normalizeModelName,
  detectModelGroup,
  hasCatalogMatch
} from "./models.js";

export const DEFAULT_COMPACTION_THRESHOLD_BYTES = 184320; // Legacy 180 KB constant retained for external callers
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.80; // 80% of active model context window
export const BYTES_PER_TOKEN = 4; // Standard character/byte heuristic for LLM tokens

/**
 * Validates that a numeric threshold value is a positive finite integer.
 * @param {number} value
 * @param {string} label
 * @returns {number}
 */
export function validatePositiveThresholdInteger(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${label} must be a positive finite integer.`);
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite integer (received ${value}).`);
  }
  return value;
}

/**
 * Validates and resolves an explicit compaction threshold override in bytes.
 * Returns null when no override is configured so callers derive the trigger dynamically
 * from the active model's context window.
 * @param {number|null|undefined} explicitValue
 * @returns {number|null}
 */
export function resolveCompactionThreshold(explicitValue) {
  if (explicitValue !== null && explicitValue !== undefined) {
    return validatePositiveThresholdInteger(explicitValue, "compactionThresholdBytes");
  }

  const envRaw = process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES;
  if (envRaw !== undefined && envRaw !== "") {
    const trimmed = envRaw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new RangeError(`Invalid ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES "${envRaw}": must be a positive finite integer.`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new RangeError(`Invalid ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES "${envRaw}": must be a positive finite integer.`);
    }
    return parsed;
  }

  return null;
}

/**
 * Computes active-context compaction headroom metrics relative to Antigravity's
 * per-model checkpointer limit (or an explicit byte threshold override when supplied).
 * @param {number} effectiveUsedBytes
 * @param {number} maxContextTokens
 * @param {number|null} [explicitThresholdBytes=null]
 * @param {number} [cumulativeHistoryBytes=0]
 * @param {string|number|null} [modelIdentifier=null]
 * @returns {Object}
 */
export function buildCompactionMetrics(
  effectiveUsedBytes,
  maxContextTokens,
  explicitThresholdBytes = null,
  cumulativeHistoryBytes = 0,
  modelIdentifier = null
) {
  const safeUsedBytes = Math.max(0, Number.isFinite(effectiveUsedBytes) ? effectiveUsedBytes : 0);
  const safeHistoryBytes = Math.max(0, Number.isFinite(cumulativeHistoryBytes) ? cumulativeHistoryBytes : 0);
  const safeMaxTokens = Number.isFinite(maxContextTokens) && maxContextTokens > 0
    ? maxContextTokens
    : DEFAULT_CONTEXT_WINDOW;
  let thresholdBytes;
  if (explicitThresholdBytes !== null && explicitThresholdBytes !== undefined) {
    thresholdBytes = validatePositiveThresholdInteger(explicitThresholdBytes, "explicitThresholdBytes");
  } else {
    let defaultThresholdTokens;
    if (typeof modelIdentifier === "number" && Number.isFinite(modelIdentifier) && modelIdentifier > 0) {
      defaultThresholdTokens = Math.round(modelIdentifier);
    } else if (typeof modelIdentifier === "string" && modelIdentifier.trim()) {
      defaultThresholdTokens = getModelCompactionThreshold(modelIdentifier);
    } else {
      defaultThresholdTokens = Math.min(
        DEFAULT_COMPACTION_CAP_TOKENS,
        Math.round(safeMaxTokens * DEFAULT_COMPACTION_TRIGGER_RATIO)
      );
    }
    thresholdBytes = defaultThresholdTokens * BYTES_PER_TOKEN;
  }

  const activeTokens = Math.max(0, Math.round(safeUsedBytes / BYTES_PER_TOKEN));
  const thresholdTokens = Math.max(0, Math.round(thresholdBytes / BYTES_PER_TOKEN));
  const tokensRemaining = Math.max(0, thresholdTokens - activeTokens);
  const trajectoryKb = parseFloat((safeUsedBytes / 1024).toFixed(1));
  const thresholdKb = Math.round(thresholdBytes / 1024);
  const bytesRemaining = Math.max(0, thresholdBytes - safeUsedBytes);
  const kbRemaining = Math.max(0, Math.round(bytesRemaining / 1024));
  const percentCompacted = thresholdBytes > 0 ? Math.min(100, Math.round((safeUsedBytes / thresholdBytes) * 100)) : 0;
  const isNearCompaction = percentCompacted >= 80 || (thresholdBytes <= 368640 && kbRemaining <= 35);

  return {
    trajectoryBytes: safeUsedBytes,
    trajectoryKb,
    cumulativeHistoryBytes: safeHistoryBytes,
    thresholdBytes,
    thresholdKb,
    bytesRemaining,
    kbRemaining,
    percentCompacted,
    isNearCompaction,
    activeTokens,
    thresholdTokens,
    tokensRemaining,
    activeTokensFormatted: formatTokenCount(activeTokens),
    thresholdTokensFormatted: formatTokenCount(thresholdTokens),
    tokensRemainingFormatted: formatTokenCount(tokensRemaining)
  };
}

/**
 * Enriches `currentModel` from `candidateModelId` only when `currentModel` fell back
 * or lacks a catalog match, and only when `candidateModelId` resolves to a catalog entry.
 * Never clobbers an already-detected catalog-matched model.
 * @param {Object|null|undefined} currentModel
 * @param {string|null|undefined} candidateModelId
 * @returns {Object|null|undefined}
 */
function resolveEnrichedModel(currentModel, candidateModelId) {
  if (typeof candidateModelId !== "string" || !candidateModelId.trim()) {
    return currentModel;
  }
  const hasCurrentCatalogMatch = Boolean(
    currentModel &&
    (hasCatalogMatch(currentModel.id) || hasCatalogMatch(currentModel.displayName))
  );
  const currentFellBack = !currentModel || !currentModel.id || currentModel.isFallback === true;
  if (!currentFellBack && hasCurrentCatalogMatch) {
    return currentModel;
  }
  if (!hasCatalogMatch(candidateModelId)) {
    return currentModel;
  }
  const normalizedId = candidateModelId.trim();
  return {
    id: normalizedId,
    displayName: normalizeModelName(normalizedId),
    maxTokens: getModelContextWindow(normalizedId),
    compactionTokens: getModelCompactionThreshold(normalizedId),
    group: detectModelGroup(normalizedId),
    isFallback: false
  };
}

/**
 * Applies exact Language Server `modelUsage` prompt/cache counts to a metrics object.
 * Falls back unchanged when `modelUsage` is absent or has non-positive total prompt tokens.
 * @param {Object} metrics
 * @param {Object|null|undefined} modelUsage
 * @param {number|null} [compactionThresholdBytes=null]
 * @returns {Object}
 */
export function applyModelUsageMetrics(metrics, modelUsage, compactionThresholdBytes = null) {
  if (!metrics || typeof metrics !== "object") {
    return metrics;
  }
  if (!modelUsage || typeof modelUsage !== "object") {
    return metrics;
  }
  if (!Number.isFinite(modelUsage.totalPromptTokens) || modelUsage.totalPromptTokens <= 0) {
    return metrics;
  }

  const cachedTokens = Math.max(0, Number.isFinite(modelUsage.cacheReadTokens) ? modelUsage.cacheReadTokens : 0);
  const inputTokens = Math.max(0, Number.isFinite(modelUsage.inputTokens) ? modelUsage.inputTokens : 0);
  const cacheCreationTokens = Math.max(0, Number.isFinite(modelUsage.cacheCreationTokens) ? modelUsage.cacheCreationTokens : 0);
  const uncachedTokens = inputTokens + cacheCreationTokens;
  const totalTokens = cachedTokens + uncachedTokens;
  if (totalTokens <= 0) {
    return metrics;
  }

  const resolvedModel = resolveEnrichedModel(metrics.model, modelUsage.model);
  const hitRatio = cachedTokens / totalTokens;
  const hitRatioPercent = parseFloat((hitRatio * 100).toFixed(1));
  const maxTokens = Number.isFinite(resolvedModel?.maxTokens) && resolvedModel.maxTokens > 0
    ? resolvedModel.maxTokens
    : DEFAULT_CONTEXT_WINDOW;
  const percentUsed = parseFloat(((totalTokens / maxTokens) * 100).toFixed(1));
  const contextBytes = totalTokens * BYTES_PER_TOKEN;
  const cumulativeHistoryBytes = metrics.compaction?.cumulativeHistoryBytes ?? 0;
  const modelHint = resolvedModel?.compactionTokens ?? resolvedModel?.id ?? resolvedModel?.displayName ?? null;
  const compaction = buildCompactionMetrics(
    contextBytes,
    maxTokens,
    compactionThresholdBytes,
    cumulativeHistoryBytes,
    modelHint
  );

  return {
    ...metrics,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    contextWindow: {
      ...(metrics.contextWindow || {}),
      currentTokens: totalTokens,
      maxTokens,
      percentUsed,
      contextBytes,
      currentTokensFormatted: formatTokenCount(totalTokens),
      maxTokensFormatted: formatTokenCount(maxTokens)
    },
    cache: {
      cachedTokens,
      uncachedTokens,
      totalTokens,
      hitRatio: parseFloat(hitRatio.toFixed(3)),
      hitRatioPercent,
      cachedTokensFormatted: formatTokenCount(cachedTokens),
      uncachedTokensFormatted: formatTokenCount(uncachedTokens),
      totalTokensFormatted: formatTokenCount(totalTokens)
    },
    compaction
  };
}

/**
 * Applies exact Language Server `modelUsage` metrics onto a condensed agent-tree node in-place.
 * @param {Object} node
 * @param {Object|null|undefined} modelUsage
 * @param {number|null} [compactionThresholdBytes=null]
 * @returns {Object}
 */
export function applyModelUsageToTreeNode(node, modelUsage, compactionThresholdBytes = null) {
  if (!node || typeof node !== "object" || !modelUsage) {
    return node;
  }
  if (!Number.isFinite(modelUsage.totalPromptTokens) || modelUsage.totalPromptTokens <= 0) {
    return node;
  }
  const maxTokens = Number.isFinite(node.maxTokens) && node.maxTokens > 0
    ? node.maxTokens
    : DEFAULT_CONTEXT_WINDOW;
  const enriched = applyModelUsageMetrics(
    {
      model: {
        id: node.modelId || node.modelName || null,
        maxTokens,
        compactionTokens: node.compactionTokens ?? null
      },
      contextWindow: {},
      cache: {},
      compaction: { cumulativeHistoryBytes: node.cumulativeHistoryBytes ?? 0 }
    },
    modelUsage,
    compactionThresholdBytes
  );
  if (!enriched?.contextWindow?.currentTokensFormatted) {
    return node;
  }
  node.currentTokensFormatted = enriched.contextWindow.currentTokensFormatted;
  node.maxTokensFormatted = enriched.contextWindow.maxTokensFormatted;
  node.percentUsed = enriched.contextWindow.percentUsed;
  node.cachedTokensFormatted = enriched.cache.cachedTokensFormatted;
  node.totalCacheTokensFormatted = enriched.cache.totalTokensFormatted;
  node.hitRatioPercent = enriched.cache.hitRatioPercent;
  node.activeTokensFormatted = enriched.compaction.activeTokensFormatted;
  node.thresholdTokensFormatted = enriched.compaction.thresholdTokensFormatted;
  node.trajectoryKb = enriched.compaction.trajectoryKb;
  node.thresholdKb = enriched.compaction.thresholdKb;
  node.tokensRemainingFormatted = enriched.compaction.tokensRemainingFormatted;
  node.kbRemaining = enriched.compaction.kbRemaining;
  node.percentCompacted = enriched.compaction.percentCompacted;
  node.isNearCompaction = enriched.compaction.isNearCompaction;
  return node;
}
