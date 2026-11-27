/**
 * `token_tracker_status` Tool Schema, Validation, and Execution Handler.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationTracker } from "../lib/conversation-tracker.js";
import { applyModelUsageMetrics } from "../lib/compaction.js";
import { QuotaService } from "../lib/quota-service.js";
import {
  findSubagentConversations,
  validateSafeConversationId,
  verifyConfinedRegularFile
} from "../lib/subagent-tracker.js";
import { formatStatusReport } from "./format.js";

export const VALID_FORMATS = new Set(["markdown", "json"]);

export const TOOL_DEFINITIONS = [
  {
    name: "token_tracker_status",
    description:
      "Inspect current conversation token usage, prompt cache hit ratio, model-aware compaction headroom, optional Language Server quota summary, and optional child subagent telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Target conversation ID (defaults to current session)."
        },
        includeSubagents: {
          type: "boolean",
          description: "Also return telemetry for child subagents of the target conversation (default: false)."
        },
        activeOnly: {
          type: "boolean",
          description: "When includeSubagents is true, filter to subagents with active .lock files (default: false)."
        },
        includeQuota: {
          type: "boolean",
          description: "Also include Language Server 5-hour & weekly quota summary (default: false)."
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format (default: markdown)."
        }
      }
    }
  }
];

/**
 * Checks whether a value is a non-null, non-array plain object.
 * @param {*} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads an optional boolean property from an object, throwing TypeError on invalid types.
 * @param {Object} obj
 * @param {string} key
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function readOptionalBoolean(obj, key, defaultValue) {
  if (obj[key] === undefined) {
    return defaultValue;
  }
  if (typeof obj[key] !== "boolean") {
    throw new TypeError(`${key} must be a boolean.`);
  }
  return obj[key];
}

/**
 * Reads the last recorded active conversation ID from active_conversation.json.
 * @param {string} pluginDataDir
 * @returns {string|null}
 */
export function readActiveConversationId(pluginDataDir) {
  const resolvedDir = path.resolve(pluginDataDir);
  if (!fs.existsSync(resolvedDir)) {
    return null;
  }

  let realDir;
  try {
    realDir = fs.realpathSync(resolvedDir);
  } catch (err) {
    console.error(`[TokenTracker MCP] Failed resolving pluginDataDir: ${err.message}`);
    return null;
  }

  const stateFile = path.join(resolvedDir, "active_conversation.json");
  const verified = verifyConfinedRegularFile(stateFile, realDir);
  if (!verified) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(verified.realPath, "utf8"));
    if (typeof parsed?.conversationId === "string" && parsed.conversationId.trim().length > 0) {
      return validateSafeConversationId(parsed.conversationId, "activeConversationId");
    }
  } catch (err) {
    console.error(`[TokenTracker MCP] Failed to parse active_conversation.json: ${err.message}`);
  }
  return null;
}

/**
 * Resolves the target conversation ID using strict precedence:
 * args.conversationId -> params._meta.conversationId -> params._meta.sessionId ->
 * initialize sessionId -> ANTIGRAVITY_CONVERSATION_ID -> CONVERSATION_ID ->
 * active_conversation.json -> null.
 * @param {Object} [options]
 * @returns {string|null}
 */
export function resolveTargetConversationId({
  args = {},
  params = {},
  initSessionId = null,
  env = process.env,
  pluginDataDir = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "token-tracker")
} = {}) {
  const candidates = [
    args?.conversationId,
    params?._meta?.conversationId,
    params?._meta?.sessionId,
    initSessionId,
    env?.ANTIGRAVITY_CONVERSATION_ID,
    env?.CONVERSATION_ID
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return readActiveConversationId(pluginDataDir);
}

/**
 * Strictly validates and normalizes arguments for `token_tracker_status`.
 * @param {*} rawArgs
 * @returns {{ conversationId: string|undefined, includeSubagents: boolean, activeOnly: boolean, includeQuota: boolean, format: "markdown"|"json" }}
 */
export function validateStatusArguments(rawArgs = {}) {
  if (!isPlainObject(rawArgs)) {
    throw new TypeError("arguments must be a plain object.");
  }

  const conversationId = rawArgs.conversationId !== undefined
    ? validateSafeConversationId(rawArgs.conversationId, "conversationId")
    : undefined;

  const includeSubagents = readOptionalBoolean(rawArgs, "includeSubagents", false);
  const activeOnly = readOptionalBoolean(rawArgs, "activeOnly", false);
  const includeQuota = readOptionalBoolean(rawArgs, "includeQuota", false);

  let format = "markdown";
  if (rawArgs.format !== undefined) {
    if (typeof rawArgs.format !== "string" || !VALID_FORMATS.has(rawArgs.format)) {
      throw new RangeError('format must be either "markdown" or "json".');
    }
    format = rawArgs.format;
  }

  return {
    conversationId,
    includeSubagents,
    activeOnly,
    includeQuota,
    format
  };
}

/**
 * Executes `token_tracker_status` and returns formatted text and raw report data.
 * @param {Object} validatedArgs
 * @param {Object} [context]
 * @returns {Promise<{ text: string, report: Object }>}
 */
export async function executeTokenTrackerStatus(validatedArgs, {
  params = {},
  initSessionId = null,
  env = process.env,
  tracker = new ConversationTracker(),
  quotaService = new QuotaService(),
  pluginDataDir = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "token-tracker")
} = {}) {
  const resolvedConvId = resolveTargetConversationId({
    args: validatedArgs,
    params,
    initSessionId,
    env,
    pluginDataDir
  });

  const safeConvId = resolvedConvId !== null
    ? validateSafeConversationId(resolvedConvId, "conversationId")
    : null;

  let metrics = tracker.getConversationMetrics(safeConvId, { strict: Boolean(safeConvId) });

  let subagentReport = null;
  if (validatedArgs.includeSubagents) {
    subagentReport = findSubagentConversations({
      rootConversationId: metrics.conversationId,
      conversationsDir: tracker.conversationsDir,
      activeOnly: validatedArgs.activeOnly,
      tracker
    });
  }

  const canFetchUsage = typeof quotaService?.getCascadeUsage === "function";
  const mainUsagePromise = metrics?.conversationId && canFetchUsage
    ? quotaService.getCascadeUsage(metrics.conversationId, metrics.stepCount, false).catch(() => null)
    : Promise.resolve(null);

  let quota = null;
  let quotaError = null;
  const quotaPromise = validatedArgs.includeQuota
    ? quotaService.getQuotaSummary(false).catch((err) => {
        quotaError = err?.message || String(err);
        console.error(`[TokenTracker MCP] Quota retrieval non-fatal error: ${quotaError}`);
        return null;
      })
    : Promise.resolve(null);

  let mainUsage = null;
  [quota, mainUsage] = await Promise.all([quotaPromise, mainUsagePromise]);
  if (metrics && mainUsage) {
    metrics = applyModelUsageMetrics(metrics, mainUsage, tracker?.compactionThresholdBytes ?? null);
  }

  if (canFetchUsage && subagentReport?.subagents?.length > 0) {
    await Promise.all(
      subagentReport.subagents.map(async (sub) => {
        if (!sub?.conversationId || !sub?.metrics) return;
        const subUsage = await quotaService
          .getCascadeUsage(sub.conversationId, sub.metrics.stepCount, false)
          .catch(() => null);
        if (subUsage) {
          sub.metrics = applyModelUsageMetrics(sub.metrics, subUsage, tracker?.compactionThresholdBytes ?? null);
        }
      })
    );
  }

  const report = {
    metrics,
    includeQuota: validatedArgs.includeQuota,
    quota,
    quotaError,
    includeSubagents: validatedArgs.includeSubagents,
    subagentReport,
    activeOnly: validatedArgs.activeOnly
  };

  return {
    text: formatStatusReport(report, validatedArgs.format),
    report
  };
}
