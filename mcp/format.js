/**
 * Output Formatting Utilities for `token_tracker_status`.
 * Formats conversation telemetry, quota summaries, and subagent status into
 * concise, high-signal Markdown or structured JSON.
 */

/**
 * Normalizes an optional display string, trimming whitespace and returning null when blank.
 * @param {*} value
 * @returns {string|null}
 */
function normalizeDisplayText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Formats a concise, high-signal markdown summary for `token_tracker_status`.
 * @param {Object} report
 * @returns {string}
 */
export function formatStatusMarkdown(report) {
  const { metrics, quota, quotaError, subagentReport, activeOnly } = report;
  const comp = metrics.compaction;
  const convName = normalizeDisplayText(metrics.conversationName);
  const convLabel = convName
    ? `${convName} (\`${metrics.conversationId}\`)`
    : `\`${metrics.conversationId}\``;
  const lines = [
    `### Token Tracker Status (${convLabel})`,
    `- **Model**: ${metrics.model.displayName} (${metrics.contextWindow.maxTokensFormatted} max context)`,
    `- **Context**: ${metrics.contextWindow.currentTokensFormatted} / ${metrics.contextWindow.maxTokensFormatted} (${metrics.contextWindow.percentUsed}%)`,
    `- **Cache**: ${metrics.cache.hitRatioPercent}% hit (${metrics.cache.cachedTokensFormatted} cached / ${metrics.cache.uncachedTokensFormatted} uncached)`
  ];

  const alertSuffix = comp.isNearCompaction ? " — ⚠️ NEAR COMPACTION" : "";
  if (comp.tokensRemainingFormatted && comp.thresholdTokensFormatted) {
    lines.push(
      `- **Compaction**: ${comp.tokensRemainingFormatted} tokens (~${comp.kbRemaining} KB) remaining (Trigger: ${comp.thresholdTokensFormatted}, ${comp.percentCompacted}% used)${alertSuffix}`
    );
  } else {
    lines.push(
      `- **Compaction**: ~${comp.kbRemaining} KB remaining (${comp.percentCompacted}% used)${alertSuffix}`
    );
  }

  if (quota) {
    const g5h = quota.gemini?.fiveHour;
    const gWk = quota.gemini?.weekly;
    const tp5h = quota.thirdParty?.fiveHour;
    const tpWk = quota.thirdParty?.weekly;
    if (g5h && gWk) {
      lines.push(
        `- **Gemini Quota**: 5h ${g5h.remainingPercent}% (resets ${g5h.countdown}), Weekly ${gWk.remainingPercent}% (resets ${gWk.countdown})`
      );
    }
    if (tp5h && tpWk) {
      lines.push(
        `- **3P Quota (Claude/GPT)**: 5h ${tp5h.remainingPercent}% (resets ${tp5h.countdown}), Weekly ${tpWk.remainingPercent}% (resets ${tpWk.countdown})`
      );
    }
  } else if (quotaError) {
    lines.push(`- **Quota**: Unavailable (${quotaError})`);
  }

  if (subagentReport) {
    const { subagents, scannedCount, activeCount } = subagentReport;
    lines.push("");
    lines.push(`#### Subagents (${subagents.length} matched, ${activeCount} active, ${scannedCount} scanned)`);
    if (subagents.length === 0) {
      lines.push(activeOnly ? "- No active subagents found." : "- No subagents found.");
    } else {
      for (const sub of subagents) {
        const m = sub.metrics;
        const roleBase = normalizeDisplayText(sub.subagentType) || "subagent";
        const roleName = normalizeDisplayText(sub.subagentName) || normalizeDisplayText(sub.subagentRole);
        const role = roleName ? `${roleBase}: ${roleName}` : roleBase;
        const stateLabel = sub.isActive ? "active" : "idle";
        const compLeft = m.compaction.tokensRemainingFormatted
          ? `${m.compaction.tokensRemainingFormatted} left`
          : `~${m.compaction.kbRemaining ?? 0} KB left`;
        lines.push(
          `- \`${sub.conversationId}\` (${role}, ${stateLabel}): ${m.model.displayName} · ${m.contextWindow.currentTokensFormatted}/${m.contextWindow.maxTokensFormatted} (${m.contextWindow.percentUsed}%) · Cache ${m.cache.hitRatioPercent}% · Compaction ${m.compaction.percentCompacted}% (${compLeft})`
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Formats the status report as markdown or structured JSON text.
 * @param {Object} report
 * @param {"markdown"|"json"} [format="markdown"]
 * @returns {string}
 */
export function formatStatusReport(report, format = "markdown") {
  if (format === "json") {
    const { metrics, includeQuota, quota, quotaError, includeSubagents, subagentReport } = report;
    const convName = normalizeDisplayText(metrics.conversationName);
    const payload = {
      conversationId: metrics.conversationId,
      ...(convName ? { conversationName: convName } : {}),
      lastModified: metrics.lastModified,
      stepCount: metrics.stepCount,
      model: metrics.model,
      contextWindow: metrics.contextWindow,
      cache: metrics.cache,
      compaction: metrics.compaction
    };

    if (includeQuota) {
      payload.quota = quota
        ? {
            gemini: quota.gemini,
            thirdParty: quota.thirdParty,
            timestamp: quota.timestamp,
            ...(quota.isStale !== undefined ? { isStale: quota.isStale } : {}),
            ...(quota.error !== undefined ? { error: quota.error } : {})
          }
        : null;
      if (quotaError) {
        payload.quotaError = quotaError;
      }
    }

    if (includeSubagents && subagentReport) {
      payload.subagents = {
        items: subagentReport.subagents,
        scannedCount: subagentReport.scannedCount,
        activeCount: subagentReport.activeCount
      };
    }

    return JSON.stringify(payload, null, 2);
  }

  return formatStatusMarkdown(report);
}
