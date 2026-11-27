/**
 * Sidecar Telemetry Payload Builder.
 * Collects live conversation metrics, Connect-RPC usage & quota telemetry,
 * and enriched active agent trees for the Native Aux Pane dashboard.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildCompactionMetrics } from "../../lib/conversation-tracker.js";
import { applyModelUsageMetrics, applyModelUsageToTreeNode } from "../../lib/compaction.js";
import { DEFAULT_CONTEXT_WINDOW, getModelCompactionThreshold } from "../../lib/models.js";
import { findActiveAgentTree } from "../../lib/agent-tree.js";
import { getCascadeEntry } from "../../lib/active-status.js";

/**
 * Normalizes an optional conversation ID string.
 * @param {*} value
 * @returns {string|null}
 */
export function normalizeConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses the includeAgents boolean/query flag safely (defaults to true).
 * @param {*} value
 * @returns {boolean}
 */
export function parseIncludeAgentsFlag(value) {
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

function readPersistedActiveConversationId() {
  try {
    const activeFile = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "token-tracker", "active_conversation.json");
    if (fs.existsSync(activeFile)) {
      const parsed = JSON.parse(fs.readFileSync(activeFile, "utf8"));
      return normalizeConversationId(parsed.conversationId);
    }
  } catch {
    // Non-fatal state read
  }
  return null;
}

function findMatchingTreeNode(agentTree, resolvedConvId) {
  if (!agentTree?.roots) return null;
  for (const root of agentTree.roots) {
    if (root.conversationId === resolvedConvId) {
      return root;
    }
    if (Array.isArray(root.children)) {
      const childMatch = root.children.find((child) => child?.conversationId === resolvedConvId);
      if (childMatch) {
        return childMatch;
      }
    }
  }
  return null;
}

/**
 * Collects metrics, quotas, cascade states, and optional active agent tree into
 * a normalized dashboard API payload.
 * @param {Object} params
 * @param {import("../../lib/conversation-tracker.js").ConversationTracker} params.tracker
 * @param {import("../../lib/quota-service.js").QuotaService} params.quotaService
 * @param {string|null} [params.preferredConvId=null]
 * @param {boolean} [params.forceRefresh=false]
 * @param {boolean} [params.includeAgents=true]
 * @returns {Promise<Object>}
 */
export async function buildTelemetryPayload({
  tracker,
  quotaService,
  preferredConvId = null,
  forceRefresh = false,
  includeAgents = true
}) {
  const explicitConvId = normalizeConversationId(preferredConvId);
  const convId = explicitConvId || readPersistedActiveConversationId();

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
    ? quotaService.getCascadeUsage(metrics.conversationId, null, forceRefresh).catch(() => null)
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
              : await quotaService.getCascadeUsage(node.conversationId, null, forceRefresh).catch(() => null);
            if (usage) {
              applyModelUsageToTreeNode(node, usage, tracker.compactionThresholdBytes);
              if (usage.isWaitingForUser && node.runState !== "error") {
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
  const matchingNode = findMatchingTreeNode(agentTree, resolvedConvId);
  const conversationName = matchingNode?.conversationName || null;
  const cascadeEntry = resolvedConvId !== "unknown"
    ? getCascadeEntry(cascadeStatuses, resolvedConvId)
    : null;
  const subagentType = matchingNode?.subagentType || cascadeEntry?.subagentType || null;
  let resolvedRunState;
  if (matchingNode?.runState) {
    resolvedRunState = matchingNode.runState;
  } else {
    const isError = cascadeEntry?.latestTerminationReason === "EXECUTOR_TERMINATION_REASON_ERROR";
    const isWaiting = Boolean(mainUsage?.isWaitingForUser);
    const isRunning = Boolean(cascadeEntry?.isRunning);
    resolvedRunState = isError ? "error" : isWaiting ? "waiting" : isRunning ? "running" : "idle";
  }
  const lastActivityAt = matchingNode?.lastActivityAt || cascadeEntry?.lastModifiedTime || metrics?.lastModified || null;

  return {
    ok: Boolean(metrics || quota),
    timestamp: Date.now(),
    conversationId: resolvedConvId,
    ...(conversationName ? { conversationName } : {}),
    ...(subagentType ? { subagentType } : {}),
    runState: resolvedRunState,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    stepCount: metrics?.stepCount || 0,
    model: metrics?.model || {
      id: "gemini-3.8-flash-high",
      displayName: "Gemini 3.8 Flash (High)",
      maxTokens: DEFAULT_CONTEXT_WINDOW,
      compactionTokens: getModelCompactionThreshold("gemini-3.8-flash-high"),
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
    compaction: metrics?.compaction || buildCompactionMetrics(0, DEFAULT_CONTEXT_WINDOW, tracker.compactionThresholdBytes, 0, "gemini-3.8-flash-high"),
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
