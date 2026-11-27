/**
 * Quota Normalization & Countdown Formatting Helpers.
 * Normalizes Language Server RetrieveUserQuotaSummary payloads and computes
 * live countdown strings from bucket reset timestamps.
 */

/**
 * Formats a duration until a reset timestamp into a concise countdown string.
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

/**
 * Parses the raw RetrieveUserQuotaSummary RPC response into normalized telemetry structure.
 * @param {Object} rawData
 * @returns {Object}
 */
export function normalizeQuotaResponse(rawData) {
  const defaultBucket = {
    remainingFraction: 1,
    remainingPercent: 100,
    usedPercent: 0,
    resetTime: null,
    countdown: "Ready"
  };

  const rawGroups = Array.isArray(rawData?.response?.groups) ? rawData.response.groups : [];
  const quota = {
    gemini: {
      weekly: { ...defaultBucket },
      fiveHour: { ...defaultBucket }
    },
    thirdParty: {
      weekly: { ...defaultBucket },
      fiveHour: { ...defaultBucket }
    },
    rawGroups,
    timestamp: Date.now()
  };

  for (const group of rawGroups) {
    if (!group || typeof group !== "object") continue;
    const name = (typeof group.displayName === "string" ? group.displayName : "").toLowerCase();
    const isGemini = name.includes("gemini");
    const is3p = name.includes("claude") || name.includes("gpt") || name.includes("third");
    const targetGroup = isGemini ? quota.gemini : is3p ? quota.thirdParty : null;

    if (!targetGroup || !Array.isArray(group.buckets)) continue;

    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const windowType = (typeof bucket.window === "string" ? bucket.window : "").toLowerCase();
      const fraction = Number.isFinite(bucket.remainingFraction)
        ? Math.max(0, Math.min(1, bucket.remainingFraction))
        : 1;
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
        description: typeof bucket.description === "string" ? bucket.description : ""
      };

      const bucketId = typeof bucket.bucketId === "string" ? bucket.bucketId : "";
      const bucketDisplayName = typeof bucket.displayName === "string" ? bucket.displayName : "";

      if (windowType === "weekly" || bucketId.includes("weekly")) {
        targetGroup.weekly = bucketData;
      } else if (windowType === "5h" || bucketId.includes("5h") || bucketDisplayName.includes("Five Hour")) {
        targetGroup.fiveHour = bucketData;
      }
    }
  }

  return quota;
}

function refreshBucketCountdown(bucket) {
  if (!bucket || typeof bucket !== "object") return bucket;
  return {
    ...bucket,
    countdown: bucket.resetTime ? formatCountdown(bucket.resetTime) : bucket.countdown
  };
}

/**
 * Returns a shallow clone of a cached quota summary with recomputed countdown strings.
 * @param {Object} quota
 * @returns {Object}
 */
export function refreshQuotaCountdowns(quota) {
  if (!quota || typeof quota !== "object") return quota;
  return {
    ...quota,
    gemini: {
      weekly: refreshBucketCountdown(quota.gemini?.weekly),
      fiveHour: refreshBucketCountdown(quota.gemini?.fiveHour)
    },
    thirdParty: {
      weekly: refreshBucketCountdown(quota.thirdParty?.weekly),
      fiveHour: refreshBucketCountdown(quota.thirdParty?.fiveHour)
    }
  };
}
